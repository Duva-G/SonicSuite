// WHY: Visualises the delta between dry and convolved playback spectra.
import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";

type SmoothingMode = "1/12" | "1/6" | "1/3";

type WorkerResultPayload = {
  freqs: Float32Array;
  dryDb: Float32Array;
  wetDb: Float32Array | null;
  hasIR: boolean;
};

type WorkerResultMessage = {
  type: "playback-fr-result";
  requestId: number;
  payload: WorkerResultPayload;
};

type WorkerErrorMessage = {
  type: "playback-fr-error";
  requestId: number;
  error: string;
};

type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

type Props = {
  musicBuffer: AudioBuffer | null;
  irBuffer: AudioBuffer | null;
  sampleRate: number;
};

const Plot = createPlotlyComponent(Plotly);
type PlotProps = ComponentProps<typeof Plot>;
type PlotLayout = NonNullable<PlotProps["layout"]>;

type DifferenceSpectra = WorkerResultPayload & { diffDb: Float32Array | null };

const MIN_FREQ = 20;
const MAX_FREQ = 20000;

const smoothingOptions: Array<{ value: SmoothingMode; label: string }> = [
  { value: "1/12", label: "1/12 octave" },
  { value: "1/6", label: "1/6 octave" },
  { value: "1/3", label: "1/3 octave" },
];

export default function FRDifference({ musicBuffer, irBuffer, sampleRate }: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
  const [spectra, setSpectra] = useState<DifferenceSpectra | null>(null);
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
      if (data.type === "playback-fr-result") {
        if (data.requestId !== activeRequestRef.current) return;
        const payload = data.payload;
        const diff = payload.wetDb ? computeDifference(payload.dryDb, payload.wetDb) : null;
        setSpectra({ ...payload, diffDb: diff });
        setLoading(false);
        setError(null);
      } else if (data.type === "playback-fr-error") {
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
    if (!musicBuffer) {
      setSpectra(null);
      setLoading(false);
      setError("Load a music track to compare its convolved difference.");
      return;
    }
    const worker = workerRef.current;
    if (!worker) return;

    const requestId = ++requestIdRef.current;
    activeRequestRef.current = requestId;
    setLoading(true);
    setError(null);

    const musicPayload = serializeBuffer(musicBuffer, "music");
    const irPayload = irBuffer ? serializeBuffer(irBuffer, "ir") : null;
    const transferables: Transferable[] = [musicPayload.data.buffer];
    if (irPayload) transferables.push(irPayload.data.buffer);

    worker.postMessage(
      {
        type: "compute-playback-fr",
        requestId,
        payload: {
          sampleRate,
          smoothing,
          music: {
            data: musicPayload.data,
            sampleRate: musicPayload.sampleRate,
            label: "Music",
          },
          ir: irPayload
            ? {
                data: irPayload.data,
                sampleRate: irPayload.sampleRate,
                label: "IR",
              }
            : null,
        },
      },
      transferables
    );
  }, [workerReady, musicBuffer, irBuffer, sampleRate, smoothing]);

  const trace = useMemo(() => {
    if (!spectra?.diffDb || !spectra.wetDb) return null;
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      name: "Wet - Dry (dB)",
      x: spectra.freqs,
      y: spectra.diffDb,
      line: { color: "#ff7b84", width: 2 },
      hovertemplate: "<b>%{x:.0f} Hz</b><br>%{y:.2f} dB<extra></extra>",
    };
  }, [spectra]);

  const layout = useMemo<PlotLayout>(
    () => ({
      autosize: true,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(28,28,30,0.6)",
      font: { color: "#f2f2f7", family: "Inter, system-ui, sans-serif" },
      margin: { l: 64, r: 24, t: 24, b: 64 },
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: "rgba(20,20,22,0.92)",
        bordercolor: "rgba(255,255,255,0.25)",
        font: { color: "#f5f5f7" },
      },
      legend: {
        orientation: "h",
        yanchor: "bottom",
        y: -0.25,
        x: 0,
        xanchor: "left",
        font: { size: 12, color: "#f5f5f7" },
      },
      xaxis: {
        type: "log",
        autorange: true,
        autorangeoptions: { clipmin: MIN_FREQ, clipmax: MAX_FREQ },
        title: { text: "Frequency (Hz)", font: { color: "#f5f5f7" } },
        showgrid: true,
        gridcolor: "rgba(255,255,255,0.12)",
        tickfont: { size: 12, color: "#f5f5f7" },
        ticks: "outside",
        tickcolor: "rgba(255,255,255,0.35)",
        ticklen: 6,
      },
      yaxis: {
        autorange: true,
        title: { text: "Magnitude delta (dB)", font: { color: "#f5f5f7" } },
        zeroline: true,
        zerolinecolor: "rgba(255,255,255,0.35)",
        showgrid: true,
        gridcolor: "rgba(255,255,255,0.12)",
        tickfont: { size: 12, color: "#f5f5f7" },
      },
      shapes: [
        {
          type: "line",
          xref: "paper",
          x0: 0,
          x1: 1,
          yref: "y",
          y0: 0,
          y1: 0,
          line: { color: "rgba(255,255,255,0.3)", width: 1, dash: "dot" },
        },
      ],
    }),
    []
  );

  const config = useMemo(
    () => ({
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      toImageButtonOptions: {
        format: "png" as const,
        filename: "fr-difference-response",
        height: 700,
        width: 1200,
        scale: 2,
      },
    }),
    []
  );

  return (
    <div className="frpink frdifference">
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
      </div>

      {error && <div className="frpink-message frpink-message--error">{error}</div>}
      {isLoading && <div className="frpink-message">Analysing the difference between dry and wet spectra.</div>}
      {!isLoading && !error && !spectra && (
        <div className="frpink-message">Load a music track and impulse response to inspect the delta.</div>
      )}
      {!isLoading && spectra && !spectra.hasIR && (
        <div className="frpink-message">Load an impulse response to inspect the difference curve.</div>
      )}

      <div className="frpink-plot">
        {isLoading && (
          <div className="frplot-loader" role="status" aria-live="polite">
            <div className="frplot-loader__progress">
              <div className="frplot-loader__bar" />
            </div>
            <span className="frplot-loader__text">Calculating difference curve...</span>
          </div>
        )}
        {trace && (
          <Plot
            data={[trace]}
            layout={layout}
            config={config}
            useResizeHandler
            style={{ width: "100%", height: "100%" }}
          />
        )}
        {!isLoading && spectra && spectra.hasIR && !trace && (
          <div className="frpink-message">Rendering difference data...</div>
        )}
      </div>
    </div>
  );
}

function computeDifference(dry: Float32Array, wet: Float32Array): Float32Array {
  const len = Math.min(dry.length, wet.length);
  const diff = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    diff[i] = wet[i] - dry[i];
  }
  return diff;
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
