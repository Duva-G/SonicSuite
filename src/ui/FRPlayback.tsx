// WHY: Renders the playback frequency response overlaying dry and convolved music.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";

type SmoothingMode = "1/24" | "1/12" | "1/6" | "1/3";

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
type PlotComponentProps = ComponentProps<typeof Plot>;
type PlotDataArray = NonNullable<PlotComponentProps["data"]>;
type PlotDatum = PlotDataArray[number];
type PlotLayout = NonNullable<PlotComponentProps["layout"]>;
type PlotConfig = NonNullable<PlotComponentProps["config"]>;

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);
const DEFAULT_LOG_RANGE: [number, number] = [LOG_MIN, LOG_MAX];

const smoothingOptions: Array<{ value: SmoothingMode; label: string }> = [
  { value: "1/24", label: "1/24 octave" },
  { value: "1/12", label: "1/12 octave" },
  { value: "1/6", label: "1/6 octave" },
  { value: "1/3", label: "1/3 octave" },
];

export default function FRPlayback({ musicBuffer, irBuffer, sampleRate }: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
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
          rangemode: "normal" as const,
          title: { text: "Magnitude (dB)", font: { color: "#f5f5f7" } },
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.12)",
          zeroline: true,
          zerolinecolor: "rgba(255,255,255,0.35)",
          tickfont: { size: 12, color: "#f5f5f7" },
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
    const worker = new Worker(new URL("../workers/dspWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setWorkerReady(true);

    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "playback-fr-result") {
        if (data.requestId !== activeRequestRef.current) return;
        pendingRenderRef.current = true;
        setSpectra(data.payload);
        setError(null);
      } else if (data.type === "playback-fr-error") {
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
    if (!musicBuffer) {
      setSpectra(null);
      pendingRenderRef.current = false;
      setLoading(false);
      setError("Load a music track to inspect its response.");
      return;
    }
    const worker = workerRef.current;
    if (!worker) return;

    const requestId = ++requestIdRef.current;
    activeRequestRef.current = requestId;
    pendingRenderRef.current = false;
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

  const traces = useMemo<PlotDataArray>(() => {
    if (!spectra) return [] as PlotDataArray;
    const baseHover = "<b>%{x:.0f} Hz</b><br>%{y:.2f} dB<extra></extra>";
    const freqs = Array.from(spectra.freqs);
    const sanitizedFreqs = freqs.map((hz) => (hz > 0 ? hz : MIN_FREQ));
    const series: number[][] = [Array.from(spectra.dryDb)];

    if (spectra.hasIR && spectra.wetDb) {
      series.push(Array.from(spectra.wetDb));
    }

    const { arrays } = normalizePlaybackSeries(series);
    const dryNormalized = arrays[0] ?? [];
    const result: PlotDatum[] = [
      {
        type: "scatter",
        mode: "lines",
        name: "Original (music)",
        hovertemplate: baseHover,
        x: sanitizedFreqs,
        y: dryNormalized,
        line: { color: "#5ac8fa", width: 2 },
      } as PlotDatum,
    ];

    if (spectra.hasIR && arrays[1]) {
      result.push({
        type: "scatter",
        mode: "lines",
        name: "Convolved",
        hovertemplate: baseHover,
        x: sanitizedFreqs,
        y: arrays[1],
        line: { color: "#ff9f0a", width: 2 },
      } as PlotDatum);
    }

    return result as PlotDataArray;
  }, [spectra]);

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
        toImageButtonOptions: {
          format: "png" as const,
          filename: "fr-playback-response",
          height: 700,
          width: 1200,
          scale: 2,
        },
      }) as PlotConfig,
    []
  );

  return (
    <div className="frpink frplayback">
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
      </div>

      {error && <div className="frpink-message frpink-message--error">{error}</div>}
      {!isLoading && spectra && !irBuffer && (
        <div className="frpink-message">Load an impulse response to overlay the convolved response.</div>
      )}
      {!isLoading && spectra && irBuffer && !spectra.hasIR && (
        <div className="frpink-message">Overlay pending—try matching RMS before reanalysing.</div>
      )}

      <div className="frpink-plot">
        {isLoading && (
          <div className="frplot-progress" role="status" aria-live="polite">
            <div className="frplot-progress__track">
              <div className="frplot-progress__bar" />
            </div>
            <span className="frplot-progress__label">Preparing spectrum</span>
          </div>
        )}
        {spectra && (
          <Plot
            data={traces}
            layout={layout}
            config={config}
            useResizeHandler
            style={{ width: "100%", height: "100%", minHeight: 320 }}
            onRelayout={handleRelayout}
            onAfterPlot={handleAfterPlot}
          />
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

function normalizePlaybackSeries(series: number[][]): { arrays: number[][] } {
  if (series.length === 0) {
    return { arrays: [] };
  }

  let peak = Number.NEGATIVE_INFINITY;
  for (const arr of series) {
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      if (!Number.isFinite(value)) continue;
      if (value > peak) peak = value;
    }
  }

  if (!Number.isFinite(peak)) {
    peak = 0;
  }

  let min = Number.POSITIVE_INFINITY;
  const centered = series.map((source) => {
    const normalized: number[] = new Array(source.length);
    for (let i = 0; i < source.length; i++) {
      const value = source[i];
      const normalizedValue = Number.isFinite(value) ? value - peak : Number.NaN;
      normalized[i] = normalizedValue;
      if (Number.isFinite(normalizedValue) && normalizedValue < min) {
        min = normalizedValue;
      }
    }
    return normalized;
  });

  const offset = Number.isFinite(min) ? -min : 0;

  return {
    arrays: centered.map((source) => {
      const shifted: number[] = new Array(source.length);
      for (let i = 0; i < source.length; i++) {
        const value = source[i];
        shifted[i] = Number.isFinite(value) ? Math.max(0, value + offset) : Number.NaN;
      }
      return shifted;
    }),
  };
}
