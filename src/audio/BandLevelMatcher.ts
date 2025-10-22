import type { BandSettings } from "./bandPassFactory";
import { createBandpassChain } from "./bandPassFactory";

export type PathKey = "A" | "B" | "C";

type ChainBuilder = (ctx: OfflineAudioContext, src: AudioBufferSourceNode, destination: AudioNode) => void;

export type BandRmsResult = {
  reference: number;
  paths: Partial<Record<PathKey, number>>;
};

export type TrimResult = {
  band: BandSettings;
  referencePath: PathKey;
  trims: Partial<Record<Exclude<PathKey, "A">, number>>;
  rms: BandRmsResult;
};

const MIN_GAIN = 0.1;
const MAX_GAIN = 4;

async function renderRms(
  buffer: AudioBuffer,
  band: BandSettings,
  builder: ChainBuilder,
): Promise<number> {
  const ctx = new OfflineAudioContext(buffer.numberOfChannels || 1, buffer.length, buffer.sampleRate);
  const src = new AudioBufferSourceNode(ctx, { buffer });
  const bandChain = createBandpassChain(ctx, band);
  bandChain.update(band, 0);
  builder(ctx, src, bandChain.input);
  bandChain.output.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return computeBufferRms(rendered);
}

export function computeBufferRms(buffer: AudioBuffer): number {
  const { numberOfChannels, length } = buffer;
  if (length === 0) return 0;
  let accum = 0;
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    let sum = 0;
    for (let i = 0; i < length; i++) {
      const sample = data[i];
      sum += sample * sample;
    }
    accum += sum / length;
  }
  const mean = accum / Math.max(1, numberOfChannels);
  return Math.sqrt(Math.max(mean, 0));
}

export type ComputeBandTrimsParams = {
  dry: AudioBuffer;
  irB?: AudioBuffer | null;
  irC?: AudioBuffer | null;
  band: BandSettings;
};

export async function computeBandTrims({
  dry,
  irB,
  irC,
  band,
}: ComputeBandTrimsParams): Promise<TrimResult> {
  const referenceRms = await renderRms(
    dry,
    band,
    (_ctx, src, destination) => {
      src.connect(destination);
    },
  );

  const pathRms: Partial<Record<PathKey, number>> = { A: referenceRms };
  const trims: Partial<Record<Exclude<PathKey, "A">, number>> = {};

  if (irB) {
    const rmsB = await renderRms(
      dry,
      band,
      (ctx, src, destination) => {
        const conv = new ConvolverNode(ctx, { buffer: irB, disableNormalization: false });
        src.connect(conv).connect(destination);
      },
    );
    pathRms.B = rmsB;
    trims.B = calculateGain(referenceRms, rmsB);
  }

  if (irC) {
    const rmsC = await renderRms(
      dry,
      band,
      (ctx, src, destination) => {
        const conv = new ConvolverNode(ctx, { buffer: irC, disableNormalization: false });
        src.connect(conv).connect(destination);
      },
    );
    pathRms.C = rmsC;
    trims.C = calculateGain(referenceRms, rmsC);
  }

  return {
    band,
    referencePath: "A",
    trims,
    rms: {
      reference: referenceRms,
      paths: pathRms,
    },
  };
}

export function calculateGain(referenceRms: number, otherRms: number): number {
  if (!Number.isFinite(referenceRms) || referenceRms <= 0) return 1;
  if (!Number.isFinite(otherRms) || otherRms <= 0) return 1;
  const ratio = referenceRms / otherRms;
  const clamped = Math.min(Math.max(ratio, MIN_GAIN), MAX_GAIN);
  return clamped;
}
