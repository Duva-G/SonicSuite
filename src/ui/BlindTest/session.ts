import { createRng, shuffled } from "../../lib/rng";

export type VariantId = "O" | "A" | "B";

export type CompareMode = "OA" | "OB" | "AB" | "OAB";

export type RandomizationMode = "stratified" | "random" | "fixed";

export type RatingStyle = "pairwise" | "rank" | "score";

export type PairwiseChoice = VariantId;

export type ConfidenceLevel = "low" | "medium" | "high";

export type RoundRating =
  | {
      type: "pairwise";
      choice: PairwiseChoice;
      confidence?: ConfidenceLevel;
    }
  | {
      type: "rank";
      ranking: Record<VariantId, 1 | 2 | 3>;
    }
  | {
      type: "score";
      scores: Record<VariantId, number>;
    };

export type SessionConfig = {
  id: string;
  mode: CompareMode;
  rounds: number;
  snippetLength: number;
  randomization: RandomizationMode;
  seed: string;
  anonymize: boolean;
  ratingStyle: RatingStyle;
  crossfadeMs: number;
  lufsMatch: boolean;
  enableConfidence: boolean;
  fixedStartSeconds?: number;
};

export type VariantGains = Partial<Record<VariantId, number>>;

export type RoundResult = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  variantOrder: VariantId[];
  rating?: RoundRating;
  gainsDb?: Partial<Record<VariantId, number>>;
  loudnessDb?: Partial<Record<VariantId, number>>;
  adjustedLoudnessDb?: Partial<Record<VariantId, number>>;
};

export type SessionRound = RoundResult;

export type SessionState = {
  config: SessionConfig;
  rounds: SessionRound[];
};

export type SessionSummary = {
  preferred?: VariantId;
  leastPreferred?: VariantId;
  winsByVariant: Partial<Record<VariantId, number>>;
  lossesByVariant: Partial<Record<VariantId, number>>;
  meansByVariant: Partial<Record<VariantId, number>>;
};

const MODE_VARIANTS: Record<CompareMode, VariantId[]> = {
  OA: ["O", "A"],
  OB: ["O", "B"],
  AB: ["A", "B"],
  OAB: ["O", "A", "B"],
};

const VARIANT_LABEL: Record<VariantId, string> = {
  O: "Original",
  A: "IR A",
  B: "IR B",
};

export function getVariantsForMode(mode: CompareMode): VariantId[] {
  return MODE_VARIANTS[mode] ?? ["O", "A"];
}

export function getVariantLabel(id: VariantId): string {
  return VARIANT_LABEL[id] ?? id;
}

export function createSessionRounds(
  config: SessionConfig,
  trackDuration: number,
): SessionRound[] {
  const variants = getVariantsForMode(config.mode);
  const snippetLength = Math.max(1, config.snippetLength);
  const safeDuration = Math.max(snippetLength, trackDuration);
  const maxStart = Math.max(0, safeDuration - snippetLength);
  const rng = createRng(`${config.seed}:snippets`);
  const variantRng = createRng(`${config.seed}:order`);
  const starts = generateStartTimes(
    config.randomization,
    config.rounds,
    snippetLength,
    safeDuration,
    maxStart,
    rng,
    config.fixedStartSeconds,
  );

  return starts.map((startSeconds, index) => ({
    index,
    startSeconds,
    endSeconds: Math.min(startSeconds + snippetLength, safeDuration),
    variantOrder: variants.length > 1 ? shuffled(variants, variantRng) : [...variants],
  }));
}

function generateStartTimes(
  mode: RandomizationMode,
  rounds: number,
  snippetLength: number,
  trackDuration: number,
  maxStart: number,
  rng: () => number,
  fixedStartSeconds?: number,
): number[] {
  switch (mode) {
    case "fixed": {
      const clampedStart = clamp(Math.max(0, fixedStartSeconds ?? 0), 0, maxStart);
      return Array.from({ length: rounds }, () => clampedStart);
    }
    case "stratified":
      return generateStratifiedStarts(rounds, snippetLength, trackDuration, maxStart, rng);
    case "random":
    default:
      return generateRandomStarts(rounds, maxStart, rng);
  }
}

function generateRandomStarts(rounds: number, maxStart: number, rng: () => number): number[] {
  if (maxStart <= 0) return Array.from({ length: rounds }, () => 0);
  return Array.from({ length: rounds }, () => rng() * maxStart);
}

