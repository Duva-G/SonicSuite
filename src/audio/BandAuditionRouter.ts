import { createBandpassChain, type BandSettings, type BandpassChain } from "./bandPassFactory";
import { LatencyCompensator, type PathKey as BasePathKey, type LatencySecondsMap } from "./LatencyCompensator";

export type BasePath = BasePathKey;
export type DeltaPath = "DeltaAB" | "DeltaAC" | "DeltaBC";
export type AuditionPath = BasePath | DeltaPath;

type OutputGainMap = Record<AuditionPath, GainNode>;

type BasePathNodes = {
  input: GainNode;
  band: BandpassChain;
  trim: GainNode;
};

type DeltaNodes = {
  mix: GainNode;
  positive: GainNode;
  negative: GainNode;
};

const BASE_PATHS: BasePath[] = ["A", "B", "C"];
const DELTA_PATHS: DeltaPath[] = ["DeltaAB", "DeltaAC", "DeltaBC"];

const DEFAULT_CROSSFADE_MS = 8;

export type BandAuditionRouterOptions = {
  destination: AudioNode;
  band: BandSettings;
  crossfadeMs?: number;
};

export class BandAuditionRouter {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;
  private readonly latencyCompensator: LatencyCompensator;
  private readonly baseNodes: Record<BasePath, BasePathNodes>;
  private readonly outputGains: OutputGainMap;
  private readonly deltaNodes: Record<DeltaPath, DeltaNodes>;
  private crossfadeSeconds: number;
  private currentPath: AuditionPath | null = null;

  constructor(ctx: AudioContext, options: BandAuditionRouterOptions) {
    this.ctx = ctx;
    this.destination = options.destination;
    this.crossfadeSeconds = Math.max(0.001, (options.crossfadeMs ?? DEFAULT_CROSSFADE_MS) / 1000);

    this.latencyCompensator = new LatencyCompensator(ctx);

    const delayNodes = {
      A: this.latencyCompensator.getNode("A"),
      B: this.latencyCompensator.getNode("B"),
      C: this.latencyCompensator.getNode("C"),
    };

    this.baseNodes = {
      A: this.createBaseNodes("A", options.band, delayNodes.A),
      B: this.createBaseNodes("B", options.band, delayNodes.B),
      C: this.createBaseNodes("C", options.band, delayNodes.C),
    };

    this.outputGains = this.createOutputGains();
    this.deltaNodes = this.createDeltaNodes();

    this.connectOutputs();
    this.connectDeltaRouting();
  }

  private createBaseNodes(_path: BasePath, band: BandSettings, delay: DelayNode): BasePathNodes {
    const input = new GainNode(this.ctx, { gain: 1 });
    const bandChain = createBandpassChain(this.ctx, band);
    bandChain.update(band, 0);
    const trim = new GainNode(this.ctx, { gain: 1 });

    input.connect(delay);
    delay.connect(bandChain.input);
    bandChain.output.connect(trim);

    return { input, band: bandChain, trim };
  }

  private createOutputGains(): OutputGainMap {
    return {
      A: new GainNode(this.ctx, { gain: 0 }),
      B: new GainNode(this.ctx, { gain: 0 }),
      C: new GainNode(this.ctx, { gain: 0 }),
      DeltaAB: new GainNode(this.ctx, { gain: 0 }),
      DeltaAC: new GainNode(this.ctx, { gain: 0 }),
      DeltaBC: new GainNode(this.ctx, { gain: 0 }),
    };
  }

  private createDeltaNodes(): Record<DeltaPath, DeltaNodes> {
    const create = (): DeltaNodes => {
      const mix = new GainNode(this.ctx, { gain: 1 });
      const positive = new GainNode(this.ctx, { gain: 1 });
      const negative = new GainNode(this.ctx, { gain: -1 });
      positive.connect(mix);
      negative.connect(mix);
      return { mix, positive, negative };
    };

    return {
      DeltaAB: create(),
      DeltaAC: create(),
      DeltaBC: create(),
    };
  }

  private connectOutputs() {
    (Object.entries(this.outputGains) as [AuditionPath, GainNode][]).forEach(([, gain]) => {
      gain.connect(this.destination);
    });

    BASE_PATHS.forEach((path) => {
      const nodes = this.baseNodes[path];
      const output = this.outputGains[path];
      nodes.trim.connect(output);
    });

    this.deltaNodes.DeltaAB.mix.connect(this.outputGains.DeltaAB);
    this.deltaNodes.DeltaAC.mix.connect(this.outputGains.DeltaAC);
    this.deltaNodes.DeltaBC.mix.connect(this.outputGains.DeltaBC);
  }

  private connectDeltaRouting() {
    this.baseNodes.A.trim.connect(this.deltaNodes.DeltaAB.negative);
    this.baseNodes.B.trim.connect(this.deltaNodes.DeltaAB.positive);

    this.baseNodes.A.trim.connect(this.deltaNodes.DeltaAC.negative);
    this.baseNodes.C.trim.connect(this.deltaNodes.DeltaAC.positive);

    this.baseNodes.B.trim.connect(this.deltaNodes.DeltaBC.negative);
    this.baseNodes.C.trim.connect(this.deltaNodes.DeltaBC.positive);
  }

  connectBase(path: BasePath, node: AudioNode) {
    const nodes = this.baseNodes[path];
    node.connect(nodes.input);
  }

  updateBand(settings: BandSettings, rampSeconds = 0.01) {
    BASE_PATHS.forEach((path) => {
      this.baseNodes[path].band.update(settings, rampSeconds);
    });
  }

  updateLatencies(latencies: LatencySecondsMap, rampSeconds = 0.01) {
    this.latencyCompensator.update(latencies, rampSeconds);
  }

  updateTrims(trims: Partial<Record<BasePath, number>>, rampSeconds = 0.01) {
    const now = this.ctx.currentTime;
    BASE_PATHS.forEach((path) => {
      const gain = trims[path];
      if (typeof gain === "number" && Number.isFinite(gain) && gain > 0) {
        const clamped = Math.min(Math.max(gain, 0.05), 10);
        const node = this.baseNodes[path].trim;
        node.gain.cancelScheduledValues(now);
        node.gain.setTargetAtTime(clamped, now, rampSeconds);
      }
    });
  }

  setActive(path: AuditionPath, crossfadeMs?: number) {
    const ramp = Math.max(0.001, (crossfadeMs ?? this.crossfadeSeconds * 1000) / 1000);
    const now = this.ctx.currentTime;
    (Object.entries(this.outputGains) as [AuditionPath, GainNode][]).forEach(([key, gain]) => {
      const target = key === path ? 1 : 0;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(target, now, ramp);
    });
    this.currentPath = path;
  }

  getCurrentPath(): AuditionPath | null {
    return this.currentPath;
  }

  dispose() {
    (Object.values(this.outputGains) as GainNode[]).forEach((gain) => gain.disconnect());
    BASE_PATHS.forEach((path) => {
      const nodes = this.baseNodes[path];
      nodes.input.disconnect();
      nodes.trim.disconnect();
    });
    DELTA_PATHS.forEach((path) => {
      const delta = this.deltaNodes[path];
      delta.mix.disconnect();
      delta.positive.disconnect();
      delta.negative.disconnect();
    });
  }
}

export default BandAuditionRouter;
