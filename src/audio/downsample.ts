export const MAX_POINTS = 4000;
export const SAMPLE_WINDOW_RATIO = 0.1;
export const MIN_SAMPLE_WINDOW_SECONDS = 15;
export const MAX_SAMPLE_WINDOW_SECONDS = 45;

export type DownsampleInput = {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  channelData: Float32Array[];
};

export type DownsampleOutput = {
  times: Float32Array;
  channelSamples: Float32Array[];
  peak: number;
  duration: number;
};

export function downsample({
  sampleRate,
  length,
  numberOfChannels,
  channelData,
}: DownsampleInput): DownsampleOutput {
  const channelCount = numberOfChannels > 0 ? numberOfChannels : 1;

  if (length === 0 || sampleRate <= 0) {
    const emptyTimes = new Float32Array(0);
    const emptyChannels = Array.from(
      { length: channelCount },
      () => new Float32Array(0),
    );
    return {
      times: emptyTimes,
      channelSamples: emptyChannels,
      peak: 0,
      duration: 0,
    };
  }

  const timeScalar = 1 / sampleRate;
  const totalDuration = length * timeScalar;
  const desiredWindow = totalDuration * SAMPLE_WINDOW_RATIO;
  let windowDuration = Math.min(
    MAX_SAMPLE_WINDOW_SECONDS,
    Math.max(desiredWindow, MIN_SAMPLE_WINDOW_SECONDS),
  );
  if (windowDuration > totalDuration) {
    windowDuration = totalDuration;
  }

  let windowStartTime = totalDuration / 2 - windowDuration / 2;
  if (windowStartTime < 0) {
    windowStartTime = 0;
  }
  let windowEndTime = windowStartTime + windowDuration;
  if (windowEndTime > totalDuration) {
    windowEndTime = totalDuration;
    windowStartTime = Math.max(0, windowEndTime - windowDuration);
  }

  const startSample = Math.max(0, Math.floor(windowStartTime * sampleRate));
  const endSample = Math.min(
    length,
    Math.max(startSample + 1, Math.ceil(windowEndTime * sampleRate)),
  );
  const snippetLength = endSample - startSample;

  const step = Math.max(1, Math.floor(snippetLength / MAX_POINTS));
  const outputLength =
    snippetLength === 0 ? 0 : Math.ceil(snippetLength / step);
  const times = new Float32Array(outputLength);
  const channelSamples = Array.from(
    { length: channelCount },
    () => new Float32Array(outputLength),
  );

  if (snippetLength === 0) {
    return { times, channelSamples, peak: 0, duration: 0 };
  }

  let globalMax = Number.NEGATIVE_INFINITY;
  let globalMin = Number.POSITIVE_INFINITY;
  let writeIndex = 0;

  for (let start = startSample; start < endSample; start += step) {
    const bucketEnd = Math.min(endSample, start + step);
    times[writeIndex] = (start - startSample) * timeScalar;

    for (let ch = 0; ch < channelCount; ch++) {
      const channel = channelData[ch];
      let maxVal = Number.NEGATIVE_INFINITY;
      let minVal = Number.POSITIVE_INFINITY;

      if (channel) {
        for (let i = start; i < bucketEnd; i++) {
          const value = channel[i];
          if (value > maxVal) maxVal = value;
          if (value < minVal) minVal = value;
        }
      }

      const safeMax = Number.isFinite(maxVal) ? maxVal : 0;
      const safeMin = Number.isFinite(minVal) ? minVal : 0;
      const dominant =
        Math.abs(safeMax) > Math.abs(safeMin) ? safeMax : safeMin;
      const resolved = Number.isFinite(dominant) ? dominant : 0;
      channelSamples[ch][writeIndex] = resolved;

      if (safeMax > globalMax) globalMax = safeMax;
      if (safeMin < globalMin) globalMin = safeMin;
    }

    writeIndex++;
  }

  const resolvedMax = Number.isFinite(globalMax) ? Math.abs(globalMax) : 0;
  const resolvedMin = Number.isFinite(globalMin) ? Math.abs(globalMin) : 0;
  const peak = Math.max(resolvedMax, resolvedMin);
  const duration = snippetLength * timeScalar;

  return { times, channelSamples, peak, duration };
}
