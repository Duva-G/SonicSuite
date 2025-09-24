// WHY: Presents the pink-noise frequency response UI and coordinates DSP worker requests.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const worker = new Worker(new URL("../workers/dspWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setWorkerReady(true);

    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "fr-result") {
        if (data.requestId !== activeRequestRef.current) return;
        setSpectra(data.payload);
        setLoading(false);
        setError(null);
      } else if (data.type === "fr-error") {
        if (data.requestId !== activeRequestRef.current) return;
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

    const items: PlotDatum[] = [
      {
        type: "scatter" as const,
        mode: "lines" as const,
        name: "Pink noise",
        x: spectra.freqs,
        y: spectra.pinkDb,
        text: Array.from({ length: spectra.freqs.length }, () => "Pink noise"),
        line: { color: "#ff9f0a", width: 1.5 },
        ...baseStyle,
      } as PlotDatum,
    ];

    if (spectra.convolvedDb) {
      items.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name: spectra.irLabel ? `Convolved (${spectra.irLabel})` : "Convolved",
        x: spectra.freqs,
        y: spectra.convolvedDb,
        text: Array.from({ length: spectra.freqs.length }, () => "Convolved"),
        line: { color: "#0a84ff", width: 1.5 },
        ...baseStyle,
      } as PlotDatum);
    }

    if (spectra.transferDb && showTransfer) {
      items.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name: "Transfer",
        x: spectra.freqs,
        y: spectra.transferDb,
        text: Array.from({ length: spectra.freqs.length }, () => "Transfer"),
        line: { color: "#ffd60a", width: 1.3, dash: "dot" },
        ...baseStyle,
      } as PlotDatum);
    }

    return items as PlotDataArray;
  }, [spectra, showTransfer]);

  const layout = useMemo<PlotLayout>(
    () =>
      ({
        autosize: true,
        height: 480,
        margin: { t: 24, r: 20, l: 48, b: 48 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(28,28,30,0.6)",
        font: { color: "#f2f2f7", family: "Inter, system-ui, sans-serif", size: 12 },
        xaxis: {
          title: { text: "Frequency (Hz)" },
          type: "log" as const,
          autorange: true,
          zeroline: false,
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.12)",
          tickfont: { size: 12 },
          rangeslider: { visible: false },
          minor: { ticklen: 4, showgrid: false },
        },
        yaxis: {
          title: { text: "Magnitude (dB)" },
          autorange: true,
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.12)",
          zeroline: true,
          zerolinecolor: "rgba(255,255,255,0.3)",
          tickfont: { size: 12 },
        },
      }) as PlotLayout,
    []
  );

  const config = useMemo<PlotConfig>(
    () =>
      ({
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
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

  function handleExportCsv() {
    if (!spectra) return;
    const rows: string[] = ["frequency_hz,pink_db,convolved_db,transfer_db"];
    const len = spectra.freqs.length;
    const hasConv = Boolean(spectra.convolvedDb);
    const hasTransfer = Boolean(spectra.transferDb);
    for (let i = 0; i < len; i++) {
      const f = spectra.freqs[i];
      const pink = spectra.pinkDb[i];
      const conv = hasConv ? spectra.convolvedDb![i] : null;
      const tf = hasTransfer ? spectra.transferDb![i] : null;
      rows.push(
        [
          f.toFixed(2),
          pink.toFixed(4),
          conv != null ? conv.toFixed(4) : "",
          tf != null ? tf.toFixed(4) : "",
        ].join(",")
      );
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fr-pink-${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="frpink">
      <div className="frpink-controls">
        <label className="frpink-control">
          <span className="frpink-control__label">Smoothing</span>
          <select
            className="frpink-control__select"
            value={smoothing}
            onChange={(e) => setSmoothing(e.target.value as SmoothingMode)}
          >
            {smoothingOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="frpink-checkbox">
          <input
            type="checkbox"
            checked={showTransfer}
            onChange={(e) => setShowTransfer(e.target.checked)}
          />
          <span>Show transfer function (pink&gt;IR / pink)</span>
        </label>
        <button
          type="button"
          className="control-button button-ghost frpink-export"
          onClick={handleExportCsv}
          disabled={!spectra}
        >
          Export CSV
        </button>
      </div>

      {error && <div className="frpink-message frpink-message--error">{error}</div>}
      {isLoading && <div className="frpink-message">Analyzing 30 s of pink noise.</div>}
      {!isLoading && spectra && !spectra.hasIR && (
        <div className="frpink-message">Load an impulse response to compare the overlay.</div>
      )}

      <div className="frpink-plot">
        {isLoading && (
          <div className="frplot-loader" role="status" aria-live="polite">
            <div className="frplot-loader__progress">
              <div className="frplot-loader__bar" />
            </div>
            <span className="frplot-loader__text">Simulating pink-noise response...</span>
          </div>
        )}
        {spectra ? (
          <Plot data={traces} layout={layout} config={config} useResizeHandler style={{ width: "100%", height: "100%" }} />
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

