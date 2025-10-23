import { useEffect, useMemo, useRef } from "react";
import type {
  DiffRegion,
  DiffSettings,
  PlaybackBand,
  UseFRDifferenceResult,
} from "../hooks/useFRDifference";
import { useFRDifference } from "../hooks/useFRDifference";

type DifferencePanelProps = {
  open: boolean;
  onClose: () => void;
  onResult?: (result: UseFRDifferenceResult) => void;
  onSelectRegion?: (region: DiffRegion) => void;
  inputs: {
    a: Float32Array | number[] | null;
    b: Float32Array | number[] | null;
    sampleRate: number;
  };
  playback: {
    band: PlaybackBand;
  };
  settings: DiffSettings;
  onChangeSettings: (next: Partial<DiffSettings>) => void;
};

const ALIGN_OPTIONS: DiffSettings["align"][] = ["time", "phase", "none"];

export default function DifferencePanel({
  open,
  onClose,
  onResult,
  onSelectRegion,
  inputs,
  playback,
  settings,
  onChangeSettings,
}: DifferencePanelProps) {
  const { a, b, sampleRate } = inputs;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const diff = useFRDifference({
    a,
    b,
    sampleRate,
    band: playback.band,
    settings,
    active: open,
  });

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = getFocusable(panelRef.current);
    focusable[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const elements = getFocusable(panelRef.current);
        if (elements.length === 0) return;
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!onResult) return;
    if (diff.state === "ready") {
      onResult(diff);
    }
  }, [diff, onResult]);

  const frPath = useMemo(() => (diff.frDelta ? buildSparkline(diff.frDelta, 280, 96) : null), [diff.frDelta]);
  const diffPath = useMemo(() => (diff.diffSignal ? buildSparkline(diff.diffSignal, 280, 64) : null), [diff.diffSignal]);

  return (
    <div className={`diff-drawer${open ? " is-open" : ""}`} aria-hidden={!open}>
      <button
        type="button"
        className="diff-drawer__backdrop"
        onClick={onClose}
        aria-hidden="true"
        tabIndex={-1}
      />
      <aside
        ref={panelRef}
        className="diff-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diff-drawer-title"
      >
        <header className="diff-drawer__header">
          <div>
            <h2 id="diff-drawer-title">Difference details</h2>
            <p className="diff-drawer__subtitle">Inspect advanced metrics for the audible difference signal.</p>
          </div>
          <button type="button" className="diff-drawer__close" onClick={onClose} aria-label="Close difference details">
            ×
          </button>
        </header>

        <section className="diff-drawer__section">
          <h3 className="diff-drawer__section-title">Controls</h3>
          <div className="diff-drawer__form">
            <label className="diff-drawer__field">
              <span>Alignment</span>
              <select value={settings.align} onChange={(event) => onChangeSettings({ align: event.target.value as DiffSettings["align"] })}>
                {ALIGN_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === "time" ? "Time alignment" : option === "phase" ? "Phase alignment" : "None"}
                  </option>
                ))}
              </select>
            </label>
            <label className="diff-drawer__field">
              <span>Window (ms)</span>
              <input
                type="number"
                min={5}
                max={500}
                step={5}
                value={Math.round(settings.windowMs)}
                onChange={(event) => onChangeSettings({ windowMs: clampNumber(Number(event.target.value), 5, 500) })}
              />
            </label>
            <label className="diff-drawer__field">
              <span>Smoothing</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={clampNumber(settings.smoothing, 0, 1)}
                onChange={(event) =>
                  onChangeSettings({ smoothing: clampNumber(Number(event.target.value), 0, 1) })
                }
              />
              <span className="diff-drawer__field-note">{(settings.smoothing * 100).toFixed(0)}%</span>
            </label>
            <label className="diff-drawer__field">
              <span>Threshold (dB)</span>
              <input
                type="number"
                min={-120}
                max={12}
                step={1}
                value={settings.threshold}
                onChange={(event) => onChangeSettings({ threshold: clampNumber(Number(event.target.value), -120, 12) })}
              />
            </label>
          </div>
        </section>

        <section className="diff-drawer__section">
          <h3 className="diff-drawer__section-title">Summary</h3>
          <div className="diff-drawer__summary">
            <SummaryItem label="RMS" value={formatDb(diff.stats?.rms)} />
            <SummaryItem label="Peak" value={formatDb(diff.stats?.peak)} />
            <SummaryItem
              label="% over threshold"
              value={diff.stats ? `${diff.stats.overThresholdPct.toFixed(1)}%` : "—"}
            />
            <SummaryItem label="Status" value={formatState(diff.state, diff.error)} />
          </div>
        </section>

        <section className="diff-drawer__section">
          <h3 className="diff-drawer__section-title">Spectral delta</h3>
          <div className="diff-drawer__chart" role="img" aria-label="Frequency response delta sparkline">
            {frPath ? (
              <svg viewBox="0 0 280 96" preserveAspectRatio="none">
                <path d={frPath} className="diff-drawer__chart-line" />
              </svg>
            ) : (
              <p className="diff-drawer__placeholder">Difference spectrum will appear once data is ready.</p>
            )}
          </div>
        </section>

        <section className="diff-drawer__section">
          <h3 className="diff-drawer__section-title">Waveform</h3>
          <div className="diff-drawer__chart diff-drawer__chart--wave" role="img" aria-label="Difference waveform preview">
            {diffPath ? (
              <svg viewBox="0 0 280 64" preserveAspectRatio="none">
                <path d={diffPath} className="diff-drawer__wave-line" />
              </svg>
            ) : (
              <p className="diff-drawer__placeholder">Load sources and enable difference playback to preview.</p>
            )}
          </div>
        </section>

        <section className="diff-drawer__section">
          <h3 className="diff-drawer__section-title">Regions</h3>
          <div className="diff-drawer__regions">
            {diff.regions.length === 0 ? (
              <p className="diff-drawer__placeholder">No regions exceed the current threshold.</p>
            ) : (
              diff.regions.map((region, idx) => (
                <button
                  key={`${region.start}-${idx}`}
                  type="button"
                  className="diff-drawer__region"
                  onClick={() => onSelectRegion?.(region)}
                >
                  <span className="diff-drawer__region-time">
                    {formatSeconds(region.start)} – {formatSeconds(region.end)}
                  </span>
                  <span className="diff-drawer__region-peak">{formatDb(region.peak)}</span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="diff-drawer__section">
          <h3 className="diff-drawer__section-title">Export</h3>
          <button type="button" className="diff-drawer__export" disabled>
            Export stats (coming soon)
          </button>
        </section>
      </aside>
    </div>
  );
}

type SummaryItemProps = {
  label: string;
  value: string;
};

function SummaryItem({ label, value }: SummaryItemProps) {
  return (
    <div className="diff-drawer__summary-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getFocusable(root: HTMLElement | null) {
  if (!root) return [] as HTMLElement[];
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => !element.hasAttribute("data-ignore-focus"));
}

function buildSparkline(values: Float32Array | number[], width: number, height: number): string {
  const points = sampleArray(values, 256);
  if (points.length === 0) return "";
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point < min) min = point;
    if (point > max) max = point;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
  if (Math.abs(max - min) < 1e-6) {
    max = min + 1e-6;
  }
  const span = max - min;
  const stepX = width / Math.max(1, points.length - 1);
  let path = "";
  points.forEach((value, index) => {
    const x = index * stepX;
    const norm = (value - min) / span;
    const y = height - norm * height;
    path += `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
  });
  return path.trim();
}

function sampleArray(values: Float32Array | number[], limit: number): number[] {
  const length = values.length;
  if (length <= limit) {
    return Array.from(values);
  }
  const step = length / limit;
  const sampled = new Array<number>(limit);
  for (let i = 0; i < limit; i++) {
    const index = Math.min(length - 1, Math.floor(i * step));
    sampled[i] = values[index];
  }
  return sampled;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function formatDb(value: number | undefined | null) {
  if (value == null || !Number.isFinite(value)) {
    return "–";
  }
  return `${value.toFixed(1)} dB`;
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}s`;
}

function formatState(state: UseFRDifferenceResult["state"], error?: string) {
  if (state === "error") return error ?? "Error";
  if (state === "computing") return "Computing…";
  if (state === "ready") return "Ready";
  return "Idle";
}
