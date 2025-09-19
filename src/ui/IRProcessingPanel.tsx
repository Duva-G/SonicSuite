// WHY: Provides manual and automatic trimming controls for the impulse response.
import { useEffect, useMemo, useRef, useState } from "react";
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
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef(startMs);
  const endRef = useRef(endMs);
  const [dragTarget, setDragTarget] = useState<"start" | "end" | null>(null);

  useEffect(() => {
    const nextDuration = original.duration * 1000;
    setStartMs(0);
    setEndMs(nextDuration);
  }, [original]);

  useEffect(() => {
    startRef.current = startMs;
  }, [startMs]);

  useEffect(() => {
    endRef.current = endMs;
  }, [endMs]);

  const formattedDuration = useMemo(() => `${original.duration.toFixed(3)} s`, [original]);
  const processedDuration = processed ? `${processed.duration.toFixed(3)} s` : "--";
  const minGapMs = useMemo(() => {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
    const adaptive = durationMs * 0.001;
    return Math.max(1, adaptive);
  }, [durationMs]);

  const startPercent = durationMs > 0 ? (startMs / durationMs) * 100 : 0;
  const endPercent = durationMs > 0 ? (endMs / durationMs) * 100 : 100;
  const selectionWidth = Math.max(0, endPercent - startPercent);

  function clampMs(ms: number): number {
    if (!Number.isFinite(ms) || durationMs <= 0) return 0;
    return Math.max(0, Math.min(durationMs, ms));
  }

  function clientXToMs(clientX: number): number {
    const slider = sliderRef.current;
    if (!slider || durationMs <= 0) return 0;
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return clampMs(ratio * durationMs);
  }

  function updateFromPointer(target: "start" | "end", clientX: number) {
    if (durationMs <= 0) return;
    const ms = clientXToMs(clientX);
    if (target === "start") {
      const maxStart = clampMs(endRef.current - minGapMs);
      const next = clampMs(Math.min(ms, maxStart));
      setStartMs(next);
    } else {
      const minEnd = clampMs(startRef.current + minGapMs);
      const next = clampMs(Math.max(ms, minEnd));
      setEndMs(next);
    }
  }

  function beginDrag(target: "start" | "end", clientX: number) {
    updateFromPointer(target, clientX);
    setDragTarget(target);
  }

  useEffect(() => {
    if (!dragTarget) return;

    const target = dragTarget;

    function handleMove(ev: PointerEvent) {
      ev.preventDefault();
      updateFromPointer(target, ev.clientX);
    }

    function handleUp() {
      setDragTarget(null);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragTarget, minGapMs, durationMs]);

  function applyManual() {
    const clampedStart = clampMs(startMs);
    const clampedEnd = clampMs(endMs);
    if (clampedEnd <= clampedStart + minGapMs) return;
    onManualTrim(clampedStart, clampedEnd);
  }

  function handleSliderPointerDown(ev: React.PointerEvent<HTMLDivElement>) {
    ev.preventDefault();
    const ms = clientXToMs(ev.clientX);
    const distanceToStart = Math.abs(ms - startRef.current);
    const distanceToEnd = Math.abs(ms - endRef.current);
    const target: "start" | "end" = distanceToStart <= distanceToEnd ? "start" : "end";
    beginDrag(target, ev.clientX);
  }

  function handleHandlePointerDown(target: "start" | "end") {
    return (ev: React.PointerEvent<HTMLDivElement>) => {
      ev.preventDefault();
      ev.stopPropagation();
      beginDrag(target, ev.clientX);
    };
  }

  function handleInputStart(ev: React.ChangeEvent<HTMLInputElement>) {
    const next = Number(ev.target.value);
    if (Number.isNaN(next)) return;
    const clamped = clampMs(Math.min(next, endRef.current - minGapMs));
    setStartMs(clamped);
  }

  function handleInputEnd(ev: React.ChangeEvent<HTMLInputElement>) {
    const next = Number(ev.target.value);
    if (Number.isNaN(next)) return;
    const clamped = clampMs(Math.max(next, startRef.current + minGapMs));
    setEndMs(clamped);
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
        <div>
          <span className="ir-meta__label">Source</span>
          <span className="ir-meta__value">{irName || "Impulse response"}</span>
        </div>
        <div>
          <span className="ir-meta__label">Original length</span>
          <span className="ir-meta__value">{formattedDuration}</span>
        </div>
        <div>
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
            onChange={handleInputStart}
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
            onChange={handleInputEnd}
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
        <div className="ir-trim-slider" ref={sliderRef} onPointerDown={handleSliderPointerDown}>
          <div className="ir-trim-slider__track" />
          <div
            className="ir-trim-slider__selection"
            style={{ left: `${startPercent}%`, width: `${selectionWidth}%` }}
          />
          <div
            className="ir-trim-slider__handle ir-trim-slider__handle--start"
            style={{ left: `${startPercent}%` }}
            onPointerDown={handleHandlePointerDown("start")}
          />
          <div
            className="ir-trim-slider__handle ir-trim-slider__handle--end"
            style={{ left: `${endPercent}%` }}
            onPointerDown={handleHandlePointerDown("end")}
          />
        </div>
        <WaveformPlot buffer={processed ?? original} color="#ff375f" title="Processed IR" />
      </div>
    </section>
  );
}

