// WHY: Renders a down-sampled waveform view for audio buffers.
import { useMemo } from "react";
import type { ComponentProps } from "react";
import Plotly from "plotly.js-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";

const Plot = createPlotlyComponent(Plotly);
type PlotComponentProps = ComponentProps<typeof Plot>;
type PlotDataArray = NonNullable<PlotComponentProps["data"]>;
type PlotDatum = PlotDataArray[number];
type PlotLayout = NonNullable<PlotComponentProps["layout"]>;
type PlotConfig = NonNullable<PlotComponentProps["config"]>;

type Props = {
  buffer: AudioBuffer;
  color: string;
  title: string;
};

const MAX_POINTS = 4000;

export default function WaveformPlot({ buffer, color, title }: Props) {
  const { times, samples } = useMemo(() => downsampleBuffer(buffer), [buffer]);

  const data = useMemo<PlotDataArray>(
    () =>
      [
        {
          type: "scatter",
          mode: "lines",
          name: title,
          hovertemplate: "<b>%{x:.3f}s</b><br>%{y:.3f}<extra></extra>",
          x: times,
          y: samples,
          line: { color, width: 1.6 },
        } as PlotDatum,
      ] as PlotDataArray,
    [times, samples, color, title]
  );

  const layout = useMemo<PlotLayout>(
    () =>
      ({
        autosize: true,
        height: 260,
        margin: { t: 24, r: 20, l: 48, b: 36 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(28,28,30,0.6)",
        font: { color: "#f2f2f7", family: "Inter, system-ui, sans-serif", size: 12 },
        xaxis: {
          title: "Time (s)",
          zeroline: false,
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.11)",
        },
        yaxis: {
          title: "Amplitude",
          showgrid: true,
          gridcolor: "rgba(255,255,255,0.11)",
          zeroline: true,
          zerolinecolor: "rgba(255,255,255,0.3)",
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
          filename: "waveform",
          height: 420,
          width: 1200,
          scale: 2,
        },
      }) as PlotConfig,
    []
  );

  return <Plot data={data} layout={layout} config={config} useResizeHandler style={{ width: "100%", height: "100%" }} />;
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
    let sum = 0;
    let count = 0;
    const end = Math.min(length, i + step);
    for (let j = i; j < end; j++) {
      sum += mono[j];
      count++;
    }
    samples[writeIndex] = count ? sum / count : 0;
    times[writeIndex] = i / sampleRate;
    writeIndex++;
  }

  return { times, samples };
}
