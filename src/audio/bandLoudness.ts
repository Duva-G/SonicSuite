import type { BandSettings } from "./bandPassFactory";
import { createBandpassChain } from "./bandPassFactory";
import { computeIntegratedLufs } from "./lufs";

export type PathKey = "A" | "B" | "C";

type ChainBuilder = (ctx: OfflineAudioContext, src: AudioBufferSourceNode, destination: AudioNode) => void;

export type BandLoudnessResult = {
  reference: number;
  paths: Partial<Record<PathKey, number>>;
  gains: Partial<Record<Exclude<PathKey, "A">, number>>;
};

const MIN_GAIN = 0.1;
const MAX_GAIN = 4;

async function renderBandLimited(
  buffer: AudioBuffer,
  band: BandSettings,
  builder: ChainBuilder,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(buffer.numberOfChannels || 1, buffer.length, buffer.sampleRate);
  const src = new AudioBufferSourceNode(ctx, { buffer });
  const chain = createBandpassChain(ctx, band);
  chain.update(band, 0);
  builder(ctx, src, chain.input);
  chain.output.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

function calculateGain(referenceLufs: number, otherLufs: number): number {
  if (!Number.isFinite(referenceLufs) || !Number.isFinite(otherLufs)) {
    return 1;
  }
  const delta = referenceLufs - otherLufs;
  let ratio = 10 ** (delta / 20);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    ratio = 1;
  }
  return Math.min(Math.max(ratio, MIN_GAIN), MAX_GAIN);
}

function scaleBufferInPlace(buffer: AudioBuffer, gain: number) {
  if (!Number.isFinite(gain) || gain === 1) return;
  const clamped = Math.max(gain, 0);
  if (clamped === 1) return;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] *= clamped;
    }
  }
}

export type ComputeBandLoudnessParams = {
  dry: AudioBuffer;
  irB?: AudioBuffer | null;
  irC?: AudioBuffer | null;
  band: BandSettings;
  wetBGain?: number;
  wetCGain?: number;
};

export async function computeBandLoudnessGains({
  dry,
  irB,
  irC,
  band,
  wetBGain,
  wetCGain,
}: ComputeBandLoudnessParams): Promise<BandLoudnessResult> {
  const referenceBuffer = await renderBandLimited(
    dry,
    band,
    (_ctx, src, destination) => {
      src.connect(destination);
    },
  );
  const reference = computeIntegratedLufs(referenceBuffer, 0, referenceBuffer.length);
  const paths: Partial<Record<PathKey, number>> = { A: reference };
  const gains: Partial<Record<Exclude<PathKey, "A">, number>> = {};

  if (irB) {
    const renderedB = await renderBandLimited(
      dry,
      band,
      (ctx, src, destination) => {
        const conv = new ConvolverNode(ctx, { buffer: irB, disableNormalization: false });
        src.connect(conv).connect(destination);
      },
    );
    if (wetBGain && wetBGain !== 1) {
      scaleBufferInPlace(renderedB, wetBGain);
    }
    const compensatedB = computeIntegratedLufs(renderedB, 0, renderedB.length);
    paths.B = compensatedB;
    gains.B = calculateGain(reference, compensatedB);
  }

  if (irC) {
    const renderedC = await renderBandLimited(
      dry,
      band,
      (ctx, src, destination) => {
        const conv = new ConvolverNode(ctx, { buffer: irC, disableNormalization: false });
        src.connect(conv).connect(destination);
      },
    );
    if (wetCGain && wetCGain !== 1) {
      scaleBufferInPlace(renderedC, wetCGain);
    }
    const compensatedC = computeIntegratedLufs(renderedC, 0, renderedC.length);
    paths.C = compensatedC;
    gains.C = calculateGain(reference, compensatedC);
  }

  return {
    reference,
    paths,
    gains,
  };
}
