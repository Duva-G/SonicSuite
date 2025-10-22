// WHY: Presents the pink-noise frequency response UI and coordinates DSP worker requests.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
import { createModuleWorker } from "../utils/workerSupport";

type SmoothingMode = "1/12" | "1/6" | "1/3";

type WorkerResultPayload = {
  freqs: Float32Array;
  pinkDb: Float32Array;
  convolvedDb: Float32Array | null;
  transferDb: Float32Array | null;
  hasIR: boolean;
  irLabel: string | null;
};

type WorkerResultMessage = {
  type: "fr-result";
  requestId: number;
  payload: WorkerResultPayload;
};

type WorkerErrorMessage = {
  type: "fr-error";
  requestId: number;
  error: string;
};

type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

type Props = {
  irBuffer: AudioBuffer | null;
  sampleRate: number;
  label: "A" | "B" | "C";
};

const Plot = createPlotlyComponent(Plotly);
type PlotComponentProps = ComponentProps<typeof Plot>;
type PlotDataArray = NonNullable<PlotComponentProps["data"]>;
type PlotDatum = PlotDataArray[number];
type PlotLayout = NonNullable<PlotComponentProps["layout"]>;
type PlotConfig = NonNullable<PlotComponentProps["config"]>;

const smoothingOptions: Array<{ value: SmoothingMode; label: string }> = [
  { value: "1/12", label: "1/12 octave" },
  { value: "1/6", label: "1/6 octave" },
  { value: "1/3", label: "1/3 octave" },
];

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);
const DEFAULT_LOG_RANGE: [number, number] = [LOG_MIN, LOG_MAX];

