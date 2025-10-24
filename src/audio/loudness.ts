export type LoudnessMeasure = {
  rms: number;
  rmsDb: number;
};

export type LoudnessGainMap = Record<string, number>;

export function computeSegmentLoudness(
  buffer: AudioBuffer,
  startSeconds: number,
  durationSeconds: number,
): LoudnessMeasure {
    const sampleRate = buffer.sampleRate || 44100;
    const startFrame = Math.min(Math.max(Math.floor(startSeconds * sampleRate), 0), buffer.length);
    const frameCount = Math.min(Math.max(Math.floor(durationSeconds * sampleRate), 0), buffer.length - startFrame);
    if (frameCount <= 0) {
      return { rms: 0, rmsDb: Number.NEGATIVE_INFINITY };
    }

    let sumSquares = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < frameCount; i += 1) {
        const sample = data[startFrame + i] ?? 0;
        sumSquares += sample * sample;
      }
    }
    const totalSamples = frameCount * buffer.numberOfChannels || 1;
    const meanSquare = sumSquares / totalSamples;
    const rms = Math.sqrt(Math.max(meanSquare, 0));
    const rmsDb = linearToDb(rms);
    return { rms, rmsDb };
}

export function linearToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(value);
}

export function dbToLinear(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return 10 ** (value / 20);
}

export function deriveMatchGains(levels: Record<string, number>): {
  targetDb: number;
  gains: LoudnessGainMap;
} {
  const entries = Object.entries(levels).filter(([, level]) => Number.isFinite(level));
  if (entries.length === 0) {
    return { targetDb: 0, gains: {} };
  }
  const targetDb = entries.reduce((sum, [, value]) => sum + value, 0) / entries.length;
  const gains: LoudnessGainMap = {};
  entries.forEach(([key, level]) => {
    gains[key] = clampGain(dbToLinear(targetDb - level));
  });
  return { targetDb, gains };
}

export function clampGain(gain: number, min = 0.01, max = 100): number {
  if (!Number.isFinite(gain)) return 1;
  return Math.min(Math.max(gain, min), max);
}

export function applyGain(buffer: AudioBuffer, gain: number): AudioBuffer {
  const clampedGain = clampGain(gain);
  const clone = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
  });
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    const target = clone.getChannelData(channel);
    for (let i = 0; i < buffer.length; i += 1) {
      target[i] = source[i] * clampedGain;
    }
  }
  return clone;
}

export function computeRmsDifferenceDb(a: number, b: number): number {
  return Math.abs(a - b);
}

export function isWithinTolerance(levels: Record<string, number>, toleranceDb: number): boolean {
  const values = Object.values(levels).filter((value) => Number.isFinite(value));
  if (values.length <= 1) return true;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return max - min <= Math.abs(toleranceDb);
}

export function accumulateRms(buffer: AudioBuffer): LoudnessMeasure {
  return computeSegmentLoudness(buffer, 0, buffer.duration);
}
