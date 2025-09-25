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
  onResetVolumes: () => void;
};

type SliderStyle = CSSProperties & { "--progress"?: string };
type VolumeSliderStyle = CSSProperties & { "--volume-progress"?: string };

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const VOLUME_DB_MIN = -6;
const VOLUME_DB_MAX = 6;
const VOLUME_DB_RANGE = VOLUME_DB_MAX - VOLUME_DB_MIN;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function linearToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return VOLUME_DB_MIN;
  }
  const db = 20 * Math.log10(value);
  return clamp(db, VOLUME_DB_MIN, VOLUME_DB_MAX);
}

function dbToLinear(db: number): number {
  const clamped = clamp(db, VOLUME_DB_MIN, VOLUME_DB_MAX);
  return Math.pow(10, clamped / 20);
}

function formatDb(db: number): string {
  const normalized = Math.abs(db) < 0.05 ? 0 : Math.round(db * 10) / 10;
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(1)} dB`;
}

type VolumeTone = "positive" | "negative" | "neutral";

function getVolumeTone(db: number): VolumeTone {
  if (db > 0.05) return "positive";
  if (db < -0.05) return "negative";
  return "neutral";
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
  onResetVolumes,
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

  const originalVolDb = useMemo(() => {
    const db = linearToDb(originalVol);
    return Math.round(db * 10) / 10;
  }, [originalVol]);
  const convolvedVolDb = useMemo(() => {
    const db = linearToDb(convolvedVol);
    return Math.round(db * 10) / 10;
  }, [convolvedVol]);

  const originalVolumeStyle = useMemo<VolumeSliderStyle>(() => {
    const progress = ((originalVolDb - VOLUME_DB_MIN) / VOLUME_DB_RANGE) * 100;
    const bounded = clamp(progress, 0, 100);
    return { "--volume-progress": `${bounded}%` };
  }, [originalVolDb]);

  const convolvedVolumeStyle = useMemo<VolumeSliderStyle>(() => {
    const progress = ((convolvedVolDb - VOLUME_DB_MIN) / VOLUME_DB_RANGE) * 100;
    const bounded = clamp(progress, 0, 100);
    return { "--volume-progress": `${bounded}%` };
  }, [convolvedVolDb]);

  const originalVolumeTone = useMemo(() => getVolumeTone(originalVolDb), [originalVolDb]);
  const convolvedVolumeTone = useMemo(() => getVolumeTone(convolvedVolDb), [convolvedVolDb]);

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
        <div className="volume-group__header">
          <span className="volume-group__caption">Volume (-6 dB to +6 dB)</span>
          <button
            type="button"
            className="control-button button-ghost volume-reset-button"
            onClick={onResetVolumes}
          >
            Reset Volumes
          </button>
        </div>
        <label className="volume-control">
          <span className="volume-label">Original Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={VOLUME_DB_MIN}
              max={VOLUME_DB_MAX}
              step={0.1}
              value={originalVolDb}
              onChange={(e) => onChangeOriginalVol(dbToLinear(Number(e.target.value)))}
              aria-valuemin={VOLUME_DB_MIN}
              aria-valuemax={VOLUME_DB_MAX}
              aria-valuenow={originalVolDb}
              aria-valuetext={formatDb(originalVolDb)}
              style={originalVolumeStyle}
            />
            <div className="volume-slider__labels" aria-hidden="true">
              <span>-6 dB</span>
              <span>0 dB</span>
              <span>+6 dB</span>
            </div>
            <span className={`volume-value volume-value--${originalVolumeTone}`}>{formatDb(originalVolDb)}</span>
          </div>
        </label>
        <label className="volume-control">
          <span className="volume-label">Convolved Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={VOLUME_DB_MIN}
              max={VOLUME_DB_MAX}
              step={0.1}
              value={convolvedVolDb}
              onChange={(e) => onChangeConvolvedVol(dbToLinear(Number(e.target.value)))}
              aria-valuemin={VOLUME_DB_MIN}
              aria-valuemax={VOLUME_DB_MAX}
              aria-valuenow={convolvedVolDb}
              aria-valuetext={formatDb(convolvedVolDb)}
              style={convolvedVolumeStyle}
            />
            <div className="volume-slider__labels" aria-hidden="true">
              <span>-6 dB</span>
              <span>0 dB</span>
              <span>+6 dB</span>
            </div>
            <span className={`volume-value volume-value--${convolvedVolumeTone}`}>{formatDb(convolvedVolDb)}</span>
          </div>
        </label>
      </div>

    </section>
  );
}
