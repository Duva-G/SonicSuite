import { useEffect, useMemo, useRef, useState, useId } from "react";
import type { BlindTestMode, BasePath, TrialLogEntry } from "../audio/ABCXController";

type AuditionTarget = "A" | "B" | "C" | "X";

type Stats = {
  total: number;
  correct: number;
  pValue: number;
};

type SlotInfo = {
  trimLinear: number;
  trimDb: number | null;
  latencySeconds: number;
  bandMultiplier?: number;
};

type Props = {
  mode: BlindTestMode | "off";
  onChangeMode: (mode: BlindTestMode | "off") => void;
  availableModes: {
    ABX: boolean;
    ACX: boolean;
    BCX: boolean;
    ABCX: boolean;
  };
  onStart: () => void;
  onReset: () => void;
  onReveal: () => void;
  onNext: () => void;
  onGuess: (choice: BasePath) => void;
  onAudition: (target: AuditionTarget) => void;
  canAuditionC: boolean;
  stats: Stats;
  currentTrialIndex: number | null;
  lastLogEntry: TrialLogEntry | null;
  seed: string;
  onSeedChange: (seed: string) => void;
  isLatencyLocked: boolean;
  isBandTrimPending: boolean;
  seedHash: string;
  bandRangeLabel?: string | null;
  pathInfo: {
    A: SlotInfo;
    B?: SlotInfo | null;
    C?: SlotInfo | null;
  };
};

const MODE_LABELS: Record<BlindTestMode, string> = {
  ABX: "ABX",
  ACX: "ACX",
  BCX: "BCX",
  ABCX: "ABCX",
};

const AUDITION_LABELS: Record<AuditionTarget, string> = {
  A: "Listen A",
  B: "Listen B",
  C: "Listen C",
  X: "Listen X",
};

