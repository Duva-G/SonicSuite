// WHY: Renders waveform views for single or multi-trace audio buffers.
import type React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { downsample, MAX_POINTS } from "../audio/downsample";
import type { DownsampleInput, DownsampleOutput } from "../audio/downsample";

type WaveformMode = "A" | "B" | "diff";
type OverlayTrace = {
  label: string;
  times: Float32Array;
  samples: Float32Array;
  color: string;
  opacity?: number;
  dash?: "solid" | "dot" | "dash" | "dashdot";
};
type Region = {
  start: number;
  end: number;
};

type SingleWaveformProps = {
  variant?: "single";
  buffer: AudioBuffer;
  color: string;
  title: string;
  mode?: WaveformMode;
  overlayTraces?: OverlayTrace[];
  regions?: Region[];
};

type TraceId = "original" | "convolvedA" | "convolvedB";
type DifferenceId = "origMinusA" | "origMinusB" | "aMinusB";

type BaseTraceInput = {
  buffer: AudioBuffer | null;
  latencySeconds?: number;
  channelLabels?: string[];
};

type DifferenceSpec = {
  id: DifferenceId;
  label?: string;
  minuend: TraceId;
  subtrahend: TraceId;
};

type ViewWindow = {
  start: number;
  end: number;
};

type MultiWaveformProps = {
  variant: "multi";
  title?: string;
  traces: {
    original: BaseTraceInput;
    convolvedA?: BaseTraceInput;
    convolvedB?: BaseTraceInput;
  };
  differences?: DifferenceSpec[];
  viewWindow?: ViewWindow;
};

type Props = SingleWaveformProps | MultiWaveformProps;

type ChannelColor = {
  stroke: string;
  fill: string;
};

type RGB = {
  r: number;
  g: number;
  b: number;
};

const DOWN_SAMPLE_WORKER_URL = new URL(
  "./workers/downsampleWorker.ts",
  import.meta.url,
);

const IOS_FALLBACK_PALETTE: ChannelColor[] = [
  {
    stroke: "rgba(10, 132, 255, 0.95)",
    fill: "rgba(10, 132, 255, 0.25)",
  },
  {
    stroke: "rgba(48, 209, 88, 0.9)",
    fill: "rgba(48, 209, 88, 0.22)",
  },
  {
    stroke: "rgba(255, 159, 10, 0.88)",
    fill: "rgba(255, 159, 10, 0.24)",
  },
];

const DEFAULT_AXIS_EXTENT = 1;
const MIN_VISIBLE_Y_EXTENT = 1e-6;
const Y_EXTENT_PADDING = 1.05;
const Y_EXTENT_EPSILON = 1e-9;
const DEFAULT_LAYOUT_HEIGHT = 320;

const BASE_TRACE_META: Record<
  TraceId,
  { label: string; color: string; missingMessage?: string }
> = {
  original: {
    label: "Original",
    color: "#5ac8fa",
    missingMessage: "Load original source",
  },
  convolvedA: {
    label: "Convolved A",
    color: "#ff9f0a",
    missingMessage: "Load IR A",
  },
  convolvedB: {
    label: "Convolved B",
    color: "#ff453a",
    missingMessage: "Requires IR B",
  },
};

const DEFAULT_DIFFERENCE_CONFIG: Record<
  DifferenceId,
  {
    label: string;
    color: string;
    minuend: TraceId;
    subtrahend: TraceId;
    disabledMessage?: string;
  }
> = {
  origMinusA: {
    label: "Original - A",
    color: "#ffd166",
    minuend: "original",
    subtrahend: "convolvedA",
    disabledMessage: "Requires IR A",
  },
  origMinusB: {
    label: "Original - B",
    color: "#ff7f83",
    minuend: "original",
    subtrahend: "convolvedB",
    disabledMessage: "Requires IR B",
  },
  aMinusB: {
    label: "A - B",
    color: "#ff9fbf",
    minuend: "convolvedA",
    subtrahend: "convolvedB",
    disabledMessage: "Requires IR B",
  },
};

type PlotlyTrace = {
  type: "scatter";
  mode: "lines";
  name: string;
  legendgroup?: string;
  line: {
    color: string;
    width: number;
    shape?: "linear" | "spline";
    smoothing?: number;
    dash?: "solid" | "dot" | "dash" | "dashdot";
  };
  hovertemplate: string;
  opacity?: number;
  fill?: "tozeroy" | "none";
  fillcolor?: string;
  x: Float32Array;
  y: Float32Array;
};

type PlotComponentProps = {
  data: PlotlyTrace[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
  useResizeHandler?: boolean;
  style?: React.CSSProperties;
};

type PlotComponentType = React.ComponentType<PlotComponentProps>;

type WorkerMessage =
  | (DownsampleOutput & { id: number })
  | { id: number; error: string };

type BaseTraceDefinition = {
  id: TraceId;
  label: string;
  color: string;
  buffer: AudioBuffer | null;
  latencySeconds: number;
  channelLabels?: string[];
  disabledReason: string | null;
};

type DifferenceDefinition = {
  id: DifferenceId;
  label: string;
  color: string;
  minuend: TraceId;
  subtrahend: TraceId;
  disabledMessage?: string | null;
};

type DifferenceState = DifferenceDefinition & {
  isAvailable: boolean;
  effectiveDisabledReason: string | null;
};

type AlignedTrace = {
  id: string;
  label: string;
  color: string;
  sampleRate: number;
  channelData: Float32Array[];
  channelLabels: string[];
  duration: number;
  version: string;
};

type DownsampleCacheEntry = {
  version: string;
  output: DownsampleOutput;
};

const bufferIdentity = new WeakMap<AudioBuffer, number>();
let bufferIdentityCounter = 1;

function usePlotComponent(): PlotComponentType | null {
  const [PlotComponent, setPlotComponent] =
    useState<PlotComponentType | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadPlotly = async () => {
      const Plotly = await import("plotly.js-dist-min");
      const createPlotlyComponent = (await import("react-plotly.js/factory"))
        .default;
      if (!mounted) return;
      setPlotComponent(() => createPlotlyComponent(Plotly));
    };
    loadPlotly();
    return () => {
      mounted = false;
    };
  }, []);

  return PlotComponent;
}

