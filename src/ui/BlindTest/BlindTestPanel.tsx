import { useEffect, useMemo, useState } from "react";
import StartBlindTest, { type StartFormValues } from "./StartBlindTest";
import ResultsPanel from "./ResultsPanel";
import type { CompareMode, SessionConfig, VariantId } from "./session";
import { getVariantLabel, getVariantsForMode } from "./session";
import { useBlindTestEngine, type BlindTestEngine } from "./useBlindTestEngine";

type Props = {
  musicBuffer: AudioBuffer | null;
  irABuffer: AudioBuffer | null;
  irBBuffer: AudioBuffer | null;
  musicName?: string | null;
  irAName?: string | null;
  irBName?: string | null;
  onClose: () => void;
};

type PairwiseDecision = VariantId | null;
type ConfidenceLevel = "low" | "medium" | "high";
type RankState = Partial<Record<VariantId, 1 | 2 | 3>>;
type ScoreState = Partial<Record<VariantId, number>>;

const DEFAULT_FORM: StartFormValues = {
  mode: "OAB",
  rounds: 12,
  snippetLength: 10,
  randomization: "stratified",
  seed: "",
  lufsMatch: true,
  crossfadeMs: 75,
  anonymize: true,
  ratingStyle: "rank",
  enableConfidence: false,
  fixedStartSeconds: 0,
};

const CONFIDENCE_OPTIONS: ConfidenceLevel[] = ["low", "medium", "high"];

