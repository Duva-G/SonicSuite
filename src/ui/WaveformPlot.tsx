// WHY: Renders a channel-aware waveform view for audio buffers.
import { useEffect, useMemo, useRef, useState } from "react";
import { downsample } from "../audio/downsample";
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
type Props = {
  buffer: AudioBuffer;
  color: string;
  title: string;
  mode?: WaveformMode;
  overlayTraces?: OverlayTrace[];
  regions?: Region[];
};
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
type WorkerMessage =
  | (DownsampleOutput & { id: number })
  | { id: number; error: string };
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

export default function WaveformPlot({
  buffer,
  color,
  title,
  mode = "A",
  overlayTraces,
  regions,
}: Props) {
  const baseChannelCount = resolveChannelCount(buffer);
  const [downsampled, setDownsampled] = useState<DownsampleOutput>(() =>
    createEmptyDownsample(baseChannelCount),
  );
  const { times, channelSamples, duration, peak } = downsampled;
  const channelCount =
    channelSamples.length > 0 ? channelSamples.length : baseChannelCount;
  const [xExtent, setXExtent] = useState(() => (duration > 0 ? duration : DEFAULT_AXIS_EXTENT));
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
      setXExtent(duration > 0 && Number.isFinite(duration) ? duration : DEFAULT_AXIS_EXTENT);
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
          mode: "lines",
          name: traceName,
          line: {
            color: colorForChannel.stroke,
            width: isDiffMode ? 2.8 : 2.4,
            shape: "spline",
            smoothing: 0.58,
            dash: isDiffMode ? "solid" : undefined,
          },
          fill: "tozeroy" as const,
          fillcolor: colorForChannel.fill,
          opacity: isDiffMode ? 1 : channelCount > 1 ? 0.95 : 1,
          hovertemplate: `<b>${label}</b><br><b>%{x:.3f}s</b><br>Amplitude: %{y:.6f}<extra></extra>`,
          x: times,
          y: samples,
        };
      }),
    [channelSamples, channelCount, channelColors, channelLabels, isDiffMode, times, title],
  );
  const overlays = useMemo(() => {
    if (!overlayTraces || overlayTraces.length === 0) return [];
    return overlayTraces.map((overlay) => ({
      type: "scatter" as const,
      mode: "lines",
      name: overlay.label,
      line: {
        color: overlay.color,
        width: 1.6,
        dash: overlay.dash ?? "dot",
        shape: "spline",
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
  const data = useMemo(() => [...baseTraces, ...overlays], [baseTraces, overlays]);
  const layout = useMemo(() => {
    const safeXExtent = xExtent > 0 && Number.isFinite(xExtent) ? xExtent : DEFAULT_AXIS_EXTENT;
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
      height: 420,
      margin: { t: 36, r: 26, l: 56, b: 44 },
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
        y: 1.12,
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
        height: 420,
        width: 1200,
        scale: 2,
      },
    }),
    [],
  );
  const [Plot, setPlot] = useState<React.ComponentType<{
    data: Array<{
      type: string;
      mode: string;
      name: string;
      line: { color: string; width: number; shape: string; smoothing: number };
      hovertemplate: string;
      opacity?: number;
      fill: string;
      fillcolor: string;
      x: Float32Array;
      y: Float32Array;
    }>;
    layout: {
      autosize: boolean;
      height: number;
      margin: { t: number; r: number; l: number; b: number };
      paper_bgcolor: string;
      plot_bgcolor: string;
      font: { color: string; family: string; size: number };
      hoverlabel: {
        bgcolor: string;
        bordercolor: string;
        font: { color: string };
      };
      hovermode: string;
      showlegend: boolean;
      legend: Record<string, unknown>;
      xaxis: Record<string, unknown>;
      yaxis: Record<string, unknown>;
    };
    config: {
      responsive: boolean;
      displaylogo: boolean;
      scrollZoom: boolean;
      displayModeBar: boolean;
      modeBarButtonsToRemove: string[];
      toImageButtonOptions: Record<string, unknown>;
    };
    useResizeHandler?: boolean;
    style?: React.CSSProperties;
    onHover?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  }> | null>(null);
  useEffect(() => {
    const loadPlotly = async () => {
      const Plotly = await import("plotly.js-dist-min");
      const createPlotlyComponent = (await import("react-plotly.js/factory"))
        .default;
      setPlot(() => createPlotlyComponent(Plotly));
    };
    loadPlotly();
  }, []);
  if (!Plot) {
    return <div>Loading Plotly...</div>;
  }
  return (
    <Plot
      data={data}
      layout={layout}
      config={config}
      useResizeHandler
      style={{ width: "100%", height: "100%", minHeight: 220 }}
    />
  );
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
    if (count > 1) {
      const shifted = adjustLightness(shiftHue(parsed, 28), 0.08);
      const secondaryStroke = rgbaString(shifted, 0.9);
      const secondaryFill = rgbaString(shifted, 0.25);
      palette.push({ stroke: secondaryStroke, fill: secondaryFill });
    }
    if (count > 2) {
      const accent = adjustLightness(shiftHue(parsed, -32), -0.05);
      const accentStroke = rgbaString(accent, 0.88);
      const accentFill = rgbaString(accent, 0.22);
      palette.push({ stroke: accentStroke, fill: accentFill });
    }
    for (let i = palette.length; i < count; i++) {
      palette.push(IOS_FALLBACK_PALETTE[i % IOS_FALLBACK_PALETTE.length]);
    }
    return palette.slice(0, count);
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