export default function WaveformPlot(props: Props) {
  if ("variant" in props && props.variant === "multi") {
    return <MultiWaveformView {...props} />;
  }
  return <SingleWaveformView {...(props as SingleWaveformProps)} />;
}

function SingleWaveformView({
  buffer,
  color,
  title,
  mode = "A",
  overlayTraces,
  regions,
}: SingleWaveformProps) {
  const PlotComponent = usePlotComponent();
  const baseChannelCount = resolveChannelCount(buffer);
  const [downsampled, setDownsampled] = useState<DownsampleOutput>(() =>
    createEmptyDownsample(baseChannelCount),
  );
  const { times, channelSamples, duration, peak } = downsampled;
  const channelCount =
    channelSamples.length > 0 ? channelSamples.length : baseChannelCount;
  const [xExtent, setXExtent] = useState(() =>
    duration > 0 ? duration : DEFAULT_AXIS_EXTENT,
  );
  const [yExtent, setYExtent] = useState(() => computeAutoYExtent(peak));
  const previousTitleRef = useRef(title);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const applyResult = (result: DownsampleOutput) => {
      if (!cancelled) {
        setDownsampled(result);
      }
    };
    const fallbackToMainThread = () => {
      try {
        const input = buildDownsampleInput(buffer);
        const result = downsample(input);
        applyResult(result);
      } catch (fallbackError) {
        console.error("Waveform downsample fallback failed:", fallbackError);
        applyResult(createEmptyDownsample(resolveChannelCount(buffer)));
      }
    };
    if (typeof Worker === "undefined") {
      fallbackToMainThread();
      return () => {
        cancelled = true;
      };
    }
    let worker = workerRef.current;
    if (!worker) {
      try {
        worker = new Worker(DOWN_SAMPLE_WORKER_URL, { type: "module" });
        workerRef.current = worker;
      } catch (workerError) {
        console.error(
          "Waveform downsample worker failed to start:",
          workerError,
        );
        workerRef.current = null;
        fallbackToMainThread();
        return () => {
          cancelled = true;
        };
      }
    }
    if (!worker) {
      fallbackToMainThread();
      return () => {
        cancelled = true;
      };
    }
    const input = buildDownsampleInput(buffer);
    const requestId = ++requestIdRef.current;
    applyResult(createEmptyDownsample(input.channelData.length));
    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (!message || message.id !== requestId || cancelled) {
        return;
      }
      if ("error" in message) {
        console.error("Waveform downsample worker error:", message.error);
        worker?.removeEventListener("message", handleMessage);
        worker?.removeEventListener("error", handleError);
        worker?.terminate();
        workerRef.current = null;
        worker = null;
        fallbackToMainThread();
        return;
      }
      applyResult({
        times: message.times,
        channelSamples: message.channelSamples,
        peak: message.peak,
        duration: message.duration,
      });
    };
    const handleError = (event: ErrorEvent) => {
      if (cancelled || requestId !== requestIdRef.current) {
        return;
      }
      console.error("Waveform downsample worker crashed:", event.message);
      worker?.removeEventListener("message", handleMessage);
      worker?.removeEventListener("error", handleError);
      worker?.terminate();
      workerRef.current = null;
      worker = null;
      fallbackToMainThread();
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    try {
      worker.postMessage(
        {
          id: requestId,
          payload: input,
        },
        input.channelData.map((array) => array.buffer),
      );
    } catch (postError) {
      console.error(
        "Waveform downsample worker postMessage failed:",
        postError,
      );
      worker?.removeEventListener("message", handleMessage);
      worker?.removeEventListener("error", handleError);
      worker?.terminate();
      workerRef.current = null;
      worker = null;
      fallbackToMainThread();
    }
    return () => {
      cancelled = true;
      if (worker) {
        worker?.removeEventListener("message", handleMessage);
        worker?.removeEventListener("error", handleError);
      }
    };
  }, [buffer]);

  useEffect(() => {
    if (duration > 0 && Number.isFinite(duration)) {
      setXExtent((prev) => (duration > prev ? duration : prev));
    }
  }, [duration]);

  useEffect(() => {
    setYExtent((prev) => {
      const nextExtent = computeAutoYExtent(peak);
      return Math.abs(prev - nextExtent) <= Y_EXTENT_EPSILON ? prev : nextExtent;
    });
  }, [peak]);

  useEffect(() => {
    if (previousTitleRef.current !== title) {
      previousTitleRef.current = title;
      setXExtent(
        duration > 0 && Number.isFinite(duration)
          ? duration
          : DEFAULT_AXIS_EXTENT,
      );
      setYExtent(computeAutoYExtent(peak));
    }
  }, [title, duration, peak]);

  const channelLabels = useMemo(() => {
    if (channelCount === 1) {
      return [title];
    }
    const baseLabels = ["Left", "Right"];
    return Array.from({ length: channelCount }, (_, idx) => {
      if (idx < baseLabels.length) {
        return baseLabels[idx];
      }
      return `Channel ${idx + 1}`;
    });
  }, [channelCount, title]);

  const isDiffMode = mode === "diff";
  const paletteSeed = isDiffMode ? "#ff375f" : color;
  const channelColors = useMemo(
    () => deriveIosChannelPalette(paletteSeed, channelCount),
    [paletteSeed, channelCount],
  );

  const baseTraces = useMemo(
    () =>
      channelSamples.map((samples, idx) => {
        const label = channelLabels[idx] ?? `Channel ${idx + 1}`;
        const colorForChannel =
          channelColors[idx] ??
          IOS_FALLBACK_PALETTE[idx % IOS_FALLBACK_PALETTE.length];
        const traceName =
          channelCount > 1 ? `${label}${isDiffMode ? " (diff)" : ""}` : title;
        return {
          type: "scatter" as const,
          mode: "lines" as const,
          name: traceName,
          line: {
            color: colorForChannel.stroke,
            width: isDiffMode ? 2.8 : 2.4,
            shape: "spline" as const,
            smoothing: 0.58,
            dash: isDiffMode ? ("solid" as const) : undefined,
          },
          fill: "tozeroy" as const,
          fillcolor: colorForChannel.fill,
          opacity: isDiffMode ? 1 : channelCount > 1 ? 0.95 : 1,
          hovertemplate: `<b>${label}</b><br><b>%{x:.3f}s</b><br>Amplitude: %{y:.6f}<extra></extra>`,
          x: times,
          y: samples,
        };
      }),
    [
      channelSamples,
      channelCount,
      channelColors,
      channelLabels,
      isDiffMode,
      times,
      title,
    ],
  );

  const overlays = useMemo(() => {
    if (!overlayTraces || overlayTraces.length === 0) return [];
    return overlayTraces.map((overlay) => ({
      type: "scatter" as const,
      mode: "lines" as const,
      name: overlay.label,
      line: {
        color: overlay.color,
        width: 1.6,
        dash: overlay.dash ?? ("dot" as const),
        shape: "spline" as const,
        smoothing: 0.5,
      },
      opacity: overlay.opacity ?? 0.6,
      hovertemplate: `<b>${overlay.label}</b><br><b>%{x:.3f}s</b><br>%{y:.6f}<extra></extra>`,
      x: overlay.times,
      y: overlay.samples,
      fill: "none" as const,
      fillcolor: "rgba(0,0,0,0)",
    }));
  }, [overlayTraces]);

  const data = useMemo(
    () => [...baseTraces, ...overlays],
    [baseTraces, overlays],
  );

  const layout = useMemo(() => {
    const safeXExtent =
      xExtent > 0 && Number.isFinite(xExtent) ? xExtent : DEFAULT_AXIS_EXTENT;
    const safeYExtent =
      yExtent > 0 && Number.isFinite(yExtent)
        ? yExtent
        : computeAutoYExtent(peak);
    const regionShapes =
      regions && regions.length > 0
        ? regions
            .filter(
              (region) =>
                Number.isFinite(region.start) &&
                Number.isFinite(region.end) &&
                region.end > region.start,
            )
            .map((region) => ({
              type: "rect" as const,
              xref: "x",
              yref: "paper",
              x0: region.start,
              x1: region.end,
              y0: 0,
              y1: 1,
              fillcolor: "rgba(255, 69, 58, 0.12)",
              line: { width: 0 },
              layer: "below" as const,
            }))
        : undefined;
    return {
      autosize: true,
      height: DEFAULT_LAYOUT_HEIGHT,
      margin: { t: 24, r: 18, l: 42, b: 28 },
      paper_bgcolor: "rgba(17, 17, 21, 0.78)",
      plot_bgcolor: "rgba(11, 11, 15, 0.62)",
      font: {
        color: "rgba(235, 235, 245, 0.84)",
        family: "Inter, system-ui, sans-serif",
        size: 12,
      },
      hoverlabel: {
        bgcolor: "rgba(15, 15, 18, 0.94)",
        bordercolor: "rgba(255, 255, 255, 0.12)",
        font: { color: "#f9f9ff" },
      },
      hovermode: "x unified",
      showlegend: channelCount > 1 || overlays.length > 0,
      legend: {
        orientation: "h" as const,
        x: 0,
        y: 1.02,
        yanchor: "bottom" as const,
        bgcolor: "rgba(20, 20, 26, 0.78)",
        bordercolor: "rgba(255, 255, 255, 0.14)",
        borderwidth: 1,
        font: {
          color: "rgba(235, 235, 245, 0.85)",
          size: 11,
        },
        title: {
          text: "Channels",
          font: { color: "rgba(235, 235, 245, 0.65)", size: 11 },
          side: "top" as const,
        },
      },
      xaxis: {
        title: {
          text: "Time (s)",
          standoff: 12,
          font: { color: "rgba(235, 235, 245, 0.7)", size: 12 },
        },
        autorange: false,
        range: [0, safeXExtent],
        zeroline: false,
        showgrid: true,
        gridcolor: "rgba(255, 255, 255, 0.05)",
        tickfont: { size: 11, color: "rgba(235, 235, 245, 0.65)" },
        linecolor: "rgba(255, 255, 255, 0.18)",
        mirror: true,
      },
      yaxis: {
        title: {
          text: "Amplitude",
          standoff: 12,
          font: { color: "rgba(235, 235, 245, 0.7)", size: 12 },
        },
        autorange: false,
        range: [-safeYExtent, safeYExtent],
        showgrid: true,
        gridcolor: "rgba(255, 255, 255, 0.05)",
        zeroline: false,
        tickfont: { size: 11, color: "rgba(235, 235, 245, 0.65)" },
        linecolor: "rgba(255, 255, 255, 0.18)",
        mirror: true,
      },
      shapes: regionShapes,
    };
  }, [channelCount, overlays, xExtent, yExtent, regions, peak]);

  const config = useMemo(
    () => ({
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ["select2d", "lasso2d"],
      toImageButtonOptions: {
        format: "png" as const,
        filename: "waveform",
        height: 340,
        width: 1200,
        scale: 2,
      },
    }),
    [],
  );

  if (!PlotComponent) {
    return (
      <div className="plot-skeleton" role="status" aria-live="polite">
        Loading waveform...
      </div>
    );
  }

  return (
    <PlotComponent
      data={data}
      layout={layout}
      config={config}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}

