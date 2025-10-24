import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCsvBlob, type CsvRow } from "../../lib/csv";
import { deriveSeed } from "../../lib/rng";
import {
  assignRoundRating,
  computeSessionSummary,
  createSession,
  type ConfidenceLevel,
  type PairwiseChoice,
  type SessionConfig,
  type SessionRound,
  type SessionState,
  type SessionSummary,
  type VariantId,
  type RoundRating,
} from "./session";
import { BlindTestPlayback, type PlaybackStatus } from "./playback";
import { buildVariantLibrary, createSnippetAssets, type SnippetAssets, type VariantLibrary } from "./snippet";

export type EngineStatus = "idle" | "preparing" | "ready" | "running" | "complete" | "error";

type StartParams = {
  config: SessionConfig;
  music: AudioBuffer;
  irA?: AudioBuffer | null;
  irB?: AudioBuffer | null;
};

type RankInput = Record<VariantId, 1 | 2 | 3>;
type ScoreInput = Record<VariantId, number>;

export type BlindTestEngine = {
  status: EngineStatus;
  error: string | null;
  session: SessionState | null;
  currentRound: SessionRound | null;
  currentIndex: number;
  selectedVariant: VariantId | null;
  playbackStatus: PlaybackStatus;
  assets: SnippetAssets | null;
  summary: SessionSummary | null;
  isPreparing: boolean;
  start: (params: StartParams) => Promise<void>;
  selectVariant: (variant: VariantId) => void;
  togglePlay: () => Promise<void>;
  stopPlayback: () => void;
  submitPairwise: (choice: PairwiseChoice, confidence?: ConfidenceLevel) => void;
  submitRank: (ranking: RankInput) => void;
  submitScores: (scores: ScoreInput) => void;
  nextRound: () => Promise<void>;
  restart: () => void;
  endEarly: () => void;
  exportCsv: () => Blob | null;
};

const MIN_VOLUME_DB = -50;

function volumeSliderToGain(value: number): number {
  if (value <= 0) return 0;
  const db = MIN_VOLUME_DB * (1 - value);
  return Math.pow(10, db / 20);
}

