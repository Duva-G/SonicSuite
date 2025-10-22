import { useEffect, useMemo, useRef, useState, useId } from "react";
import type { BlindTestMode, BasePath, TrialLogEntry } from "../audio/ABCXController";

type AuditionTarget = "A" | "B" | "C" | "X";

type Stats = {
  total: number;
  correct: number;
  pValue: number;
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
  bandRangeLabel?: string | null;
  isReady: boolean;
};

const MODE_LABELS: Record<BlindTestMode, string> = {
  ABX: "OAX",
  ACX: "OBX",
  BCX: "ABX",
  ABCX: "OABX",
};

const PATH_LETTER: Record<BasePath, string> = {
  A: "O",
  B: "A",
  C: "B",
};

const PATH_NAME: Record<BasePath, string> = {
  A: "Music WAV",
  B: "Impulse response WAV",
  C: "Impulse response C",
};

const getPathLetter = (path: BasePath) => PATH_LETTER[path] ?? path;
const getPathName = (path: BasePath) => PATH_NAME[path] ?? path;
const formatPathDisplay = (path: BasePath) => `${getPathLetter(path)} (${getPathName(path)})`;

const formatAuditionLabel = (target: AuditionTarget) => {
  if (target === "X") return "Listen X";
  const path = target as BasePath;
  return `Listen ${getPathLetter(path)} (${getPathName(path)})`;
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
  bandRangeLabel,
  isReady,
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
  const accuracy = stats.total > 0 ? Math.round((stats.correct / Math.max(stats.total, 1)) * 100) : null;
  const trialNumber = currentTrialIndex != null ? currentTrialIndex + 1 : 1;

  return (
    <section className={`panel blind-panel${isOpen ? "" : " blind-panel--collapsed"}`}>
      <div className="panel-header blind-panel__header">
        <div>
          <h2 className="panel-title">Blind Tests</h2>
          <p className="panel-desc">Freeze trims, audition paths, and log quick ABX-style guesses.</p>
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
                <p className="panel-help__text">1. Pick a comparison mode and scope your playback band.</p>
                <p className="panel-help__text">2. Press Start to lock trims and latency with a repeatable seed.</p>
                <p className="panel-help__text">3. Audition O/A/B/X, then guess, reveal, or advance as you go.</p>
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
        <div className="blind-panel__card blind-panel__setup">
          <div className="blind-panel__mode-group">
            <span className="blind-panel__label">Mode</span>
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
              <span className="blind-panel__label">Seed (optional)</span>
              <input
                type="text"
                className="blind-panel__seed-input"
                value={seed}
                placeholder="Random if left blank"
                onChange={(event) => onSeedChange(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="control-button blind-panel__start"
              onClick={onStart}
              disabled={mode === "off"}
            >
              Start
            </button>
          </div>
        </div>

        {mode !== "off" && (
          <>
            <div className="blind-panel__card blind-panel__actions-card">
              <div className="blind-panel__audition">
                {auditionOptions.map((target) => (
                  <button key={target} type="button" className="control-button" onClick={() => onAudition(target)}>
                    {formatAuditionLabel(target)}
                  </button>
                ))}
              </div>
              <div className="blind-panel__action-row">
                {guessOptions.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className="control-button button-ghost"
                    onClick={() => onGuess(choice)}
                    disabled={!isReady}
                  >
                    Guess {formatPathDisplay(choice)}
                  </button>
                ))}
                <button
                  type="button"
                  className="control-button button-ghost"
                  onClick={onReveal}
                  disabled={!isReady}
                >
                  Reveal
                </button>
                <button
                  type="button"
                  className="control-button button-ghost"
                  onClick={onNext}
                  disabled={!isReady}
                >
                  Next
                </button>
                <button
                  type="button"
                  className="control-button button-ghost"
                  onClick={onReset}
                  disabled={!isReady}
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="blind-panel__summary" aria-live="polite">
              <div className="blind-panel__summary-item">
                <span className="blind-panel__summary-label">Status</span>
                <span className="blind-panel__summary-value">{isReady ? "Ready" : "Press Start"}</span>
              </div>
              <div className="blind-panel__summary-item">
                <span className="blind-panel__summary-label">Trial</span>
                <span className="blind-panel__summary-value">{trialNumber}</span>
              </div>
              <div className="blind-panel__summary-item">
                <span className="blind-panel__summary-label">Completed</span>
                <span className="blind-panel__summary-value">{stats.total}</span>
              </div>
              <div className="blind-panel__summary-item">
                <span className="blind-panel__summary-label">Correct</span>
                <span className="blind-panel__summary-value">{stats.correct}</span>
              </div>
              <div className="blind-panel__summary-item">
                <span className="blind-panel__summary-label">Accuracy</span>
                <span className="blind-panel__summary-value">{accuracy != null ? `${accuracy}%` : "n/a"}</span>
              </div>
              {bandRangeLabel ? (
                <div className="blind-panel__summary-item">
                  <span className="blind-panel__summary-label">Band</span>
                  <span className="blind-panel__summary-value">{bandRangeLabel}</span>
                </div>
              ) : null}
            </div>

            {latestResult && (
              <div className={`blind-panel__result${latestResult.correct ? " is-correct" : " is-incorrect"}`}>
                Last guess: {latestResult.correct ? "Correct" : "Incorrect"} (X was {formatPathDisplay(latestResult.actual)})
              </div>
            )}

            <p className="blind-panel__hints">
              Hotkeys: 1=O, 2=A, 3=B, 4=X, Enter=guess, N=next, R=reveal. Band scope stays frozen while testing. Legend: O (Music WAV), A (Impulse response WAV), B (Impulse response C).
            </p>
          </>
        )}
      </div>
    </section>
  );
}
