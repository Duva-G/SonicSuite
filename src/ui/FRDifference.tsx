// WHY: Visualises the delta between dry and convolved playback spectra.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ChangeEvent,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
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
  sampleRate: number;
  compact?: boolean;
  // Controlled props (optional) so parent can sync threshold/abs across instances
  thresholdDb?: number;
  onChangeThresholdDb?: (v: number) => void;
  absMode?: boolean;
  onChangeAbsMode?: (v: boolean) => void;
  bandSoloEnabled?: boolean;
  bandMinHz?: number;
  bandMaxHz?: number;
  onChangeBandSoloEnabled?: (v: boolean) => void;
  onChangeBandHz?: (min: number, max: number) => void;
};

const Plot = createPlotlyComponent(Plotly);
type PlotProps = ComponentProps<typeof Plot>;
type PlotLayout = NonNullable<PlotProps["layout"]>;
type PlotConfig = NonNullable<PlotProps["config"]>;

type DifferenceSpectra = WorkerResultPayload & { diffDb: Float32Array | null };

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);
const DEFAULT_LOG_RANGE: [number, number] = [LOG_MIN, LOG_MAX];
const BAND_SLIDER_MIN = 0;
const BAND_SLIDER_MAX = 1000;
const MIN_BAND_GAP_HZ = 1;

function freqToSliderValue(freq: number): number {
  const clamped = Math.min(Math.max(freq, MIN_FREQ), MAX_FREQ);
  const norm = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return BAND_SLIDER_MIN + norm * (BAND_SLIDER_MAX - BAND_SLIDER_MIN);
}

function sliderValueToFreq(value: number): number {
  const norm = (value - BAND_SLIDER_MIN) / (BAND_SLIDER_MAX - BAND_SLIDER_MIN);
  const logValue = LOG_MIN + norm * (LOG_MAX - LOG_MIN);
  return Math.pow(10, logValue);
}

function clampBandRange(minHz: number, maxHz: number): [number, number] {
  const min = Math.max(MIN_FREQ, Math.min(minHz, MAX_FREQ - MIN_BAND_GAP_HZ));
  let max = Math.max(min + MIN_BAND_GAP_HZ, Math.min(maxHz, MAX_FREQ));
  if (max - min < MIN_BAND_GAP_HZ) {
    max = Math.min(MAX_FREQ, min + MIN_BAND_GAP_HZ);
  }
  return [min, max];
}