export function useBlindTestEngine(): BlindTestEngine {

  const [status, setStatus] = useState<EngineStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [selectedVariant, setSelectedVariant] = useState<VariantId | null>(null);
  const [assets, setAssets] = useState<SnippetAssets | null>(null);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>("idle");
  const [volume, setVolume] = useState<number>(1);

  const playbackRef = useRef<BlindTestPlayback | null>(null);
  const libraryRef = useRef<VariantLibrary | null>(null);
  const configRef = useRef<SessionConfig | null>(null);
  const musicRef = useRef<AudioBuffer | null>(null);
  const sessionRef = useRef<SessionState | null>(null);
  const volumeRef = useRef<number>(1);

  const updateSession = useCallback(
    (
      value:
        | SessionState
        | null
        | ((previous: SessionState | null) => SessionState | null),
    ) => {
      setSession((prev) => {
        const next =
          typeof value === "function" ? (value as (previous: SessionState | null) => SessionState | null)(prev) : value;
        sessionRef.current = next;
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    return () => {
      playbackRef.current?.dispose();
    };
  }, []);

  const getPlayback = useCallback(() => {
    if (!playbackRef.current) {
      playbackRef.current = new BlindTestPlayback({
        onEnded: () => {
          setPlaybackStatus("ended");
        },
      });
      playbackRef.current.setVolume(volumeSliderToGain(volumeRef.current));
    }
    return playbackRef.current;
  }, []);

  const prepareRound = useCallback(
    async (roundIndex: number) => {
      const currentSession = sessionRef.current;
      const library = libraryRef.current;
      const config = configRef.current;
      if (!currentSession || !library || !config) return null;
      const round = currentSession.rounds[roundIndex];
      if (!round) return null;
      const snippet = createSnippetAssets(library, round, config.snippetLength, config.lufsMatch);
      setAssets(snippet);
      const updatedRound: SessionRound = {
        ...round,
        gainsDb: snippet.gainsDb,
        loudnessDb: snippet.loudnessDb,
        adjustedLoudnessDb: snippet.adjustedLoudnessDb,
      };
      updateSession((prev) =>
        prev
          ? {
              ...prev,
              rounds: prev.rounds.map((existing) => (existing.index === roundIndex ? updatedRound : existing)),
            }
         : prev,
      );

      const playback = getPlayback();
      playback.setCrossfadeMs(config.crossfadeMs);
      playback.prepare(snippet.buffers, snippet.gains);
      setPlaybackStatus(playback.getStatus());
      const availableVariants = (Object.entries(snippet.buffers) as [VariantId, AudioBuffer | undefined][])
        .filter(([, buffer]) => Boolean(buffer))
        .map(([variant]) => variant);
      const initialVariant =
        round.variantOrder.find((variant) => availableVariants.includes(variant)) ??
        availableVariants[0] ??
        null;
      if (initialVariant) {
        playback.setActiveVariant(initialVariant, true);
        setSelectedVariant(initialVariant);
      } else {
        setSelectedVariant(null);
      }
      return snippet;
    },
    [getPlayback, updateSession],
  );

  const start = useCallback(
    async ({ config, music, irA, irB }: StartParams) => {
      setStatus("preparing");
      setError(null);
      setSummary(null);
      updateSession(null);
      volumeRef.current = 1;
      setVolume(1);
      playbackRef.current?.setVolume(volumeSliderToGain(1));
      setAssets(null);
      setSelectedVariant(null);
      setCurrentIndex(0);
      setPlaybackStatus("idle");
      playbackRef.current?.stop();
      playbackRef.current?.dispose();
      playbackRef.current = null;
      musicRef.current = music;
      configRef.current = { ...config, seed: config.seed || deriveSeed() };
      try {
        const library = await buildVariantLibrary(music, irA ?? null, irB ?? null);
        libraryRef.current = library;
        const nextSession = createSession(configRef.current, music.duration);
        updateSession(nextSession);
        setStatus("running");
        await prepareRound(0);
        setCurrentIndex(0);
        setPlaybackStatus("ready");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus("error");
        setError(message);
      }
    },
    [prepareRound, updateSession],
  );

  const selectVariant = useCallback(
    (variant: VariantId) => {
      setSelectedVariant(variant);
      playbackRef.current?.setActiveVariant(variant);
    },
    [],
  );

  const togglePlay = useCallback(async () => {
    const playback = getPlayback();
    if (playback.getStatus() === "playing") {
      playback.pause();
      setPlaybackStatus("ready");
    } else {
      await playback.play(selectedVariant);
      setPlaybackStatus("playing");
    }
  }, [getPlayback, selectedVariant]);

  const updateVolume = useCallback(
    (value: number) => {
      const clamped = Math.min(Math.max(value, 0), 1);
      volumeRef.current = clamped;
      setVolume(clamped);
      playbackRef.current?.setVolume(volumeSliderToGain(clamped));
    },
    [],
  );

  const stopPlayback = useCallback(() => {
    playbackRef.current?.stop();
    setPlaybackStatus("idle");
  }, []);

  const submitRating = useCallback(
    (rating: RoundRating) => {
      const currentSession = sessionRef.current;
      if (!currentSession) return;
      const next = assignRoundRating(currentSession, currentIndex, rating);
      updateSession(next);
    },
    [currentIndex, updateSession],
  );

  const submitPairwise = useCallback(
    (choice: PairwiseChoice, confidence?: ConfidenceLevel) => {
      submitRating({
        type: "pairwise",
        choice,
        confidence,
      });
    },
    [submitRating],
  );

  const submitRank = useCallback(
    (ranking: RankInput) => {
      submitRating({
        type: "rank",
        ranking,
      });
    },
    [submitRating],
  );

  const submitScores = useCallback(
    (scores: ScoreInput) => {
      submitRating({
        type: "score",
        scores,
      });
    },
    [submitRating],
  );

  const advanceSummary = useCallback(
    (nextSession: SessionState) => {
      const report = computeSessionSummary(nextSession);
      setSummary(report);
      setStatus("complete");
      stopPlayback();
    },
    [stopPlayback],
  );

  const endEarly = useCallback(() => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    stopPlayback();
    const report = computeSessionSummary(currentSession);
    setSummary(report);
    setStatus("complete");
  }, [stopPlayback]);

  const nextRound = useCallback(async () => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= currentSession.rounds.length) {
      advanceSummary(currentSession);
      return;
    }
    setCurrentIndex(nextIndex);
    stopPlayback();
    await prepareRound(nextIndex);
    setStatus("running");
  }, [advanceSummary, currentIndex, prepareRound, stopPlayback]);

  const restart = useCallback(() => {
    setStatus("idle");
    setError(null);
    updateSession(null);
    setAssets(null);
    setSummary(null);
    setSelectedVariant(null);
    setCurrentIndex(0);
    setPlaybackStatus("idle");
    volumeRef.current = 1;
    setVolume(1);
    playbackRef.current?.stop();
    playbackRef.current?.setVolume(volumeSliderToGain(1));
  }, [updateSession]);

  const exportCsv = useCallback((): Blob | null => {
    if (!session || !configRef.current) return null;
    const columns = [
      "round",
      "start",
      "end",
      "mode",
      "rating_style",
      "choice",
      "confidence",
      "rank_O",
      "rank_A",
      "rank_B",
      "score_O",
      "score_A",
      "score_B",
      "variant_order",
      "seed",
      "lufs_match",
      "crossfade_ms",
      "anonymize",
      "gains_db_O",
      "gains_db_A",
      "gains_db_B",
    ];
    const rows: CsvRow[] = session.rounds.map((round) => {
      const rating = round.rating;
      return {
        round: round.index + 1,
        start: round.startSeconds.toFixed(3),
        end: round.endSeconds.toFixed(3),
        mode: configRef.current?.mode ?? "",
        rating_style: configRef.current?.ratingStyle ?? "",
        choice: rating && rating.type === "pairwise" ? rating.choice : "",
        confidence: rating && rating.type === "pairwise" ? rating.confidence ?? "" : "",
        rank_O: rating && rating.type === "rank" ? rating.ranking.O ?? "" : "",
        rank_A: rating && rating.type === "rank" ? rating.ranking.A ?? "" : "",
        rank_B: rating && rating.type === "rank" ? rating.ranking.B ?? "" : "",
        score_O: rating && rating.type === "score" ? rating.scores.O ?? "" : "",
        score_A: rating && rating.type === "score" ? rating.scores.A ?? "" : "",
        score_B: rating && rating.type === "score" ? rating.scores.B ?? "" : "",
        variant_order: round.variantOrder.join(">"),
        seed: configRef.current?.seed ?? "",
        lufs_match: configRef.current?.lufsMatch ? "yes" : "no",
        crossfade_ms: configRef.current?.crossfadeMs ?? 0,
        anonymize: configRef.current?.anonymize ? "yes" : "no",
        gains_db_O: round.gainsDb?.O ?? "",
        gains_db_A: round.gainsDb?.A ?? "",
        gains_db_B: round.gainsDb?.B ?? "",
      };
    });
    return buildCsvBlob(columns, rows);
  }, [session]);

  const currentRound = useMemo(() => {
    if (!session) return null;
    return session.rounds[currentIndex] ?? null;
  }, [currentIndex, session]);

  const isPreparing = status === "preparing";

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleModalClose = () => {
      const playback = playbackRef.current;
      if (!playback) return;
      const status = playback.getStatus();
      if (status === "playing" || status === "ready") {
        playback.stop();
        const nextGain = volumeSliderToGain(volumeRef.current);
        playback.setVolume(nextGain);
      }
    };

    document.addEventListener("visibilitychange", handleModalClose);
    return () => {
      document.removeEventListener("visibilitychange", handleModalClose);
    };
  }, []);

  return {
    status,
    error,
    session,
    currentRound,
    currentIndex,
    selectedVariant,
    playbackStatus,
    assets,
    summary,
    isPreparing,
    start,
    selectVariant,
    togglePlay,
    stopPlayback,
    volume,
    updateVolume,
    endEarly,
    submitPairwise,
    submitRank,
    submitScores,
    nextRound,
    restart,
    exportCsv,
  };
}