function MultiWaveformView({
  traces,
  differences,
  viewWindow,
}: MultiWaveformProps) {
  const PlotComponent = usePlotComponent();
  const baseDefinitions = useMemo<BaseTraceDefinition[]>(() => {
    const entries: BaseTraceDefinition[] = [];
    (["original", "convolvedA", "convolvedB"] as TraceId[]).forEach((id) => {
      const meta = BASE_TRACE_META[id];
      const input =
        id === "original"
          ? traces.original
          : id === "convolvedA"
            ? traces.convolvedA
            : traces.convolvedB;
      const latencySeconds =
        Number.isFinite(input?.latencySeconds) && input?.latencySeconds != null
          ? Number(input.latencySeconds)
          : 0;
      entries.push({
        id,
        label: meta.label,
        color: meta.color,
        buffer: input?.buffer ?? null,
        latencySeconds,
        channelLabels: input?.channelLabels,
        disabledReason: input?.buffer ? null : meta.missingMessage ?? null,
      });
    });
    return entries;
  }, [traces]);

  const baseDefinitionMap = useMemo(
    () =>
      new Map<TraceId, BaseTraceDefinition>(
        baseDefinitions.map((def) => [def.id, def]),
      ),
    [baseDefinitions],
  );

  const differenceDefinitions = useMemo<DifferenceDefinition[]>(() => {
    const defaults = (Object.keys(
      DEFAULT_DIFFERENCE_CONFIG,
    ) as DifferenceId[]).map((id) => {
      const spec = DEFAULT_DIFFERENCE_CONFIG[id];
      return {
        id,
        label: spec.label,
        color: spec.color,
        minuend: spec.minuend,
        subtrahend: spec.subtrahend,
        disabledMessage: spec.disabledMessage ?? null,
      };
    });
    if (!differences || differences.length === 0) {
      return defaults;
    }
    const overrideMap = new Map<DifferenceId, DifferenceSpec>();
    differences.forEach((diff) => overrideMap.set(diff.id, diff));
    return defaults.map((base) => {
      const override = overrideMap.get(base.id);
      if (!override) return base;
      return {
        id: base.id,
        label: override.label ?? base.label,
        color: base.color,
        minuend: override.minuend,
        subtrahend: override.subtrahend,
        disabledMessage: base.disabledMessage ?? null,
      };
    });
  }, [differences]);

  const differenceStates = useMemo<DifferenceState[]>(() => {
    return differenceDefinitions.map((definition) => {
      const minuend = baseDefinitionMap.get(definition.minuend);
      const subtrahend = baseDefinitionMap.get(definition.subtrahend);
      const hasMinuend = Boolean(minuend?.buffer);
      const hasSubtrahend = Boolean(subtrahend?.buffer);
      const isAvailable = hasMinuend && hasSubtrahend;
      let effectiveDisabledReason = definition.disabledMessage ?? null;
      if (!isAvailable) {
        effectiveDisabledReason =
          definition.id === "origMinusB" || definition.id === "aMinusB"
            ? "Requires IR B"
            : definition.disabledMessage ?? "Not available";
      }
      return {
        ...definition,
        isAvailable,
        effectiveDisabledReason,
      };
    });
  }, [baseDefinitionMap, differenceDefinitions]);

  const [activeBaseIds, setActiveBaseIds] = useState<TraceId[]>(() =>
    baseDefinitions.filter((def) => def.buffer).map((def) => def.id),
  );

  useEffect(() => {
    const available = baseDefinitions
      .filter((def) => def.buffer)
      .map((def) => def.id);
    setActiveBaseIds((prev) => {
      const sanitized = prev.filter((id) => available.includes(id));
      if (sanitized.length === prev.length && arraysEqual(prev, sanitized)) {
        if (sanitized.length === 0 && available.length > 0) {
          return available;
        }
        return prev;
      }
      if (sanitized.length === 0 && available.length > 0) {
        return available;
      }
      return sanitized;
    });
  }, [baseDefinitions]);

  const [activeDifferenceIds, setActiveDifferenceIds] = useState<
    DifferenceId[]
  >(() => {
    const firstAvailable = differenceDefinitions.find((diff) => {
      const minuend = baseDefinitionMap.get(diff.minuend);
      const subtrahend = baseDefinitionMap.get(diff.subtrahend);
      return Boolean(minuend?.buffer) && Boolean(subtrahend?.buffer);
    });
    return firstAvailable ? [firstAvailable.id] : [];
  });

  useEffect(() => {
    const available = differenceStates
      .filter((state) => state.isAvailable)
      .map((state) => state.id);
    setActiveDifferenceIds((prev) => {
      const sanitized = prev.filter((id) => available.includes(id));
      if (sanitized.length === prev.length && arraysEqual(prev, sanitized)) {
        if (sanitized.length === 0 && available.length > 0) {
          return [available[0]];
        }
        return prev;
      }
      if (sanitized.length === 0 && available.length > 0) {
        return [available[0]];
      }
      return sanitized;
    });
  }, [differenceStates]);

  const alignedBase = useMemo(() => {
    const map = new Map<TraceId, AlignedTrace>();
    baseDefinitions.forEach((definition) => {
      const buffer = definition.buffer;
      if (!buffer) return;
      const sampleRate = buffer.sampleRate;
      if (sampleRate <= 0) return;
      const bufferId = getBufferVersion(buffer);
      const latencySamples = Math.min(
        Math.max(
          0,
          Math.round(Math.max(0, definition.latencySeconds) * sampleRate),
        ),
        buffer.length,
      );
      const availableLength = Math.max(0, buffer.length - latencySamples);
      const channelData = Array.from(
        { length: buffer.numberOfChannels },
        (_, idx) => {
          const data = buffer.getChannelData(idx);
          if (latencySamples >= data.length) {
            return new Float32Array(0);
          }
          return data.subarray(latencySamples, latencySamples + availableLength);
        },
      );
      const resolvedChannelLabels = resolveChannelLabels(
        definition.channelLabels,
        buffer.numberOfChannels,
        definition.label,
      );
      const duration =
        channelData.length > 0 && channelData[0]?.length
          ? channelData[0].length / sampleRate
          : 0;
      map.set(definition.id, {
        id: definition.id,
        label: definition.label,
        color: definition.color,
        sampleRate,
        channelData,
        channelLabels: resolvedChannelLabels,
        duration,
        version: `${bufferId}:${latencySamples}:${availableLength}`,
      });
    });
    return map;
  }, [baseDefinitions]);

  const alignedDifference = useMemo(() => {
    const map = new Map<DifferenceId, AlignedTrace>();
    differenceStates.forEach((state) => {
      if (!state.isAvailable) return;
      const minuend = alignedBase.get(state.minuend);
      const subtrahend = alignedBase.get(state.subtrahend);
      if (!minuend || !subtrahend) return;
      if (Math.abs(minuend.sampleRate - subtrahend.sampleRate) > 1e-6) {
        console.warn(
          `Waveform difference skipped: sample rate mismatch for ${state.label}`,
        );
        return;
      }
      const channelCount = Math.min(
        minuend.channelData.length,
        subtrahend.channelData.length,
      );
      if (channelCount === 0) return;
      const channelData = Array.from({ length: channelCount }, (_, idx) => {
        const minuendChannel = minuend.channelData[idx] ?? new Float32Array(0);
        const subChannel = subtrahend.channelData[idx] ?? new Float32Array(0);
        const minLength = Math.min(minuendChannel.length, subChannel.length);
        const diff = new Float32Array(minLength);
        for (let i = 0; i < minLength; i++) {
          diff[i] = minuendChannel[i] - subChannel[i];
        }
        return diff;
      });
      const duration =
        channelData.length > 0 && channelData[0]?.length
          ? channelData[0].length / minuend.sampleRate
          : 0;
      const channelLabels = minuend.channelLabels.slice(0, channelCount);
      map.set(state.id, {
        id: state.id,
        label: state.label,
        color: state.color,
        sampleRate: minuend.sampleRate,
        channelData,
        channelLabels,
        duration,
        version: `${minuend.version}|${subtrahend.version}`,
      });
    });
    return map;
  }, [alignedBase, differenceStates]);

  const downsampleCacheRef = useRef<Map<string, DownsampleCacheEntry>>(
    new Map(),
  );

  const resolvedRange = useMemo(() => {
    const start =
      Number.isFinite(viewWindow?.start) && viewWindow
        ? Math.max(0, viewWindow.start)
        : 0;
    let end =
      Number.isFinite(viewWindow?.end) && viewWindow
        ? Math.max(viewWindow.end, start)
        : 0;
    if (!viewWindow || !Number.isFinite(viewWindow.end) || end <= start) {
      const durations: number[] = [];
      alignedBase.forEach((trace) => {
        durations.push(trace.duration);
      });
      alignedDifference.forEach((trace) => {
        durations.push(trace.duration);
      });
      const fallback = durations.length > 0 ? Math.max(...durations) : 0;
      end = fallback > start ? fallback : start + DEFAULT_AXIS_EXTENT;
    }
    if (!Number.isFinite(end) || end <= start) {
      end = start + DEFAULT_AXIS_EXTENT;
    }
    return { start, end };
  }, [alignedBase, alignedDifference, viewWindow]);

  const getDownsampled = useCallback(
    (
      key: string,
      version: string,
      channelData: Float32Array[],
      sampleRate: number,
      rangeStart: number,
      rangeEnd: number,
    ) => {
      const cacheKey = `${key}:${rangeStart.toFixed(4)}:${rangeEnd.toFixed(4)}`;
      const cache = downsampleCacheRef.current;
      const cached = cache.get(cacheKey);
      if (cached && cached.version === version) {
        return cached.output;
      }
      const output = downsampleWindow(
        channelData,
        sampleRate,
        rangeStart,
        rangeEnd,
      );
      cache.set(cacheKey, { version, output });
      return output;
    },
    [],
  );

  const plotData = useMemo(() => {
    const traces: PlotlyTrace[] = [];
    let combinedPeak = 0;

    const appendTrace = (
      trace: AlignedTrace,
      dash: PlotlyTrace["line"]["dash"],
      opacity: number,
    ) => {
      const result = getDownsampled(
        trace.id,
        trace.version,
        trace.channelData,
        trace.sampleRate,
        resolvedRange.start,
        resolvedRange.end,
      );
      combinedPeak = Math.max(combinedPeak, result.peak);
      const palette = deriveIosChannelPalette(
        trace.color,
        trace.channelData.length,
      );
      result.channelSamples.forEach((samples, idx) => {
        const colorForChannel =
          palette[idx] ??
          IOS_FALLBACK_PALETTE[idx % IOS_FALLBACK_PALETTE.length];
        const channelLabel =
          trace.channelLabels[idx] ?? `Channel ${idx + 1}`;
        traces.push({
          type: "scatter" as const,
          mode: "lines" as const,
          name: `${trace.label} ${channelLabel}`,
          legendgroup: trace.id,
          line: {
            color: colorForChannel.stroke,
            width: dash ? 2 : 2.2,
            dash,
            shape: "linear" as const,
          },
          hovertemplate: `<b>${trace.label}</b><br>${channelLabel}<br>t=%{x:.3f}s<br>Amp %{y:.6f}<extra></extra>`,
          opacity,
          fill: "none",
          x: result.times,
          y: samples,
        });
      });
    };

    activeBaseIds.forEach((id) => {
      const trace = alignedBase.get(id);
      if (!trace) return;
      appendTrace(trace, "solid", 0.98);
    });

    activeDifferenceIds.forEach((id) => {
      const trace = alignedDifference.get(id);
      if (!trace) return;
      appendTrace(trace, "dash", 0.68);
    });

    const yExtent = computeAutoYExtent(combinedPeak);
    return { traces, peak: combinedPeak, yExtent };
  }, [
    activeBaseIds,
    activeDifferenceIds,
    alignedBase,
    alignedDifference,
    getDownsampled,
    resolvedRange.end,
    resolvedRange.start,
  ]);

  const layout = useMemo(() => {
    const safeYExtent =
      plotData.peak > 0 ? plotData.yExtent : computeAutoYExtent(plotData.peak);
    return {
      autosize: true,
      height: DEFAULT_LAYOUT_HEIGHT,
      margin: { t: 32, r: 18, l: 42, b: 28 },
      paper_bgcolor: "rgba(17, 17, 21, 0.78)",
      plot_bgcolor: "rgba(11, 11, 15, 0.62)",
      font: {
        color: "rgba(235, 235, 245, 0.84)",
        family: "Inter, system-ui, sans-serif",
        size: 12,
      },
      hoverlabel: {
        bgcolor: "rgba(15, 15, 18, 0.94)",
        bordercolor: "rgba(255, 255, 255, 0.12)",
        font: { color: "#f9f9ff" },
      },
      hovermode: "x unified",
      showlegend: plotData.traces.length > 0,
      legend: {
        orientation: "h" as const,
        x: 0,
        y: 1.05,
        yanchor: "bottom" as const,
        bgcolor: "rgba(20, 20, 26, 0.78)",
        bordercolor: "rgba(255, 255, 255, 0.14)",
        borderwidth: 1,
        font: {
          color: "rgba(235, 235, 245, 0.85)",
          size: 11,
        },
        title: {
          text: "Traces",
          font: { color: "rgba(235, 235, 245, 0.65)", size: 11 },
          side: "top" as const,
        },
      },
      xaxis: {
        title: {
          text: "Time (s)",
          standoff: 12,
          font: { color: "rgba(235, 235, 245, 0.7)", size: 12 },
        },
        autorange: false,
        range: [resolvedRange.start, resolvedRange.end],
        zeroline: false,
        showgrid: true,
        gridcolor: "rgba(255, 255, 255, 0.05)",
        tickfont: { size: 11, color: "rgba(235, 235, 245, 0.65)" },
        linecolor: "rgba(255, 255, 255, 0.18)",
        mirror: true,
      },
      yaxis: {
        title: {
          text: "Amplitude",
          standoff: 12,
          font: { color: "rgba(235, 235, 245, 0.7)", size: 12 },
        },
        autorange: false,
        range: [-safeYExtent, safeYExtent],
        showgrid: true,
        gridcolor: "rgba(255, 255, 255, 0.05)",
        zeroline: false,
        tickfont: { size: 11, color: "rgba(235, 235, 245, 0.65)" },
        linecolor: "rgba(255, 255, 255, 0.18)",
        mirror: true,
      },
    };
  }, [plotData, resolvedRange.end, resolvedRange.start]);

  const config = useMemo(
    () => ({
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ["select2d", "lasso2d"],
      toImageButtonOptions: {
        format: "png" as const,
        filename: "waveform",
        height: 340,
        width: 1200,
        scale: 2,
      },
    }),
    [],
  );

  const toggleBase = useCallback(
    (id: TraceId) => {
      setActiveBaseIds((prev) => {
        if (prev.includes(id)) {
          return prev.filter((value) => value !== id);
        }
        const next = [...prev, id];
        const ordered = baseDefinitions
          .filter((definition) => next.includes(definition.id))
          .map((definition) => definition.id);
        return ordered;
      });
    },
    [baseDefinitions],
  );

  const toggleDifference = useCallback(
    (id: DifferenceId) => {
      setActiveDifferenceIds((prev) => {
        if (prev.includes(id)) {
          return prev.filter((value) => value !== id);
        }
        const next = [...prev, id];
        const ordered = differenceDefinitions
          .filter((definition) => next.includes(definition.id))
          .map((definition) => definition.id);
        return ordered;
      });
    },
    [differenceDefinitions],
  );

  const plotContent = PlotComponent ? (
    <PlotComponent
      data={plotData.traces}
      layout={layout}
      config={config}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  ) : (
    <div className="plot-skeleton" role="status" aria-live="polite">
      Loading waveform...
    </div>
  );

  return (
    <>
      <div className="waveform-toolbar" role="group" aria-label="Waveform controls">
        <div
          className="segmented-control"
          role="group"
          aria-label="Base traces"
        >
          {baseDefinitions.map((definition) => {
            const isActive = activeBaseIds.includes(definition.id);
            const disabled = !definition.buffer;
            const title = disabled
              ? definition.disabledReason ?? "Not available"
              : `Toggle ${definition.label}`;
            return (
              <button
                key={definition.id}
                type="button"
                className="segmented-control__button"
                aria-pressed={isActive}
                onClick={() => toggleBase(definition.id)}
                disabled={disabled}
                title={title ?? undefined}
              >
                {definition.label}
              </button>
            );
          })}
        </div>
        <div
          className="segmented-control"
          role="group"
          aria-label="Difference overlays"
        >
          {differenceStates.map((state) => {
            const isActive = activeDifferenceIds.includes(state.id);
            const disabled = !state.isAvailable;
            const title = disabled
              ? state.effectiveDisabledReason ?? "Not available"
              : `Toggle ${state.label}`;
            return (
              <button
                key={state.id}
                type="button"
                className="segmented-control__button"
                aria-pressed={isActive}
                onClick={() => toggleDifference(state.id)}
                disabled={disabled}
                title={title ?? undefined}
              >
                {state.label}
              </button>
            );
          })}
        </div>
      </div>
      {plotContent}
    </>
  );
}