function formatHz(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz`;
  }
  return `${value.toFixed(0)} Hz`;
}

const smoothingOptions: Array<{ value: SmoothingMode; label: string }> = [
  { value: "1/24", label: "1/24 octave" },
  { value: "1/12", label: "1/12 octave" },
  { value: "1/6", label: "1/6 octave" },
  { value: "1/3", label: "1/3 octave" },
];

const THRESHOLD_MIN = 0;
const THRESHOLD_MAX = 12;
const THRESHOLD_STEP = 0.1;
const AUTO_THRESHOLD_PERCENTILE = 0.8;
const PRESET_TOLERANCE_HZ = 1;

const SOLO_PRESETS: Array<{ value: string; label: string; range: [number, number] }> = [
  { value: "full", label: "Full", range: [MIN_FREQ, MAX_FREQ] },
  { value: "bass", label: "Bass", range: [20, 200] },
  { value: "vocals", label: "Vocals", range: [200, 5000] },
  { value: "air", label: "Air", range: [8000, 20000] },
];

function derivePresetValue(minHz: number, maxHz: number): string {
  for (const preset of SOLO_PRESETS) {
    if (
      Math.abs(preset.range[0] - minHz) <= PRESET_TOLERANCE_HZ &&
      Math.abs(preset.range[1] - maxHz) <= PRESET_TOLERANCE_HZ
    ) {
      return preset.value;
    }
  }
  return "custom";
}

type InfoTipProps = {
  label: string;
  tooltipId?: string;
  placement?: "center" | "left";
  children: ReactNode;
};

function InfoTip({ label, tooltipId, placement = "center", children }: InfoTipProps) {
  const fallbackId = useId();
  const id = tooltipId ?? fallbackId;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <span className="frinfo">
      <button
        ref={buttonRef}
        type="button"
        className="frinfo__button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        i
      </button>
      <span
        id={id}
        role="tooltip"
        className={`frinfo__tooltip${placement === "left" ? " frinfo__tooltip--left" : ""}${open ? " is-open" : ""}`}
      >
        {children}
      </span>
    </span>
  );
}

function clampThreshold(value: number): number {
  if (Number.isNaN(value)) return THRESHOLD_MIN;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, value));
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = fraction * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export default function FRDifference({
  musicBuffer,
  irBuffer,
  sampleRate,
  compact = false,
  thresholdDb: thresholdDbProp,
  onChangeThresholdDb,
  absMode,
  onChangeAbsMode,
  bandSoloEnabled: bandSoloEnabledProp,
  bandMinHz: bandMinHzProp,
  bandMaxHz: bandMaxHzProp,
  onChangeBandSoloEnabled,
  onChangeBandHz,
}: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
  const [spectra, setSpectra] = useState<DifferenceSpectra | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);

  // New: absolute (fold negatives) display + threshold control ("move the 0 line")
  const [useAbsoluteState, setUseAbsoluteState] = useState<boolean>(true);
  const [thresholdDbState, setThresholdDbState] = useState<number>(0);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const stored = window.localStorage.getItem("frdifference.showAdvanced");
      return stored === "true";
    } catch {
      return false;
    }
  });
  const useAbsolute = typeof absMode === "boolean" ? absMode : useAbsoluteState;
  const thresholdDb = typeof thresholdDbProp === "number" ? thresholdDbProp : thresholdDbState;
  const setUseAbsolute = useCallback(
    (v: boolean) => {
      if (onChangeAbsMode) onChangeAbsMode(v);
      else setUseAbsoluteState(v);
    },
    [onChangeAbsMode]
  );
  const setThresholdDb = useCallback(
    (v: number) => {
      if (onChangeThresholdDb) onChangeThresholdDb(v);
      else setThresholdDbState(v);
    },
    [onChangeThresholdDb]
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("frdifference.showAdvanced", String(showAdvanced));
    } catch {
      // ignore storage issues
    }
  }, [showAdvanced]);
  const [bandSoloState, setBandSoloState] = useState<boolean>(false);
  const [bandRangeState, setBandRangeState] = useState<[number, number]>([MIN_FREQ, MAX_FREQ]);
  const bandSoloEnabled = typeof bandSoloEnabledProp === "boolean" ? bandSoloEnabledProp : bandSoloState;
  const bandMinHz = typeof bandMinHzProp === "number" ? bandMinHzProp : bandRangeState[0];
  const bandMaxHz = typeof bandMaxHzProp === "number" ? bandMaxHzProp : bandRangeState[1];
  const customPresetRequestRef = useRef(false);
  const [bandPresetState, setBandPresetState] = useState<string>(() => derivePresetValue(bandMinHz, bandMaxHz));
  const setBandSolo = (v: boolean) => {
    if (onChangeBandSoloEnabled) onChangeBandSoloEnabled(v);
    else setBandSoloState(v);
  };
  const setBandRange = (min: number, max: number) => {
    const [nextMin, nextMax] = clampBandRange(min, max);
    if (onChangeBandHz) onChangeBandHz(nextMin, nextMax);
    else setBandRangeState([nextMin, nextMax]);
  };
  const bandMinSlider = freqToSliderValue(bandMinHz);
  const bandMaxSlider = freqToSliderValue(bandMaxHz);
  const sliderSpan = BAND_SLIDER_MAX - BAND_SLIDER_MIN || 1;
  const sliderClamp = (value: number) => Math.min(100, Math.max(0, value));
  const sliderStart = sliderClamp(
    ((Math.min(bandMinSlider, bandMaxSlider) - BAND_SLIDER_MIN) / sliderSpan) * 100,
  );
  const sliderEnd = sliderClamp(
    ((Math.max(bandMinSlider, bandMaxSlider) - BAND_SLIDER_MIN) / sliderSpan) * 100,
  );
  const sliderSelectionWidth = Math.max(1, sliderEnd - sliderStart);
  const bandRangeLabel = `${formatHz(bandMinHz)} - ${formatHz(bandMaxHz)}`;
  const thresholdTooltipId = useId();
  const smoothingTooltipId = useId();
  const displayTooltipId = useId();
  const soloTooltipId = useId();
  const thresholdLabelId = useId();
  const smoothingLabelId = useId();
  const displayLabelId = useId();
  const soloLabelId = useId();
  const thresholdHelperId = useId();
  const derivedPreset = useMemo(
    () => derivePresetValue(bandMinHz, bandMaxHz),
    [bandMinHz, bandMaxHz]
  );

  useEffect(() => {
    if (customPresetRequestRef.current) {
      if (derivedPreset === "custom") {
        customPresetRequestRef.current = false;
      }
      return;
    }
    setBandPresetState(derivedPreset);
  }, [derivedPreset]);

  const handleBandMinChange = (event: ChangeEvent<HTMLInputElement>) => {
    const sliderValue = Number(event.currentTarget.value);
    const freq = sliderValueToFreq(sliderValue);
    const nextMin = Math.min(freq, bandMaxHz - MIN_BAND_GAP_HZ);
    customPresetRequestRef.current = false;
    setBandPresetState("custom");
    setBandRange(nextMin, bandMaxHz);
  };

  const handleBandMaxChange = (event: ChangeEvent<HTMLInputElement>) => {
    const sliderValue = Number(event.currentTarget.value);
    const freq = sliderValueToFreq(sliderValue);
    const nextMax = Math.max(freq, bandMinHz + MIN_BAND_GAP_HZ);
    customPresetRequestRef.current = false;
    setBandPresetState("custom");
    setBandRange(bandMinHz, nextMax);
  };

  const diffValues = useMemo(() => {
    if (!spectra?.diffDb) return null;
    return Array.from(spectra.diffDb);
  }, [spectra]);

  const absoluteDiffValues = useMemo(() => {
    if (!diffValues) return null;
    return diffValues.map((value) => Math.abs(value));
  }, [diffValues]);

  const displayedDiffValues = useMemo(() => {
    if (!diffValues) return null;
    return useAbsolute ? absoluteDiffValues ?? null : diffValues;
  }, [absoluteDiffValues, diffValues, useAbsolute]);

  const metrics = useMemo(() => {
    if (!displayedDiffValues || !displayedDiffValues.length || !absoluteDiffValues) return null;
    const len = displayedDiffValues.length;
    const rms =
      len === 0 ? 0 : Math.sqrt(displayedDiffValues.reduce((sum, value) => sum + value * value, 0) / len);
    const peak = displayedDiffValues.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    const threshold = Math.max(thresholdDb, 0);
    const aboveCount = absoluteDiffValues.reduce(
      (count, value) => count + (value >= threshold ? 1 : 0),
      0,
    );
    const percentAbove = len === 0 ? 0 : (aboveCount / len) * 100;
    return { rms, peak, percentAbove };
  }, [absoluteDiffValues, displayedDiffValues, thresholdDb]);

  const metricsBadges = useMemo(() => {
    if (!metrics) return [];
    return [
      { label: "RMS", value: `${metrics.rms.toFixed(1)} dB` },
      { label: "Peak", value: `${metrics.peak.toFixed(1)} dB` },
      { label: "% > threshold", value: `${Math.round(metrics.percentAbove)}%` },
    ];
  }, [metrics]);
  const showMetrics = metricsBadges.length > 0;

  const handlePresetChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    if (value === "custom") {
      customPresetRequestRef.current = true;
      setBandPresetState("custom");
      if (!bandSoloEnabled) setBandSolo(true);
      return;
    }
    customPresetRequestRef.current = false;
    setBandPresetState(value);
    const preset = SOLO_PRESETS.find((option) => option.value === value);
    if (preset) {
      setBandRange(preset.range[0], preset.range[1]);
      if (!bandSoloEnabled) setBandSolo(true);
    }
  };

  const showSoloControls = bandSoloEnabled && bandPresetState === "custom";

  const handleAutoThreshold = useCallback(() => {
    if (!absoluteDiffValues || !absoluteDiffValues.length) return;
    const value = percentile(absoluteDiffValues, AUTO_THRESHOLD_PERCENTILE);
    if (value === null) return;
    setThresholdDb(clampThreshold(Number(value.toFixed(1))));
  }, [absoluteDiffValues, setThresholdDb]);

  const handleThresholdSliderChange = (value: number) => {
    setThresholdDb(clampThreshold(value));
  };

  const handleThresholdRangeChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleThresholdSliderChange(Number(event.currentTarget.value));
  };

  const handleThresholdNumberChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    if (raw === "") return;
    handleThresholdSliderChange(Number(raw));
  };

  const handleThresholdKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const delta = event.shiftKey ? 1 : THRESHOLD_STEP;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    handleThresholdSliderChange(thresholdDb + direction * delta);
  };

  const handleBandMinKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const deltaHz = event.shiftKey ? 10 : 0.1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    const nextMin = Math.max(MIN_FREQ, Math.min(MAX_FREQ, bandMinHz + direction * deltaHz));
    customPresetRequestRef.current = false;
    setBandPresetState("custom");
    setBandRange(nextMin, bandMaxHz);
  };

  const handleBandMaxKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const deltaHz = event.shiftKey ? 10 : 0.1;
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
    const nextMax = Math.max(MIN_FREQ, Math.min(MAX_FREQ, bandMaxHz + direction * deltaHz));
    customPresetRequestRef.current = false;
    setBandPresetState("custom");
    setBandRange(bandMinHz, nextMax);
  };

  const updateBandFromInput = (min: number, max: number) => {
    customPresetRequestRef.current = false;
    setBandPresetState("custom");
    setBandRange(min, max);
  };

  const handleBandMinInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.currentTarget.value);
    if (Number.isNaN(value)) return;
    const clamped = Math.max(MIN_FREQ, Math.min(value, bandMaxHz - MIN_BAND_GAP_HZ));
    updateBandFromInput(clamped, bandMaxHz);
  };

  const handleBandMaxInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.currentTarget.value);
    if (Number.isNaN(value)) return;
    const clamped = Math.min(MAX_FREQ, Math.max(value, bandMinHz + MIN_BAND_GAP_HZ));
    updateBandFromInput(bandMinHz, clamped);
  };

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
        console.warn("Difference FR worker unavailable.", error);
      }
      setWorkerReady(false);
      setError("Difference analysis is unavailable in this browser (missing Web Worker support).");
      return;
    }
    workerRef.current = worker;
    setWorkerReady(true);

    const handleMessage = (event: MessageEvent<WorkerMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "playback-fr-result") {
        if (data.requestId !== activeRequestRef.current) return;
        const payload = data.payload;
        const diff = payload.wetDb ? computeDifference(payload.dryDb, payload.wetDb) : null;
        pendingRenderRef.current = Boolean(diff);
        setSpectra({ ...payload, diffDb: diff });
        if (!diff) {
          setLoading(false);
        }
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
      setError("Load a music track to compare its convolved difference.");
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

  const trace = useMemo(() => {
    if (!spectra?.diffDb || !spectra.wetDb || !displayedDiffValues) return null;
    const freqs = Array.from(spectra.freqs);
    const sanitizedFreqs = freqs.map((hz) => (hz > 0 ? hz : MIN_FREQ));
    const name = useAbsolute ? "|Wet - Dry| (dB)" : "Wet - Dry (dB)";
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      name,
      x: sanitizedFreqs,
      y: displayedDiffValues,
      line: { color: "#ff7b84", width: 2 },
      hovertemplate: "<b>%{x:.0f} Hz</b><br>%{y:.2f} dB<extra></extra>",
    };
  }, [displayedDiffValues, spectra, useAbsolute]);

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

  // Update layout shapes/title when absolute/threshold/band settings change
  useEffect(() => {
    setLayout((prevLayout: PlotLayout) => {
      const base: PlotLayout = { ...prevLayout };
      const shapes: NonNullable<PlotLayout["shapes"]> = [];
      if (bandSoloEnabled) {
        const x0 = Math.max(MIN_FREQ, bandMinHz);
        const x1 = Math.min(MAX_FREQ, bandMaxHz);
        shapes.push({
          type: "rect",
          xref: "x",
          x0,
          x1,
          yref: "paper",
          y0: 0,
          y1: 1,
          fillcolor: "rgba(10, 132, 255, 0.08)",
          line: { width: 0 },
          layer: "below",
        });
      }
      shapes.push(
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
      );
      if (useAbsolute && thresholdDb > 0) {
        shapes.push({
          type: "line",
          xref: "paper",
          x0: 0,
          x1: 1,
          yref: "y",
          y0: thresholdDb,
          y1: thresholdDb,
          line: { color: "rgba(255,255,255,0.6)", width: 1, dash: "dash" },
        });
      }
      base.shapes = shapes;
      base.annotations = bandSoloEnabled
        ? [
            {
              xref: "paper",
              x: 1,
              xanchor: "right",
              yref: "paper",
              y: 1.08,
              showarrow: false,
              align: "right",
              font: { size: 12, color: "rgba(220, 236, 255, 0.9)" },
              text: `Solo band: ${formatHz(Math.max(MIN_FREQ, bandMinHz))} - ${formatHz(
                Math.min(MAX_FREQ, bandMaxHz),
              )}`,
            },
          ]
        : [];
      base.yaxis = {
        ...base.yaxis,
        title: {
          text: useAbsolute ? "Absolute magnitude delta (dB)" : "Magnitude delta (dB)",
          ...(base.yaxis && (base.yaxis as PlotLayout["yaxis"]).title ? (base.yaxis as PlotLayout["yaxis"]).title : {}),
        },
      } as PlotLayout["yaxis"];
      return base;
    });
  }, [useAbsolute, thresholdDb, bandSoloEnabled, bandMinHz, bandMaxHz]);

  const config = useMemo<PlotConfig>(
    () => ({
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ["select2d", "lasso2d"],
      toImageButtonOptions: {
        format: "png" as const,
        filename: "fr-difference-response",
        height: 700,
        width: 1200,
        scale: 2,
      },
    }) as PlotConfig,
    []
  );


  return (
    <div className="frpink frdifference">
      <header className="frdifference-header">
        <div className="frdifference-heading">
          <h2 className="frdifference-title">Difference Detection</h2>
          <p className="frdifference-subtitle">Pick how much change counts as a difference.</p>
          {showMetrics && (
            <ul className="frdifference-metrics" role="status" aria-live="polite">
              {metricsBadges.map((badge) => (
                <li key={badge.label}>
                  <span className="frdifference-metrics__label">{badge.label}</span>
                  <span className="frdifference-metrics__value">{badge.value}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="frdifference-mode" role="group" aria-label="View mode">
          <button
            type="button"
            className={`frdifference-mode__button${showAdvanced ? "" : " is-active"}`}
            aria-pressed={!showAdvanced}
            onClick={() => setShowAdvanced(false)}
          >
            Simple
          </button>
          <button
            type="button"
            className={`frdifference-mode__button${showAdvanced ? " is-active" : ""}`}
            aria-pressed={showAdvanced}
            onClick={() => setShowAdvanced(true)}
          >
            Advanced
          </button>
        </div>
      </header>

      <div className="frdifference-grid">
        <section className="frdifference-threshold-card" aria-labelledby={thresholdLabelId}>
          <div className="frdifference-section-header">
            <span className="frdifference-section-label" id={thresholdLabelId}>
              Threshold (dB)
            </span>
            <InfoTip label="Threshold help" tooltipId={thresholdTooltipId}>
              Treat changes below this dB as no difference.
            </InfoTip>
          </div>
          <div
            className="frdifference-threshold-row"
            aria-describedby={`${thresholdTooltipId} ${thresholdHelperId}`}
          >
            <input
              type="range"
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={THRESHOLD_STEP}
              value={thresholdDb}
              aria-labelledby={thresholdLabelId}
              aria-describedby={`${thresholdTooltipId} ${thresholdHelperId}`}
              onChange={handleThresholdRangeChange}
              onKeyDown={handleThresholdKeyDown}
            />
            <input
              type="number"
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={THRESHOLD_STEP}
              value={thresholdDb.toFixed(1)}
              onChange={handleThresholdNumberChange}
              aria-label="Threshold in decibels"
              className="frdifference-field-input"
            />
            <button
              type="button"
              className="frdifference-inline-button"
              onClick={handleAutoThreshold}
              disabled={!absoluteDiffValues || absoluteDiffValues.length === 0}
            >
              Auto
            </button>
          </div>
          <p className="frdifference-helper" id={thresholdHelperId}>
            Ignores changes below this dB.
          </p>

          <div className="frdifference-display">
            <div className="frdifference-section-header">
              <span className="frdifference-section-label" id={displayLabelId}>
                Display
              </span>
              <InfoTip label="Display help" tooltipId={displayTooltipId}>
                Absolute mode shows only magnitude. Signed mode shows increase/decrease.
              </InfoTip>
            </div>
            <div
              className="frdifference-segmented"
              role="group"
              aria-labelledby={displayLabelId}
              aria-describedby={displayTooltipId}
            >
              <button
                type="button"
                className={`frdifference-segmented__button${useAbsolute ? " is-active" : ""}`}
                aria-pressed={useAbsolute}
                onClick={() => setUseAbsolute(true)}
              >
                Absolute
              </button>
              <button
                type="button"
                className={`frdifference-segmented__button${!useAbsolute ? " is-active" : ""}`}
                aria-pressed={!useAbsolute}
                onClick={() => setUseAbsolute(false)}
              >
                Signed
              </button>
            </div>
          </div>
        </section>

        <section className={`frdifference-accordion${showAdvanced ? " is-open" : ""}`}>
          <button
            type="button"
            className="frdifference-accordion__toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((prev) => !prev)}
          >
            <span>Advanced</span>
            <span className="frdifference-accordion__chevron" aria-hidden="true" />
          </button>
          <div
            className="frdifference-accordion__body"
            aria-hidden={!showAdvanced}
          >
            <div className="frdifference-advanced-grid">
              <div className="frdifference-advanced-section" role="group" aria-labelledby={smoothingLabelId}>
                <div className="frdifference-section-header">
                  <span className="frdifference-section-label" id={smoothingLabelId}>
                    Smoothing
                  </span>
                  <InfoTip label="Smoothing help" tooltipId={smoothingTooltipId} placement="left">
                    Higher = steadier, less detail.
                  </InfoTip>
                </div>
                <div
                  className="frdifference-segmented"
                  role="radiogroup"
                  aria-labelledby={smoothingLabelId}
                  aria-describedby={smoothingTooltipId}
                >
                  {smoothingOptions.map((option) => {
                    const isActive = smoothing === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        className={`frdifference-segmented__button${isActive ? " is-active" : ""}`}
                        onClick={() => setSmoothing(option.value)}
                      >
                        {option.label.replace(" octave", "")}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="frdifference-advanced-section frdifference-advanced-section--solo" role="group" aria-labelledby={soloLabelId}>
                <div className="frdifference-section-header">
                  <span className="frdifference-section-label" id={soloLabelId}>
                    Analyze a band
                  </span>
                  <InfoTip label="Solo band help" tooltipId={soloTooltipId}>
                    Limit analysis to a frequency band. Drag the handles or type values.
                  </InfoTip>
                  <button
                    type="button"
                    className={`frdifference-switch${bandSoloEnabled ? " is-active" : ""}`}
                    aria-pressed={bandSoloEnabled}
                    onClick={() => setBandSolo(!bandSoloEnabled)}
                    aria-label={bandSoloEnabled ? "Disable band analysis" : "Enable band analysis"}
                  >
                    {bandSoloEnabled ? "On" : "Off"}
                  </button>
                </div>
                <label className="frdifference-field">
                  <span>Preset</span>
                  <select
                    value={bandPresetState}
                    onChange={handlePresetChange}
                    className="frdifference-field-select"
                    aria-label="Solo band preset"
                  >
                    {SOLO_PRESETS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                </label>

                {bandSoloEnabled && (
                  <div className="frdifference-band-readout" role="text" aria-live="polite">
                    <span>{formatHz(Math.max(MIN_FREQ, bandMinHz))}</span>
                    <span className="frdifference-band-readout__dash">-</span>
                    <span>{formatHz(Math.min(MAX_FREQ, bandMaxHz))}</span>
                  </div>
                )}

                {showSoloControls && (
                  <>
                    <div
                      className="frdifference-band-slider"
                      aria-label={`Solo band frequency range ${bandRangeLabel}`}
                    >
                      <div className="frdifference-band-slider__track" />
                      <div
                        className="frdifference-band-slider__selection"
                        style={{ left: `${sliderStart}%`, width: `${sliderSelectionWidth}%` }}
                      />
                      <input
                        type="range"
                        min={BAND_SLIDER_MIN}
                        max={BAND_SLIDER_MAX}
                        step={1}
                        value={bandMinSlider}
                        onChange={handleBandMinChange}
                        onKeyDown={handleBandMinKeyDown}
                        aria-label="Solo band start frequency"
                        className="frdifference-band-slider__input"
                      />
                      <input
                        type="range"
                        min={BAND_SLIDER_MIN}
                        max={BAND_SLIDER_MAX}
                        step={1}
                        value={bandMaxSlider}
                        onChange={handleBandMaxChange}
                        onKeyDown={handleBandMaxKeyDown}
                        aria-label="Solo band end frequency"
                        className="frdifference-band-slider__input frdifference-band-slider__input--upper"
                      />
                    </div>
                    <div className="frdifference-band-inputs">
                      <label className="frdifference-field">
                        <span>Start (Hz)</span>
                        <input
                          type="number"
                          min={MIN_FREQ}
                          max={MAX_FREQ}
                          step={0.1}
                          value={bandMinHz.toFixed(1)}
                          onChange={handleBandMinInputChange}
                          aria-label="Solo band start frequency"
                          className="frdifference-field-input"
                        />
                      </label>
                      <label className="frdifference-field">
                        <span>End (Hz)</span>
                        <input
                          type="number"
                          min={MIN_FREQ}
                          max={MAX_FREQ}
                          step={0.1}
                          value={bandMaxHz.toFixed(1)}
                          onChange={handleBandMaxInputChange}
                          aria-label="Solo band end frequency"
                          className="frdifference-field-input"
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {error && <div className="frpink-message frpink-message--error">{error}</div>}
      <div className="frpink-plot">
        {isLoading && (
          <div className="frplot-progress" role="status" aria-live="polite">
            <div className="frplot-progress__track">
              <div className="frplot-progress__bar" />
            </div>
            <span className="frplot-progress__label">Preparing difference curve</span>
          </div>
        )}
        {trace && (
          <Plot
            data={[trace]}
            layout={layout}
            config={config}
            useResizeHandler
            style={{ width: "100%", height: "100%", minHeight: compact ? 220 : 320 }}
            onRelayout={handleRelayout}
            onAfterPlot={handleAfterPlot}
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