export default function BlindTestPanel({
  musicBuffer,
  irABuffer,
  irBBuffer,
  musicName,
  irAName,
  irBName,
  onClose,
}: Props) {
  const engine = useBlindTestEngine();
  const [pairChoice, setPairChoice] = useState<PairwiseDecision>(null);
  const [confidence, setConfidence] = useState<ConfidenceLevel>("medium");
  const [rankState, setRankState] = useState<RankState>({});
  const [scoreState, setScoreState] = useState<ScoreState>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const hasMusic = Boolean(musicBuffer);
  const hasIrA = Boolean(irABuffer);
  const hasIrB = Boolean(irBBuffer);

  const modeAvailability = useMemo(
    () => ({
      OA: hasMusic && hasIrA,
      OB: hasMusic && hasIrB,
      AB: hasMusic && hasIrA && hasIrB,
      OAB: hasMusic && hasIrA && hasIrB,
    }),
    [hasIrA, hasIrB, hasMusic],
  );

  const defaultMode = useMemo(() => computeDefaultMode(modeAvailability), [modeAvailability]);
  const startDefaults = useMemo<StartFormValues>(
    () => ({
      ...DEFAULT_FORM,
      mode: defaultMode,
      ratingStyle: defaultMode === "OAB" ? DEFAULT_FORM.ratingStyle : "pairwise",
    }),
    [defaultMode],
  );

  useEffect(() => {
    if (engine.currentRound) {
      setPairChoice(null);
      setRankState({});
      setScoreState(() => {
        const defaults: ScoreState = {};
        engine.currentRound?.variantOrder.forEach((variant) => {
          defaults[variant] = 3;
        });
        return defaults;
      });
      setConfidence("medium");
      setIsSubmitting(false);
    }
  }, [engine.currentRound]);

  useEffect(() => {
    const stop = engine.stopPlayback;
    return () => {
      stop();
    };
  }, [engine.stopPlayback]);

  const handleStart = (values: StartFormValues) => {
    if (!musicBuffer) return;
    const config: SessionConfig = {
      id: cryptoUuid(),
      mode: values.mode,
      rounds: values.rounds,
      snippetLength: values.snippetLength,
      randomization: values.randomization,
      seed: values.seed,
      anonymize: values.anonymize,
      ratingStyle: values.mode === "OAB" ? values.ratingStyle : "pairwise",
      crossfadeMs: values.crossfadeMs,
      lufsMatch: values.lufsMatch,
      enableConfidence: values.enableConfidence,
      fixedStartSeconds: values.randomization === "fixed" ? values.fixedStartSeconds : undefined,
    };
    engine.start({
      config,
      music: musicBuffer,
      irA: irABuffer ?? null,
      irB: irBBuffer ?? null,
    });
  };

  const handleSubmitRound = () => {
    if (!engine.currentRound || !engine.session) return;
    if (isSubmitting) return;
    const { config } = engine.session;
    const modeVariants = getVariantsForMode(config.mode);
    if (config.ratingStyle === "pairwise" || config.mode !== "OAB") {
      if (!pairChoice) return;
      const selected = pairChoice;
      engine.submitPairwise(selected, config.enableConfidence ? confidence : undefined);
    } else if (config.ratingStyle === "rank") {
      if (!isRankComplete(rankState, modeVariants)) return;
      engine.submitRank(rankState as Record<VariantId, 1 | 2 | 3>);
    } else if (config.ratingStyle === "score") {
      if (!isScoreComplete(scoreState, modeVariants)) return;
      engine.submitScores(scoreState as Record<VariantId, number>);
    }
    setIsSubmitting(true);
    setTimeout(() => {
      engine.nextRound();
      setIsSubmitting(false);
    }, 300);
  };

  const handleExport = () => {
    const blob = engine.exportCsv();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `blind-test-${Date.now()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const roundContent =
    engine.status === "running" && engine.currentRound && engine.session ? (
      <RoundView
        roundIndex={engine.currentIndex}
        totalRounds={engine.session.rounds.length}
        round={engine.currentRound}
        config={engine.session.config}
        pairChoice={pairChoice}
        onPairChoice={setPairChoice}
        confidence={confidence}
        onConfidence={setConfidence}
        rankState={rankState}
        onRankState={setRankState}
        scoreState={scoreState}
        onScoreState={setScoreState}
        playbackStatus={engine.playbackStatus}
        onTogglePlay={engine.togglePlay}
        onSelectVariant={engine.selectVariant}
        selectedVariant={engine.selectedVariant}
        isSubmitting={isSubmitting}
        onSubmit={handleSubmitRound}
      />
    ) : null;

  return (
    <div className="blind-panel-modal">
      {engine.status === "idle" ? (
        <StartBlindTest
          modeAvailability={modeAvailability}
          defaults={startDefaults}
          onSubmit={handleStart}
          onCancel={onClose}
          musicName={musicName}
          irAName={irAName}
          irBName={irBName}
        />
      ) : null}

      {engine.status === "preparing" && (
        <div className="blind-panel-modal__status" role="status">
          Preparing audio buffers...
        </div>
      )}

      {roundContent}

      {engine.status === "complete" && engine.session && engine.summary && (
        <ResultsPanel
          summary={engine.summary}
          rounds={engine.session.rounds}
          mode={engine.session.config.mode}
          ratingStyle={engine.session.config.ratingStyle}
          canRetestAB={modeAvailability.AB ?? false}
          onRetestAB={() => {
            engine.restart();
            handleStart({ ...DEFAULT_FORM, mode: "AB", ratingStyle: "pairwise" });
          }}
          onRestart={() => {
            engine.restart();
            onClose();
          }}
          onExport={handleExport}
        />
      )}

      {engine.status === "error" && (
        <div className="blind-panel-modal__error">
          <p>Unable to prepare the blind test. {engine.error}</p>
          <button type="button" className="control-button" onClick={() => engine.restart()}>
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

type ActualRoundProps = {
  roundIndex: number;
  totalRounds: number;
  round: NonNullable<BlindTestEngine["currentRound"]>;
  config: SessionConfig;
  pairChoice: PairwiseDecision;
  onPairChoice: (value: PairwiseDecision) => void;
  confidence: ConfidenceLevel;
  onConfidence: (value: ConfidenceLevel) => void;
  rankState: RankState;
  onRankState: (state: RankState) => void;
  scoreState: ScoreState;
  onScoreState: (state: ScoreState) => void;
  playbackStatus: BlindTestEngine["playbackStatus"];
  onTogglePlay: () => Promise<void>;
  onSelectVariant: (variant: VariantId) => void;
  selectedVariant: VariantId | null;
  isSubmitting: boolean;
  onSubmit: () => void;
};

function RoundView(props: ActualRoundProps) {
  const {
    roundIndex,
    totalRounds,
    round,
    config,
    pairChoice,
    onPairChoice,
    confidence,
    onConfidence,
    rankState,
    onRankState,
    scoreState,
    onScoreState,
    playbackStatus,
    onTogglePlay,
    onSelectVariant,
    selectedVariant,
    isSubmitting,
    onSubmit,
  } = props;

  const variants = config.mode === "OAB" ? (["O", "A", "B"] as VariantId[]) : getVariantsForMode(config.mode);

  const positionMap = useMemo(
    () =>
      round.variantOrder.map((variant, idx) => ({
        variant,
        idx,
        label: config.anonymize ? `Variant ${idx + 1}` : getVariantLabel(variant),
      })),
    [config.anonymize, round.variantOrder],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === " ") {
        event.preventDefault();
        onTogglePlay().catch(() => undefined);
      } else if (event.key === "Enter") {
        event.preventDefault();
        onSubmit();
      } else if (["1", "2", "3"].includes(event.key)) {
        const idx = Number(event.key) - 1;
        const mapping = positionMap[idx];
        if (mapping) {
          onSelectVariant(mapping.variant);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onSelectVariant, onSubmit, onTogglePlay, positionMap]);

  const isTriStimulus = config.mode === "OAB";
  const isPairwise = config.ratingStyle === "pairwise" || !isTriStimulus;
  const isRank = isTriStimulus && config.ratingStyle === "rank";
  const isScore = isTriStimulus && config.ratingStyle === "score";
  const startTime = formatTime(round.startSeconds);
  const endTime = formatTime(round.endSeconds);
  const progress = ((roundIndex + 1) / totalRounds) * 100;

  const canSubmit =
    !isSubmitting &&
    ((isPairwise && Boolean(pairChoice)) ||
      (isRank && isRankComplete(rankState, variants)) ||
      (isScore && isScoreComplete(scoreState, variants)));

  return (
    <div className="blind-round">
      <header className="blind-round__header">
        <h3>
          Round {roundIndex + 1}/{totalRounds} - {startTime}-{endTime} - Seed {config.seed || "auto"}
        </h3>
        <div className="blind-round__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
          <div className="blind-round__progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </header>

      <div className="blind-round__variants">
        {positionMap.map((entry) => (
          <button
            key={entry.variant}
            type="button"
            className={`blind-round__variant${selectedVariant === entry.variant ? " is-active" : ""}`}
            onClick={() => onSelectVariant(entry.variant)}
          >
            <span className="blind-round__variant-label">{entry.label}</span>
            {!config.anonymize && <span className="blind-round__variant-sub">{getVariantLabel(entry.variant)}</span>}
          </button>
        ))}
      </div>

      <div className="blind-round__controls">
        <button
          type="button"
          className="control-button blind-round__play"
          onClick={() => {
            void onTogglePlay();
          }}
        >
          {playbackStatus === "playing" ? "Pause (Space)" : "Play (Space)"}
        </button>
        {isPairwise && (
          <div className="blind-round__choices">
            {positionMap.map((entry) => (
              <label key={entry.variant} className={`blind-round__choice${pairChoice === entry.variant ? " is-selected" : ""}`}>
                <input
                  type="radio"
                  name="pair-choice"
                  value={entry.variant}
                  checked={pairChoice === entry.variant}
                  onChange={() => onPairChoice(entry.variant)}
                />
                <span>Prefer {entry.label}</span>
              </label>
            ))}
          </div>
        )}

        {isRank && (
          <div className="blind-round__rank">
            {positionMap.map((entry) => (
              <label key={entry.variant}>
                <span>{entry.label}</span>
                <select
                  value={rankState[entry.variant] ?? ""}
                  onChange={(event) =>
                    {
                      const parsed = parseInt(event.target.value, 10);
                      const next: RankState = { ...rankState };
                      if (Number.isNaN(parsed)) {
                        delete next[entry.variant];
                      } else {
                        next[entry.variant] = parsed as 1 | 2 | 3;
                      }
                      onRankState(next);
                    }
                  }
                >
                  <option value="">Rank...</option>
                  {[1, 2, 3].map((rank) => (
                    <option key={rank} value={rank} disabled={Object.values(rankState).includes(rank as 1 | 2 | 3) && rankState[entry.variant] !== rank}>
                      {rank}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}

        {isScore && (
          <div className="blind-round__scores">
            {positionMap.map((entry) => (
              <label key={entry.variant}>
                <span>{entry.label}</span>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={scoreState[entry.variant] ?? 3}
                  onChange={(event) =>
                    onScoreState({
                      ...scoreState,
                      [entry.variant]: parseInt(event.target.value, 10),
                    })
                  }
                />
                <span className="blind-round__score-value">{scoreState[entry.variant] ?? 3}</span>
              </label>
            ))}
          </div>
        )}

        {config.enableConfidence && isPairwise && (
          <div className="blind-round__confidence">
            {CONFIDENCE_OPTIONS.map((option) => (
              <label key={option} className={`blind-round__confidence-option${confidence === option ? " is-selected" : ""}`}>
                <input
                  type="radio"
                  name="confidence"
                  value={option}
                  checked={confidence === option}
                  onChange={() => onConfidence(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        )}

        <button type="button" className="control-button blind-round__submit" onClick={onSubmit} disabled={!canSubmit}>
          Submit (Enter)
        </button>
      </div>
    </div>
  );
}

function isRankComplete(state: RankState, variants: VariantId[]): boolean {
  const values = variants.map((variant) => state[variant]);
  if (values.some((value) => value == null)) return false;
  const unique = new Set(values);
  return unique.size === variants.length;
}

function isScoreComplete(state: ScoreState, variants: VariantId[]): boolean {
  return variants.every((variant) => {
    const value = state[variant];
    return typeof value === "number" && value >= 1 && value <= 5;
  });
}

function computeDefaultMode(availability: Partial<Record<CompareMode, boolean>>): CompareMode {
  if (availability.OAB) return "OAB";
  if (availability.OA) return "OA";
  if (availability.OB) return "OB";
  return "AB";
}

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return "0:00";
  const clamped = Math.max(0, value);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60) 
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function cryptoUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