function createEmptyDownsample(channelCount = 0): DownsampleOutput {
  return {
    times: new Float32Array(0),
    channelSamples: Array.from(
      { length: channelCount },
      () => new Float32Array(0),
    ),
    peak: 0,
    duration: 0,
  };
}

function resolveChannelCount(buffer: AudioBuffer) {
  return buffer.numberOfChannels > 0 ? buffer.numberOfChannels : 1;
}

function buildDownsampleInput(buffer: AudioBuffer): DownsampleInput {
  const channelCount = resolveChannelCount(buffer);
  const channelData =
    buffer.numberOfChannels > 0
      ? Array.from({ length: channelCount }, (_, idx) =>
          buffer.getChannelData(idx).slice(),
        )
      : [new Float32Array(buffer.length)];
  return {
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    channelData,
  };
}

function computeAutoYExtent(peak: number) {
  const safePeak = Number.isFinite(peak) ? Math.abs(peak) : 0;
  if (safePeak <= 0) {
    return DEFAULT_AXIS_EXTENT;
  }
  const padded = safePeak * Y_EXTENT_PADDING;
  return padded > MIN_VISIBLE_Y_EXTENT ? padded : MIN_VISIBLE_Y_EXTENT;
}

function resolveChannelLabels(
  provided: string[] | undefined,
  channelCount: number,
  baseLabel: string,
): string[] {
  if (provided && provided.length >= channelCount) {
    return provided.slice(0, channelCount);
  }
  if (channelCount === 1) {
    return [baseLabel];
  }
  const base = ["Left", "Right"];
  return Array.from({ length: channelCount }, (_, idx) => {
    if (provided && idx < provided.length) {
      return provided[idx] ?? `Channel ${idx + 1}`;
    }
    if (idx < base.length) {
      return base[idx];
    }
    return `Channel ${idx + 1}`;
  });
}

