export {};

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

type ComputeResidualRequest = {
  type: "compute-residual";
  requestId: number;
  payload: {
    wetChannels: Float32Array[];
    dryChannels: Float32Array[];
    gains: Float32Array;
    offset: number;
    thresholdDb: number;
    sampleRate: number;
    originalLength: number;
    bandSoloEnabled: boolean;
    bandMinHz: number;
    bandMaxHz: number;
  };
};

type ComputeResidualSuccess = {
  type: "residual-ready";
  requestId: number;
  payload: {
    channelData: Float32Array;
    sampleRate: number;
  };
};

type ComputeResidualError = {
  type: "residual-error";
  requestId: number;
  error: string;
};

const TARGET_RATE = 22050;
const WINDOW_SIZE = 1024;
const HOP_SIZE = 512;
const EPSILON = 1e-9;

const HANN_WINDOW = createHannWindow(WINDOW_SIZE);

workerScope.addEventListener("message", (event: MessageEvent<ComputeResidualRequest>) => {
  const data = event.data;
  if (!data || data.type !== "compute-residual") {
    return;
  }

  const { requestId, payload } = data;

  try {
    const residual = computeResidual(payload);
    const response: ComputeResidualSuccess = {
      type: "residual-ready",
      requestId,
      payload: {
        channelData: residual,
        sampleRate: payload.sampleRate,
      },
    };
    workerScope.postMessage(response, [residual.buffer]);
  } catch (err) {
    const error: ComputeResidualError = {
      type: "residual-error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
    };
    workerScope.postMessage(error);
  }
});

function computeResidual(payload: ComputeResidualRequest["payload"]): Float32Array {
  const {
    wetChannels,
    dryChannels,
    gains,
    offset,
    thresholdDb,
    sampleRate,
    originalLength,
    bandSoloEnabled,
    bandMinHz,
    bandMaxHz,
  } = payload;

  const wetLength = wetChannels[0]?.length ?? originalLength;

  const wetMono = mixToMono(wetChannels, wetLength);
  const alignedDry = alignAndMixDry(dryChannels, gains, wetLength, offset);

  const targetRate = Math.min(sampleRate, TARGET_RATE);
  const wetForStft = sampleRate === targetRate ? wetMono : resampleLinear(wetMono, sampleRate, targetRate);
  const dryForStft = sampleRate === targetRate ? alignedDry : resampleLinear(alignedDry, sampleRate, targetRate);

  const stftWet = performStft(wetForStft, HANN_WINDOW, HOP_SIZE);
  const stftDry = performStft(dryForStft, HANN_WINDOW, HOP_SIZE);

  const { real: resReal, imag: resImag } = applyThreshold(
    stftWet,
    stftDry,
    thresholdDb,
    bandSoloEnabled,
    bandMinHz,
    bandMaxHz,
    targetRate,
  );
  const residualDown = performIstft(resReal, resImag, HANN_WINDOW, HOP_SIZE, wetForStft.length);

  const residualUp = sampleRate === targetRate
    ? residualDown
    : resampleLinear(residualDown, targetRate, sampleRate, originalLength);

  if (residualUp.length !== originalLength) {
    const resized = new Float32Array(originalLength);
    resized.set(residualUp.subarray(0, Math.min(residualUp.length, originalLength)));
    return resized;
  }

  return residualUp;
}

function mixToMono(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(length);
  }
  const mono = new Float32Array(length);
  const count = channels.length;
  for (let ch = 0; ch < count; ch++) {
    const src = channels[ch];
    const srcLength = src.length;
    for (let i = 0; i < length; i++) {
      if (i < srcLength) {
        mono[i] += src[i];
      }
    }
  }
  const inv = 1 / count;
  for (let i = 0; i < length; i++) {
    mono[i] *= inv;
  }
  return mono;
}

function alignAndMixDry(
  dryChannels: Float32Array[],
  gains: Float32Array,
  length: number,
  offsetSamples: number,
): Float32Array {
  const aligned = new Float32Array(length);
  const delay = Math.max(0, Math.floor(offsetSamples));
  const count = dryChannels.length > 0 ? dryChannels.length : 1;

  for (let ch = 0; ch < count; ch++) {
    const source = dryChannels[Math.min(ch, dryChannels.length - 1)] ?? new Float32Array(0);
    const gain = Number.isFinite(gains[ch]) ? gains[ch] : 1;
    const srcLength = source.length;
    for (let i = 0; i < length; i++) {
      const srcIndex = i - delay;
      const value = srcIndex >= 0 && srcIndex < srcLength ? source[srcIndex] * gain : 0;
      aligned[i] += value;
    }
  }

  const inv = 1 / count;
  for (let i = 0; i < length; i++) {
    aligned[i] *= inv;
  }
  return aligned;
}

function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  targetLength?: number,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) {
    return new Float32Array(targetLength ?? input.length);
  }
  if (fromRate === toRate) {
    if (targetLength && targetLength !== input.length) {
      const output = new Float32Array(targetLength);
      const ratio = (input.length - 1) / Math.max(1, targetLength - 1);
      for (let i = 0; i < targetLength; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = input[idx] ?? 0;
        const b = input[idx + 1] ?? a;
        output[i] = a + (b - a) * frac;
      }
      return output;
    }
    return input.slice();
  }

  const ratio = toRate / fromRate;
  const outputLength = targetLength ?? Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);
  const step = fromRate / toRate;

  for (let i = 0; i < outputLength; i++) {
    const pos = i * step;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }

  return output;
}