export default function BlindTestPanel({
  mode,
  onChangeMode,
  availableModes,
  onStart,
  onReset,
  onReveal,
  onNext,
  onGuess,
  onAudition,
  canAuditionC,
  stats,
  currentTrialIndex,
  lastLogEntry,
  seed,
  onSeedChange,
  isLatencyLocked,
  isBandTrimPending,
  seedHash,
  bandRangeLabel,
  pathInfo,
}: Props) {
  const panelId = useId();
  const bodyId = `${panelId}-body`;
  const infoId = `${panelId}-info`;
  const infoRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    if (mode !== "off") {
      setIsOpen(true);
    }
  }, [mode]);

  useEffect(() => {
    if (!isOpen) {
      setShowInfo(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!showInfo) return;
    if (typeof window === "undefined") return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!infoRef.current) return;
      if (infoRef.current.contains(event.target as Node)) return;
      setShowInfo(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowInfo(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showInfo]);

  const guessOptions = useMemo(() => {
    if (mode === "ACX") return ["A", "C"] as BasePath[];
    if (mode === "BCX") return ["B", "C"] as BasePath[];
    if (mode === "ABCX") return ["A", "B", "C"] as BasePath[];
    return ["A", "B"] as BasePath[];
  }, [mode]);

  const auditionOptions = useMemo(() => {
    const base: AuditionTarget[] = ["A", "B", "X"];
    if (canAuditionC) base.splice(2, 0, "C");
    return base;
  }, [canAuditionC]);

  const latestResult = lastLogEntry && lastLogEntry.correct != null ? lastLogEntry : null;

  const formatLatency = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "0.00 ms";
    const ms = seconds * 1000;
    const decimals = ms >= 10 ? 1 : 2;
    return `${ms.toFixed(decimals)} ms`;
  };

  const formatTrim = (db: number | null) => {
    if (db == null || !Number.isFinite(db)) return "0.0 dB";
    const normalized = Math.abs(db) < 0.05 ? 0 : Math.round(db * 10) / 10;
    const sign = normalized > 0 ? "+" : "";
    return `${sign}${normalized.toFixed(1)} dB`;
  };

  const formatBandMultiplier = (multiplier: number | undefined) => {
    if (!multiplier || !Number.isFinite(multiplier)) return "";
    if (Math.abs(multiplier - 1) < 0.001) return "";
    return `| Band x${multiplier.toFixed(2)}`;
  };

  const renderPathStat = (label: string, info: SlotInfo | null | undefined) => {
    if (!info) return null;
    const base = `Trim ${formatTrim(info.trimDb)} | Lat ${formatLatency(info.latencySeconds)}`;
    const bandPart = formatBandMultiplier(info.bandMultiplier);
    const value = isBandTrimPending && label !== "A" ? "Computing..." : `${base} ${bandPart}`.trim();
    return (
      <div key={label} className="blind-panel__stat">
        <span className="blind-panel__stat-label">{`Path ${label}`}</span>
        <span className="blind-panel__stat-value">{value}</span>
      </div>
    );
  };

  return (
    <section className={`panel blind-panel${isOpen ? "" : " blind-panel--collapsed"}`}>
      <div className="panel-header blind-panel__header">
        <div>
          <h2 className="panel-title">Blind Tests</h2>
          <p className="panel-desc">Run ABX comparisons with frozen trims and latency.</p>
        </div>
        <div className="blind-panel__header-actions">
          <div className="panel-help blind-panel__info" ref={infoRef}>
            <button
              type="button"
              className="panel-help__button"
              aria-label="How blind tests work"
              aria-expanded={showInfo}
              aria-controls={infoId}
              onClick={() => setShowInfo((prev) => !prev)}
            >
              i
            </button>
            {showInfo && (
              <div
                className="panel-help__popover blind-panel__info-popover"
                id={infoId}
                role="dialog"
                aria-modal="false"
              >
                <h3 className="panel-help__title">How blind tests work</h3>
                <p className="panel-help__text">
                  1. Choose a mode, then press Start to freeze the trims and latency with a random seed.
                </p>
                <p className="panel-help__text">
                  2. Use the Listen buttons or hotkeys (1-4) to audition A, B, C, and X before committing.
                </p>
                <p className="panel-help__text">
                  3. Log guesses with the Guess buttons. The stats and p-value update after every trial; Reveal shows
                  the answer.
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            className="blind-panel__toggle"
            aria-expanded={isOpen}
            aria-controls={bodyId}
            onClick={() => setIsOpen((prev) => !prev)}
          >
            <span className="blind-panel__toggle-label">{isOpen ? "Hide" : "Show"}</span>
            <span className={`blind-panel__toggle-icon${isOpen ? " is-open" : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        className="blind-panel__body"
        id={bodyId}
        role="region"
        aria-live="polite"
        aria-hidden={!isOpen}
        hidden={!isOpen}
      >
        <div className="blind-panel__card blind-panel__card--primary">
          <div className="blind-panel__mode-group">
            <span className="blind-panel__label">Compare</span>
            <div className="segmented-control blind-panel__modes" role="group" aria-label="Blind test mode selector">
              {(Object.keys(MODE_LABELS) as BlindTestMode[]).map((value) => {
                const enabled = availableModes[value];
                const isActive = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    className={`segmented-control__segment${isActive ? " is-active" : ""}`}
                    onClick={() => onChangeMode(isActive ? "off" : value)}
                    disabled={!enabled && !isActive}
                  >
                    {MODE_LABELS[value]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="blind-panel__seed">
            <label className="blind-panel__seed-label">
              <span className="blind-panel__label">Seed</span>
              <input
                type="text"
                className="blind-panel__seed-input"
                value={seed}
                onChange={(event) => onSeedChange(event.target.value)}
              />
            </label>
            <button type="button" className="control-button blind-panel__start" onClick={onStart} disabled={mode === "off"}>
              Start
            </button>
          </div>
        </div>

        {mode !== "off" && (
          <div className="blind-panel__card blind-panel__card--controls">
            <div className="blind-panel__audition">
              {auditionOptions.map((target) => (
                <button key={target} type="button" className="control-button" onClick={() => onAudition(target)}>
                  {AUDITION_LABELS[target]}
                </button>
              ))}
            </div>
            <div className="blind-panel__actions">
              {guessOptions.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className="control-button button-ghost"
                  onClick={() => onGuess(choice)}
                >
                  Guess {choice}
                </button>
              ))}
              <button type="button" className="control-button button-ghost" onClick={onReveal}>
                Reveal
              </button>
              <button type="button" className="control-button button-ghost" onClick={onNext}>
                Next
              </button>
              <button type="button" className="control-button button-ghost" onClick={onReset}>
                Reset
              </button>
            </div>
          </div>
        )}

        {mode !== "off" && (
          <p className="blind-panel__hints">
            Hotkeys: 1=A, 2=B, 3=C, 4=X, Enter=commit, N=next, R=reveal. Band scope freezes while testing.
          </p>
        )}

        <div className="blind-panel__card blind-panel__card--stats">
          <div className="blind-panel__stats">
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Trials</span>
              <span className="blind-panel__stat-value">{stats.total}</span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Correct</span>
              <span className="blind-panel__stat-value">{stats.correct}</span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">p-value</span>
              <span className="blind-panel__stat-value">{stats.total > 0 ? stats.pValue.toFixed(4) : "n/a"}</span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Seed hash</span>
              <span className="blind-panel__stat-value">{seedHash}</span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Latency locked</span>
              <span className="blind-panel__stat-value">{isLatencyLocked ? "Yes" : "No"}</span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Current trial</span>
              <span className="blind-panel__stat-value">
                {currentTrialIndex != null ? currentTrialIndex + 1 : "n/a"}
              </span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Band trims</span>
              <span className="blind-panel__stat-value">{isBandTrimPending ? "Computing..." : "Ready"}</span>
            </div>
            <div className="blind-panel__stat">
              <span className="blind-panel__stat-label">Band range</span>
              <span className="blind-panel__stat-value">{bandRangeLabel ?? "n/a"}</span>
            </div>
            {renderPathStat("A", pathInfo.A)}
            {renderPathStat("B", pathInfo.B)}
            {renderPathStat("C", pathInfo.C)}
          </div>
        </div>

        {latestResult && (
          <div className={`blind-panel__result${latestResult.correct ? " is-correct" : " is-incorrect"}`}>
            Last guess: {latestResult.correct ? "Correct" : "Incorrect"} (X was {latestResult.actual})
          </div>
        )}
      </div>
    </section>
  );
}
