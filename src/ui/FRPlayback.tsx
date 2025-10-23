// WHY: Renders the playback frequency response overlaying dry and convolved music.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
import { createModuleWorker } from "../utils/workerSupport";

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
  irBufferB?: AudioBuffer | null;
  sampleRate: number;
};

const Plot = createPlotlyComponent(Plotly);
type PlotComponentProps = ComponentProps<typeof Plot>;
type PlotDataArray = NonNullable<PlotComponentProps["data"]>;
type PlotDatum = PlotDataArray[number];
type PlotLayout = NonNullable<PlotComponentProps["layout"]>;
type PlotConfig = NonNullable<PlotComponentProps["config"]>;
type RequestKind = "dry" | "wetA" | "wetB";
type PlaybackSpectraSet = {
  dry: WorkerResultPayload | null;
  convolvedA: WorkerResultPayload | null;
  convolvedB: WorkerResultPayload | null;
};

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

const MAX_PLAYBACK_ANALYSIS_SECONDS = 30;
const PLAYBACK_COLORS = {
  original: "#0a84ff",
  convolvedA: "#30d158",
  convolvedB: "#ff9f0a",
} as const;

export default function FRPlayback({ musicBuffer, irBuffer: irBufferA, irBufferB = null, sampleRate }: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
  const [spectraSet, setSpectraSet] = useState<PlaybackSpectraSet>(() => ({
    dry: null,
    convolvedA: null,
    convolvedB: null,
  }));
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const generationRef = useRef(0);
  const pendingRenderRef = useRef(false);
  const requestKindMapRef = useRef(new Map<number, { kind: RequestKind; generation: number }>());
  const expectedKindsRef = useRef<Set<RequestKind>>(new Set());
  const responsesRef = useRef<PlaybackSpectraSet>({ dry: null, convolvedA: null, convolvedB: null });

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
    const { worker, error } = createModuleWorker(new URL("../workers/dspWorker.ts", import.meta.url));
    if (!worker) {
      if (error) {
        console.warn("Playback FR worker unavailable.", error);
      }
      setWorkerReady(false);
      setError("Playback frequency analysis is unavailable in this browser (missing Web Worker support).");
      return;
    }
    workerRef.current = worker;
    setWorkerReady(true);

    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type !== "playback-fr-result" && data.type !== "playback-fr-error") {
        return;
      }

      const meta = requestKindMapRef.current.get(data.requestId);
      if (!meta) {
        return;
      }

      requestKindMapRef.current.delete(data.requestId);
      if (meta.generation !== generationRef.current) {
        return;
      }

      const { kind } = meta;

      if (data.type === "playback-fr-result") {
        if (kind === "dry") {
          responsesRef.current.dry = data.payload;
        } else if (kind === "wetA") {
          responsesRef.current.convolvedA = data.payload;
        } else if (kind === "wetB") {
          responsesRef.current.convolvedB = data.payload;
        }
        setSpectraSet({
          dry: responsesRef.current.dry,
          convolvedA: responsesRef.current.convolvedA,
          convolvedB: responsesRef.current.convolvedB,
        });
        setError(null);
      } else {
        if (kind === "dry") {
          responsesRef.current.dry = null;
        } else if (kind === "wetA") {
          responsesRef.current.convolvedA = null;
        } else if (kind === "wetB") {
          responsesRef.current.convolvedB = null;
        }
        setSpectraSet({
          dry: responsesRef.current.dry,
          convolvedA: responsesRef.current.convolvedA,
          convolvedB: responsesRef.current.convolvedB,
        });
        setError(data.error);
      }

      expectedKindsRef.current.delete(kind);
      const stillPending = expectedKindsRef.current.size > 0;
      setLoading(stillPending);
      if (!stillPending) {
        pendingRenderRef.current = true;
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
    const worker = workerRef.current;
    if (!worker) return;

    if (!musicBuffer) {
      requestKindMapRef.current.clear();
      expectedKindsRef.current.clear();
      responsesRef.current = { dry: null, convolvedA: null, convolvedB: null };
      setSpectraSet({ dry: null, convolvedA: null, convolvedB: null });
      pendingRenderRef.current = false;
      setLoading(false);
      setError("Load a music track to compare its convolved response.");
      return;
    }

    generationRef.current += 1;
    const currentGeneration = generationRef.current;
    requestKindMapRef.current.clear();
    responsesRef.current = { dry: null, convolvedA: null, convolvedB: null };
    setSpectraSet({ dry: null, convolvedA: null, convolvedB: null });
    pendingRenderRef.current = false;
    setError(null);

    const pendingKinds: RequestKind[] = ["dry"];
    if (irBufferA) pendingKinds.push("wetA");
    if (irBufferB) pendingKinds.push("wetB");

    if (pendingKinds.length === 0) {
      setLoading(false);
      return;
    }

    expectedKindsRef.current = new Set(pendingKinds);
    setLoading(true);

    const makePayload = (buffer: AudioBuffer, label: string) =>
      serializeBuffer(buffer, label, MAX_PLAYBACK_ANALYSIS_SECONDS);

    for (const kind of pendingKinds) {
      const requestId = ++requestIdRef.current;
      requestKindMapRef.current.set(requestId, { kind, generation: currentGeneration });

      const musicPayload = makePayload(musicBuffer, "music");
      const irSource = kind === "wetA" ? irBufferA : kind === "wetB" ? irBufferB : null;
      const irPayload = irSource ? makePayload(irSource, kind === "wetB" ? "ir-b" : "ir") : null;

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
                  label: kind === "wetB" ? "IR B" : "IR",
                }
              : null,
          },
        },
        transferables
      );
    }
  }, [workerReady, musicBuffer, irBufferA, irBufferB, sampleRate, smoothing]);

  const traces = useMemo<PlotDataArray>(() => {
    const dry = spectraSet.dry;
    if (!dry) return [] as PlotDataArray;

    const freqs = Array.from(dry.freqs);
    const sanitizedFreqs = freqs.map((hz) => (hz > 0 ? hz : MIN_FREQ));
    const baseHover = "<b>%{customdata}</b><br><b>%{x:.0f} Hz</b><br>%{y:.2f} dB<extra></extra>";

    const series: number[][] = [];
    const meta: Array<{ key: "original" | "convolvedA" | "convolvedB"; name: string }> = [];

    series.push(Array.from(dry.dryDb));
    meta.push({ key: "original", name: "Original" });

    if (spectraSet.convolvedA?.wetDb) {
      series.push(Array.from(spectraSet.convolvedA.wetDb));
      meta.push({ key: "convolvedA", name: "Convolved A" });
    }

    if (spectraSet.convolvedB?.wetDb) {
      series.push(Array.from(spectraSet.convolvedB.wetDb));
      meta.push({ key: "convolvedB", name: "Convolved B" });
    }

    const { arrays } = normalizePlaybackSeries(series);

    const result: PlotDatum[] = meta.map((entry, idx) => {
      const yValues = arrays[idx] ?? [];
      return {
        type: "scatter",
        mode: "lines",
        name: entry.name,
        hovertemplate: baseHover,
        customdata: new Array(yValues.length).fill(entry.name),
        x: sanitizedFreqs,
        y: yValues,
        line: { color: PLAYBACK_COLORS[entry.key], width: 2 },
      } as PlotDatum;
    });

    return result as PlotDataArray;
  }, [spectraSet]);

  useEffect(() => {
    if (!spectraSet.dry) return;
    resetAxes();
  }, [spectraSet.dry, resetAxes]);


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

  const hasDry = Boolean(spectraSet.dry);
  const hasWetA = Boolean(spectraSet.convolvedA?.wetDb);
  const hasWetB = Boolean(spectraSet.convolvedB?.wetDb);
  const showNoIrMessage = !isLoading && hasDry && !irBufferA && !irBufferB;
  const showWetAPending = !isLoading && Boolean(irBufferA) && !hasWetA;
  const showWetBPending = !isLoading && Boolean(irBufferB) && !hasWetB;

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
      {showNoIrMessage && (
        <div className="frpink-message">Load an impulse response to overlay the convolved responses.</div>
      )}
      {showWetAPending && (
        <div className="frpink-message">Convolved A overlay pending - try matching RMS before reanalysing.</div>
      )}
      {showWetBPending && (
        <div className="frpink-message">Convolved B overlay pending - try matching RMS before reanalysing.</div>
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
        {hasDry && (
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

function serializeBuffer(buffer: AudioBuffer, label: string, maxSeconds?: number) {
  const totalLength = buffer.length;
  const channels = buffer.numberOfChannels;
  const maxSamples = maxSeconds
    ? Math.min(totalLength, Math.max(0, Math.floor(buffer.sampleRate * maxSeconds)))
    : totalLength;
  const length = Math.max(0, maxSamples);
  if (length === 0) {
    return { data: new Float32Array(0), sampleRate: buffer.sampleRate, label };
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
