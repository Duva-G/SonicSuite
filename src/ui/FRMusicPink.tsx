import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
} from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
import { createModuleWorker } from "../utils/workerSupport";
import FullscreenModal from "./FullscreenModal";

type SmoothingMode = "1/24" | "1/12" | "1/6" | "1/3";

type PlaybackWorkerResult = {
  freqs: Float32Array;
  dryDb: Float32Array;
  wetDb: Float32Array | null;
  hasIR: boolean;
};

type PlaybackWorkerMessage =
  | { type: "playback-fr-result"; requestId: number; payload: PlaybackWorkerResult }
  | { type: "playback-fr-error"; requestId: number; error: string };

type PinkWorkerResult = {
  freqs: Float32Array;
  pinkDb: Float32Array;
  convolvedDb: Float32Array | null;
  transferDb: Float32Array | null;
  hasIR: boolean;
  irLabel: string | null;
};

type PinkWorkerMessage =
  | { type: "fr-result"; requestId: number; payload: PinkWorkerResult }
  | { type: "fr-error"; requestId: number; error: string };

type WorkerMessage = PlaybackWorkerMessage | PinkWorkerMessage;

type Props = {
  musicBuffer: AudioBuffer | null;
  sampleRate: number;
};

const Plot = createPlotlyComponent(Plotly);
type PlotComponentProps = ComponentProps<typeof Plot>;
type PlotDataArray = NonNullable<PlotComponentProps["data"]>;
type PlotDatum = PlotDataArray[number];
type PlotLayout = NonNullable<PlotComponentProps["layout"]>;
type PlotConfig = NonNullable<PlotComponentProps["config"]>;

const smoothingOptions: Array<{ value: SmoothingMode; label: string }> = [
  { value: "1/24", label: "1/24 octave" },
  { value: "1/12", label: "1/12 octave" },
  { value: "1/6", label: "1/6 octave" },
  { value: "1/3", label: "1/3 octave" },
];

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);
const MAX_PLAYBACK_ANALYSIS_SECONDS = 30;

function clampOffset(value: number) {
  if (!Number.isFinite(value)) return 0;
  if (value < PINK_OFFSET_MIN) return PINK_OFFSET_MIN;
  if (value > PINK_OFFSET_MAX) return PINK_OFFSET_MAX;
  return value;
}