function arraysEqual<T>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function downsampleWindow(
  channelData: Float32Array[],
  sampleRate: number,
  startTime: number,
  endTime: number,
): DownsampleOutput {
  const channelCount = channelData.length > 0 ? channelData.length : 1;
  if (sampleRate <= 0) {
    return createEmptyDownsample(channelCount);
  }
  if (endTime <= startTime) {
    return createEmptyDownsample(channelCount);
  }
  const totalSamples =
    channelData.length > 0 ? channelData[0]?.length ?? 0 : 0;
  if (totalSamples === 0) {
    return createEmptyDownsample(channelCount);
  }
  const clampedStart = Math.min(
    Math.max(0, Math.floor(startTime * sampleRate)),
    totalSamples,
  );
  const clampedEnd = Math.min(
    Math.max(clampedStart, Math.ceil(endTime * sampleRate)),
    totalSamples,
  );
  const snippetLength = clampedEnd - clampedStart;
  if (snippetLength <= 0) {
    return createEmptyDownsample(channelCount);
  }
  const step =
    snippetLength <= MAX_POINTS
      ? 1
      : Math.max(1, Math.floor(snippetLength / MAX_POINTS));
  const outputLength = Math.max(0, Math.ceil(snippetLength / step));
  const times = new Float32Array(outputLength);
  const outputChannels = Array.from(
    { length: channelCount },
    () => new Float32Array(outputLength),
  );

  let globalMax = Number.NEGATIVE_INFINITY;
  let globalMin = Number.POSITIVE_INFINITY;
  let writeIndex = 0;

  for (
    let bucketStart = clampedStart;
    bucketStart < clampedEnd;
    bucketStart += step
  ) {
    const bucketEnd = Math.min(clampedEnd, bucketStart + step);
    const bucketMid = bucketStart + (bucketEnd - bucketStart) / 2;
    times[writeIndex] = bucketMid / sampleRate;
    for (let ch = 0; ch < channelCount; ch++) {
      const source = channelData[ch];
      if (!source || source.length === 0) {
        outputChannels[ch][writeIndex] = 0;
        continue;
      }
      let maxVal = Number.NEGATIVE_INFINITY;
      let minVal = Number.POSITIVE_INFINITY;
      for (let idx = bucketStart; idx < bucketEnd; idx++) {
        const value = source[idx];
        if (value > maxVal) maxVal = value;
        if (value < minVal) minVal = value;
      }
      const safeMax = Number.isFinite(maxVal) ? maxVal : 0;
      const safeMin = Number.isFinite(minVal) ? minVal : 0;
      const dominant =
        Math.abs(safeMax) >= Math.abs(safeMin) ? safeMax : safeMin;
      const resolved = Number.isFinite(dominant) ? dominant : 0;
      outputChannels[ch][writeIndex] = resolved;
      if (safeMax > globalMax) globalMax = safeMax;
      if (safeMin < globalMin) globalMin = safeMin;
    }
    writeIndex++;
  }

  const resolvedMax = Number.isFinite(globalMax) ? Math.abs(globalMax) : 0;
  const resolvedMin = Number.isFinite(globalMin) ? Math.abs(globalMin) : 0;
  const peak = Math.max(resolvedMax, resolvedMin);
  const duration = snippetLength / sampleRate;

  return {
    times,
    channelSamples: outputChannels,
    peak,
    duration,
  };
}

