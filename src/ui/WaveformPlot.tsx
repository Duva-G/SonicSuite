// WHY: Renders a channel-aware waveform view for audio buffers.
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  buffer: AudioBuffer;
  color: string;
  title: string;
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

const MAX_POINTS = 4000;
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

export default function WaveformPlot({ buffer, color, title }: Props) {
  const { times, channelSamples, duration, peak } = useMemo(
    () => downsampleBuffer(buffer),
    [buffer]
  );

  const channelCount = channelSamples.length > 0 ? channelSamples.length : 1;

  const [xExtent, setXExtent] = useState(() => (duration > 0 ? duration : 1));
  const [yExtent, setYExtent] = useState(() => (peak > 0 ? peak : 1));
  const previousTitleRef = useRef(title);

  useEffect(() => {
    if (duration > 0 && Number.isFinite(duration)) {
      setXExtent((prev) => (duration > prev ? duration : prev));
    }
  }, [duration]);

  useEffect(() => {
    if (peak > 0 && Number.isFinite(peak)) {
      setYExtent((prev) => (peak > prev ? peak : prev));
    }
  }, [peak]);

  useEffect(() => {
    if (previousTitleRef.current !== title) {
      previousTitleRef.current = title;
      setXExtent(duration > 0 && Number.isFinite(duration) ? duration : 1);
      setYExtent(peak > 0 && Number.isFinite(peak) ? peak : 1);
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

  const channelColors = useMemo(
    () => deriveIosChannelPalette(color, channelCount),
    [color, channelCount]
  );

  const data = useMemo(
    () =>
      channelSamples.map((samples, idx) => {
        const label = channelLabels[idx] ?? `Channel ${idx + 1}`;
        const colorForChannel =
          channelColors[idx] ??
          IOS_FALLBACK_PALETTE[idx % IOS_FALLBACK_PALETTE.length];

        return {
          type: "scatter" as const,
          mode: "lines",
          name: channelCount > 1 ? `${label}` : title,
          line: {
            color: colorForChannel.stroke,
            width: 2.4,
            shape: "spline",
            smoothing: 0.58,
          },
          fill: "tozeroy" as const,
          fillcolor: colorForChannel.fill,
          opacity: channelCount > 1 ? 0.95 : 1,
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
      times,
      title,
    ]
  );

  const layout = useMemo(() => {
    const safeXExtent = xExtent > 0 && Number.isFinite(xExtent) ? xExtent : 1;
    const safeYExtent = yExtent > 0 && Number.isFinite(yExtent) ? yExtent : 1;

    return {
      autosize: true,
      height: 220,
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
      showlegend: channelCount > 1,
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
    };
  }, [channelCount, xExtent, yExtent]);

  const config = useMemo(
    () =>
      ({
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
    []
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
      hoverlabel: { bgcolor: string; bordercolor: string; font: { color: string } };
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
      const createPlotlyComponent = (await import("react-plotly.js/factory")).default;
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

function downsampleBuffer(buffer: AudioBuffer) {
  const { sampleRate, length, numberOfChannels } = buffer;
  const channelCount = numberOfChannels > 0 ? numberOfChannels : 1;
  const step = Math.max(1, Math.floor(length / MAX_POINTS));
  const outputLength = length === 0 ? 0 : Math.ceil(length / step);
  const times = new Float32Array(outputLength);
  const channelSamples = Array.from({ length: channelCount }, () => new Float32Array(outputLength));

  if (length === 0 || sampleRate <= 0) {
    return { times, channelSamples, peak: 0, duration: 0 };
  }

  const sourceData = numberOfChannels > 0
    ? Array.from({ length: channelCount }, (_, idx) => buffer.getChannelData(idx))
    : [new Float32Array(length)];

  const timeScalar = 1 / sampleRate;
  let globalMax = Number.NEGATIVE_INFINITY;
  let globalMin = Number.POSITIVE_INFINITY;
  let writeIndex = 0;

  for (let start = 0; start < length; start += step) {
    const end = Math.min(length, start + step);
    times[writeIndex] = start * timeScalar;

    for (let ch = 0; ch < channelCount; ch++) {
      const channel = sourceData[ch];
      let maxVal = Number.NEGATIVE_INFINITY;
      let minVal = Number.POSITIVE_INFINITY;

      for (let i = start; i < end; i++) {
        const value = channel[i];
        if (value > maxVal) maxVal = value;
        if (value < minVal) minVal = value;
      }

      const dominant = Math.abs(maxVal) > Math.abs(minVal) ? maxVal : minVal;
      channelSamples[ch][writeIndex] = Number.isFinite(dominant) ? dominant : 0;

      if (maxVal > globalMax) globalMax = maxVal;
      if (minVal < globalMin) globalMin = minVal;
    }

    writeIndex++;
  }

  const resolvedMax = Number.isFinite(globalMax) ? Math.abs(globalMax) : 0;
  const resolvedMin = Number.isFinite(globalMin) ? Math.abs(globalMin) : 0;
  const peak = Math.max(resolvedMax, resolvedMin);
  const duration = length * timeScalar;

  return { times, channelSamples, peak, duration };
}

function deriveIosChannelPalette(baseColor: string, count: number): ChannelColor[] {
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

  const rgbMatch = trimmed.match(/^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})/i);
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