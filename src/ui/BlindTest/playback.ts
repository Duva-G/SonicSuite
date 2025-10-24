import type { VariantId } from "./session";

type SourceMap = Partial<Record<VariantId, AudioBufferSourceNode>>;
type MixGainMap = Partial<Record<VariantId, GainNode>>;

export type PlaybackStatus = "idle" | "ready" | "playing" | "ended";

export type PlaybackCallbacks = {
  onEnded?: () => void;
};

export class BlindTestPlayback {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sources: SourceMap = {};
  private mixGains: MixGainMap = {};
  private currentVariant: VariantId | null = null;
  private crossfadeSeconds = 0.05;
  private status: PlaybackStatus = "idle";
  private callbacks: PlaybackCallbacks;
  private endedVariants = new Set<VariantId>();

  constructor(callbacks: PlaybackCallbacks = {}) {
    this.callbacks = callbacks;
  }

  setCrossfadeMs(value: number) {
    this.crossfadeSeconds = Math.max(0, value) / 1000;
  }

  prepare(buffers: Partial<Record<VariantId, AudioBuffer>>, gains?: Partial<Record<VariantId, number>>) {
    this.disposeSources();
    this.getContext();
    const ctx = this.ctx!;
    const master = this.getMasterGain();
    const sources: SourceMap = {};
    const mixNodes: MixGainMap = {};
    this.endedVariants.clear();

    (Object.entries(buffers) as [VariantId, AudioBuffer | undefined][]).forEach(([variant, buffer]) => {
      if (!buffer) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.onended = () => this.handleEnded(variant);

      const loudnessGain = ctx.createGain();
      loudnessGain.gain.value = typeof gains?.[variant] === "number" ? gains[variant]! : 1;

      const mixGain = ctx.createGain();
      mixGain.gain.value = 0;

      source.connect(loudnessGain);
      loudnessGain.connect(mixGain);
      mixGain.connect(master);

      sources[variant] = source;
      mixNodes[variant] = mixGain;
    });

    this.sources = sources;
    this.mixGains = mixNodes;
    this.status = Object.keys(sources).length > 0 ? "ready" : "idle";
  }

  async play(startVariant: VariantId | null = null) {
    if (this.status === "playing") return;
    const ctx = this.getContext();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    Object.values(this.sources).forEach((source) => {
      if (!source) return;
      try {
        source.start(0);
      } catch (error) {
        if (error instanceof DOMException && error.name === "InvalidStateError") {
          // Node already started; safe to ignore.
        }
      }
    });
    const variant =
      startVariant ?? this.currentVariant ?? (Object.keys(this.sources)[0] as VariantId | undefined) ?? null;
    if (variant) {
      this.setActiveVariant(variant, true);
    }
    this.status = "playing";
  }

  pause() {
    if (this.status !== "playing" || !this.ctx) return;
    this.ctx.suspend().catch(() => undefined);
    this.status = "ready";
  }

  stop() {
    if (this.status === "idle") return;
    this.disposeSources();
    this.status = "idle";
  }

  setActiveVariant(variant: VariantId, immediate = false) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const fade = immediate ? 0 : Math.max(this.crossfadeSeconds, 0.001);
    (Object.entries(this.mixGains) as [VariantId, GainNode | undefined][]).forEach(([key, gainNode]) => {
      if (!gainNode) return;
      const target = key === variant ? 1 : 0;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setTargetAtTime(target, now, fade);
    });
    this.currentVariant = variant;
  }

  getStatus(): PlaybackStatus {
    return this.status;
  }

  getCurrentVariant(): VariantId | null {
    return this.currentVariant;
  }

  dispose() {
    this.stop();
    if (this.master) {
      this.master.disconnect();
    }
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    this.master = null;
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  private getMasterGain(): GainNode {
    if (!this.master && this.ctx) {
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    return this.master!;
  }

  private disposeSources() {
    Object.values(this.sources).forEach((source) => {
      try {
        source?.stop();
      } catch {
        // ignored
      }
      source?.disconnect();
    });
    Object.values(this.mixGains).forEach((gain) => gain?.disconnect());
    this.sources = {};
    this.mixGains = {};
    this.currentVariant = null;
    this.endedVariants.clear();
  }

  private handleEnded(variant: VariantId) {
    this.endedVariants.add(variant);
    const keys = Object.keys(this.sources) as VariantId[];
    const done = keys.length > 0 && keys.every((key) => this.endedVariants.has(key));
    if (done) {
      this.status = "ended";
      this.callbacks.onEnded?.();
    }
  }
}