function getBufferVersion(buffer: AudioBuffer): number {
  let id = bufferIdentity.get(buffer);
  if (!id) {
    id = bufferIdentityCounter++;
    bufferIdentity.set(buffer, id);
  }
  return id;
}

function deriveIosChannelPalette(
  baseColor: string,
  count: number,
): ChannelColor[] {
  if (count <= 0) {
    return [IOS_FALLBACK_PALETTE[0]];
  }
  const palette: ChannelColor[] = [];
  const parsed = parseColorToRgb(baseColor);
  if (parsed) {
    const primaryStroke = rgbaString(parsed, count > 1 ? 0.96 : 0.98);
    const primaryFill = rgbaString(parsed, 0.28);
    palette.push({ stroke: primaryStroke, fill: primaryFill });
    if (count === 1) {
      return palette;
    }
    for (let i = 1; i < count; i++) {
      const shiftedHue = shiftHue(parsed, i * 12);
      const adjusted = adjustLightness(
        shiftedHue,
        (i % 2 === 0 ? -1 : 1) * 0.08,
      );
      const stroke = rgbaString(adjusted, 0.92);
      const fill = rgbaString(adjusted, 0.22);
      palette.push({ stroke, fill });
    }
    return palette;
  }
  for (let i = 0; i < count; i++) {
    palette.push(IOS_FALLBACK_PALETTE[i % IOS_FALLBACK_PALETTE.length]);
  }
  return palette;
}

