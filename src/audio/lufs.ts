type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

type KWeightingCoefficients = {
  shelf: BiquadCoefficients;
  highpass: BiquadCoefficients;
};

const LOG_OFFSET = -0.691; // Offset so that 0 dBFS sine registers 0 LUFS.
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_DROP = 10;
const BLOCK_DURATION_SECONDS = 0.4;
const STEP_DURATION_SECONDS = 0.1;
const COEFFICIENT_CACHE = new Map<number, KWeightingCoefficients>();

function getKWeightingCoefficients(sampleRate: number): KWeightingCoefficients {
  if (sampleRate <= 0) {
    return {
      shelf: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
      highpass: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
    };
  }
  const cached = COEFFICIENT_CACHE.get(sampleRate);
  if (cached) return cached;

  // High-frequency shelving stage.
  const fShelf = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const qShelf = 0.7071752369554196;
  const kShelf = Math.tan(Math.PI * fShelf / sampleRate);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const a0Shelf = 1 + kShelf / qShelf + kShelf * kShelf;
  const shelf: BiquadCoefficients = {
    b0: (vh + (vb * kShelf) / qShelf + kShelf * kShelf) / a0Shelf,
    b1: (2 * (kShelf * kShelf - vh)) / a0Shelf,
    b2: (vh - (vb * kShelf) / qShelf + kShelf * kShelf) / a0Shelf,
    a1: (2 * (kShelf * kShelf - 1)) / a0Shelf,
    a2: (1 - kShelf / qShelf + kShelf * kShelf) / a0Shelf,
  };

  // High-pass stage with double zero at z = 1.
  const fHp = 38.13547087602444;
  const qHp = 0.5003270373238773;
  const kHp = Math.tan(Math.PI * fHp / sampleRate);
  const a0Hp = 1 + kHp / qHp + kHp * kHp;
  const highpass: BiquadCoefficients = {
    b0: 1 / a0Hp,
    b1: -2 / a0Hp,
    b2: 1 / a0Hp,
    a1: (2 * (kHp * kHp - 1)) / a0Hp,
    a2: (1 - kHp / qHp + kHp * kHp) / a0Hp,
  };

  const coeffs = { shelf, highpass };
  COEFFICIENT_CACHE.set(sampleRate, coeffs);
  return coeffs;
}

function applyBiquadInPlace(data: Float32Array, coeffs: BiquadCoefficients): void {
  const { b0, b1, b2, a1, a2 } = coeffs;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    data[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
  }
  return sum / values.length;
}

function energyToLufs(energy: number): number {
  if (!Number.isFinite(energy) || energy <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const log10 = Math.log10 ?? ((x: number) => Math.log(x) / Math.LN10);
  return LOG_OFFSET + 10 * log10(energy);
}

function lufsToEnergy(lufs: number): number {
  return 10 ** ((lufs - LOG_OFFSET) / 10);
}

function clampIndex(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function computeIntegratedLufs(buffer: AudioBuffer, start: number, frames: number): number {
  const sampleRate = buffer.sampleRate;
  if (sampleRate <= 0 || buffer.length === 0 || frames <= 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const maxStart = Math.max(0, buffer.length - 1);
  const frameStart = clampIndex(Math.floor(start), 0, maxStart);
  const available = buffer.length - frameStart;
  const frameCount = Math.min(Math.max(1, Math.floor(frames)), available);

  const { shelf, highpass } = getKWeightingCoefficients(sampleRate);
  const channelCount = buffer.numberOfChannels;
  const filtered: Float32Array[] = [];

  for (let ch = 0; ch < channelCount; ch++) {
    const source = buffer.getChannelData(ch);
    const copy = new Float32Array(source.subarray(frameStart, frameStart + frameCount));
    applyBiquadInPlace(copy, shelf);
    applyBiquadInPlace(copy, highpass);
    filtered.push(copy);
  }

  const blockSize = Math.max(1, Math.round(BLOCK_DURATION_SECONDS * sampleRate));
  const stepSize = Math.max(1, Math.round(STEP_DURATION_SECONDS * sampleRate));
  const energies: number[] = [];

  if (frameCount < blockSize) {
    let energy = 0;
    for (let ch = 0; ch < filtered.length; ch++) {
      const data = filtered[ch];
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        energy += v * v;
      }
    }
    energy /= frameCount;
    energies.push(energy);
  } else {
    for (let startIdx = 0; startIdx + blockSize <= frameCount; startIdx += stepSize) {
      let energy = 0;
      for (let ch = 0; ch < filtered.length; ch++) {
        const data = filtered[ch];
        for (let i = 0; i < blockSize; i++) {
          const v = data[startIdx + i];
          energy += v * v;
        }
      }
      energy /= blockSize;
      energies.push(energy);
    }
  }

  if (energies.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const absoluteThreshold = lufsToEnergy(ABSOLUTE_GATE_LUFS);
  const aboveAbsolute = energies.filter((e) => e > absoluteThreshold);
  if (aboveAbsolute.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const ungatedMean = average(aboveAbsolute);
  const ungatedLufs = energyToLufs(ungatedMean);
  if (!Number.isFinite(ungatedLufs)) {
    return Number.NEGATIVE_INFINITY;
  }

  const relativeThreshold = lufsToEnergy(ungatedLufs - RELATIVE_GATE_DROP);
  const gatedEnergies = aboveAbsolute.filter((e) => e >= relativeThreshold);
  const finalSet = gatedEnergies.length > 0 ? gatedEnergies : aboveAbsolute;
  const finalMean = average(finalSet);
  return energyToLufs(finalMean);
}

export function computeAlignedLufsPair(
  dry: AudioBuffer,
  wet: AudioBuffer,
  offset: number,
): [number, number] {
  if (dry.length === 0 || wet.length === 0) {
    return [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  }
  const wetAvailable = Math.max(0, wet.length - offset);
  let frames = Math.min(dry.length, wetAvailable);
  if (frames <= 0) frames = Math.min(dry.length, wet.length);
  if (frames <= 0) {
    return [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  }
  const wetOffset = clampIndex(offset, 0, Math.max(0, wet.length - frames));
  const dryLufs = computeIntegratedLufs(dry, 0, frames);
  const wetLufs = computeIntegratedLufs(wet, wetOffset, frames);
  return [dryLufs, wetLufs];
}
