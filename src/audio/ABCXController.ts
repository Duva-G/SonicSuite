import { useCallback, useMemo, useReducer, useRef } from "react";
import type { BandSettings } from "./bandPassFactory";
import type { BasePath as AuditionBasePath } from "./BandAuditionRouter";

export type BlindTestMode = "ABX" | "ACX" | "BCX" | "ABCX";
export type BasePath = AuditionBasePath;

export type TrialLogEntry = {
  index: number;
  mode: BlindTestMode;
  actual: BasePath;
  guess: BasePath | null;
  correct: boolean | null;
  timestamp: number;
  band: BandSettings;
  trims: Partial<Record<BasePath, number>>;
  latencies: Partial<Record<BasePath, number>>;
  seed: string;
};

export type ControllerConfig = {
  mode: BlindTestMode;
  band: BandSettings;
  trims: Partial<Record<BasePath, number>>;
  latencies: Partial<Record<BasePath, number>>;
  seed: string;
};

type TrialState = {
  index: number;
  actual: BasePath;
  guess: BasePath | null;
  revealed: boolean;
};

const PAIRWISE_P0 = 0.5;
const THREE_WAY_P0 = 1 / 3;

const DEFAULT_BAND: BandSettings = { enabled: false, minHz: 20, maxHz: 20000 };

export function hashSeed(seed: string): number {
  let h1 = 0xdeadbeef ^ seed.length;
  let h2 = 0x41c6ce57 ^ seed.length;
  for (let i = 0, ch; i < seed.length; i++) {
    ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 & 0xffff_ffff) >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function computeBinomialPValue(trials: number, successes: number, p0: number): number {
  if (trials <= 0) return 1;
  let cumulative = 0;
  for (let k = successes; k <= trials; k++) {
    cumulative += binomialProbability(trials, k, p0);
  }
  return Math.min(1, Math.max(0, cumulative));
}

function binomialProbability(n: number, k: number, p: number): number {
  const coeff = binomialCoefficient(n, k);
  return coeff * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

const binomialCache = new Map<string, number>();

function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const key = `${n},${k}`;
  const cached = binomialCache.get(key);
  if (cached) return cached;
  let res = 1;
  for (let i = 1; i <= k; i++) {
    res = (res * (n - (k - i))) / i;
  }
  binomialCache.set(key, res);
  return res;
}

export class ABCXController {
  private mode: BlindTestMode = "ABX";
  private band: BandSettings = DEFAULT_BAND;
  private trims: Partial<Record<BasePath, number>> = {};
  private latencies: Partial<Record<BasePath, number>> = {};
  private seed = "default";
  private rng: () => number = mulberry32(hashSeed(this.seed));
  private trials: TrialLogEntry[] = [];
  private current: TrialState | null = null;

  configure(config: ControllerConfig) {
    this.mode = config.mode;
    this.band = config.band;
    this.trims = { ...config.trims };
    this.latencies = { ...config.latencies };
    if (config.seed !== this.seed) {
      this.seed = config.seed;
      this.rng = mulberry32(hashSeed(this.seed));
    }
    this.trials = [];
    this.current = this.createTrial(0);
  }

  reset() {
    this.trials = [];
    this.current = this.createTrial(0);
  }

  getMode(): BlindTestMode {
    return this.mode;
  }

  getCurrentTrial(): TrialState | null {
    return this.current;
  }

  reveal(): BasePath | null {
    if (!this.current) return null;
    this.current.revealed = true;
    return this.current.actual;
  }

  makeChoice(choice: BasePath): { correct: boolean; actual: BasePath } | null {
    if (!this.current) return null;
    const actual = this.current.actual;
    const correct = choice === actual;
    const entry: TrialLogEntry = {
      index: this.current.index,
      mode: this.mode,
      actual,
      guess: choice,
      correct,
      timestamp: Date.now(),
      band: this.band,
      trims: { ...this.trims },
      latencies: { ...this.latencies },
      seed: this.seed,
    };
    this.trials.push(entry);
    this.current.guess = choice;
    this.current.revealed = true;
    return { correct, actual };
  }

  nextTrial() {
    const nextIndex = (this.current?.index ?? 0) + 1;
    this.current = this.createTrial(nextIndex);
  }

  getStatistics() {
    const total = this.trials.length;
    const correct = this.trials.filter((t) => t.correct).length;
    const p0 = this.mode === "ABCX" ? THREE_WAY_P0 : PAIRWISE_P0;
    const pValue = computeBinomialPValue(total, correct, p0);
    return { total, correct, pValue };
  }

  getLog(): TrialLogEntry[] {
    return [...this.trials];
  }

  private createTrial(index: number): TrialState {
    const candidates = this.getCandidatePaths();
    const actual = candidates[Math.floor(this.rng() * candidates.length)] ?? "A";
    return {
      index,
      actual,
      guess: null,
      revealed: false,
    };
  }

  private getCandidatePaths(): BasePath[] {
    switch (this.mode) {
      case "ABX":
        return ["A", "B"];
      case "ACX":
        return ["A", "C"];
      case "BCX":
        return ["B", "C"];
      case "ABCX":
      default:
        return ["A", "B", "C"];
    }
  }
}

export type AbcxHook = {
  controller: ABCXController;
  configure: (config: ControllerConfig) => void;
  reset: () => void;
  reveal: () => BasePath | null;
  makeChoice: (choice: BasePath) => { correct: boolean; actual: BasePath } | null;
  nextTrial: () => void;
  trials: TrialLogEntry[];
  stats: ReturnType<ABCXController["getStatistics"]>;
  current: TrialState | null;
};

export function useAbcxController(): AbcxHook {
  const controllerRef = useRef<ABCXController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ABCXController();
  }
  const controller = controllerRef.current;
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  const configure = useCallback(
    (config: ControllerConfig) => {
      controller.configure(config);
      forceUpdate();
    },
    [controller, forceUpdate],
  );

  const reset = useCallback(() => {
    controller.reset();
    forceUpdate();
  }, [controller, forceUpdate]);

  const reveal = useCallback(() => {
    const result = controller.reveal();
    forceUpdate();
    return result;
  }, [controller, forceUpdate]);

  const makeChoice = useCallback(
    (choice: BasePath) => {
      const result = controller.makeChoice(choice);
      forceUpdate();
      return result;
    },
    [controller, forceUpdate],
  );

  const nextTrial = useCallback(() => {
    controller.nextTrial();
    forceUpdate();
  }, [controller, forceUpdate]);

  const trials = controller.getLog();
  const stats = controller.getStatistics();
  const current = controller.getCurrentTrial();

  return useMemo(
    () => ({
      controller,
      configure,
      reset,
      reveal,
      makeChoice,
      nextTrial,
      trials,
      stats,
      current,
    }),
    [controller, configure, reset, reveal, makeChoice, nextTrial, trials, stats, current],
  );
}
