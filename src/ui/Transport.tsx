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
  convolvedDisabled?: boolean;
  convolvedTooltip?: string;
  convolvedBVol?: number;
  onChangeConvolvedBVol?: (v: number) => void;
  convolvedBDisabled?: boolean;
  convolvedBTooltip?: string;
  differenceVol: number;
  onChangeDifferenceVol: (v: number) => void;
  rmsOffsetsDb: {
    original: number;
    convolvedA: number;
    convolvedB: number;
  };
  duration: number;
  position: number;
  onSeek: (seconds: number) => void;
  onSkipForward: () => void;
  onSkipBackward: () => void;
  onResetVolumes: () => void;
  embedded?: boolean;
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

const ORIGCONV_DB_MIN = -6;
const ORIGCONV_DB_MAX = 6;
const ORIGCONV_DB_RANGE = ORIGCONV_DB_MAX - ORIGCONV_DB_MIN;
const CONVB_DB_MIN = -6;
const CONVB_DB_MAX = 6;
const CONVB_DB_RANGE = CONVB_DB_MAX - CONVB_DB_MIN;
const DIFF_DB_MIN = -40;
const DIFF_DB_MAX = 40;
const DIFF_DB_RANGE = DIFF_DB_MAX - DIFF_DB_MIN;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function linearToDbWithRange(value: number, minDb: number, maxDb: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return minDb;
  }
  const db = 20 * Math.log10(value);
  return clamp(db, minDb, maxDb);
}

