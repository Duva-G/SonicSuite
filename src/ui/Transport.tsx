import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, PointerEvent } from "react";

type Props = {
  isPlaying: boolean;
  playPause: () => void;
  stopAll: () => void;
  originalVol: number;
  onChangeOriginalVol: (v: number) => void;
  convolvedVol: number;
  onChangeConvolvedVol: (v: number) => void;
  duration: number;
  position: number;
  onSeek: (seconds: number) => void;
  onSkipForward: () => void;
  onSkipBackward: () => void;
};

type SliderStyle = CSSProperties & { "--progress"?: string };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export default function Transport({
  isPlaying,
  playPause,
  stopAll,
  originalVol,
  onChangeOriginalVol,
  convolvedVol,
  onChangeConvolvedVol,
  duration,
  position,
  onSeek,
  onSkipForward,
  onSkipBackward,
}: Props) {
  const [isScrubbing, setScrubbing] = useState(false);
  const [pendingPosition, setPendingPosition] = useState(position);

  useEffect(() => {
    if (!isScrubbing) {
      setPendingPosition(position);
    }
  }, [position, isScrubbing]);

  useEffect(() => {
    if (duration <= 0) {
      setPendingPosition(0);
      setScrubbing(false);
    }
  }, [duration]);

  const isReady = duration > 0;
  const displayPosition = isScrubbing ? pendingPosition : position;
  const progressPercent = useMemo(() => {
    if (!isReady || duration <= 0) return 0;
    if (!Number.isFinite(displayPosition)) return 0;
    return Math.min(100, Math.max(0, (displayPosition / duration) * 100));
  }, [displayPosition, duration, isReady]);

  const sliderStyle = useMemo<SliderStyle | undefined>(() => {
    if (!isReady) return undefined;
    return { "--progress": `${progressPercent}%` };
  }, [isReady, progressPercent]);

  const handleScrubStart = () => {
    if (!isReady) return;
    setScrubbing(true);
  };

  const handleScrubChange = (value: string) => {
    if (!isReady) return;
    setPendingPosition(Number(value));
  };

  const commitScrub = (value: string) => {
    if (!isReady) return;
    const next = Number(value);
    setScrubbing(false);
    setPendingPosition(next);
    onSeek(next);
  };

  const handleSliderKeyUp = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      commitScrub(e.currentTarget.value);
    }
  };

  const handleSliderPointerUp = (e: PointerEvent<HTMLInputElement>) => {
    commitScrub(e.currentTarget.value);
  };

  const handleSliderBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (isScrubbing) {
      commitScrub(e.currentTarget.value);
    }
  };

  return (
    <section className="panel transport-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Transport</h2>
          <p className="panel-desc">Preview your mix, pause to tweak, and reset in a click.</p>
        </div>
      </div>
      <div className="transport-progress">
        <span className="transport-progress__time">{formatTime(displayPosition)}</span>
        <input
          className="transport-progress__slider"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(Math.max(displayPosition, 0), duration || 0)}
          disabled={!isReady}
          onPointerDown={handleScrubStart}
          onPointerUp={handleSliderPointerUp}
          onPointerCancel={handleSliderPointerUp}
          onChange={(e) => handleScrubChange(e.target.value)}
          onBlur={handleSliderBlur}
          onKeyUp={handleSliderKeyUp}
          style={sliderStyle}
        />
        <span className="transport-progress__time">{formatTime(duration)}</span>
      </div>

      <div className="transport-controls">
        <div className="transport-controls__cluster">
          <button
            type="button"
            className="transport-button transport-button--skip"
            onClick={onSkipBackward}
            disabled={!isReady}
          >
            -10s
          </button>
          <button
            type="button"
            className={`transport-button transport-button--play${isPlaying ? " is-active" : ""}`}
            onClick={playPause}
            disabled={!isReady && !isPlaying}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            className="transport-button transport-button--skip"
            onClick={onSkipForward}
            disabled={!isReady}
          >
            +10s
          </button>
        </div>
        <button
          type="button"
          className="control-button button-ghost transport-stop"
          onClick={stopAll}
          disabled={!isReady && !isPlaying && position <= 0}
        >
          Stop
        </button>
      </div>

      <div className="volume-group">
        <label className="volume-control">
          <span className="volume-label">Original Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={originalVol}
              onChange={(e) => onChangeOriginalVol(parseFloat(e.target.value))}
            />
            <span className="volume-value">{originalVol.toFixed(2)}x</span>
          </div>
        </label>
        <label className="volume-control">
          <span className="volume-label">Convolved Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={convolvedVol}
              onChange={(e) => onChangeConvolvedVol(parseFloat(e.target.value))}
            />
            <span className="volume-value">{convolvedVol.toFixed(2)}x</span>
          </div>
        </label>
      </div>
    </section>
  );
}