function generateStratifiedStarts(
  rounds: number,
  snippetLength: number,
  trackDuration: number,
  maxStart: number,
  rng: () => number,
): number[] {
  if (trackDuration <= snippetLength) {
    return Array.from({ length: rounds }, () => 0);
  }
  const sectionCount = Math.max(1, Math.min(rounds, Math.floor(trackDuration / snippetLength)));
  const sectionLength = trackDuration / sectionCount;
  const sectionIndices = Array.from({ length: sectionCount }, (_, idx) => idx);
  const queue: number[] = [];
  const starts: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    if (queue.length === 0) {
      const shuffledSections = shuffled(sectionIndices, rng);
      queue.push(...shuffledSections);
    }
    const section = queue.shift() ?? 0;
    const sectionStart = section * sectionLength;
    const sectionEnd = Math.min(sectionStart + sectionLength, trackDuration);
    const available = Math.max(0, sectionEnd - sectionStart - snippetLength);
    const offset = available > 0 ? rng() * available : 0;
    const start = clamp(sectionStart + offset, 0, maxStart);
    starts.push(start);
  }
  return starts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createSession(config: SessionConfig, trackDuration: number): SessionState {
  return {
    config,
    rounds: createSessionRounds(config, trackDuration),
  };
}

export function assignRoundRating(state: SessionState, index: number, rating: RoundRating): SessionState {
  if (index < 0 || index >= state.rounds.length) return state;
  const nextRounds = state.rounds.map((round) =>
    round.index === index
      ? {
          ...round,
          rating,
        }
      : round,
  );
  return { ...state, rounds: nextRounds };
}

export function computeSessionSummary(state: SessionState): SessionSummary {
  const variants = getVariantsForMode(state.config.mode);
  const wins: Partial<Record<VariantId, number>> = {};
  const losses: Partial<Record<VariantId, number>> = {};
  const scoreTotals: Partial<Record<VariantId, number>> = {};
  const scoreCounts: Partial<Record<VariantId, number>> = {};

  state.rounds.forEach((round) => {
    if (!round.rating) return;
    if (round.rating.type === "pairwise") {
      const choice = round.rating.choice;
      wins[choice] = (wins[choice] ?? 0) + 1;
      variants.forEach((variant) => {
        if (variant !== choice) {
          losses[variant] = (losses[variant] ?? 0) + 1;
        }
      });
    } else if (round.rating.type === "rank") {
      Object.entries(round.rating.ranking).forEach(([key, rank]) => {
        scoreTotals[key as VariantId] = (scoreTotals[key as VariantId] ?? 0) + (4 - rank);
        scoreCounts[key as VariantId] = (scoreCounts[key as VariantId] ?? 0) + 1;
      });
    } else if (round.rating.type === "score") {
      Object.entries(round.rating.scores).forEach(([key, score]) => {
        scoreTotals[key as VariantId] = (scoreTotals[key as VariantId] ?? 0) + score;
        scoreCounts[key as VariantId] = (scoreCounts[key as VariantId] ?? 0) + 1;
      });
    }
  });

  const means: Partial<Record<VariantId, number>> = {};
  Object.entries(scoreTotals).forEach(([key, total]) => {
    const variant = key as VariantId;
    const count = scoreCounts[variant] ?? 0;
    if (count > 0) {
      means[variant] = total / count;
    }
  });

  let preferred: VariantId | undefined;
  let leastPreferred: VariantId | undefined;

  if (state.config.ratingStyle === "pairwise") {
    const bestWinRate = getHighestVariant(wins, variants);
    const worstWinRate = getLowestVariant(wins, variants);
    preferred = bestWinRate;
    leastPreferred = worstWinRate;
  } else {
    const bestMean = getHighestVariant(means, variants);
    const worstMean = getLowestVariant(means, variants);
    preferred = bestMean;
    leastPreferred = worstMean;
  }

  return {
    preferred,
    leastPreferred,
    winsByVariant: wins,
    lossesByVariant: losses,
    meansByVariant: means,
  };
}

function getHighestVariant(
  metric: Partial<Record<VariantId, number>>,
  variants: VariantId[],
): VariantId | undefined {
  let best: VariantId | undefined;
  let bestValue = -Infinity;
  variants.forEach((variant) => {
    const value = metric[variant] ?? 0;
    if (value > bestValue) {
      bestValue = value;
      best = variant;
    }
  });
  return best;
}

function getLowestVariant(
  metric: Partial<Record<VariantId, number>>,
  variants: VariantId[],
): VariantId | undefined {
  let worst: VariantId | undefined;
  let worstValue = Infinity;
  variants.forEach((variant) => {
    const value = metric[variant] ?? 0;
    if (value < worstValue) {
      worstValue = value;
      worst = variant;
    }
  });
  return worst;
}
