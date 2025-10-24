import { extractSnippet, getConvolvedBuffer } from "../../audio/convolution";
import { accumulateRms, deriveMatchGains, linearToDb, dbToLinear } from "../../audio/loudness";
import type { LoudnessGainMap } from "../../audio/loudness";
import type { SessionRound, VariantId } from "./session";

export type VariantLibrary = Partial<Record<VariantId, AudioBuffer>>;

export type SnippetAssets = {
  buffers: Partial<Record<VariantId, AudioBuffer>>;
  gains: LoudnessGainMap;
  gainsDb: Partial<Record<VariantId, number>>;
  loudnessDb: Partial<Record<VariantId, number>>;
  adjustedLoudnessDb: Partial<Record<VariantId, number>>;
  withinTolerance: boolean;
};

const LOUDNESS_TOLERANCE_DB = 0.2;

export async function buildVariantLibrary(
  original: AudioBuffer,
  irA?: AudioBuffer | null,
  irB?: AudioBuffer | null,
): Promise<VariantLibrary> {
  const library: VariantLibrary = { O: original };
  if (irA) {
    library.A = await getConvolvedBuffer(original, irA);
  }
  if (irB) {
    library.B = await getConvolvedBuffer(original, irB);
  }
  return library;
}

export function createSnippetAssets(
  library: VariantLibrary,
  round: SessionRound,
  snippetLength: number,
  matchLoudness: boolean,
): SnippetAssets {
  const buffers: Partial<Record<VariantId, AudioBuffer>> = {};
  const loudnessDb: Partial<Record<VariantId, number>> = {};
  const gains: LoudnessGainMap = {};
  const gainsDb: Partial<Record<VariantId, number>> = {};
  const adjustedLoudnessDb: Partial<Record<VariantId, number>> = {};
  const durationSeconds = Math.max(0.001, Math.min(snippetLength, round.endSeconds - round.startSeconds));

  round.variantOrder.forEach((variant) => {
    const buffer = library[variant];
    if (!buffer) return;
    buffers[variant] = extractSnippet(buffer, round.startSeconds, durationSeconds);
    const { rmsDb } = accumulateRms(buffers[variant]!);
    loudnessDb[variant] = rmsDb;
  });

  if (matchLoudness) {
    const { gains: matchGains } = deriveMatchGains(loudnessDb);
    round.variantOrder.forEach((variant) => {
      gains[variant] = matchGains[variant] ?? 1;
      gainsDb[variant] = linearToDb(gains[variant]!);
      const level = loudnessDb[variant] ?? Number.NEGATIVE_INFINITY;
      adjustedLoudnessDb[variant] = level + gainsDb[variant]!;
    });
  } else {
    round.variantOrder.forEach((variant) => {
      gains[variant] = 1;
      gainsDb[variant] = 0;
      adjustedLoudnessDb[variant] = loudnessDb[variant];
    });
  }

  const withinTolerance = checkTolerance(adjustedLoudnessDb);

  // If tolerance not met, re-balance by forcing average target
  if (matchLoudness && !withinTolerance) {
    const levels: Record<string, number> = {};
    round.variantOrder.forEach((variant) => {
      levels[variant] = loudnessDb[variant] ?? 0;
    });
    const { targetDb } = deriveMatchGains(levels);
    round.variantOrder.forEach((variant) => {
      const base = loudnessDb[variant] ?? targetDb;
      const gainDb = targetDb - base;
      const gainLinear = dbToLinear(gainDb);
      gains[variant] = gainLinear;
      gainsDb[variant] = gainDb;
      adjustedLoudnessDb[variant] = base + gainDb;
    });
  }

  return {
    buffers,
    gains,
    gainsDb,
    loudnessDb,
    adjustedLoudnessDb,
    withinTolerance: checkTolerance(adjustedLoudnessDb),
  };
}

function checkTolerance(levels: Partial<Record<VariantId, number>>): boolean {
  const values = Object.values(levels).filter((value) => Number.isFinite(value));
  if (values.length <= 1) return true;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return Math.abs(max - min) <= LOUDNESS_TOLERANCE_DB;
}
