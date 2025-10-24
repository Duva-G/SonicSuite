import { extractSnippet, getConvolvedBuffer } from "../../audio/convolution";
import { accumulateRms, deriveMatchGains, linearToDb, dbToLinear } from "../../audio/loudness";
import type { LoudnessGainMap } from "../../audio/loudness";
import type { SessionRound, VariantId } from "./session";

export type VariantLibrary = Partial<Record<VariantId, AudioBuffer>>;

export const SILENCE_RMS_THRESHOLD_DB = -120;
const PRACTICAL_SILENCE_DB = -70;
const PRACTICAL_SILENCE_RETRY_LIMIT = 6;

export type SnippetAssets = {
  buffers: Partial<Record<VariantId, AudioBuffer>>;
  gains: LoudnessGainMap;
  gainsDb: Partial<Record<VariantId, number>>;
  loudnessDb: Partial<Record<VariantId, number>>;
  adjustedLoudnessDb: Partial<Record<VariantId, number>>;
  withinTolerance: boolean;
  startSeconds: number;
  durationSeconds: number;
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
  const referenceBuffer = library.O ?? library[round.variantOrder[0] as VariantId] ?? null;
  const trackDuration = referenceBuffer?.duration ?? Math.max(round.endSeconds, snippetLength);
  const maxDuration = Math.max(0.001, Math.min(snippetLength, trackDuration));
  const usableDuration = referenceBuffer ? Math.min(getUsableDuration(referenceBuffer), trackDuration) : trackDuration;
  const maxStartSeconds = Math.max(0, usableDuration - maxDuration);
  let effectiveStartSeconds = clampSeconds(round.startSeconds, 0, maxStartSeconds);
  let effectiveDuration = Math.max(0.001, Math.min(maxDuration, usableDuration - effectiveStartSeconds || maxDuration));

  const populateSnippets = (startSeconds: number, durationSeconds: number) => {
    round.variantOrder.forEach((variant) => {
      const buffer = library[variant];
      if (!buffer) return;
      const snippet = extractSnippet(buffer, startSeconds, durationSeconds);
      buffers[variant] = snippet;
      const { rmsDb } = accumulateRms(snippet);
      loudnessDb[variant] = rmsDb;
    });
  };

  const clearSnippets = () => {
    round.variantOrder.forEach((variant) => {
      delete buffers[variant];
      delete loudnessDb[variant];
    });
  };

  const getMaxMeasuredDb = () => {
    let maxDb = Number.NEGATIVE_INFINITY;
    round.variantOrder.forEach((variant) => {
      const level = loudnessDb[variant];
      if (typeof level === "number" && Number.isFinite(level)) {
        maxDb = Math.max(maxDb, level);
      }
    });
    return maxDb;
  };

  populateSnippets(effectiveStartSeconds, effectiveDuration);

  let maxMeasuredDb = getMaxMeasuredDb();
  let bestMaxMeasuredDb = maxMeasuredDb;
  let bestStartSeconds = effectiveStartSeconds;
  let bestDurationSeconds = effectiveDuration;
  let retryAttempts = 0;

  if (maxMeasuredDb < PRACTICAL_SILENCE_DB && maxStartSeconds > 0) {
    let foundPracticalSnippet = false;
    for (let attempt = 0; attempt < PRACTICAL_SILENCE_RETRY_LIMIT; attempt += 1) {
      retryAttempts = attempt + 1;
      const tryStartSeconds = clampSeconds(Math.random() * maxStartSeconds, 0, maxStartSeconds);
      const tryDuration = Math.max(0.001, Math.min(maxDuration, usableDuration - tryStartSeconds || maxDuration));
      clearSnippets();
      populateSnippets(tryStartSeconds, tryDuration);
      const attemptMaxDb = getMaxMeasuredDb();
      if (attemptMaxDb > bestMaxMeasuredDb) {
        bestMaxMeasuredDb = attemptMaxDb;
        bestStartSeconds = tryStartSeconds;
        bestDurationSeconds = tryDuration;
      }
      if (attemptMaxDb >= PRACTICAL_SILENCE_DB) {
        maxMeasuredDb = attemptMaxDb;
        effectiveStartSeconds = tryStartSeconds;
        effectiveDuration = tryDuration;
        foundPracticalSnippet = true;
        break;
      }
      maxMeasuredDb = attemptMaxDb;
    }

    if (!foundPracticalSnippet) {
      effectiveStartSeconds = bestStartSeconds;
      effectiveDuration = bestDurationSeconds;
      clearSnippets();
      populateSnippets(effectiveStartSeconds, effectiveDuration);
      maxMeasuredDb = bestMaxMeasuredDb;
    }
  }

  const allSilent = round.variantOrder.every((variant) => {
    const level = loudnessDb[variant];
    return level == null || !Number.isFinite(level) || level <= SILENCE_RMS_THRESHOLD_DB;
  });

  const shouldFallback = allSilent || maxMeasuredDb < PRACTICAL_SILENCE_DB;

  if (shouldFallback) {
    const fallbackMaxDb = maxMeasuredDb;
    clearSnippets();
    effectiveStartSeconds = 0;
    effectiveDuration = maxDuration;
    populateSnippets(effectiveStartSeconds, effectiveDuration);
    if (import.meta.env.DEV) {
      console.info("[blind-test] snippet fallback", {
        round: round.index,
        reason: allSilent ? "all-silent" : "too-quiet",
        attempts: retryAttempts,
        lastMaxDb: Number.isFinite(fallbackMaxDb) ? fallbackMaxDb : null,
      });
    }
    maxMeasuredDb = getMaxMeasuredDb();
  }

  const representative = buffers[round.variantOrder[0] as VariantId] ?? buffers.O ?? buffers.A ?? buffers.B ?? null;
  const snippetDuration = representative?.duration ?? effectiveDuration;

  if (import.meta.env.DEV) {
    console.info("[blind-test] snippet", {
      round: round.index,
      originalStart: round.startSeconds.toFixed(3),
      effectiveStart: effectiveStartSeconds.toFixed(3),
      duration: snippetDuration.toFixed(3),
      loudnessDb,
      maxMeasuredDb: Number.isFinite(maxMeasuredDb) ? maxMeasuredDb : null,
      bestMaxMeasuredDb: Number.isFinite(bestMaxMeasuredDb) ? bestMaxMeasuredDb : null,
      retries: retryAttempts,
    });
  }

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
    withinTolerance,
    startSeconds: effectiveStartSeconds,
    durationSeconds: snippetDuration,
  };
}

function clampSeconds(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function checkTolerance(levels: Partial<Record<VariantId, number>>): boolean {
  const values = Object.values(levels).filter((value) => Number.isFinite(value));
  if (values.length <= 1) return true;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return Math.abs(max - min) <= LOUDNESS_TOLERANCE_DB;
}

const DEFAULT_SILENCE_THRESHOLD = 1e-4;

function getUsableDuration(buffer: AudioBuffer, threshold = DEFAULT_SILENCE_THRESHOLD): number {
  const sampleRate = buffer.sampleRate || 44100;
  const length = buffer.length;
  let lastNonSilent = -1;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = length - 1; index >= 0; index -= 1) {
      if (Math.abs(data[index]) > threshold) {
        if (index > lastNonSilent) {
          lastNonSilent = index;
        }
        break;
      }
    }
  }
  if (lastNonSilent < 0) {
    return buffer.duration;
  }
  const marginFrames = Math.floor(sampleRate * 0.05);
  const usableFrames = Math.min(length, lastNonSilent + 1 + marginFrames);
  return usableFrames / sampleRate;
}
