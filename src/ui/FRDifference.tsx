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
  irBufferB?: AudioBuffer | null;
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
  bandMatchRmsEnabled?: boolean;
  onChangeBandMatchRmsEnabled?: (v: boolean) => void;
};

const Plot = createPlotlyComponent(Plotly);
type PlotProps = ComponentProps<typeof Plot>;
type PlotLayout = NonNullable<PlotProps["layout"]>;
type PlotConfig = NonNullable<PlotProps["config"]>;
type PlotDataArray = NonNullable<PlotProps["data"]>;
type PlotDatum = PlotDataArray[number];

type RequestKind = "dry" | "wetA" | "wetB";

type DifferenceSpectraSet = {
  dry: WorkerResultPayload | null;
  convolvedA: WorkerResultPayload | null;
  convolvedB: WorkerResultPayload | null;
};

type DifferenceCurveId = "origMinusA" | "origMinusB" | "aMinusB";

type DifferenceCurveMeta = {
  id: DifferenceCurveId;
  label: string;
  color: string;
  dash: "dash";
  disabledReason?: string;
};

type DifferenceCurveData = DifferenceCurveMeta & {
  values: Float32Array | null;
  available: boolean;
  phase?: Float32Array | null;
};

const DIFFERENCE_CURVE_META: Record<DifferenceCurveId, DifferenceCurveMeta> = {
  origMinusA: {
    id: "origMinusA",
    label: "Original − A",
    color: "#6ea8ff",
    dash: "dash",
    disabledReason: "Requires IR A",
  },
  origMinusB: {
    id: "origMinusB",
    label: "Original − B",
    color: "#6fd59a",
    dash: "dash",
    disabledReason: "Requires IR B",
  },
  aMinusB: {
    id: "aMinusB",
    label: "A − B",
    color: "#f3a762",
    dash: "dash",
    disabledReason: "Requires IR B",
  },
};