function roundToStep(value: number, step: number) {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

function normalizeOffset(value: number) {
  const clamped = clampOffset(value);
  const rounded = roundToStep(clamped, PINK_OFFSET_STEP);
  const normalized = Number(rounded.toFixed(2));
  return Math.abs(normalized) < 1e-3 ? 0 : normalized;
}

type PinkOffsetControlProps = {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onStep: (delta: number) => void;
  onReset: () => void;
  disabled?: boolean;
  variant?: "inline" | "modal";
};

function PinkOffsetControl({
  value,
  min,
  max,
  step,
  onChange,
  onStep,
  onReset,
  disabled = false,
  variant = "inline",
}: PinkOffsetControlProps) {
  const formatted = `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
  const baseClass = `frpink-offset${variant === "modal" ? " frpink-offset--modal" : ""}`;
  const rangeId = variant === "modal" ? "frpink-offset-range-modal" : "frpink-offset-range";

  const handleRangeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(Number(event.target.value));
  };

  return (
    <div className={baseClass}>
      <div className="frpink-offset__header">
        <span className="frpink-offset__label">Pink offset</span>
        <span className="frpink-offset__value" aria-live="polite">
          {formatted}
        </span>
      </div>
      <div className="frpink-offset__controls">
        <button
          type="button"
          className="frpink-offset__step"
          onClick={() => onStep(-step)}
          disabled={disabled}
          aria-label="Lower pink noise line"
        >
          −
        </button>
        <input
          id={rangeId}
          className="frpink-offset__range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleRangeChange}
          disabled={disabled}
          aria-label="Adjust pink noise offset"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={formatted}
        />
        <button
          type="button"
          className="frpink-offset__step"
          onClick={() => onStep(step)}
          disabled={disabled}
          aria-label="Raise pink noise line"
        >
          +
        </button>
        <button
          type="button"
          className="frpink-offset__reset"
          onClick={onReset}
          disabled={disabled || Math.abs(value) < 1e-3}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
const PINK_OFFSET_MIN = -24;
const PINK_OFFSET_MAX = 24;
const PINK_OFFSET_STEP = 0.5;

type PlaybackSpectra = Pick<PlaybackWorkerResult, "freqs" | "dryDb">;
type PinkSpectra = Pick<PinkWorkerResult, "freqs" | "pinkDb">;

const zeroLineShape = {
  type: "line" as const,
  xref: "paper" as const,
  yref: "y" as const,
  x0: 0,
  x1: 1,
  y0: 0,
  y1: 0,
  line: { color: "rgba(255,255,255,0.35)", width: 1, dash: "dot" as const },
};

export default function FRMusicPink({ musicBuffer, sampleRate }: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
  const [showDifference, setShowDifference] = useState(false);
  const [pinkOffsetDb, setPinkOffsetDb] = useState(0);
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [playbackSpectra, setPlaybackSpectra] = useState<PlaybackSpectra | null>(null);
  const [pinkSpectra, setPinkSpectra] = useState<PinkSpectra | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const activePlaybackRequestRef = useRef(0);
  const activePinkRequestRef = useRef(0);
  const pendingCountRef = useRef(0);
  const pendingRenderRef = useRef(false);

  const createBaseLayout = useCallback(
    (difference: boolean): PlotLayout =>
      ({
        autosize: true,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(28,28,30,0.6)",
        font: { color: "#f2f2f7", family: "Inter, system-ui, sans-serif" },
        margin: { l: 58, r: 30, t: difference ? 82 : 72, b: 68 },
        hovermode: "x unified" as const,
        hoverlabel: {
          bgcolor: "rgba(20,20,22,0.92)",
          bordercolor: "rgba(255,255,255,0.25)",
          font: { color: "#f5f5f7" },
        },
        legend: {
          orientation: "h" as const,
          yanchor: "top" as const,
          y: 1.12,
          x: 0,
          xanchor: "left" as const,
          font: { size: 12, color: "#f5f5f7" },
          bgcolor: "rgba(18,18,24,0.78)",
          bordercolor: "rgba(255,255,255,0.12)",
          borderwidth: 1,
          itemwidth: 72,
        },
        xaxis: {
          type: "log" as const,
          range: [LOG_MIN, LOG_MAX],
          autorange: false,
          dtick: 1,
          title: {
            text: "Frequency (Hz)",
            font: { color: "#f5f5f7", size: 12 },
            standoff: 12,
          },
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.08)",
          tickfont: { size: 11, color: "rgba(235,235,245,0.78)" },
          ticks: "outside" as const,
          tickcolor: "rgba(255,255,255,0.24)",
          ticklen: 6,
        },
        yaxis: {
          autorange: true,
          title: {
            text: "Magnitude (dB)",
            font: { color: "#f5f5f7", size: 12 },
            standoff: 14,
          },
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.1)",
          tickfont: { size: 11, color: "rgba(235,235,245,0.78)" },
          tickcolor: "rgba(255,255,255,0.24)",
          ticks: "outside" as const,
          ticklen: 6,
        },
        shapes: difference ? [zeroLineShape] : [],
      }) as PlotLayout,
    []
  );

  const [layout, setLayout] = useState<PlotLayout>(() => createBaseLayout(false));

  const resetAxes = useCallback(() => {
    setLayout(createBaseLayout(showDifference));
  }, [createBaseLayout, showDifference]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const { worker, error: workerError } = createModuleWorker(new URL("../workers/dspWorker.ts", import.meta.url));
    if (!worker) {
      if (workerError) {
        console.warn("FRMusicPink worker unavailable.", workerError);
      }
      setWorkerReady(false);
      setError("Pink-noise comparison is unavailable in this browser.");
      return;
    }

    workerRef.current = worker;
    setWorkerReady(true);

    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "playback-fr-result") {
        if (data.requestId !== activePlaybackRequestRef.current) return;
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
        setPlaybackSpectra({
          freqs: data.payload.freqs,
          dryDb: data.payload.dryDb,
        });
        setError(null);
        if (pendingCountRef.current === 0) {
          pendingRenderRef.current = true;
        }
      } else if (data.type === "playback-fr-error") {
        if (data.requestId !== activePlaybackRequestRef.current) return;
        pendingCountRef.current = 0;
        pendingRenderRef.current = false;
        setPlaybackSpectra(null);
        setLoading(false);
        setError(data.error);
      } else if (data.type === "fr-result") {
        if (data.requestId !== activePinkRequestRef.current) return;
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
        setPinkSpectra({
          freqs: data.payload.freqs,
          pinkDb: data.payload.pinkDb,
        });
        setError(null);
        if (pendingCountRef.current === 0) {
          pendingRenderRef.current = true;
        }
      } else if (data.type === "fr-error") {
        if (data.requestId !== activePinkRequestRef.current) return;
        pendingCountRef.current = 0;
        pendingRenderRef.current = false;
        setPinkSpectra(null);
        setLoading(false);
        setError(data.error);
      }
    };

    worker.addEventListener("message", handleMessage);

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, []);

  useEffect(() => {
    if (!workerReady) return;
    const worker = workerRef.current;
    if (!worker) return;

    if (!musicBuffer) {
      setPlaybackSpectra(null);
      setPinkSpectra(null);
      pendingRenderRef.current = false;
      pendingCountRef.current = 0;
      setLoading(false);
      setError(null);
      return;
    }

    const playbackRequestId = ++requestIdRef.current;
    const pinkRequestId = ++requestIdRef.current;
    activePlaybackRequestRef.current = playbackRequestId;
    activePinkRequestRef.current = pinkRequestId;
    pendingRenderRef.current = false;
    pendingCountRef.current = 2;
    setLoading(true);
    setError(null);
    setPlaybackSpectra(null);
    setPinkSpectra(null);

    const musicPayload = serializeBuffer(musicBuffer, MAX_PLAYBACK_ANALYSIS_SECONDS);
    const transferables: Transferable[] = [musicPayload.data.buffer];

    worker.postMessage(
      {
        type: "compute-playback-fr",
        requestId: playbackRequestId,
        payload: {
          sampleRate,
          smoothing,
          music: {
            data: musicPayload.data,
            sampleRate: musicPayload.sampleRate,
            label: "Music",
          },
          ir: null,
        },
      },
      transferables
    );

    worker.postMessage({
      type: "compute-fr",
      requestId: pinkRequestId,
      payload: {
        sampleRate,
        smoothing,
        ir: null,
      },
    });
  }, [workerReady, musicBuffer, sampleRate, smoothing]);

  const dataset = useMemo(() => {
    if (!playbackSpectra || !pinkSpectra) return null;
    const len = Math.min(playbackSpectra.freqs.length, pinkSpectra.freqs.length);
    if (len === 0) return null;
    const freqSlice = playbackSpectra.freqs.slice(0, len);
    const musicSlice = playbackSpectra.dryDb.slice(0, len);
    const pinkSlice = pinkSpectra.pinkDb.slice(0, len);
    const freqs = Array.from(freqSlice, (hz) => (hz > 0 ? hz : MIN_FREQ));
    const musicDb = Array.from(musicSlice);
    const pinkDb = Array.from(pinkSlice);
    return { freqs, musicDb, pinkDb };
  }, [playbackSpectra, pinkSpectra]);

  const { adjustedPink, diffSeries } = useMemo(() => {
    if (!dataset) {
      return { adjustedPink: null, diffSeries: null };
    }
    const adjusted = dataset.pinkDb.map((value) => value + pinkOffsetDb);
    const difference = dataset.musicDb.map((value, idx) => value - adjusted[idx]);
    return { adjustedPink: adjusted, diffSeries: difference };
  }, [dataset, pinkOffsetDb]);

  const handleOffsetChange = useCallback((value: number) => {
    setPinkOffsetDb(normalizeOffset(value));
  }, []);

  const handleOffsetStep = useCallback((delta: number) => {
    setPinkOffsetDb((prev) => normalizeOffset(prev + delta));
  }, []);

  const handleOffsetReset = useCallback(() => {
    setPinkOffsetDb(0);
  }, []);

  useEffect(() => {
    if (dataset) {
      resetAxes();
    }
  }, [dataset, resetAxes]);

  useEffect(() => {
    setLayout((prev: PlotLayout) => {
      const nextMargin = { ...(prev.margin ?? {}) };
      nextMargin.l = isFullscreenOpen ? 72 : 58;
      nextMargin.r = isFullscreenOpen ? 72 : 58;
      nextMargin.t = isFullscreenOpen
        ? showDifference
          ? 70
          : 60
        : showDifference
        ? 78
        : 68;
      nextMargin.b = isFullscreenOpen ? 76 : 64;

      const nextLegend = { ...(prev.legend ?? {}) };
      nextLegend.y = isFullscreenOpen ? 1.06 : 1.12;
      nextLegend.x = 0;
      nextLegend.xanchor = "left";
      nextLegend.orientation = "h";
      nextLegend.bgcolor = "rgba(18,18,24,0.78)";
      nextLegend.bordercolor = "rgba(255,255,255,0.12)";
      nextLegend.borderwidth = 1;

      return {
        ...prev,
        margin: nextMargin,
        legend: nextLegend,
      };
    });
  }, [isFullscreenOpen, showDifference]);

  const traces = useMemo<PlotDataArray>(() => {
    if (!dataset) return [] as PlotDataArray;
    const hover = "<b>%{x:.0f} Hz</b><br>%{y:.2f} dB<extra></extra>";
    const pinkLegend =
      Math.abs(pinkOffsetDb) < 1e-3
        ? "Pink noise"
        : `Pink noise (${pinkOffsetDb > 0 ? "+" : ""}${pinkOffsetDb.toFixed(1)} dB)`;
    const items: PlotDatum[] = [
      {
        type: "scatter",
        mode: "lines",
        name: "Music",
        x: dataset.freqs,
        y: dataset.musicDb,
        line: { color: "#5ac8fa", width: 2 },
        hovertemplate: hover,
      } as PlotDatum,
      {
        type: "scatter",
        mode: "lines",
        name: pinkLegend,
        x: dataset.freqs,
        y: adjustedPink ?? dataset.pinkDb,
        line: { color: "#ff9f0a", width: 2 },
        hovertemplate: hover,
      } as PlotDatum,
    ];
    if (showDifference && diffSeries) {
      items.push({
        type: "scatter",
        mode: "lines",
        name: "Music - Pink",
        x: dataset.freqs,
        y: diffSeries,
        line: { color: "#ffd60a", width: 1.5 },
        hovertemplate: hover,
      } as PlotDatum);
    }
    return items as PlotDataArray;
  }, [dataset, adjustedPink, diffSeries, pinkOffsetDb, showDifference]);

  const handleRelayout = (eventData: Partial<Record<string, unknown>>) => {
    if (!eventData) return;
    const xAuto = eventData["xaxis.autorange"] === true;
    const yAuto = eventData["yaxis.autorange"] === true;
    const xMin = eventData["xaxis.range[0]"];
    const xMax = eventData["xaxis.range[1]"];
    const outOfRange =
      typeof xMin === "number" && typeof xMax === "number" && (xMin < LOG_MIN || xMax > LOG_MAX);
    if (xAuto || outOfRange || yAuto) {
      resetAxes();
    }
  };

  const handleAfterPlot = () => {
    if (pendingRenderRef.current) {
      pendingRenderRef.current = false;
      setLoading(false);
    }
  };

  const config = useMemo<PlotConfig>(
    () =>
      ({
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
        toImageButtonOptions: {
          format: "png" as const,
          filename: `fr-music-pink`,
          height: 700,
          width: 1200,
          scale: 2,
        },
      }) as PlotConfig,
    []
  );

  const handleToggleDifference = () => {
    setShowDifference((prev) => {
      const next = !prev;
      setLayout((current: PlotLayout) => ({
        ...current,
        shapes: next ? [zeroLineShape] : [],
      }));
      return next;
    });
  };

  const handleExportCsv = () => {
    if (!dataset) return;
    const pinkValues = adjustedPink ?? dataset.pinkDb;
    const diffValues =
      diffSeries ?? dataset.musicDb.map((value, idx) => value - pinkValues[idx]);
    const rows: string[] = ["frequency_hz,music_db,pink_db,diff_db"];
    rows.push(`# pink_offset_db=${pinkOffsetDb.toFixed(2)}`);
    for (let i = 0; i < dataset.freqs.length; i++) {
      rows.push(
        [
          dataset.freqs[i].toFixed(2),
          dataset.musicDb[i]?.toFixed(4) ?? "",
          pinkValues[i]?.toFixed(4) ?? "",
          diffValues[i]?.toFixed(4) ?? "",
        ].join(",")
      );
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fr-music-pink-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const hasMusic = Boolean(musicBuffer);
  const hasData = Boolean(dataset);
  const basePlotStyle = useMemo(
    () => ({ width: "100%", height: "clamp(380px, 50vh, 520px)" }),
    []
  );

  return (
    <>
      <div className="frpink frmusicpink">
        <div className="frpink-controls">
          <div className="frpink-segment">
            <span className="frpink-segment__label">Smoothing</span>
            <div className="frpink-segment__control" role="radiogroup" aria-label="Smoothing amount">
              {smoothingOptions.map((option) => {
                const isActive = smoothing === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    className={`frpink-segment__button${isActive ? " is-active" : ""}`}
                    aria-pressed={isActive}
                    onClick={() => setSmoothing(option.value)}
                  >
                    {option.label.replace(" octave", "")}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="frpink-checkbox">
            <input
              type="checkbox"
              checked={showDifference}
              onChange={handleToggleDifference}
              disabled={!hasData}
            />
            <span>Show difference (Music - Pink)</span>
          </label>
          <PinkOffsetControl
            value={pinkOffsetDb}
            min={PINK_OFFSET_MIN}
            max={PINK_OFFSET_MAX}
            step={PINK_OFFSET_STEP}
            onChange={handleOffsetChange}
            onStep={handleOffsetStep}
            onReset={handleOffsetReset}
            disabled={!hasData}
          />
          <div className="frpink-actions">
            <button
              type="button"
              className="control-button button-ghost frpink-export"
              onClick={handleExportCsv}
              disabled={!hasData}
            >
              Export CSV
            </button>
            <button
              type="button"
              className="control-button button-ghost frpink-fullscreen"
              onClick={() => setIsFullscreenOpen(true)}
              disabled={!hasData}
            >
              Full screen
            </button>
          </div>
        </div>

        {error && <div className="frpink-message frpink-message--error">{error}</div>}
        {!hasMusic && (
          <div className="frpink-message">Load a music track to compare against pink noise.</div>
        )}

        <div className="frpink-plot">
          {isLoading && (
            <div className="frplot-progress" role="status" aria-live="polite">
              <div className="frplot-progress__track">
                <div className="frplot-progress__bar" />
              </div>
              <span className="frplot-progress__label">Analysing music response</span>
            </div>
          )}
          {hasData && (
            <Plot
              data={traces}
              layout={layout}
              config={config}
              useResizeHandler
              style={basePlotStyle}
              onRelayout={handleRelayout}
              onAfterPlot={handleAfterPlot}
            />
          )}
          {!isLoading && hasMusic && !hasData && (
            <div className="frpink-message">Preparing pink-noise comparison...</div>
          )}
        </div>
      </div>

      <FullscreenModal
        isOpen={isFullscreenOpen}
        onClose={() => setIsFullscreenOpen(false)}
        title="Spectrum vs Pink"
        size="wide"
        bodyClassName="fullscreen-modal__body--stretch"
      >
        <div className="frpink-modal">
          <PinkOffsetControl
            value={pinkOffsetDb}
            min={PINK_OFFSET_MIN}
            max={PINK_OFFSET_MAX}
            step={PINK_OFFSET_STEP}
            onChange={handleOffsetChange}
            onStep={handleOffsetStep}
            onReset={handleOffsetReset}
            disabled={!hasData}
            variant="modal"
          />
          <div className="fullscreen-modal__plot frpink-modal__plot">
            {hasData ? (
              <Plot
                data={traces}
                layout={layout}
                config={config}
                useResizeHandler
                style={{ width: "100%", height: "100%" }}
                onRelayout={handleRelayout}
                onAfterPlot={handleAfterPlot}
              />
            ) : (
              <div className="frpink-message">Load a music track to view the spectrum.</div>
            )}
          </div>
        </div>
      </FullscreenModal>
    </>
  );
}

function serializeBuffer(buffer: AudioBuffer, maxSeconds: number) {
  const totalLength = buffer.length;
  const channels = buffer.numberOfChannels;
  const maxSamples = Math.min(totalLength, Math.max(0, Math.floor(buffer.sampleRate * maxSeconds)));
  const length = Math.max(0, maxSamples);
  if (length === 0) {
    return { data: new Float32Array(0), sampleRate: buffer.sampleRate };
  }
  const start = length < totalLength ? Math.floor((totalLength - length) / 2) : 0;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const channel = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channel[start + i];
    }
  }
  if (channels > 0) {
    const inv = 1 / channels;
    for (let i = 0; i < length; i++) {
      mono[i] *= inv;
    }
  }
  return { data: mono, sampleRate: buffer.sampleRate };
}













