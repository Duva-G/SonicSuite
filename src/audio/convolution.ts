type ConvolutionCache = WeakMap<AudioBuffer, WeakMap<AudioBuffer, Promise<AudioBuffer>>>;

const cache: ConvolutionCache = new WeakMap();

function ensureOfflineContext(): typeof OfflineAudioContext {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("OfflineAudioContext not supported in this environment.");
  }
  return OfflineAudioContext;
}

export async function renderConvolution(source: AudioBuffer, ir: AudioBuffer): Promise<AudioBuffer> {
  if (!source) {
    throw new Error("Source buffer is required for convolution.");
  }
  if (!ir) {
    throw new Error("Impulse response buffer is required for convolution.");
  }

  const OfflineCtx = ensureOfflineContext();
  const maxChannels = Math.max(source.numberOfChannels, ir.numberOfChannels, 1);
  const length = source.length + ir.length;
  const ctx = new OfflineCtx(maxChannels, length, source.sampleRate);
  const sourceNode = ctx.createBufferSource();
  sourceNode.buffer = source;
  const convolver = ctx.createConvolver();
  convolver.normalize = false;
  convolver.buffer = ir;
  sourceNode.connect(convolver);
  convolver.connect(ctx.destination);
  sourceNode.start(0);
  return ctx.startRendering();
}

export function getConvolvedBuffer(source: AudioBuffer, ir: AudioBuffer): Promise<AudioBuffer> {
  let irMap = cache.get(source);
  if (!irMap) {
    irMap = new WeakMap<AudioBuffer, Promise<AudioBuffer>>();
    cache.set(source, irMap);
  }
  const existing = irMap.get(ir);
  if (existing) return existing;
  const pending = renderConvolution(source, ir).then((result) => result);
  irMap.set(ir, pending);
  return pending;
}

export function extractSnippet(buffer: AudioBuffer, startSeconds: number, durationSeconds: number): AudioBuffer {
  const sampleRate = buffer.sampleRate || 44100;
  const totalFrames = buffer.length;
  if (totalFrames === 0) {
    return new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length: 0,
      sampleRate,
    });
  }
  const requestedFrames = Math.max(Math.floor(durationSeconds * sampleRate), 1);
  const frameCount = Math.min(requestedFrames, totalFrames);
  const startFrame = clampFrame(Math.floor(startSeconds * sampleRate), 0, totalFrames - 1);
  const snippet = new AudioBuffer({
    numberOfChannels: buffer.numberOfChannels,
    length: frameCount,
    sampleRate,
  });
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const target = snippet.getChannelData(channel);
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i += 1) {
      const sourceIndex = (startFrame + i) % totalFrames;
      target[i] = data[sourceIndex] ?? 0;
    }
  }
  return snippet;
}

function clampFrame(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
