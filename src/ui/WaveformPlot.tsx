// WHY: Renders a down-sampled waveform view for audio buffers.
import { useEffect, useState, useMemo } from "react";

type Props = {
  buffer: AudioBuffer;
  color: string;
  title: string;
};

const MAX_POINTS = 4000;

export default function WaveformPlot({ buffer, color, title }: Props) {
  const { times, samples } = useMemo(() => downsampleBuffer(buffer), [buffer]);

  const data = useMemo(
    () => [
      {
        type: "scatter",
        mode: "lines",
        name: title,
        line: {
          color,
          width: 1.8,
          shape: "spline",
          smoothing: 0.6,
        },
        hovertemplate: "<b>%{x:.3f}s</b><br>%{y:.6f}<extra></extra>",
        x: times,
        y: samples,
      },
    ],
    [times, samples, color, title]
  );

  const layout = useMemo(
    () =>
      ({
        autosize: true,
        height: 220,
        margin: { t: 36, r: 26, l: 56, b: 40 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        font: {
          color: "rgba(235, 235, 245, 0.78)",
          family: "Inter, system-ui, sans-serif",
          size: 12,
        },
        hoverlabel: {
          bgcolor: "rgba(22, 22, 26, 0.92)",
          bordercolor: "rgba(255, 255, 255, 0.12)",
          font: { color: "#f9f9ff" },
        },
        hovermode: "x unified",
        showlegend: false,
        xaxis: {
          title: { text: "Time (s)", standoff: 12, font: { color: "rgba(235, 235, 245, 0.7)", size: 12 } },
          zeroline: true,
          showgrid: true,
          gridcolor: "rgba(255, 255, 255, 0.08)",
          zerolinecolor: "rgba(10, 132, 255, 0.4)",
          tickfont: { size: 11, color: "rgba(235, 235, 245, 0.65)" },
          linecolor: "rgba(255, 255, 255, 0.16)",
          mirror: true,
        },
        yaxis: {
          title: { text: "Amplitude", standoff: 12, font: { color: "rgba(235, 235, 245, 0.7)", size: 12 } },
          autorange: true,
          showgrid: true,
          gridcolor: "rgba(255, 255, 255, 0.08)",
          zerolinecolor: "rgba(255, 255, 255, 0.2)",
          tickfont: { size: 11, color: "rgba(235, 235, 245, 0.65)" },
          linecolor: "rgba(255, 255, 255, 0.16)",
          mirror: true,
        },
      }),
    []
  );

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
      showlegend: boolean;
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
  const mono = new Float32Array(length);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channel = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channel[i];
    }
  }
  const inv = numberOfChannels > 0 ? 1 / numberOfChannels : 1;
  for (let i = 0; i < length; i++) mono[i] *= inv;

  const step = Math.max(1, Math.floor(length / MAX_POINTS));
  const samples = new Float32Array(Math.ceil(length / step));
  const times = new Float32Array(samples.length);

  let writeIndex = 0;
  for (let i = 0; i < length; i += step) {
    let maxVal = -Infinity;
    let minVal = Infinity;
    const end = Math.min(length, i + step);
    
    // Find min and max in this chunk
    for (let j = i; j < end; j++) {
      const val = mono[j];
      maxVal = Math.max(maxVal, val);
      minVal = Math.min(minVal, val);
    }
    
    // Store the value that has the largest magnitude
    samples[writeIndex] = Math.abs(maxVal) > Math.abs(minVal) ? maxVal : minVal;
    times[writeIndex] = i / sampleRate;
    writeIndex++;
  }

  return { times, samples };
}