function dbToLinearWithRange(db: number, minDb: number, maxDb: number): number {
  const clamped = clamp(db, minDb, maxDb);
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

function formatLinearGain(db: number): string {
  const linear = Math.pow(10, db / 20);
  if (!Number.isFinite(linear)) {
    return "1.00x";
  }
  return `${linear.toFixed(linear >= 10 ? 1 : 2)}x`;
}

function buildVolumeTooltip(label: string, sliderDb: number, offsetDb: number, extra?: string) {
  const parts = [
    `${label}: ${formatDb(sliderDb)} (${formatLinearGain(sliderDb)})`,
    `RMS offset ${formatDb(offsetDb)} (${formatLinearGain(offsetDb)})`,
  ];
  if (extra) {
    parts.push(extra);
  }
  return parts.join(" • ");
}

export default function Transport({
  isPlaying,
  playPause,
  stopAll,
  originalVol,
  onChangeOriginalVol,
  convolvedVol,
  onChangeConvolvedVol,
  convolvedDisabled = false,
  convolvedTooltip,
  convolvedBVol = 1,
  onChangeConvolvedBVol,
  convolvedBDisabled = false,
  convolvedBTooltip,
  differenceVol,
  onChangeDifferenceVol,
  rmsOffsetsDb,
  duration,
  position,
  onSeek,
  onSkipForward,
  onSkipBackward,
  onResetVolumes,
  embedded = false,
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
    const db = linearToDbWithRange(originalVol, ORIGCONV_DB_MIN, ORIGCONV_DB_MAX);
    return Math.round(db * 10) / 10;
  }, [originalVol]);

  const convolvedVolDb = useMemo(() => {
    const db = linearToDbWithRange(convolvedVol, ORIGCONV_DB_MIN, ORIGCONV_DB_MAX);
    return Math.round(db * 10) / 10;
  }, [convolvedVol]);

  const differenceVolDb = useMemo(() => {
    const db = linearToDbWithRange(differenceVol, DIFF_DB_MIN, DIFF_DB_MAX);
    return Math.round(db * 10) / 10;
  }, [differenceVol]);

  const convolvedBVolDb = useMemo(() => {
    const db = linearToDbWithRange(convolvedBVol, CONVB_DB_MIN, CONVB_DB_MAX);
    return Math.round(db * 10) / 10;
  }, [convolvedBVol]);

  const originalVolumeStyle = useMemo<VolumeSliderStyle>(() => {
    const progress = ((originalVolDb - ORIGCONV_DB_MIN) / ORIGCONV_DB_RANGE) * 100;
    const bounded = clamp(progress, 0, 100);
    return { "--volume-progress": `${bounded}%` };
  }, [originalVolDb]);

  const convolvedVolumeStyle = useMemo<VolumeSliderStyle>(() => {
    const progress = ((convolvedVolDb - ORIGCONV_DB_MIN) / ORIGCONV_DB_RANGE) * 100;
    const bounded = clamp(progress, 0, 100);
    return { "--volume-progress": `${bounded}%` };
  }, [convolvedVolDb]);

  const differenceVolumeStyle = useMemo<VolumeSliderStyle>(() => {
    const progress = ((differenceVolDb - DIFF_DB_MIN) / DIFF_DB_RANGE) * 100;
    const bounded = clamp(progress, 0, 100);
    return { "--volume-progress": `${bounded}%` };
  }, [differenceVolDb]);

  const convolvedBVolumeStyle = useMemo<VolumeSliderStyle>(() => {
    const progress = ((convolvedBVolDb - CONVB_DB_MIN) / CONVB_DB_RANGE) * 100;
    const bounded = clamp(progress, 0, 100);
    return { "--volume-progress": `${bounded}%` };
  }, [convolvedBVolDb]);

  const originalVolumeTone = useMemo(() => getVolumeTone(originalVolDb), [originalVolDb]);
  const convolvedVolumeTone = useMemo(() => getVolumeTone(convolvedVolDb), [convolvedVolDb]);
  const convolvedBVolumeTone = useMemo<VolumeTone>(() => getVolumeTone(convolvedBVolDb), [convolvedBVolDb]);

  const originalVolumeTooltip = useMemo(
    () => buildVolumeTooltip("Original", originalVolDb, rmsOffsetsDb.original),
    [originalVolDb, rmsOffsetsDb.original],
  );
  const convolvedVolumeTooltip = useMemo(
    () => buildVolumeTooltip("Convolved A", convolvedVolDb, rmsOffsetsDb.convolvedA, convolvedTooltip),
    [convolvedVolDb, convolvedTooltip, rmsOffsetsDb.convolvedA],
  );
  const convolvedBVolumeTooltip = useMemo(
    () => buildVolumeTooltip("Convolved B", convolvedBVolDb, rmsOffsetsDb.convolvedB, convolvedBTooltip),
    [convolvedBVolDb, convolvedBTooltip, rmsOffsetsDb.convolvedB],
  );
  const differenceVolumeTooltip = useMemo(
    () => `Difference: ${formatDb(differenceVolDb)} (${formatLinearGain(differenceVolDb)})`,
    [differenceVolDb],
  );

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

  const handleSliderKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      commitScrub(event.currentTarget.value);
    }
  };

  const handleSliderPointerUp = (event: PointerEvent<HTMLInputElement>) => {
    commitScrub(event.currentTarget.value);
  };

  const handleSliderBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (isScrubbing) {
      commitScrub(event.currentTarget.value);
    }
  };

  const containerClassName = embedded ? "transport transport--embedded" : "panel transport-panel";

  return (
    <section className={containerClassName}>
      {!embedded && (
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Transport</h2>
            <p className="panel-desc">Preview your mix, pause to tweak, and reset in a click.</p>
          </div>
        </div>
      )}

      <div className="transport-progress">
        <span className="transport-progress__time">{formatTime(displayPosition)}</span>
        <input
          className="transport-progress__slider"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(Math.max(displayPosition, 0), duration || 0)}
          disabled={!isReady}
          onPointerDown={handleScrubStart}
          onPointerUp={handleSliderPointerUp}
          onPointerCancel={handleSliderPointerUp}
          onChange={(event) => handleScrubChange(event.target.value)}
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
          <span className="volume-group__caption">Volume controls</span>
          <button
            type="button"
            className="control-button button-ghost volume-reset-button"
            onClick={onResetVolumes}
          >
            Reset Volumes
          </button>
        </div>

        <label className="volume-control">
          <span className="volume-label">
            Original Volume
            <span className="volume-label__meta">RMS offset {formatDb(rmsOffsetsDb.original)}</span>
          </span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={ORIGCONV_DB_MIN}
              max={ORIGCONV_DB_MAX}
              step={0.1}
              value={originalVolDb}
              onChange={(event) =>
                onChangeOriginalVol(
                  dbToLinearWithRange(Number(event.target.value), ORIGCONV_DB_MIN, ORIGCONV_DB_MAX),
                )
              }
              aria-valuemin={ORIGCONV_DB_MIN}
              aria-valuemax={ORIGCONV_DB_MAX}
              aria-valuenow={originalVolDb}
              aria-valuetext={formatDb(originalVolDb)}
              style={originalVolumeStyle}
              title={originalVolumeTooltip}
            />
            <div className="volume-slider__labels" aria-hidden="true">
              <span>-6 dB</span>
              <span>0 dB</span>
              <span>+6 dB</span>
            </div>
            <span className={`volume-value volume-value--${originalVolumeTone}`}>
              {formatDb(originalVolDb)}
            </span>
          </div>
        </label>

        <label className="volume-control">
          <span className="volume-label">
            Convolved A Volume
            <span className="volume-label__meta">RMS offset {formatDb(rmsOffsetsDb.convolvedA)}</span>
          </span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={ORIGCONV_DB_MIN}
              max={ORIGCONV_DB_MAX}
              step={0.1}
              value={convolvedVolDb}
              onChange={(event) =>
                onChangeConvolvedVol(
                  dbToLinearWithRange(Number(event.target.value), ORIGCONV_DB_MIN, ORIGCONV_DB_MAX),
                )
              }
              aria-valuemin={ORIGCONV_DB_MIN}
              aria-valuemax={ORIGCONV_DB_MAX}
              aria-valuenow={convolvedVolDb}
              aria-valuetext={formatDb(convolvedVolDb)}
              style={convolvedVolumeStyle}
              disabled={convolvedDisabled}
              title={convolvedVolumeTooltip}
            />
            <div className="volume-slider__labels" aria-hidden="true">
              <span>-6 dB</span>
              <span>0 dB</span>
              <span>+6 dB</span>
            </div>
            <span className={`volume-value volume-value--${convolvedVolumeTone}`}>
              {formatDb(convolvedVolDb)}
            </span>
          </div>
        </label>

        <label className="volume-control">
          <span className="volume-label">
            Convolved B Volume
            <span className="volume-label__meta">RMS offset {formatDb(rmsOffsetsDb.convolvedB)}</span>
          </span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={CONVB_DB_MIN}
              max={CONVB_DB_MAX}
              step={0.1}
              value={convolvedBVolDb}
              onChange={(event) => {
                if (!onChangeConvolvedBVol) return;
                onChangeConvolvedBVol(
                  dbToLinearWithRange(Number(event.target.value), CONVB_DB_MIN, CONVB_DB_MAX),
                );
              }}
              aria-valuemin={CONVB_DB_MIN}
              aria-valuemax={CONVB_DB_MAX}
              aria-valuenow={convolvedBVolDb}
              aria-valuetext={formatDb(convolvedBVolDb)}
              style={convolvedBVolumeStyle}
              disabled={convolvedBDisabled || !onChangeConvolvedBVol}
              title={convolvedBVolumeTooltip}
            />
            <div className="volume-slider__labels" aria-hidden="true">
              <span>-6 dB</span>
              <span>0 dB</span>
              <span>+6 dB</span>
            </div>
            <span className={`volume-value volume-value--${convolvedBVolumeTone}`}>
              {formatDb(convolvedBVolDb)}
            </span>
          </div>
        </label>

        <label className="volume-control">
          <span className="volume-label">Difference Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={DIFF_DB_MIN}
              max={DIFF_DB_MAX}
              step={0.1}
              value={differenceVolDb}
            onChange={(event) =>
              onChangeDifferenceVol(
                dbToLinearWithRange(Number(event.target.value), DIFF_DB_MIN, DIFF_DB_MAX),
              )
            }
            aria-valuemin={DIFF_DB_MIN}
            aria-valuemax={DIFF_DB_MAX}
            aria-valuenow={differenceVolDb}
            aria-valuetext={formatDb(differenceVolDb)}
            style={differenceVolumeStyle}
            title={differenceVolumeTooltip}
          />
            <div className="volume-slider__labels" aria-hidden="true">
              <span>-40 dB</span>
              <span>0 dB</span>
              <span>+40 dB</span>
            </div>
            <span className="volume-value">{formatDb(differenceVolDb)}</span>
          </div>
        </label>
      </div>
    </section>
  );
}