export default function FRPink({ irBuffer, sampleRate, label }: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
  const [showTransfer, setShowTransfer] = useState(false);
  const [spectra, setSpectra] = useState<WorkerResultPayload | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(0);
  const pendingRenderRef = useRef(false);

  const createBaseLayout = useCallback(
    () =>
      ({
        autosize: true,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(28,28,30,0.6)",
        font: { color: "#f2f2f7", family: "Inter, system-ui, sans-serif" },
        margin: { l: 64, r: 24, t: 24, b: 64 },
        hovermode: "x unified" as const,
        hoverlabel: {
          bgcolor: "rgba(20,20,22,0.92)",
          bordercolor: "rgba(255,255,255,0.25)",
          font: { color: "#f5f5f7" },
        },
        legend: {
          orientation: "h" as const,
          yanchor: "bottom" as const,
          y: -0.25,
          x: 0,
          xanchor: "left" as const,
          font: { size: 12, color: "#f5f5f7" },
        },
        xaxis: {
          type: "log" as const,
          range: [...DEFAULT_LOG_RANGE],
          autorange: false,
          dtick: 1,
          title: { text: "Frequency (Hz)", font: { color: "#f5f5f7" } },
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.12)",
          tickfont: { size: 12, color: "#f5f5f7" },
          ticks: "outside" as const,
          tickcolor: "rgba(255,255,255,0.35)",
          ticklen: 6,
          fixedrange: false,
        },
        yaxis: {
          autorange: true,
          title: { text: "Magnitude (dB)", font: { color: "#f5f5f7" } },
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.12)",
          tickfont: { size: 12, color: "#f5f5f7" },
          zeroline: true,
          zerolinecolor: "rgba(255,255,255,0.35)",
        },
      }) as PlotLayout,
    []
  );

  const [layout, setLayout] = useState<PlotLayout>(() => createBaseLayout());
  const resetAxes = useCallback(() => {
    setLayout(createBaseLayout());
  }, [createBaseLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const { worker, error } = createModuleWorker(new URL("../workers/dspWorker.ts", import.meta.url));
    if (!worker) {
      if (error) {
        console.warn("Pink-noise analysis worker unavailable.", error);
      }
      setWorkerReady(false);
      setError("Pink-noise analysis is unavailable in this browser (missing Web Worker support).");
      return;
    }
    workerRef.current = worker;
    setWorkerReady(true);

    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "fr-result") {
        if (data.requestId !== activeRequestRef.current) return;
        pendingRenderRef.current = true;
        setSpectra(data.payload);
        setError(null);
      } else if (data.type === "fr-error") {
        if (data.requestId !== activeRequestRef.current) return;
        pendingRenderRef.current = false;
        setSpectra(null);
        setLoading(false);
        setError(data.error);
      }
    };

    worker.addEventListener("message", handleMessage);

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workerReady) return;
    if (sampleRate <= 0) return;
    const worker = workerRef.current;
    if (!worker) return;

    const requestId = ++requestIdRef.current;
    activeRequestRef.current = requestId;
    pendingRenderRef.current = false;
    setLoading(true);
    setError(null);

    const irPayload = irBuffer ? serializeBuffer(irBuffer, label) : null;
    const transferables: ArrayBuffer[] = irPayload ? [irPayload.data.buffer] : [];

    worker.postMessage(
      {
        type: "compute-fr",
        requestId,
        payload: {
          sampleRate,
          smoothing,
          ir: irPayload,
        },
      },
      transferables
    );
  }, [workerReady, irBuffer, sampleRate, smoothing, label]);

  const traces = useMemo<PlotDataArray>(() => {
    if (!spectra) return [] as PlotDataArray;
    const baseStyle = {
      hovertemplate: "<b>%{text}</b><br>%{x:.0f} Hz<br>%{y:.2f} dB<extra></extra>",
    };

    const freqs = Array.from(spectra.freqs);
    const sanitizedFreqs = freqs.map((hz) => (hz > 0 ? hz : MIN_FREQ));
    const makeText = (label: string) => Array.from({ length: sanitizedFreqs.length }, () => label);

    const items: PlotDatum[] = [
      {
        type: "scatter" as const,
        mode: "lines" as const,
        name: "Pink noise",
        x: sanitizedFreqs,
        y: spectra.pinkDb,
        text: makeText("Pink noise"),
        line: { color: "#ff9f0a", width: 1.5 },
        ...baseStyle,
      } as PlotDatum,
    ];

    if (spectra.convolvedDb) {
      items.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name: spectra.irLabel ? `Convolved (${spectra.irLabel})` : "Convolved",
        x: sanitizedFreqs,
        y: spectra.convolvedDb,
        text: makeText("Convolved"),
        line: { color: "#0a84ff", width: 1.5 },
        ...baseStyle,
      } as PlotDatum);
    }

    if (spectra.transferDb && showTransfer) {
      items.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name: "Transfer",
        x: sanitizedFreqs,
        y: spectra.transferDb,
        text: makeText("Transfer"),
        line: { color: "#ffd60a", width: 1.3, dash: "dot" },
        ...baseStyle,
      } as PlotDatum);
    }

    return items as PlotDataArray;
  }, [spectra, showTransfer]);

  useEffect(() => {
    if (!spectra) return;
    resetAxes();
  }, [spectra, resetAxes]);

  const handleRelayout = (eventData: Partial<Record<string, unknown>>) => {
    if (!eventData) return;
    const xAuto = eventData["xaxis.autorange"] === true;
    const yAuto = eventData["yaxis.autorange"] === true;
    const xMin = eventData["xaxis.range[0]"];
    const xMax = eventData["xaxis.range[1]"];
    const outOfRange =
      typeof xMin === "number" && typeof xMax === "number" && (xMin < LOG_MIN || xMax > LOG_MAX);
    if (xAuto || outOfRange) {
      resetAxes();
      return;
    }
    if (yAuto) {
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
        displayModeBar: true,
        modeBarButtonsToRemove: ["select2d", "lasso2d"],
        toImageButtonOptions: {
          format: "png" as const,
          filename: "fr-pink-response",
          height: 700,
          width: 1200,
          scale: 2,
        },
      }) as PlotConfig,
    []
  );

  return (
    <div className="frpink">
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
            checked={showTransfer}
            onChange={(e) => setShowTransfer(e.target.checked)}
          />
          <span>Show transfer function (pink&gt;IR / pink)</span>
        </label>
      </div>

      {error && <div className="frpink-message frpink-message--error">{error}</div>}
      {!isLoading && spectra && !spectra.hasIR && (
        <div className="frpink-message">Load an impulse response to compare the overlay.</div>
      )}

      <div className="frpink-plot">
        {isLoading && (
          <div className="frplot-progress" role="status" aria-live="polite">
            <div className="frplot-progress__track">
              <div className="frplot-progress__bar" />
            </div>
            <span className="frplot-progress__label">Preparing pink-noise response</span>
          </div>
        )}
        {spectra ? (
          <Plot
            data={traces}
            layout={layout}
            config={config}
            useResizeHandler
            style={{ width: "100%", height: "100%", minHeight: 320 }}
            onRelayout={handleRelayout}
            onAfterPlot={handleAfterPlot}
          />
        ) : (
          !isLoading && <div className="frpink-placeholder">Generating baseline pink-noise response.</div>
        )}
      </div>
    </div>
  );
}

function serializeBuffer(buffer: AudioBuffer, label: string) {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const channel = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channel[i];
    }
  }
  if (channels > 0) {
    const inv = 1 / channels;
    for (let i = 0; i < length; i++) {
      mono[i] *= inv;
    }
  }
  return { data: mono, sampleRate: buffer.sampleRate, label };
}

