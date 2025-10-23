export type BandSettings = {
  enabled: boolean;
  minHz: number;
  maxHz: number;
};

type ChainNodes = {
  input: GainNode;
  highpass: BiquadFilterNode;
  lowpass: BiquadFilterNode;
  output: BiquadFilterNode;
};

const MIN_HZ = 10;

function clampFrequency(value: number, ctx: BaseAudioContext): number {
  const nyquist = Math.max(100, ctx.sampleRate / 2);
  const clamped = Math.min(Math.max(value, MIN_HZ), nyquist - 10);
  return Number.isFinite(clamped) ? clamped : MIN_HZ;
}

function createNodes(ctx: BaseAudioContext, initial: BandSettings): ChainNodes {
  const input = new GainNode(ctx, { gain: 1 });
  const highpass = new BiquadFilterNode(ctx, {
    type: "highpass",
    Q: Math.SQRT1_2,
    frequency: clampFrequency(initial.enabled ? initial.minHz : MIN_HZ, ctx),
  });
  const lowpass = new BiquadFilterNode(ctx, {
    type: "lowpass",
    Q: Math.SQRT1_2,
    frequency: clampFrequency(
      initial.enabled ? Math.max(initial.maxHz, initial.minHz + 50) : ctx.sampleRate / 2 - 10,
      ctx,
    ),
  });
  input.connect(highpass).connect(lowpass);
  return { input, highpass, lowpass, output: lowpass };
}

export type BandpassChain = {
  input: GainNode;
  output: AudioNode;
  update: (settings: BandSettings, rampSeconds?: number) => void;
};

export function createBandpassChain(ctx: BaseAudioContext, initial: BandSettings): BandpassChain {
  const nodes = createNodes(ctx, initial);

  const update = (settings: BandSettings, rampSeconds = 0.01) => {
    const hpFreq = clampFrequency(settings.enabled ? settings.minHz : MIN_HZ, ctx);
    const lpFreq = clampFrequency(
      settings.enabled ? Math.max(settings.maxHz, hpFreq + 50) : ctx.sampleRate / 2 - 10,
      ctx,
    );
    const now = ctx.currentTime;
    nodes.highpass.frequency.setTargetAtTime(hpFreq, now, rampSeconds);
    nodes.lowpass.frequency.setTargetAtTime(lpFreq, now, rampSeconds);
  };

  return { input: nodes.input, output: nodes.output, update };
}