function performStft(signal: Float32Array, window: Float32Array, hopSize: number) {
  const windowSize = window.length;
  const frameCount = Math.max(1, Math.ceil((signal.length - windowSize) / hopSize) + 1);
  const realFrames: Float32Array[] = new Array(frameCount);
  const imagFrames: Float32Array[] = new Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hopSize;
    const real = new Float32Array(windowSize);
    const imag = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
      const idx = start + i;
      const sample = idx < signal.length ? signal[idx] : 0;
      real[i] = sample * window[i];
    }
    fftInPlace(real, imag, false);
    realFrames[frame] = real;
    imagFrames[frame] = imag;
  }

  return { real: realFrames, imag: imagFrames };
}

function applyThreshold(
  wet: { real: Float32Array[]; imag: Float32Array[] },
  dry: { real: Float32Array[]; imag: Float32Array[] },
  thresholdDb: number,
  bandSoloEnabled: boolean,
  bandMinHz: number,
  bandMaxHz: number,
  sampleRate: number,
) {
  const frameCount = Math.min(wet.real.length, dry.real.length);
  const resReal: Float32Array[] = new Array(frameCount);
  const resImag: Float32Array[] = new Array(frameCount);
  const absThreshold = Math.max(0, thresholdDb);
  const nyquist = sampleRate / 2;
  const minHz = Math.max(0, Math.min(bandMinHz, nyquist));
  const maxHz = Math.max(minHz, Math.min(bandMaxHz, nyquist));
  const enforceBand = bandSoloEnabled && maxHz - minHz > 1e-6;

  for (let frame = 0; frame < frameCount; frame++) {
    const wetReal = wet.real[frame];
    const wetImag = wet.imag[frame];
    const dryReal = dry.real[frame];
    const dryImag = dry.imag[frame];
    const bins = wetReal.length;
    const frameReal = new Float32Array(bins);
    const frameImag = new Float32Array(bins);

    for (let bin = 0; bin < bins; bin++) {
      const wr = wetReal[bin];
      const wi = wetImag[bin];
      const dr = dryReal[bin] ?? 0;
      const di = dryImag[bin] ?? 0;
      const magWet = Math.hypot(wr, wi);
      const magDry = Math.hypot(dr, di);
      const ratio = (magWet + EPSILON) / (magDry + EPSILON);
      const deltaDb = 20 * Math.log10(ratio);
      const mirroredBin = bin <= WINDOW_SIZE / 2 ? bin : WINDOW_SIZE - bin;
      const freq = (mirroredBin * sampleRate) / WINDOW_SIZE;
      const inBand = !enforceBand || (freq >= minHz && freq <= maxHz);
      if (inBand && (absThreshold <= 0 || Math.abs(deltaDb) >= absThreshold - 1e-6)) {
        frameReal[bin] = wr - dr;
        frameImag[bin] = wi - di;
      }
    }

    resReal[frame] = frameReal;
    resImag[frame] = frameImag;
  }

  return { real: resReal, imag: resImag };
}

function performIstft(
  realFrames: Float32Array[],
  imagFrames: Float32Array[],
  window: Float32Array,
  hopSize: number,
  outputLength: number,
): Float32Array {
  const windowSize = window.length;
  const frameCount = realFrames.length;
  const output = new Float32Array(outputLength);
  const norm = new Float32Array(outputLength);

  for (let frame = 0; frame < frameCount; frame++) {
    const real = realFrames[frame];
    const imag = imagFrames[frame];
    if (!real || !imag) continue;
    fftInPlace(real, imag, true);
    const start = frame * hopSize;
    for (let i = 0; i < windowSize; i++) {
      const idx = start + i;
      if (idx >= outputLength) break;
      const sample = real[i] * window[i];
      output[idx] += sample;
      norm[idx] += window[i] * window[i];
    }
  }

  for (let i = 0; i < outputLength; i++) {
    const scale = norm[i];
    if (scale > 1e-9) {
      output[i] /= scale;
    } else {
      output[i] = 0;
    }
  }

  return output;
}

function fftInPlace(real: Float32Array, imag: Float32Array, inverse: boolean) {
  const n = real.length;
  if (n === 0) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error("FFT length must be a power of two");
  }

  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;
      const tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const theta = (inverse ? 1 : -1) * (2 * Math.PI) / size;
    const wTemp = Math.sin(0.5 * theta);
    const wPR = -2 * wTemp * wTemp;
    const wPI = Math.sin(theta);
    for (let start = 0; start < n; start += size) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < halfSize; k++) {
        const evenIndex = start + k;
        const oddIndex = evenIndex + halfSize;
        const xr = wr * real[oddIndex] - wi * imag[oddIndex];
        const xi = wr * imag[oddIndex] + wi * real[oddIndex];
        real[oddIndex] = real[evenIndex] - xr;
        imag[oddIndex] = imag[evenIndex] - xi;
        real[evenIndex] += xr;
        imag[evenIndex] += xi;

        const wrNext = wr + wr * wPR - wi * wPI;
        const wiNext = wi + wi * wPR + wr * wPI;
        wr = wrNext;
        wi = wiNext;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

function createHannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  if (length <= 1) return window;
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return window;
}