function parseColorToRgb(color: string): RGB | null {
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const hex = trimmed.slice(1);
    if (hex.length !== 3 && hex.length !== 6) {
      return null;
    }
    const normalized =
      hex.length === 3
        ? hex
            .split("")
            .map((char) => char + char)
            .join("")
        : hex;
    const value = Number.parseInt(normalized, 16);
    if (Number.isNaN(value)) {
      return null;
    }
    return {
      r: (value >> 16) & 0xff,
      g: (value >> 8) & 0xff,
      b: value & 0xff,
    };
  }
  const rgbMatch = trimmed.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})/i,
  );
  if (rgbMatch) {
    return {
      r: clampToByte(Number(rgbMatch[1])),
      g: clampToByte(Number(rgbMatch[2])),
      b: clampToByte(Number(rgbMatch[3])),
    };
  }
  return null;
}

function shiftHue(rgb: RGB, degrees: number): RGB {
  const { h, s, l } = rgbToHsl(rgb);
  const shifted = (h + degrees) % 360;
  return hslToRgb({ h: shifted < 0 ? shifted + 360 : shifted, s, l });
}

function adjustLightness(rgb: RGB, delta: number): RGB {
  const { h, s, l } = rgbToHsl(rgb);
  const next = hslToRgb({ h, s, l: clamp01(l + delta) });
  return next;
}