const FR_VISIBILITY_STORAGE_KEY = "frdifference.visibility";
const DEFAULT_VISIBLE_CURVES: DifferenceCurveId[] = ["origMinusA", "origMinusB", "aMinusB"];

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
  irBufferB = null,
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
  bandMatchRmsEnabled: bandMatchRmsEnabledProp,
  onChangeBandMatchRmsEnabled,
}: Props) {
  const [smoothing, setSmoothing] = useState<SmoothingMode>("1/6");
  const [spectraSet, setSpectraSet] = useState<DifferenceSpectraSet>(() => ({
    dry: null,
    convolvedA: null,
    convolvedB: null,
  }));
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
  const [bandMatchRmsState, setBandMatchRmsState] = useState<boolean>(true);
  const bandSoloEnabled = typeof bandSoloEnabledProp === "boolean" ? bandSoloEnabledProp : bandSoloState;
  const bandMinHz = typeof bandMinHzProp === "number" ? bandMinHzProp : bandRangeState[0];
  const bandMaxHz = typeof bandMaxHzProp === "number" ? bandMaxHzProp : bandRangeState[1];
  const bandMatchRmsEnabled =
    typeof bandMatchRmsEnabledProp === "boolean" ? bandMatchRmsEnabledProp : bandMatchRmsState;
  const customPresetRequestRef = useRef(false);
  const [bandPresetState, setBandPresetState] = useState<string>(() => derivePresetValue(bandMinHz, bandMaxHz));
  const setBandSolo = (v: boolean) => {
    if (onChangeBandSoloEnabled) onChangeBandSoloEnabled(v);
    else setBandSoloState(v);
  };
  const setBandMatchRms = (v: boolean) => {
    if (onChangeBandMatchRmsEnabled) onChangeBandMatchRmsEnabled(v);
    else setBandMatchRmsState(v);
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
  const matchRmsTooltipId = useId();
  const thresholdLabelId = useId();
  const smoothingLabelId = useId();
  const displayLabelId = useId();
  const curvesLabelId = useId();
  const soloLabelId = useId();
  const matchRmsLabelId = useId();
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

  const [visibleCurves, setVisibleCurves] = useState<DifferenceCurveId[]>(() => {
    const fallback = [...DEFAULT_VISIBLE_CURVES];
    if (typeof window === "undefined") {
      return fallback;
    }
    try {
      const stored = window.localStorage.getItem(FR_VISIBILITY_STORAGE_KEY);
      if (!stored) {
        return fallback;
      }
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) {
        return fallback;
      }
      const sanitized = parsed.filter((value): value is DifferenceCurveId =>
        typeof value === "string" && (value === "origMinusA" || value === "origMinusB" || value === "aMinusB"),
      );
      return sanitized.length > 0 ? Array.from(new Set(sanitized)) : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(FR_VISIBILITY_STORAGE_KEY, JSON.stringify(visibleCurves));
    } catch {
      // ignore storage issues
    }
  }, [visibleCurves]);

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

  const differenceData = useMemo(() => {
    const baseDryPayload =
      spectraSet.dry ??
      (spectraSet.convolvedA?.dryDb ? spectraSet.convolvedA : null) ??
      (spectraSet.convolvedB?.dryDb ? spectraSet.convolvedB : null) ??
      null;
    const dryDb = baseDryPayload?.dryDb ?? null;
    const baseFreqs =
      spectraSet.dry?.freqs ??
      spectraSet.convolvedA?.freqs ??
      spectraSet.convolvedB?.freqs ??
      null;

    const wetA = spectraSet.convolvedA?.wetDb ?? null;
    const wetB = spectraSet.convolvedB?.wetDb ?? null;

    const origMinusAValues = dryDb && wetA ? computeDbDelta(dryDb, wetA) : null;
    const origMinusBValues = dryDb && wetB ? computeDbDelta(dryDb, wetB) : null;
    const aMinusBValues = wetA && wetB ? computeDbDelta(wetA, wetB) : null;

    const buildCurve = (
      meta: DifferenceCurveMeta,
      values: Float32Array | null,
      available: boolean,
      overrideDisabled?: string,
    ): DifferenceCurveData => ({
      ...meta,
      values,
      available,
      disabledReason: overrideDisabled ?? meta.disabledReason,
      phase: null,
    });

    const curves: Record<DifferenceCurveId, DifferenceCurveData> = {
      origMinusA: buildCurve(
        DIFFERENCE_CURVE_META.origMinusA,
        origMinusAValues,
        Boolean(origMinusAValues),
        wetA ? undefined : "Requires IR A",
      ),
      origMinusB: buildCurve(
        DIFFERENCE_CURVE_META.origMinusB,
        origMinusBValues,
        Boolean(origMinusBValues),
        wetB ? undefined : "Requires IR B",
      ),
      aMinusB: buildCurve(
        DIFFERENCE_CURVE_META.aMinusB,
        aMinusBValues,
        Boolean(aMinusBValues),
        wetA && wetB ? undefined : "Requires IR B",
      ),
    };

    return {
      freqs: baseFreqs,
      curves,
    };
  }, [spectraSet]);

  const availableCurveIds = useMemo<DifferenceCurveId[]>(() => {
    const ordered = DEFAULT_VISIBLE_CURVES.filter(
      (id) => differenceData.curves[id].available,
    ) as DifferenceCurveId[];
    return ordered;
  }, [differenceData.curves]);

  const previousAvailableRef = useRef<DifferenceCurveId[]>(availableCurveIds);

  useEffect(() => {
    const previousAvailable = previousAvailableRef.current;
    previousAvailableRef.current = availableCurveIds;
    setVisibleCurves((prev) => {
      const prevUnique = DEFAULT_VISIBLE_CURVES.filter((id) => prev.includes(id));
      const sanitized = DEFAULT_VISIBLE_CURVES.filter(
        (id) => prevUnique.includes(id) && availableCurveIds.includes(id),
      ) as DifferenceCurveId[];
      const newlyAvailable = availableCurveIds.filter((id) => !previousAvailable.includes(id));
      let next: DifferenceCurveId[];
      if (availableCurveIds.length === 0) {
        next = [];
      } else if (sanitized.length === 0) {
        next = [...availableCurveIds];
      } else if (newlyAvailable.length > 0) {
        const mergedSet = new Set<DifferenceCurveId>([...sanitized, ...newlyAvailable]);
        next = DEFAULT_VISIBLE_CURVES.filter((id) => mergedSet.has(id) && availableCurveIds.includes(id)) as DifferenceCurveId[];
      } else {
        next = sanitized;
      }
      if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) {
        return prev;
      }
      return next;
    });
  }, [availableCurveIds]);

  const primaryCurveId = useMemo<DifferenceCurveId | null>(() => {
    for (const id of DEFAULT_VISIBLE_CURVES) {
      if (visibleCurves.includes(id) && differenceData.curves[id].available) {
        return id;
      }
    }
    for (const id of DEFAULT_VISIBLE_CURVES) {
      if (differenceData.curves[id].available) {
        return id;
      }
    }
    return null;
  }, [visibleCurves, differenceData.curves]);

  const primaryCurve = primaryCurveId ? differenceData.curves[primaryCurveId] : null;

  const diffValues = useMemo(() => {
    if (!primaryCurve?.values) return null;
    return Array.from(primaryCurve.values);
  }, [primaryCurve]);

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
    const items = [
      { label: "RMS", value: `${metrics.rms.toFixed(1)} dB` },
      { label: "Peak", value: `${metrics.peak.toFixed(1)} dB` },
      { label: "% > threshold", value: `${Math.round(metrics.percentAbove)}%` },
    ];
    if (primaryCurve) {
      items.unshift({ label: "Curve", value: primaryCurve.label });
    }
    return items;
  }, [metrics, primaryCurve]);
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
  const generationRef = useRef(0);
  const requestKindMapRef = useRef(new Map<number, { kind: RequestKind; generation: number }>());
  const expectedKindsRef = useRef<Set<RequestKind>>(new Set());
  const responsesRef = useRef<DifferenceSpectraSet>({
    dry: null,
    convolvedA: null,
    convolvedB: null,
  });
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
      if (!data || (data.type !== "playback-fr-result" && data.type !== "playback-fr-error")) {
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
        const hasDiffPayload =
          Boolean(responsesRef.current.convolvedA?.wetDb) ||
          Boolean(responsesRef.current.convolvedB?.wetDb);
        pendingRenderRef.current = hasDiffPayload;
        if (!hasDiffPayload) {
          setLoading(false);
        }
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
      setError("Load a music track to compare its convolved difference.");
      return;
    }

    generationRef.current += 1;
    const currentGeneration = generationRef.current;
    requestKindMapRef.current.clear();
    expectedKindsRef.current.clear();
    responsesRef.current = { dry: null, convolvedA: null, convolvedB: null };
    setSpectraSet({ dry: null, convolvedA: null, convolvedB: null });
    pendingRenderRef.current = false;

    const pendingKinds: RequestKind[] = ["dry"];
    if (irBuffer) pendingKinds.push("wetA");
    if (irBufferB) pendingKinds.push("wetB");

    const expectDifferences = pendingKinds.includes("wetA") || pendingKinds.includes("wetB");
    expectedKindsRef.current = new Set(pendingKinds);
    setLoading(expectDifferences);
    setError(null);
    pendingRenderRef.current = expectDifferences;

    if (pendingKinds.length === 0) {
      return;
    }

    for (const kind of pendingKinds) {
      const requestId = ++requestIdRef.current;
      requestKindMapRef.current.set(requestId, { kind, generation: currentGeneration });

      const musicPayload = serializeBuffer(musicBuffer, "music");
      const irSource = kind === "wetA" ? irBuffer : kind === "wetB" ? irBufferB : null;
      const irPayload = irSource ? serializeBuffer(irSource, kind === "wetB" ? "ir-b" : "ir") : null;

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
  }, [workerReady, musicBuffer, irBuffer, irBufferB, sampleRate, smoothing]);

  const traces = useMemo<PlotDataArray>(() => {
    if (!differenceData.freqs) {
      return [] as PlotDataArray;
    }
    const sanitizedFreqs = Float32Array.from(differenceData.freqs, (hz) =>
      hz > 0 ? hz : MIN_FREQ,
    );
    const datasets: PlotDataArray = [];
    visibleCurves.forEach((id) => {
      const curve = differenceData.curves[id];
      if (!curve.available || !curve.values) {
        return;
      }
      const source = curve.values;
      const yValues =
        useAbsolute ? Float32Array.from(source, (value) => Math.abs(value)) : source;
      const hoverParts = [
        `<b>${curve.label}</b>`,
        "<br>%{x:.0f} Hz",
        `<br>${useAbsolute ? "Δ |dB|" : "Δ dB"}: %{y:.2f}`,
      ];
      let customdata: Float32Array | undefined;
      if (curve.phase) {
        customdata = Float32Array.from(curve.phase);
        hoverParts.push("<br>Δ Phase: %{customdata:.1f}°");
      }
      const trace: PlotDatum = {
        type: "scatter",
        mode: "lines",
        name: curve.label,
        x: sanitizedFreqs,
        y: yValues,
        line: { color: curve.color, width: 2, dash: curve.dash },
        hovertemplate: `${hoverParts.join("")}<extra></extra>`,
      };
      if (customdata) {
        trace.customdata = customdata;
      }
      datasets.push(trace);
    });
    return datasets;
  }, [differenceData.curves, differenceData.freqs, visibleCurves, useAbsolute]);

  const hasActiveCurves = traces.length > 0;
  const hasDifferenceAvailable = availableCurveIds.length > 0;

  const toggleCurve = useCallback(
    (id: DifferenceCurveId) => {
      if (!differenceData.curves[id].available) return;
      setVisibleCurves((prev) => {
        const nextSet = new Set(prev);
        if (nextSet.has(id)) {
          nextSet.delete(id);
        } else {
          nextSet.add(id);
        }
        const orderedNext = DEFAULT_VISIBLE_CURVES.filter(
          (value) => nextSet.has(value) && availableCurveIds.includes(value),
        ) as DifferenceCurveId[];
        if (orderedNext.length === 0 && availableCurveIds.length > 0) {
          nextSet.add(id);
          const fallback = DEFAULT_VISIBLE_CURVES.filter(
            (value) => nextSet.has(value) && availableCurveIds.includes(value),
          ) as DifferenceCurveId[];
          if (fallback.length === prev.length && fallback.every((value, index) => value === prev[index])) {
            return prev;
          }
          return fallback;
        }
        if (orderedNext.length === prev.length && orderedNext.every((value, index) => value === prev[index])) {
          return prev;
        }
        return orderedNext;
      });
    },
    [availableCurveIds, differenceData.curves],
  );

  const curveStates = DEFAULT_VISIBLE_CURVES.map((id) => differenceData.curves[id]);

  useEffect(() => {
    if (!spectraSet.convolvedA?.wetDb && !spectraSet.convolvedB?.wetDb) {
      return;
    }
    resetAxes();
  }, [spectraSet.convolvedA?.wetDb, spectraSet.convolvedB?.wetDb, resetAxes]);

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
    <div className={`frpink frdifference${compact ? " frdifference--compact" : ""}`}>
      <header className={`frdifference-header${compact ? " frdifference-header--compact" : ""}`}>
        {!compact && (
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
        )}
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

      <div className="frdifference-curve-toggle">
        <div className="frdifference-section-header">
          <span className="frdifference-section-label" id={curvesLabelId}>
            Curves
          </span>
        </div>
        <div
          className="frdifference-segmented"
          role="group"
          aria-labelledby={curvesLabelId}
        >
          {curveStates.map((curve) => {
            const isActive = visibleCurves.includes(curve.id) && curve.available;
            const disabled = !curve.available;
            const title = disabled
              ? curve.disabledReason ?? "Not available"
              : `Toggle ${curve.label}`;
            return (
              <button
                key={curve.id}
                type="button"
                className={`frdifference-segmented__button${isActive ? " is-active" : ""}`}
                aria-pressed={isActive}
                onClick={() => toggleCurve(curve.id)}
                disabled={disabled}
                title={title ?? undefined}
              >
                {curve.label}
              </button>
            );
          })}
        </div>
      </div>

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
                <div
                  className="frdifference-matchrms-row"
                  role="group"
                  aria-labelledby={matchRmsLabelId}
                  aria-describedby={matchRmsTooltipId}
                >
                  <span id={matchRmsLabelId}>Match RMS in band</span>
                  <InfoTip label="Match RMS help" tooltipId={matchRmsTooltipId}>
                    Loudness-match within the selected band for fair A/B.
                  </InfoTip>
                  <button
                    type="button"
                    className={`frdifference-switch${bandMatchRmsEnabled ? " is-active" : ""}`}
                    aria-pressed={bandMatchRmsEnabled}
                    onClick={() => setBandMatchRms(!bandMatchRmsEnabled)}
                    aria-label={bandMatchRmsEnabled ? "Disable band RMS matching" : "Enable band RMS matching"}
                  >
                    {bandMatchRmsEnabled ? "On" : "Off"}
                  </button>
                </div>

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
            <span className="frplot-progress__label">Preparing difference curves</span>
          </div>
        )}
        {hasActiveCurves && (
          <Plot
            data={traces}
            layout={layout}
            config={config}
            useResizeHandler
            style={{ width: "100%", height: "100%", minHeight: compact ? 220 : 320 }}
            onRelayout={handleRelayout}
            onAfterPlot={handleAfterPlot}
          />
        )}
        {!isLoading && !hasDifferenceAvailable && !error && (
          <div className="frpink-message">Load an impulse response to compute difference curves.</div>
        )}
        {!isLoading && hasDifferenceAvailable && !hasActiveCurves && (
          <div className="frpink-message">Rendering difference data...</div>
        )}
      </div>
    </div>
  );
}

function computeDbDelta(minuend: Float32Array, subtrahend: Float32Array): Float32Array {
  const len = Math.min(minuend.length, subtrahend.length);
  const delta = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    delta[i] = minuend[i] - subtrahend[i];
  }
  return delta;
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
