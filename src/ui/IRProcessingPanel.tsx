// WHY: Provides manual and automatic trimming controls for the impulse responses.
import { useEffect, useState } from "react";
import WaveformPlot from "./WaveformPlot";

type IrSlotId = "B" | "C";

type PanelSlot = {
  id: IrSlotId;
  label: string;
  original: AudioBuffer;
  processed: AudioBuffer | null;
  name: string;
};

type SlotRange = {
  start: number;
  end: number;
  durationMs: number;
  original: AudioBuffer;
};

type Props = {
  slots: PanelSlot[];
  onManualTrim: (slot: IrSlotId, startMs: number, endMs: number) => void;
  onAutoTrim: (slot: IrSlotId) => void;
  onReset: (slot: IrSlotId) => void;
};

export default function IRProcessingPanel({ slots, onManualTrim, onAutoTrim, onReset }: Props) {
  const [activeSlotId, setActiveSlotId] = useState<IrSlotId>(() => slots[0]?.id ?? "B");
  const [slotRanges, setSlotRanges] = useState<Partial<Record<IrSlotId, SlotRange>>>(() => {
    const initial: Partial<Record<IrSlotId, SlotRange>> = {};
    slots.forEach((slot) => {
      const durationMs = slot.original.duration * 1000;
      initial[slot.id] = {
        start: 0,
        end: durationMs,
        durationMs,
        original: slot.original,
      };
    });
    return initial;
  });

  useEffect(() => {
    if (slots.length === 0) return;
    if (!slots.some((slot) => slot.id === activeSlotId)) {
      setActiveSlotId(slots[0].id);
    }
  }, [slots, activeSlotId]);

  useEffect(() => {
    setSlotRanges((prev) => {
      const next: Partial<Record<IrSlotId, SlotRange>> = { ...prev };
      const seen = new Set<IrSlotId>();
      slots.forEach((slot) => {
        seen.add(slot.id);
        const durationMs = slot.original.duration * 1000;
        const previous = prev[slot.id];
        if (!previous || previous.original !== slot.original) {
          next[slot.id] = {
            start: 0,
            end: durationMs,
            durationMs,
            original: slot.original,
          };
        } else {
          next[slot.id] = {
            ...previous,
            end: Math.min(previous.end, durationMs),
            durationMs,
          };
        }
      });
      (Object.keys(next) as IrSlotId[]).forEach((id) => {
        if (!seen.has(id)) {
          delete next[id];
        }
      });
      return next;
    });
  }, [slots]);

  if (slots.length === 0) {
    return null;
  }

  const activeSlot = slots.find((slot) => slot.id === activeSlotId) ?? slots[0];
  const activeRange = slotRanges[activeSlot.id];
  const durationMs = activeRange?.durationMs ?? activeSlot.original.duration * 1000;
  const startMs = activeRange ? Math.round(activeRange.start) : 0;
  const endMs = activeRange ? Math.round(activeRange.end) : Math.round(durationMs);
  const formattedDuration = `${activeSlot.original.duration.toFixed(3)} s`;
  const processedDuration =
    activeSlot.processed != null ? `${activeSlot.processed.duration.toFixed(3)} s` : "--";
  const displayName = activeSlot.name || activeSlot.label;

  const updateRange = (kind: "start" | "end", value: number) => {
    setSlotRanges((prev) => {
      const previous =
        prev[activeSlot.id] ?? ({
          start: 0,
          end: durationMs,
          durationMs,
          original: activeSlot.original,
        } as SlotRange);
      const nextEntry: SlotRange = {
        ...previous,
        start: kind === "start" ? value : previous.start,
        end: kind === "end" ? value : previous.end,
        durationMs,
        original: activeSlot.original,
      };
      return { ...prev, [activeSlot.id]: nextEntry };
    });
  };

  const clampRange = () => {
    const range = slotRanges[activeSlot.id];
    const start = Math.max(0, Math.min(durationMs, range?.start ?? 0));
    const end = Math.max(start, Math.min(durationMs, range?.end ?? durationMs));
    return { start, end };
  };

  const handleApplyManual = () => {
    const { start, end } = clampRange();
    if (end <= start + 1) return;
    onManualTrim(activeSlot.id, start, end);
    setSlotRanges((prev) => ({
      ...prev,
      [activeSlot.id]: {
        ...(prev[activeSlot.id] ?? {
          durationMs,
          original: activeSlot.original,
          start,
          end,
        }),
        start,
        end,
        durationMs,
        original: activeSlot.original,
      },
    }));
  };

  const handleAutoTrim = () => {
    onAutoTrim(activeSlot.id);
  };

  const handleReset = () => {
    onReset(activeSlot.id);
    setSlotRanges((prev) => ({
      ...prev,
      [activeSlot.id]: {
        start: 0,
        end: durationMs,
        durationMs,
        original: activeSlot.original,
      },
    }));
  };

  return (
    <section className="panel ir-panel">
      <div className="panel-header ir-panel__header">
        <div className="ir-panel__headline">
          <h2 className="panel-title">IR processing</h2>
          <p className="panel-desc">Trim silence or tighten the impulse response before playback and analysis.</p>
        </div>
        {slots.length > 1 && (
          <div className="ir-panel__selector" role="tablist" aria-label="Impulse responses">
            {slots.map((slot) => (
              <button
                key={slot.id}
                type="button"
                role="tab"
                aria-selected={activeSlot.id === slot.id}
                className={`ir-panel__selector-button${activeSlot.id === slot.id ? " is-active" : ""}`}
                onClick={() => setActiveSlotId(slot.id)}
              >
                {slot.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ir-panel__layout">
        <div className="ir-panel__stack">
          <div className="ir-meta">
            <div className="ir-meta__item">
              <span className="ir-meta__label">Source</span>
              <span className="ir-meta__value ir-meta__value--primary" title={displayName}>
                {displayName}
              </span>
            </div>
            <div className="ir-meta__item">
              <span className="ir-meta__label">Original length</span>
              <span className="ir-meta__value ir-meta__value--accent">{formattedDuration}</span>
            </div>
            <div className="ir-meta__item" aria-live="polite">
              <span className="ir-meta__label">Processed length</span>
              <span className="ir-meta__value ir-meta__value--status">{processedDuration}</span>
            </div>
          </div>

          <div className="ir-trim-grid" role="group" aria-label="Impulse response trim">
            <label className="ir-trim-control">
              <span className="ir-trim-label">Start (ms)</span>
              <input
                className="ir-trim-input"
                type="number"
                min={0}
                max={Math.max(0, Math.floor(durationMs))}
                value={startMs}
                inputMode="numeric"
                step={1}
                onChange={(e) => updateRange("start", Number(e.target.value))}
              />
            </label>
            <label className="ir-trim-control">
              <span className="ir-trim-label">End (ms)</span>
              <input
                className="ir-trim-input"
                type="number"
                min={0}
                max={Math.max(0, Math.floor(durationMs))}
                value={endMs}
                inputMode="numeric"
                step={1}
                onChange={(e) => updateRange("end", Number(e.target.value))}
              />
            </label>
            <div className="ir-trim-actions">
              <button
                type="button"
                className="control-button button-primary ir-panel__button ir-panel__button--primary"
                onClick={handleApplyManual}
              >
                Apply trim
              </button>
              <button
                type="button"
                className="control-button button-ghost ir-panel__button ir-panel__button--secondary"
                onClick={handleAutoTrim}
              >
                Auto trim
              </button>
              <button
                type="button"
                className="control-button button-ghost ir-panel__button ir-panel__button--subtle"
                onClick={handleReset}
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="waveform-plot ir-panel__plot">
          <WaveformPlot buffer={activeSlot.processed ?? activeSlot.original} color="#ff375f" title="Processed IR" />
        </div>
      </div>
    </section>
  );
}