function rgbToHsl({ r, g, b }: RGB) {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case rNorm:
        h = (gNorm - bNorm) / delta + (gNorm < bNorm ? 6 : 0);
        break;
      case gNorm:
        h = (bNorm - rNorm) / delta + 2;
        break;
      default:
        h = (rNorm - gNorm) / delta + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): RGB {
  const hueToRgb = (p: number, q: number, t: number) => {
    let temp = t;
    if (temp < 0) temp += 1;
    if (temp > 1) temp -= 1;
    if (temp < 1 / 6) return p + (q - p) * 6 * temp;
    if (temp < 1 / 2) return q;
    if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
    return p;
  };
  const sat = clamp01(s);
  const light = clamp01(l);
  if (sat === 0) {
    const gray = clampToByte(light * 255);
    return { r: gray, g: gray, b: gray };
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const hNorm = ((h % 360) + 360) % 360;
  const hk = hNorm / 360;
  const r = clampToByte(hueToRgb(p, q, hk + 1 / 3) * 255);
  const g = clampToByte(hueToRgb(p, q, hk) * 255);
  const b = clampToByte(hueToRgb(p, q, hk - 1 / 3) * 255);
  return { r, g, b };
}

function rgbaString({ r, g, b }: RGB, alpha: number) {
  return `rgba(${clampToByte(r)}, ${clampToByte(g)}, ${clampToByte(b)}, ${clamp01(alpha)})`;
}

function clampToByte(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 255) {
    return 255;
  }
  return Math.round(value);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
