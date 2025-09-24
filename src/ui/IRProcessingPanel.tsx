// WHY: Provides manual and automatic trimming controls for the impulse response.
import { useEffect, useMemo, useState } from "react";
import WaveformPlot from "./WaveformPlot";

type Props = {
  original: AudioBuffer;
  processed: AudioBuffer | null;
  irName: string;
  onManualTrim: (startMs: number, endMs: number) => void;
  onAutoTrim: () => void;
  onReset: () => void;
};

export default function IRProcessingPanel({ original, processed, irName, onManualTrim, onAutoTrim, onReset }: Props) {
  const durationMs = useMemo(() => original.duration * 1000, [original]);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(durationMs);

  useEffect(() => {
    setStartMs(0);
    setEndMs(original.duration * 1000);
  }, [original]);

  const formattedDuration = useMemo(() => `${original.duration.toFixed(3)} s`, [original]);
  const processedDuration = processed ? `${processed.duration.toFixed(3)} s` : "--";

  function applyManual() {
    const clampedStart = Math.max(0, startMs);
    const clampedEnd = Math.min(endMs, durationMs);
    if (clampedEnd <= clampedStart + 1) return;
    onManualTrim(clampedStart, clampedEnd);
  }

  return (
    <section className="panel ir-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">IR processing</h2>
          <p className="panel-desc">Trim silence or tighten the impulse response before playback and analysis.</p>
        </div>
      </div>

      <div className="ir-meta">
        <div className="ir-meta__item">
          <span className="ir-meta__label">Source</span>
          <span className="ir-meta__value" title={irName || "Impulse response"}>
            {irName || "Impulse response"}
          </span>
        </div>
        <div className="ir-meta__item">
          <span className="ir-meta__label">Original length</span>
          <span className="ir-meta__value">{formattedDuration}</span>
        </div>
        <div className="ir-meta__item" aria-live="polite">
          <span className="ir-meta__label">Processed length</span>
          <span className="ir-meta__value">{processedDuration}</span>
        </div>
      </div>

      <div className="ir-trim-grid">
        <label className="ir-trim-control">
          <span className="ir-trim-label">Start (ms)</span>
          <input
            className="ir-trim-input"
            type="number"
            min={0}
            max={Math.max(0, Math.floor(durationMs))}
            value={Math.round(startMs)}
            onChange={(e) => setStartMs(Number(e.target.value))}
          />
        </label>
        <label className="ir-trim-control">
          <span className="ir-trim-label">End (ms)</span>
          <input
            className="ir-trim-input"
            type="number"
            min={0}
            max={Math.max(0, Math.floor(durationMs))}
            value={Math.round(endMs)}
            onChange={(e) => setEndMs(Number(e.target.value))}
          />
        </label>
        <div className="ir-trim-actions">
          <button type="button" className="control-button button-primary" onClick={applyManual}>
            Apply trim
          </button>
          <button type="button" className="control-button button-ghost" onClick={onAutoTrim}>
            Auto trim
          </button>
          <button type="button" className="control-button button-ghost" onClick={onReset}>
            Reset
          </button>
        </div>
      </div>

      <div className="waveform-plot">
        <WaveformPlot buffer={processed ?? original} color="#ff375f" title="Processed IR" />
      </div>
    </section>
  );
}

