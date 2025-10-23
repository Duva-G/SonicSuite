import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import FileInputs from "./ui/FileInputs";
import Transport from "./ui/Transport";
import ModeBar from "./ui/ModeBar";
import type { Mode } from "./ui/ModeBar";
import ExportBar from "./ui/ExportBar";
import FRPlayback from "./ui/FRPlayback";
import FRDifference from "./ui/FRDifference";
import IRProcessingPanel from "./ui/IRProcessingPanel";
import PasswordGate from "./ui/PasswordGate";
import { createModuleWorker } from "./utils/workerSupport";
import BandAuditionRouter, { type AuditionPath, type BasePath } from "./audio/BandAuditionRouter";
import type { BandSettings } from "./audio/bandPassFactory";
import type { LatencySecondsMap } from "./audio/LatencyCompensator";
import { computeBandTrims, type TrimResult } from "./audio/BandLevelMatcher";
import { useAbcxController, type BlindTestMode } from "./audio/ABCXController";
import BlindTestPanel from "./ui/BlindTestPanel";
import {
  BAND_PRESETS,
  BAND_RANGE_LIMITS,
  clampBandRange,
  derivePresetValue,
  formatHz,
  freqToSliderValue,
  sliderValueToFreq,
} from "./ui/bandRangeUtils";
import "./App.css";
import harbethLogo from "./assets/harbeth-logo.svg";

type ResidualBasis = {
  music: AudioBuffer;
  ir: AudioBuffer;
  convolved: AudioBuffer;
  offset: number;
  gains: number[];
  fallbackResidual: AudioBuffer;
};

type PathMetric = {
  trimLinear: number;
  trimDb: number | null;
  latencySeconds: number;
  bandMultiplier?: number;
};

type ResidualWorkerSuccess = {
  type: "residual-ready";
  requestId: number;
  payload: {
    channelData: Float32Array;
    sampleRate: number;
  };
};

type ResidualWorkerFailure = {
  type: "residual-error";
  requestId: number;
  error: string;
};

type ResidualWorkerMessage = ResidualWorkerSuccess | ResidualWorkerFailure;

const DEFAULT_SOLO_BAND: [number, number] = [20, 20000];

type DifferenceMode = "origMinusA" | "origMinusB" | "aMinusB";
const DIFFERENCE_PRIORITY: DifferenceMode[] = ["origMinusA", "origMinusB", "aMinusB"];

const {
  MIN_FREQ: PLAYBACK_BAND_MIN_HZ,
  MAX_FREQ: PLAYBACK_BAND_MAX_HZ,
  BAND_SLIDER_MIN: PLAYBACK_BAND_SLIDER_MIN,
  BAND_SLIDER_MAX: PLAYBACK_BAND_SLIDER_MAX,
} = BAND_RANGE_LIMITS;

const FULL_PLAYBACK_BAND: [number, number] = [PLAYBACK_BAND_MIN_HZ, PLAYBACK_BAND_MAX_HZ];

const MODE_BASE_PATH: Record<Exclude<Mode, "difference">, AuditionPath> = {
  original: "A",
  convolvedA: "B",
  convolvedB: "C",
};

const BLIND_MODE_LABEL: Record<BlindTestMode, string> = {
  ABX: "OAX",
  ACX: "OBX",
  BCX: "ABX",
  ABCX: "OABX",
};
const BLIND_PATH_LETTER: Record<BasePath, string> = {
  A: "O",
  B: "A",
  C: "B",
};

const BLIND_PATH_NAME: Record<BasePath, string> = {
  A: "Music WAV",
  B: "Impulse response WAV",
  C: "Impulse response C",
};

const formatBlindModeLabel = (mode: BlindTestMode): string => BLIND_MODE_LABEL[mode] ?? mode;

const formatBlindPathLabel = (path: BasePath): string => {
  const letter = BLIND_PATH_LETTER[path] ?? path;
  const name = BLIND_PATH_NAME[path];
  return name ? `${letter} (${name})` : letter;
};

const FULL_RANGE_TOLERANCE_HZ = 0.5;

function isFullRangePair(minHz: number, maxHz: number): boolean {
  return (
    Math.abs(minHz - PLAYBACK_BAND_MIN_HZ) <= FULL_RANGE_TOLERANCE_HZ &&
    Math.abs(maxHz - PLAYBACK_BAND_MAX_HZ) <= FULL_RANGE_TOLERANCE_HZ
  );
}

function SonicSuiteApp() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const convRef = useRef<ConvolverNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const convolverLatencyRef = useRef(0);
  const matchGainRef = useRef<GainNode | null>(null);
  const convCRef = useRef<ConvolverNode | null>(null);
  const matchGainCRef = useRef<GainNode | null>(null);
  const convolverLatencyCRef = useRef(0);
  const auditionRouterRef = useRef<BandAuditionRouter | null>(null);
  const bandPathRef = useRef<AuditionPath>("A");
  const bandPathOverrideRef = useRef<AuditionPath | null>(null);
  const previousPlaybackBandRef = useRef<[number, number]>([...FULL_PLAYBACK_BAND]);

  const musicBufRef = useRef<AudioBuffer | null>(null);
  const irOriginalRef = useRef<AudioBuffer | null>(null);
  const irBufRef = useRef<AudioBuffer | null>(null);
  const irCOriginalRef = useRef<AudioBuffer | null>(null);
  const irCBufRef = useRef<AudioBuffer | null>(null);
  const residualBufRef = useRef<AudioBuffer | null>(null);
  const residualBasisRef = useRef<ResidualBasis | null>(null);
  const residualWorkerRef = useRef<Worker | null>(null);
  const residualRequestIdRef = useRef(0);
  const residualPendingRef = useRef(
    new Map<number, { resolve: (buffer: AudioBuffer) => void; reject: (error: Error) => void }>(),
  );
  const inlineDiffHelpRef = useRef<HTMLDivElement | null>(null);
  const makeGraphRef = useRef<((at: number, playbackMode?: Mode) => void) | null>(null);

  const startTimeRef = useRef(0);
  const startOffsetRef = useRef(0);

  const [isPlaying, setPlaying] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState<number>(0);
  const [mode, setMode] = useState<Mode>("original");
  const [originalVol, setOriginalVol] = useState<number>(1.0);
  const [convolvedVol, setConvolvedVol] = useState<number>(1.0);
  const [differenceVol, setDifferenceVol] = useState<number>(1.0);
  const [differencePath, setDifferencePath] = useState<DifferenceMode>("origMinusA");
  const [frozenDifferencePath, setFrozenDifferencePath] = useState<DifferenceMode | null>(null);
  const [rmsOffsetsDb, setRmsOffsetsDb] = useState<{ original: number; convolvedA: number; convolvedB: number }>(() => ({
    original: 0,
    convolvedA: 0,
    convolvedB: 0,
  }));
  const [playbackBandHz, setPlaybackBandHz] = useState<[number, number]>(() => [...FULL_PLAYBACK_BAND]);
  const [differenceThresholdDb, setDifferenceThresholdDb] = useState<number>(0);
  const [pendingDifferenceThresholdDb, setPendingDifferenceThresholdDb] = useState<number>(0);
  const [differenceAbsMode, setDifferenceAbsMode] = useState<boolean>(true);
  const [soloBandEnabled, setSoloBandEnabled] = useState<boolean>(false);
  const [pendingSoloBandEnabled, setPendingSoloBandEnabled] = useState<boolean>(false);
  const [soloBandHz, setSoloBandHz] = useState<[number, number]>(() => [...DEFAULT_SOLO_BAND]);
  const [pendingSoloBandHz, setPendingSoloBandHz] = useState<[number, number]>(() => [...DEFAULT_SOLO_BAND]);
  const [bandMatchRmsEnabled, setBandMatchRmsEnabled] = useState<boolean>(true);
  const [pendingBandMatchRmsEnabled, setPendingBandMatchRmsEnabled] = useState<boolean>(true);
  const [soloBandMinHz, soloBandMaxHz] = soloBandHz;
  const playbackBandMinHz = playbackBandHz[0];
  const playbackBandMaxHz = playbackBandHz[1];
  const [isResidualComputing, setResidualComputing] = useState<boolean>(false);
  const [latencySamples, setLatencySamples] = useState<number>(0);
  const [kPerCh, setKPerCh] = useState<number[] | null>(null);
  const [isStatusInfoOpen, setStatusInfoOpen] = useState(false);
  const [status, setStatus] = useState<string>("Load a music WAV and an IR WAV.");
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [differenceDownloadUrl, setDifferenceDownloadUrl] = useState<string>("");
  const [isInlineDiffHelpOpen, setInlineDiffHelpOpen] = useState(false);
  const [view, setView] = useState<"playback" | "playback-fr" | "frdiff">("playback");
  const [sessionSampleRate, setSessionSampleRate] = useState<number>(44100);
  const [musicBuffer, setMusicBuffer] = useState<AudioBuffer | null>(null);
  const [irOriginal, setIrOriginal] = useState<AudioBuffer | null>(null);
  const [irBuffer, setIrBuffer] = useState<AudioBuffer | null>(null);
  const [convolvedMatchGain, setConvolvedMatchGain] = useState<number>(1);
  const [isConvolvedGainMatched, setConvolvedGainMatched] = useState(false);
  const [irCOriginal, setIrCOriginal] = useState<AudioBuffer | null>(null);
  const [irCBuffer, setIrCBuffer] = useState<AudioBuffer | null>(null);
  const [convolvedCMatchGain, setConvolvedCMatchGain] = useState<number>(1);
  const [isConvolvedBGainMatched, setConvolvedBGainMatched] = useState(false);
  const [bandCVol, setBandCVol] = useState<number>(1);
  const abcx = useAbcxController();
  const [blindTestMode, setBlindTestMode] = useState<BlindTestMode | "off">("off");
  const [blindTestSeed, setBlindTestSeed] = useState<string>(() => Date.now().toString(36));
  const [isMatchingRms, setMatchingRms] = useState(false);
  const [musicName, setMusicName] = useState<string>("");
  const [irName, setIrName] = useState<string>("");
  const [irCName, setIrCName] = useState<string>("");
  const inlineDiffHelpPopoverId = "inline-diff-help-popover";

  useEffect(() => {
    if (mode !== "difference") {
      setInlineDiffHelpOpen(false);
    }
  }, [mode]);

  useEffect(() => {
    if (!isInlineDiffHelpOpen) return;
    const handleDocumentClick = (event: globalThis.MouseEvent) => {
      if (!inlineDiffHelpRef.current) return;
      const target = event.target as Node | null;
      if (target && !inlineDiffHelpRef.current.contains(target)) {
        setInlineDiffHelpOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setInlineDiffHelpOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isInlineDiffHelpOpen]);
  const {
    configure: configureBlindTest,
    reset: resetBlindController,
    reveal: revealBlindChoice,
    makeChoice: makeBlindChoice,
    nextTrial: nextBlindTrial,
    trials: blindTrials,
    stats: blindStats,
    current: blindCurrent,
  } = abcx;

  const blindConfigRef = useRef<{
    band: BandSettings;
    trims: Partial<Record<BasePath, number>>;
    latencies: Partial<Record<BasePath, number>>;
    mode: BlindTestMode;
    seed: string;
  } | null>(null);

  const [bandTrimResult, setBandTrimResult] = useState<TrimResult | null>(null);

  const getModeDuration = useCallback((playbackMode: Mode = mode): number => {
    const musicDuration = musicBufRef.current?.duration ?? 0;
    const residualDuration = residualBufRef.current?.duration ?? 0;
    if (playbackMode === "difference") {
      return Math.max(musicDuration, residualDuration);
    }
    return musicDuration;
  }, [mode]);

  const resolveModePath = useCallback(
    (playbackMode: Mode): AuditionPath => {
      if (playbackMode === "difference") {
        return differencePath;
      }
      return MODE_BASE_PATH[playbackMode];
    },
    [differencePath],
  );

  const transportDuration = getModeDuration(mode);
  const clampedPlaybackPosition = Math.min(playbackPosition, transportDuration || 0);
  const residualSampleRate = residualBufRef.current?.sampleRate ?? sessionSampleRate;
  const latencyMs = residualSampleRate > 0 ? (latencySamples / residualSampleRate) * 1000 : 0;
  const formattedKPerCh = kPerCh?.map((value) => value.toFixed(4)) ?? null;
  const kPerChDisplay = formattedKPerCh
    ? formattedKPerCh.map((value, idx) => `ch${idx + 1}=${value}`).join(", ")
    : "";
  const thresholdDirty = Math.abs(pendingDifferenceThresholdDb - differenceThresholdDb) > 1e-6;
  const bandEnabledDirty = pendingSoloBandEnabled !== soloBandEnabled;
  const bandRangeDirty =
    Math.abs(pendingSoloBandHz[0] - soloBandHz[0]) > 1e-6 || Math.abs(pendingSoloBandHz[1] - soloBandHz[1]) > 1e-6;
  const bandMatchRmsDirty = pendingBandMatchRmsEnabled !== bandMatchRmsEnabled;
  const differenceControlsDirty = thresholdDirty || bandEnabledDirty || bandRangeDirty || bandMatchRmsDirty;
  const isFullRangeBand = isFullRangePair(playbackBandMinHz, playbackBandMaxHz);
  const isBandActive = !isFullRangeBand;
  const isBandFrozen = blindConfigRef.current != null;
  const isDifferenceFrozen = frozenDifferencePath != null;
  const bandScopeEngaged = isBandActive || isBandFrozen;
  const playbackPresetValue = useMemo(
    () => derivePresetValue(playbackBandMinHz, playbackBandMaxHz, BAND_PRESETS),
    [playbackBandMinHz, playbackBandMaxHz],
  );
  const playbackBandLabel = `${formatHz(playbackBandMinHz)} - ${formatHz(playbackBandMaxHz)}`;
  const blindPanelBandLabel = isBandFrozen ? `${playbackBandLabel} (frozen)` : playbackBandLabel;
  const playbackBandMinSlider = useMemo(() => freqToSliderValue(playbackBandMinHz), [playbackBandMinHz]);
  const playbackBandMaxSlider = useMemo(() => freqToSliderValue(playbackBandMaxHz), [playbackBandMaxHz]);
  const playbackSliderSpan = PLAYBACK_BAND_SLIDER_MAX - PLAYBACK_BAND_SLIDER_MIN || 1;
  const clampSliderPercent = (value: number) => Math.min(100, Math.max(0, value));
  const playbackSliderStart = clampSliderPercent(
    ((Math.min(playbackBandMinSlider, playbackBandMaxSlider) - PLAYBACK_BAND_SLIDER_MIN) / playbackSliderSpan) * 100,
  );
  const playbackSliderEnd = clampSliderPercent(
    ((Math.max(playbackBandMinSlider, playbackBandMaxSlider) - PLAYBACK_BAND_SLIDER_MIN) / playbackSliderSpan) * 100,
  );
  const playbackSliderSelectionWidth = Math.max(1, playbackSliderEnd - playbackSliderStart);
  const hasIrB = Boolean(irBuffer);
  const hasIrC = Boolean(irCBuffer);
  const canOrigMinusA = hasIrB;
  const canOrigMinusB = hasIrC;
  const canAMinusB = hasIrB && hasIrC;
  const availableDifferencePaths = useMemo(() => {
    const paths: DifferenceMode[] = [];
    if (canOrigMinusA) paths.push("origMinusA");
    if (canOrigMinusB) paths.push("origMinusB");
    if (canAMinusB) paths.push("aMinusB");
    return paths;
  }, [canOrigMinusA, canOrigMinusB, canAMinusB]);
  const isRmsMatched =
    (hasIrB ? isConvolvedGainMatched : true) && (hasIrC ? isConvolvedBGainMatched : true);

  useEffect(() => {
    if (availableDifferencePaths.length === 0) return;
    if (!availableDifferencePaths.includes(differencePath)) {
      const fallback = availableDifferencePaths[0];
      setDifferencePath(fallback);
      setFrozenDifferencePath((prev) => (prev ? fallback : prev));
    }
  }, [availableDifferencePaths, differencePath]);

  const differenceOptions = useMemo(
    () => [
      { value: "origMinusA" as DifferenceMode, label: "Original − A", shortcut: "5", disabled: !canOrigMinusA },
      { value: "origMinusB" as DifferenceMode, label: "Original − B", shortcut: "6", disabled: !canOrigMinusB },
      { value: "aMinusB" as DifferenceMode, label: "A − B", shortcut: "7", disabled: !canAMinusB },
    ],
    [canOrigMinusA, canOrigMinusB, canAMinusB],
  );

  const handleDifferencePathChange = useCallback(
    (next: DifferenceMode) => {
      if (isDifferenceFrozen) return;
      if (!availableDifferencePaths.includes(next)) return;
      if (differencePath === next) return;
      bandPathOverrideRef.current = null;
      setDifferencePath(next);
    },
    [availableDifferencePaths, differencePath, isDifferenceFrozen],
  );

  const availableBlindModes = useMemo(
    () => ({
      ABX: hasIrB,
      ACX: hasIrC,
      BCX: hasIrB && hasIrC,
      ABCX: hasIrB && hasIrC,
    }),
    [hasIrB, hasIrC],
  );

  const modeDisableMap = useMemo<Partial<Record<Mode, boolean>>>(() => {
    const base: Partial<Record<Mode, boolean>> = {};
    if (!hasIrB) base.convolvedA = true;
    if (!hasIrC) base.convolvedB = true;
    if (availableDifferencePaths.length === 0) base.difference = true;
    return base;
  }, [availableDifferencePaths.length, hasIrB, hasIrC]);

  const modeTooltips = useMemo<Partial<Record<Mode, string>>>(() => {
    const tips: Partial<Record<Mode, string>> = {};
    if (!hasIrB) tips.convolvedA = "Load IR A to audition the convolved signal.";
    if (!hasIrC) tips.convolvedB = "Load IR B to audition the second convolved signal.";
    if (availableDifferencePaths.length === 0) {
      tips.difference = "Load at least one IR to explore difference playback.";
    }
    return tips;
  }, [availableDifferencePaths.length, hasIrB, hasIrC]);

  const blindLastEntry = blindTrials.length > 0 ? blindTrials[blindTrials.length - 1] : null;
  const blindCurrentIndex = blindCurrent ? blindCurrent.index : null;

  const bandTrimB = bandMatchRmsEnabled ? bandTrimResult?.trims.B ?? 1 : 1;
  const bandTrimC = bandMatchRmsEnabled ? bandTrimResult?.trims.C ?? 1 : 1;
  const totalTrimA = Math.max(originalVol, 1e-6);
  const totalTrimB = hasIrB ? Math.max(convolvedMatchGain * convolvedVol * bandTrimB, 1e-6) : null;
  const totalTrimC = hasIrC ? Math.max(convolvedCMatchGain * bandCVol * bandTrimC, 1e-6) : null;
  const latencyBSeconds = Math.max(0, convolverLatencyRef.current);
  const latencyCSeconds = Math.max(0, convolverLatencyCRef.current);

  const linearToDbValue = (value: number | null) => {
    if (!value || value <= 0) return null;
    return 20 * Math.log10(value);
  };

  const pathMetrics: { A: PathMetric; B?: PathMetric | null; C?: PathMetric | null } = {
    A: {
      trimLinear: totalTrimA,
      trimDb: linearToDbValue(totalTrimA),
      latencySeconds: 0,
      bandMultiplier: 1,
    },
    B: totalTrimB
      ? {
          trimLinear: totalTrimB,
          trimDb: linearToDbValue(totalTrimB),
          latencySeconds: latencyBSeconds,
          bandMultiplier: bandMatchRmsEnabled ? bandTrimB : 1,
        }
      : null,
    C: totalTrimC
      ? {
          trimLinear: totalTrimC,
          trimDb: linearToDbValue(totalTrimC),
          latencySeconds: latencyCSeconds,
          bandMultiplier: bandMatchRmsEnabled ? bandTrimC : 1,
        }
      : null,
  } as const;

  useEffect(() => {
    if (!formattedKPerCh) {
      setStatusInfoOpen(false);
    }
  }, [formattedKPerCh]);


  const ensureCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
      setSessionSampleRate(audioCtxRef.current.sampleRate);
    }
    return audioCtxRef.current;
  }, [setSessionSampleRate]);

  async function decodeFile(file: File): Promise<AudioBuffer> {
    const ctx = ensureCtx();
    const arr = await file.arrayBuffer();
    return await ctx.decodeAudioData(arr.slice(0));
  }

  async function onPickMusic(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const buf = await decodeFile(f);
      musicBufRef.current = buf;
      residualBasisRef.current = null;
      residualBufRef.current = null;
      setMusicBuffer(buf);
      setMusicName(f.name);
      setSessionSampleRate(buf.sampleRate);
      setConvolvedGainMatched(false);
      startOffsetRef.current = 0;
      setPlaybackPosition(0);
      setStatus(`Music loaded: ${f.name} - ${buf.sampleRate} Hz - ${buf.duration.toFixed(2)} s`);
    } catch (err) {
      musicBufRef.current = null;
      setMusicBuffer(null);
      setMusicName("");
      setConvolvedGainMatched(false);
      startOffsetRef.current = 0;
      setPlaybackPosition(0);
      residualBasisRef.current = null;
      residualBufRef.current = null;
      setStatus(`Music load failed: ${(err as Error).message}`);
    }
  }

  type IrSlot = "B" | "C";

  async function loadIrSlot(slot: IrSlot, file: File) {
    const slotMap = {
      B: {
        originalRef: irOriginalRef,
        bufferRef: irBufRef,
        setOriginal: setIrOriginal,
        setBuffer: setIrBuffer,
        setName: setIrName,
        matchGainRef,
        setMatchGain: setConvolvedMatchGain,
        setGainMatched: setConvolvedGainMatched,
        convolverLatency: convolverLatencyRef,
      },
      C: {
        originalRef: irCOriginalRef,
        bufferRef: irCBufRef,
        setOriginal: setIrCOriginal,
        setBuffer: setIrCBuffer,
        setName: setIrCName,
        matchGainRef: matchGainCRef,
        setMatchGain: setConvolvedCMatchGain,
        setGainMatched: setConvolvedBGainMatched,
        convolverLatency: convolverLatencyCRef,
      },
    } as const;

    const slotState = slotMap[slot];

    try {
      const buf = await decodeFile(file);
      slotState.originalRef.current = buf;
      slotState.setOriginal(buf);
      slotState.bufferRef.current = buf;
      slotState.setBuffer(buf);
      slotState.setName(file.name);
      slotState.setMatchGain(1);
      slotState.setGainMatched(false);
      if (slotState.matchGainRef.current) {
        slotState.matchGainRef.current.gain.value = 1;
      }
      slotState.convolverLatency.current = 0;

      if (slot === "B") {
        residualBasisRef.current = null;
        residualBufRef.current = null;
        if (mode === "convolvedA" && gainRef.current) {
          gainRef.current.gain.value = convolvedVol;
        }
        setRmsOffsetsDb((prev) => ({ ...prev, convolvedA: 0, original: 0 }));
      } else if (slot === "C") {
        setRmsOffsetsDb((prev) => ({ ...prev, convolvedB: 0, original: 0 }));
      }

      const contextRate = audioCtxRef.current?.sampleRate ?? buf.sampleRate;
      setSessionSampleRate(contextRate);
      setStatus((s) =>
        s +
        `
IR-${slot} loaded: ${file.name} - ${buf.sampleRate} Hz - ${buf.duration.toFixed(3)} s`,
      );
    } catch (err) {
      slotState.originalRef.current = null;
      slotState.bufferRef.current = null;
      slotState.setOriginal(null);
      slotState.setBuffer(null);
      slotState.setName("");
      slotState.setMatchGain(1);
      slotState.setGainMatched(false);
      if (slotState.matchGainRef.current) {
        slotState.matchGainRef.current.gain.value = 1;
      }
      if (slot === "B") {
        residualBasisRef.current = null;
        residualBufRef.current = null;
        setRmsOffsetsDb((prev) => ({ ...prev, convolvedA: 0 }));
      } else if (slot === "C") {
        setRmsOffsetsDb((prev) => ({ ...prev, convolvedB: 0 }));
      }
      slotState.convolverLatency.current = 0;
      setStatus(`IR-${slot} load failed: ${(err as Error).message}`);
    }
  }

  async function onPickIRB(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadIrSlot("B", file);
  }

  async function onPickIRC(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await loadIrSlot("C", file);
  }

  const teardownGraph = useCallback(() => {
    if (srcRef.current) {
      srcRef.current.onended = null;
    }
    try {
      srcRef.current?.stop();
    } catch (err: unknown) {
      console.warn("Audio source stop failed", err);
    }
    srcRef.current?.disconnect();
    convRef.current?.disconnect();
    matchGainRef.current?.disconnect();
    convCRef.current?.disconnect();
    matchGainCRef.current?.disconnect();
    gainRef.current?.disconnect();
    auditionRouterRef.current?.dispose();
    srcRef.current = null;
    convRef.current = null;
    matchGainRef.current = null;
    convCRef.current = null;
    matchGainCRef.current = null;
    gainRef.current = null;
    auditionRouterRef.current = null;
  }, []);

  const makeGraph = useCallback((at: number, playbackMode: Mode = mode) => {
    const ctx = ensureCtx();
    const usingBandScope = bandScopeEngaged;
    const isDifferenceMode = playbackMode === "difference";
    const shouldUseRouter = usingBandScope || isDifferenceMode;

    const bandSettings: BandSettings = {
      enabled: usingBandScope && !isFullRangeBand,
      minHz: playbackBandMinHz,
      maxHz: playbackBandMaxHz,
    };

    const music = musicBufRef.current;
    const residual = residualBufRef.current;

    const startAudition = () => {
      if (!music) {
        setStatus("No music loaded.");
        return;
      }

      const ensurePathAvailable = (path: AuditionPath): AuditionPath | null => {
        switch (path) {
          case "A":
            return "A";
          case "B":
            return hasIrB ? "B" : null;
          case "C":
            return hasIrC ? "C" : null;
          case "origMinusA":
            return hasIrB ? "origMinusA" : null;
          case "origMinusB":
            return hasIrC ? "origMinusB" : null;
          case "aMinusB":
            return hasIrB && hasIrC ? "aMinusB" : null;
          default:
            return null;
        }
      };

      const buffer = music;
      const src = new AudioBufferSourceNode(ctx, { buffer });
      const volume = new GainNode(ctx, { gain: 1 });

      srcRef.current = src;
      gainRef.current = volume;

      const router = new BandAuditionRouter(ctx, {
        destination: volume,
        band: bandSettings,
      });
      auditionRouterRef.current = router;

      volume.connect(ctx.destination);

      const dryTap = new GainNode(ctx, { gain: 1 });
      src.connect(dryTap);
      router.connectBase("A", dryTap);

      let latencies: LatencySecondsMap = { A: 0 };
      let trims: Partial<Record<BasePath, number>> = {
        A: Math.max(originalVol, 1e-6),
      };

      const irB = irBufRef.current;
      if (irB) {
        const convB = new ConvolverNode(ctx, { buffer: irB, disableNormalization: false });
        const matchGainB = new GainNode(ctx, { gain: Math.max(convolvedMatchGain, 1e-6) });
        convRef.current = convB;
        matchGainRef.current = matchGainB;
        src.connect(convB).connect(matchGainB);
        router.connectBase("B", matchGainB);
        latencies.B = Math.max(0, convolverLatencyRef.current);
        trims.B = Math.max(convolvedMatchGain * convolvedVol, 1e-6);
      } else {
        convRef.current = null;
        matchGainRef.current = null;
      }

      const irC = irCBufRef.current;
      if (irC) {
        const convC = new ConvolverNode(ctx, { buffer: irC, disableNormalization: false });
        const matchGainC = new GainNode(ctx, { gain: Math.max(convolvedCMatchGain, 1e-6) });
        convCRef.current = convC;
        matchGainCRef.current = matchGainC;
        src.connect(convC).connect(matchGainC);
        router.connectBase("C", matchGainC);
        latencies.C = Math.max(0, convolverLatencyCRef.current);
        trims.C = Math.max(convolvedCMatchGain * bandCVol, 1e-6);
      } else {
        convCRef.current = null;
        matchGainCRef.current = null;
      }

      if (!blindConfigRef.current && bandTrimResult && bandMatchRmsEnabled) {
        if (bandTrimResult.trims.B && trims.B) {
          trims.B *= bandTrimResult.trims.B;
        }
        if (bandTrimResult.trims.C && trims.C) {
          trims.C *= bandTrimResult.trims.C;
        }
      }

      if (blindConfigRef.current) {
        latencies = { ...latencies, ...blindConfigRef.current.latencies };
        trims = { ...trims, ...blindConfigRef.current.trims };
      }

      router.updateBand(bandSettings);
      router.updateLatencies(latencies);
      router.updateTrims(trims);

      const clampedStart = Math.min(at, buffer.duration);
      startOffsetRef.current = clampedStart;
      setPlaybackPosition(clampedStart);

      const latencyValues = Object.values(latencies).filter(
        (value): value is number => typeof value === "number",
      );
      const maxLatency = latencyValues.length > 0 ? Math.max(...latencyValues) : 0;
      const startAt = Math.max(0, clampedStart - maxLatency);
      const requestedPath = bandPathOverrideRef.current ?? resolveModePath(playbackMode);
      let resolvedPath = ensurePathAvailable(requestedPath);
      if (!resolvedPath && playbackMode === "difference") {
        let fallbackDelta: DifferenceMode | null = null;
        for (const candidate of DIFFERENCE_PRIORITY) {
          if (ensurePathAvailable(candidate)) {
            fallbackDelta = candidate;
            break;
          }
        }
        if (fallbackDelta) {
          resolvedPath = fallbackDelta;
          bandPathOverrideRef.current = null;
          if (differencePath !== fallbackDelta) {
            setDifferencePath(fallbackDelta);
          }
          setFrozenDifferencePath((prev) => (prev ? fallbackDelta : prev));
        }
      }
      if (!resolvedPath) {
        setStatus("Load the required impulse responses to audition that path.");
        resolvedPath = "A";
        bandPathOverrideRef.current = null;
      }
      bandPathRef.current = resolvedPath;
      router.setActive(resolvedPath);

      src.onended = () => {
        if (srcRef.current !== src) return;
        startOffsetRef.current = 0;
        setPlaybackPosition(0);
        setPlaying(false);
        teardownGraph();
      };

      const startPlayback = () => {
        try {
          src.start(0, startAt);
          startTimeRef.current = ctx.currentTime;
          setPlaying(true);
        } catch (err) {
          console.error("Audio source start failed", err);
          const message = err instanceof Error ? err.message : String(err);
          setStatus(`Playback failed: ${message}`);
          teardownGraph();
        }
      };

      if (ctx.state === "suspended") {
        ctx
          .resume()
          .then(startPlayback)
          .catch((err) => {
            console.error("Audio context resume failed", err);
            const message = err instanceof Error ? err.message : String(err);
            setStatus(`Playback blocked by browser autoplay policy: ${message}`);
            teardownGraph();
          });
      } else {
        startPlayback();
      }
    };

    if (shouldUseRouter) {
      startAudition();
      return;
    }

    auditionRouterRef.current?.dispose();
    auditionRouterRef.current = null;

    const isDifference = isDifferenceMode;
    const isConvolvedA = playbackMode === "convolvedA";
    const isConvolvedB = playbackMode === "convolvedB";
    const isConvolved = isConvolvedA || isConvolvedB;

    let buffer: AudioBuffer | null = null;
    if (isDifference) {
      buffer = residual;
      if (!buffer) {
        setStatus("Difference signal not ready. Load music and IR first.");
        return;
      }
    } else {
      buffer = music;
      if (!buffer) {
        setStatus("No music loaded.");
        return;
      }
    }

    const src = new AudioBufferSourceNode(ctx, { buffer });
    const initialGain = isDifference
      ? differenceVol
      : isConvolvedA
      ? convolvedVol
      : isConvolvedB
      ? bandCVol
      : originalVol;
    const volume = new GainNode(ctx, { gain: initialGain });
    srcRef.current = src;
    gainRef.current = volume;

    const clampedStart = Math.min(at, buffer.duration);
    startOffsetRef.current = clampedStart;
    setPlaybackPosition(clampedStart);

    matchGainRef.current = null;
    convRef.current = null;
    convCRef.current = null;
    matchGainCRef.current = null;

    if (isConvolved) {
      const irBufferRef = isConvolvedB ? irCBufRef : irBufRef;
      const ir = irBufferRef.current;
      if (!ir) {
        setStatus(isConvolvedB ? "IR B not loaded." : "IR A not loaded.");
        (isConvolvedB ? convolverLatencyCRef : convolverLatencyRef).current = 0;
        return;
      }
      const latencySamplesValue = computeAnalysisOffset(ir, ir.length);
      const latencyRef = isConvolvedB ? convolverLatencyCRef : convolverLatencyRef;
      latencyRef.current = latencySamplesValue / ctx.sampleRate;
      const convNode = new ConvolverNode(ctx, { buffer: ir, disableNormalization: false });
      const matchValue = Math.max(isConvolvedB ? convolvedCMatchGain : convolvedMatchGain, 1e-6);
      const matchGainNode = new GainNode(ctx, { gain: matchValue });
      if (isConvolvedB) {
        convCRef.current = convNode;
        matchGainCRef.current = matchGainNode;
      } else {
        convRef.current = convNode;
        matchGainRef.current = matchGainNode;
      }
      src.connect(convNode).connect(matchGainNode).connect(volume).connect(ctx.destination);
    } else {
      const residualRate = buffer.sampleRate || sessionSampleRate;
      convolverLatencyRef.current =
        isDifference && residualRate > 0 ? latencySamples / residualRate : 0;
      src.connect(volume).connect(ctx.destination);
    }

    src.onended = () => {
      if (srcRef.current !== src) return;
      startOffsetRef.current = 0;
      setPlaybackPosition(0);
      setPlaying(false);
      teardownGraph();
    };

    const startPlayback = () => {
      const activeLatencyRef = isConvolvedB ? convolverLatencyCRef : convolverLatencyRef;
      const latency =
        isConvolved || isDifference ? Math.max(0, activeLatencyRef.current) : 0;
      const startAt = Math.max(0, clampedStart - latency);
      try {
        src.start(0, startAt);
        startTimeRef.current = ctx.currentTime;
        setPlaying(true);
      } catch (err) {
        console.error("Audio source start failed", err);
        const message = err instanceof Error ? err.message : String(err);
        setStatus(`Playback failed: ${message}`);
        teardownGraph();
      }
    };

    if (ctx.state === "suspended") {
      ctx
        .resume()
        .then(startPlayback)
        .catch((err) => {
          console.error("Audio context resume failed", err);
          const message = err instanceof Error ? err.message : String(err);
          setStatus(`Playback blocked by browser autoplay policy: ${message}`);
          teardownGraph();
        });
    } else {
      startPlayback();
    }
  }, [
    bandCVol,
    bandMatchRmsEnabled,
    bandScopeEngaged,
    bandTrimResult,
    convolvedCMatchGain,
    convolvedMatchGain,
    convolvedVol,
    differencePath,
    differenceVol,
    ensureCtx,
    hasIrB,
    hasIrC,
    isFullRangeBand,
    latencySamples,
    mode,
    originalVol,
    playbackBandMaxHz,
    playbackBandMinHz,
    resolveModePath,
    sessionSampleRate,
    setDifferencePath,
    setFrozenDifferencePath,
    setPlaybackPosition,
    setPlaying,
    setStatus,
    teardownGraph,
  ]);

  makeGraphRef.current = makeGraph;

  function currentOffset(): number {
    const ctx = audioCtxRef.current;
    if (!ctx) return 0;
    return startOffsetRef.current + (ctx.currentTime - startTimeRef.current);
  }

  useEffect(() => {
    let raf = 0;

    const resolveDuration = () => {
      const musicDuration = musicBufRef.current?.duration ?? 0;
      const residualDuration = residualBufRef.current?.duration ?? 0;
      return mode === "difference" ? Math.max(musicDuration, residualDuration) : musicDuration;
    };

    const update = () => {
      const duration = resolveDuration();
      const next = Math.min(currentOffset(), duration);
      setPlaybackPosition(next);
      raf = requestAnimationFrame(update);
    };

    if (isPlaying) {
      raf = requestAnimationFrame(update);
    } else {
      const duration = resolveDuration();
      const clamped = Math.min(startOffsetRef.current, duration);
      setPlaybackPosition(clamped);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isPlaying, mode]);

  function playPause() {
    if (!isPlaying) {
      makeGraph(startOffsetRef.current, mode);
    } else {
      const duration = getModeDuration(mode);
      const limit = duration > 0 ? duration : Infinity;
      const off = Math.min(currentOffset(), limit);
      teardownGraph();
      startOffsetRef.current = off;
      setPlaybackPosition(off);
      setPlaying(false);
    }
  }

  function stopAll() {
    teardownGraph();
    startOffsetRef.current = 0;
    setPlaybackPosition(0);
    setPlaying(false);
  }

  function seekTo(seconds: number, resume?: boolean) {
    const duration = getModeDuration(mode);
    if (duration <= 0) return;
    const target = Math.max(0, Math.min(seconds, duration));
    const wasPlaying = isPlaying;
    const shouldResume = resume ?? wasPlaying;
    if (wasPlaying) {
      teardownGraph();
      setPlaying(false);
    }
    startOffsetRef.current = target;
    setPlaybackPosition(target);
    if (shouldResume && target < duration) {
      makeGraph(target, mode);
    } else {
      setPlaying(false);
    }
  }

  function skipBy(delta: number) {
    const duration = getModeDuration(mode);
    if (duration <= 0) return;
    const base = isPlaying ? currentOffset() : startOffsetRef.current;
    seekTo(base + delta, isPlaying);
  }

  const resetBlindTest = useCallback(
    (reason?: string) => {
      if (!blindConfigRef.current) return;
      blindConfigRef.current = null;
      bandPathOverrideRef.current = null;
      const defaultPath = resolveModePath(mode);
      bandPathRef.current = defaultPath;
      if (bandScopeEngaged && auditionRouterRef.current) {
        auditionRouterRef.current.setActive(defaultPath);
      }
      resetBlindController();
      setFrozenDifferencePath(null);
      if (reason) {
        setStatus((prev) => `${prev}\nBlind test reset: ${reason}`);
      }
    },
    [auditionRouterRef, bandScopeEngaged, mode, resetBlindController, resolveModePath, setStatus],
  );

  const handleBlindModeChange = useCallback(
    (value: BlindTestMode | "off") => {
      if (value === blindTestMode) return;
      if (value === "off") {
        setBlindTestMode("off");
        resetBlindTest();
      } else {
        setBlindTestMode(value);
        resetBlindTest();
      }
    },
    [blindTestMode, resetBlindTest],
  );

  const handleBlindSeedChange = useCallback(
    (seed: string) => {
      setBlindTestSeed(seed.trim());
    },
    [setBlindTestSeed],
  );

  const handleBlindStart = useCallback(() => {
    if (blindTestMode === "off") {
      setStatus((prev) => `${prev}\nSelect a blind-test mode before starting.`);
      return;
    }
    if (!hasIrB) {
      setStatus((prev) => `${prev}\nLoad IR-B (path ${formatBlindPathLabel("B")}) before starting blind testing.`);
      return;
    }
    if ((blindTestMode === "ACX" || blindTestMode === "BCX" || blindTestMode === "ABCX") && !hasIrC) {
      setStatus(
        (prev) =>
          `${prev}\nLoad IR-C (path ${formatBlindPathLabel("C")}) to use ${formatBlindModeLabel(blindTestMode)}.`,
      );
      return;
    }
    const sanitizedSeed = blindTestSeed.trim() || Date.now().toString(36);
    if (sanitizedSeed !== blindTestSeed) {
      setBlindTestSeed(sanitizedSeed);
    }

    const trims: Partial<Record<BasePath, number>> = {
      A: Math.max(originalVol, 1e-6),
    };
    if (hasIrB) {
      trims.B = Math.max(convolvedMatchGain * convolvedVol, 1e-6);
    }
    if (hasIrC) {
      trims.C = Math.max(convolvedCMatchGain * bandCVol, 1e-6);
    }
    if (bandMatchRmsEnabled && bandTrimResult?.trims.B && trims.B) {
      trims.B *= bandTrimResult.trims.B;
    }
    if (bandMatchRmsEnabled && bandTrimResult?.trims.C && trims.C) {
      trims.C *= bandTrimResult.trims.C;
    }

    const latencies: Partial<Record<BasePath, number>> = {
      A: 0,
    };
    if (hasIrB) {
      latencies.B = Math.max(0, convolverLatencyRef.current);
    }
    if (hasIrC) {
      latencies.C = Math.max(0, convolverLatencyCRef.current);
    }

    const bandSettings: BandSettings = {
      enabled: isBandActive,
      minHz: playbackBandMinHz,
      maxHz: playbackBandMaxHz,
    };

    configureBlindTest({
      mode: blindTestMode,
      band: bandSettings,
      trims,
      latencies,
      seed: sanitizedSeed,
    });

    blindConfigRef.current = {
      mode: blindTestMode,
      band: bandSettings,
      trims,
      latencies,
      seed: sanitizedSeed,
    };
    setFrozenDifferencePath(differencePath);

    if (auditionRouterRef.current) {
      auditionRouterRef.current.updateTrims(trims);
      auditionRouterRef.current.updateLatencies(latencies);
    }

    setStatus(
      (prev) =>
        `${prev}\nBlind test prepared (mode ${formatBlindModeLabel(blindTestMode)}, seed ${sanitizedSeed}).`,
    );
  }, [
    auditionRouterRef,
    bandCVol,
    bandMatchRmsEnabled,
    bandTrimResult,
    blindTestMode,
    blindTestSeed,
    configureBlindTest,
    convolvedCMatchGain,
    convolvedMatchGain,
    convolvedVol,
    convolverLatencyCRef,
    convolverLatencyRef,
    differencePath,
    hasIrB,
    hasIrC,
    isBandActive,
    originalVol,
    playbackBandMinHz,
    playbackBandMaxHz,
    setBlindTestSeed,
    setStatus,
  ]);

  const handleBlindReset = useCallback(() => {
    blindConfigRef.current = null;
    resetBlindController();
    setFrozenDifferencePath(null);
    setStatus((prev) => `${prev}\nBlind test reset.`);
  }, [resetBlindController, setStatus]);

  const handleBlindReveal = useCallback(() => {
    const actual = revealBlindChoice();
    if (actual) {
      setStatus((prev) => `${prev}\nReveal: X was ${formatBlindPathLabel(actual)}.`);
    }
  }, [revealBlindChoice, setStatus]);

  const handleBlindNext = useCallback(() => {
    nextBlindTrial();
  }, [nextBlindTrial]);

  const handleBlindGuess = useCallback(
    (choice: BasePath) => {
      const outcome = makeBlindChoice(choice);
      if (outcome) {
        const guessLabel = formatBlindPathLabel(choice);
        const actualLabel = formatBlindPathLabel(outcome.actual);
        setStatus((prev) =>
          `${prev}\nGuess ${guessLabel}: ${outcome.correct ? "correct" : "incorrect"} (X was ${actualLabel}).`,
        );
      }
    },
    [makeBlindChoice, setStatus],
  );

  const handleBlindAudition = useCallback(
    (target: "A" | "B" | "C" | "X") => {
      if (target === "B" && !hasIrB) {
        setStatus((prev) => `${prev}\nLoad IR-B to audition path ${formatBlindPathLabel("B")}.`);
        return;
      }
      if (target === "C" && !hasIrC) {
        setStatus((prev) => `${prev}\nLoad IR-C to audition path ${formatBlindPathLabel("C")}.`);
        return;
      }
      if (!bandScopeEngaged) {
        setStatus((prev) => `${prev}\nSelect a playback band before auditioning blind-test paths.`);
        return;
      }
      if (target === "X" && !blindConfigRef.current) {
        setStatus((prev) => `${prev}\nStart a blind test before auditioning X.`);
        return;
      }

      const actualPath: BasePath = target === "X" ? (blindCurrent?.actual ?? "A") : target;
      bandPathOverrideRef.current = actualPath;
      bandPathRef.current = actualPath;

      const router = auditionRouterRef.current;
      if (router) {
        router.setActive(actualPath);
      }

      if (!isPlaying) {
        makeGraph(startOffsetRef.current, mode);
      }
    },
    [auditionRouterRef, bandScopeEngaged, blindCurrent, hasIrB, hasIrC, isPlaying, makeGraph, mode, setStatus],
  );

  function setPlaybackBandRange(minHz: number, maxHz: number) {
    if (isBandFrozen) return;
    const [nextMin, nextMax] = clampBandRange(minHz, maxHz);
    if (Math.abs(nextMin - playbackBandMinHz) < 0.01 && Math.abs(nextMax - playbackBandMaxHz) < 0.01) {
      return;
    }
    const prevEngaged = bandScopeEngaged;
    const nextIsFull = isFullRangePair(nextMin, nextMax);
    const nextEngaged = !nextIsFull;
    setPlaybackBandHz([nextMin, nextMax]);
    bandPathOverrideRef.current = null;
    if (!prevEngaged && nextEngaged) {
      bandPathRef.current = resolveModePath(mode);
    }
    if (nextIsFull) {
      bandPathRef.current = resolveModePath(mode);
    }
  }

  function handlePlaybackPresetSelect(range: [number, number]) {
    if (isBandFrozen) return;
    setPlaybackBandRange(range[0], range[1]);
  }

  function handlePlaybackBandMinSlider(event: ChangeEvent<HTMLInputElement>) {
    if (isBandFrozen) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    const freq = sliderValueToFreq(value);
    setPlaybackBandRange(freq, playbackBandMaxHz);
  }

  function handlePlaybackBandMaxSlider(event: ChangeEvent<HTMLInputElement>) {
    if (isBandFrozen) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    const freq = sliderValueToFreq(value);
    setPlaybackBandRange(playbackBandMinHz, freq);
  }

  function handlePlaybackBandMinInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (isBandFrozen) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    setPlaybackBandRange(value, playbackBandMaxHz);
  }

  function handlePlaybackBandMaxInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (isBandFrozen) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    setPlaybackBandRange(playbackBandMinHz, value);
  }

  function handlePlaybackScopeKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (isBandFrozen) return;
    if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      setPlaybackBandRange(PLAYBACK_BAND_MIN_HZ, PLAYBACK_BAND_MAX_HZ);
    }
  }

  function applyDifferenceThreshold() {
    if (!differenceControlsDirty || isResidualComputing) return;
    setDifferenceThresholdDb(pendingDifferenceThresholdDb);
    if (bandEnabledDirty) {
      setSoloBandEnabled(pendingSoloBandEnabled);
    }
    if (bandRangeDirty) {
      setSoloBandHz([pendingSoloBandHz[0], pendingSoloBandHz[1]]);
    }
    if (bandMatchRmsDirty) {
      setBandMatchRmsEnabled(pendingBandMatchRmsEnabled);
    }
  }

  function resetDifferenceThreshold() {
    if (!differenceControlsDirty) return;
    if (thresholdDirty) {
      setPendingDifferenceThresholdDb(differenceThresholdDb);
    }
    if (bandEnabledDirty) {
      setPendingSoloBandEnabled(soloBandEnabled);
    }
    if (bandRangeDirty) {
      setPendingSoloBandHz([soloBandHz[0], soloBandHz[1]]);
    }
    if (bandMatchRmsDirty) {
      setPendingBandMatchRmsEnabled(bandMatchRmsEnabled);
    }
  }

  const computeResidualWithWorker = useCallback(
    (
      basis: ResidualBasis,
      thresholdDb: number,
      bandOptions: { soloEnabled: boolean; minHz: number; maxHz: number } = {
        soloEnabled: false,
        minHz: DEFAULT_SOLO_BAND[0],
        maxHz: DEFAULT_SOLO_BAND[1],
      },
    ): Promise<AudioBuffer> => {
      const worker = residualWorkerRef.current;
      if (!worker) {
        return Promise.reject(new Error("Residual worker unavailable"));
      }
      const requestId = ++residualRequestIdRef.current;
      return new Promise<AudioBuffer>((resolve, reject) => {
        residualPendingRef.current.set(requestId, { resolve, reject });

        const wetChannels: Float32Array[] = [];
        const wetCount = basis.convolved.numberOfChannels > 0 ? basis.convolved.numberOfChannels : 1;
        for (let ch = 0; ch < wetCount; ch++) {
          wetChannels.push(basis.convolved.getChannelData(Math.min(ch, basis.convolved.numberOfChannels - 1)).slice());
        }

        const dryChannels: Float32Array[] = [];
        const dryCount = basis.music.numberOfChannels > 0 ? basis.music.numberOfChannels : 1;
        for (let ch = 0; ch < dryCount; ch++) {
          dryChannels.push(basis.music.getChannelData(Math.min(ch, basis.music.numberOfChannels - 1)).slice());
        }

        const gainArrayLength = Math.max(1, basis.gains.length, wetChannels.length, dryChannels.length);
        const gains = new Float32Array(gainArrayLength);
        for (let i = 0; i < gainArrayLength; i++) {
          const value = basis.gains[i];
          gains[i] = Number.isFinite(value) ? value : 1;
        }

        const payload = {
          wetChannels,
          dryChannels,
          gains,
          offset: basis.offset,
          thresholdDb,
          sampleRate: basis.convolved.sampleRate,
          originalLength: basis.convolved.length,
          bandSoloEnabled: bandOptions.soloEnabled,
          bandMinHz: bandOptions.minHz,
          bandMaxHz: bandOptions.maxHz,
        };
        const transfer: Transferable[] = [
          ...wetChannels.map((channel) => channel.buffer),
          ...dryChannels.map((channel) => channel.buffer),
          gains.buffer,
        ];

        worker.postMessage({ type: "compute-residual", requestId, payload }, transfer);
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const computeResidual = async () => {
      const music = musicBufRef.current;
      const ir = irBufRef.current;
      if (!music || !ir) {
        residualBasisRef.current = null;
        residualBufRef.current = null;
        if (!cancelled) {
          setKPerCh(null);
          setLatencySamples(0);
          setResidualComputing(false);
        }
        return;
      }

      let basis = residualBasisRef.current;
      const needsBasis =
        !basis || basis.music !== music || basis.ir !== ir;

      if (needsBasis) {
        if (!cancelled) setResidualComputing(true);
        try {
          const prepared = await prepareResidualBasis(music, ir);
          if (cancelled) return;
          if (!prepared) {
            residualBasisRef.current = null;
            residualBufRef.current = null;
            setKPerCh(null);
            setLatencySamples(0);
            setResidualComputing(false);
            return;
          }
          residualBasisRef.current = prepared;
          basis = prepared;
          setLatencySamples(prepared.offset);
          setKPerCh(prepared.gains);
        } catch (err) {
          if (cancelled) return;
          console.error("Residual preparation failed", err);
          residualBasisRef.current = null;
          residualBufRef.current = null;
          setKPerCh(null);
          setLatencySamples(0);
          setResidualComputing(false);
          return;
        }
      }

      if (!basis) return;

      if (!cancelled) setResidualComputing(true);
      try {
        const residual = await computeResidualWithWorker(basis, differenceThresholdDb, {
          soloEnabled: soloBandEnabled,
          minHz: soloBandMinHz,
          maxHz: soloBandMaxHz,
        });
        if (cancelled) return;
        residualBufRef.current = residual;
      } catch (err) {
        if (cancelled) return;
        console.warn("Residual worker failed; using fallback residual", err);
        residualBufRef.current = ensureMonoBuffer(basis.fallbackResidual);
      } finally {
        if (!cancelled) {
          setResidualComputing(false);
          if (mode === "difference" && isPlaying) {
            const off = currentOffset();
            teardownGraph();
            makeGraphRef.current?.(off, "difference");
          }
        }
      }
    };

    computeResidual();

    return () => {
      cancelled = true;
      setResidualComputing(false);
    };
  }, [
    musicBuffer,
    irBuffer,
    differenceThresholdDb,
    soloBandEnabled,
    soloBandMinHz,
    soloBandMaxHz,
    isPlaying,
    mode,
    computeResidualWithWorker,
    teardownGraph,
  ]);

  useEffect(() => {
    setPendingDifferenceThresholdDb(differenceThresholdDb);
  }, [differenceThresholdDb]);

  useEffect(() => {
    setPendingSoloBandEnabled(soloBandEnabled);
  }, [soloBandEnabled]);

  useEffect(() => {
    setPendingSoloBandHz([soloBandMinHz, soloBandMaxHz]);
  }, [soloBandMinHz, soloBandMaxHz]);

  useEffect(() => {
    setPendingBandMatchRmsEnabled(bandMatchRmsEnabled);
  }, [bandMatchRmsEnabled]);

  useEffect(() => {
    if (!blindConfigRef.current) return;
    resetBlindTest("Playback band changed.");
  }, [resetBlindTest, isBandActive, playbackBandMinHz, playbackBandMaxHz]);

  useEffect(() => {
    if (!blindConfigRef.current) return;
    resetBlindTest("Impulse responses changed.");
  }, [resetBlindTest, irBuffer, irCBuffer, musicBuffer]);

  useEffect(() => {
    if (!blindConfigRef.current) return;
    if (!bandScopeEngaged) {
      resetBlindTest("Playback band returned to full range.");
    }
  }, [bandScopeEngaged, resetBlindTest]);

  useEffect(() => {
    const music = musicBufRef.current;
    const irB = irBufRef.current;
    const irC = irCBufRef.current;
    const bandActive = bandScopeEngaged;
    if (!music || (!irB && !irC) || !bandActive || !bandMatchRmsEnabled) {
      setBandTrimResult(null);
      return;
    }
    let cancelled = false;
    const bandSettings: BandSettings = {
      enabled: isBandActive,
      minHz: playbackBandMinHz,
      maxHz: playbackBandMaxHz,
    };
    computeBandTrims({
      dry: music,
      irB: irB ?? undefined,
      irC: irC ?? undefined,
      band: bandSettings,
    })
      .then((result) => {
        if (cancelled) return;
        setBandTrimResult(result);
      })
      .catch((err) => {
        console.warn("Band trim computation failed", err);
        if (!cancelled) {
          setBandTrimResult(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    bandScopeEngaged,
    bandMatchRmsEnabled,
    irBuffer,
    irCBuffer,
    isBandActive,
    musicBuffer,
    playbackBandMinHz,
    playbackBandMaxHz,
  ]);

  useEffect(() => {
    if (!irCBuffer) {
      setBandCVol(1);
    }
  }, [irCBuffer]);

  useEffect(() => {
    if (!auditionRouterRef.current) return;
    if (!bandScopeEngaged) return;
    const trims: Partial<Record<BasePath, number>> = {
      A: Math.max(originalVol, 1e-6),
      B: hasIrB ? Math.max(convolvedMatchGain * convolvedVol, 1e-6) : undefined,
      C: hasIrC ? Math.max(convolvedCMatchGain * bandCVol, 1e-6) : undefined,
    };
    if (bandMatchRmsEnabled && bandTrimResult) {
      if (trims.B && bandTrimResult.trims.B) {
        trims.B *= bandTrimResult.trims.B;
      }
      if (trims.C && bandTrimResult.trims.C) {
        trims.C *= bandTrimResult.trims.C;
      }
    }
    auditionRouterRef.current.updateTrims(trims);
  }, [
    bandScopeEngaged,
    bandMatchRmsEnabled,
    bandTrimResult,
    originalVol,
    convolvedVol,
    convolvedMatchGain,
    convolvedCMatchGain,
    bandCVol,
    hasIrB,
    hasIrC,
  ]);

  useEffect(() => {
    if (!bandScopeEngaged) return;
    const currentPath = bandPathRef.current;
    const needsB = currentPath === "B" || currentPath === "origMinusA" || currentPath === "aMinusB";
    const needsC = currentPath === "C" || currentPath === "origMinusB" || currentPath === "aMinusB";
    const hasCAssets = Boolean(irCBuffer && irCOriginal && irCName);
    if ((needsB && !hasIrB) || (needsC && !hasCAssets)) {
      bandPathRef.current = "A";
      bandPathOverrideRef.current = null;
      if (auditionRouterRef.current) {
        auditionRouterRef.current.setActive("A");
      }
      setStatus((prev) => `${prev}\nPlayback path reset to O; required impulse response missing.`);
    }
  }, [bandScopeEngaged, hasIrB, irBuffer, irCBuffer, irCOriginal, irCName, setStatus]);

  useEffect(() => {
    if (bandScopeEngaged) return;
    bandPathOverrideRef.current = null;
    bandPathRef.current = resolveModePath(mode);
  }, [bandScopeEngaged, mode, resolveModePath]);

  useEffect(() => {
    if (mode !== "difference") return;
    if (bandPathOverrideRef.current) return;
    bandPathRef.current = differencePath;
    const router = auditionRouterRef.current;
    if (router) {
      router.setActive(differencePath);
    }
  }, [differencePath, mode]);

  useEffect(() => {
    if (mode !== "difference") return;
    const handleGlobalKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName.toLowerCase();
        if (target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select") {
          return;
        }
      }
      let next: DifferenceMode | null = null;
      switch (event.key) {
        case "5":
          next = "origMinusA";
          break;
        case "6":
          next = "origMinusB";
          break;
        case "7":
          next = "aMinusB";
          break;
        default:
          return;
      }
      if (!next) return;
      if (differencePath === next) return;
      if (!availableDifferencePaths.includes(next)) return;
      if (isDifferenceFrozen) return;
      event.preventDefault();
      handleDifferencePathChange(next);
    };
    window.addEventListener("keydown", handleGlobalKey);
    return () => {
      window.removeEventListener("keydown", handleGlobalKey);
    };
  }, [availableDifferencePaths, differencePath, handleDifferencePathChange, isDifferenceFrozen, mode]);

  useEffect(() => {
    if (!auditionRouterRef.current) return;
    if (!bandScopeEngaged) return;
    auditionRouterRef.current.updateBand({
      enabled: isBandActive,
      minHz: playbackBandMinHz,
      maxHz: playbackBandMaxHz,
    });
  }, [bandScopeEngaged, isBandActive, playbackBandMinHz, playbackBandMaxHz]);

  useEffect(() => {
    const [prevMin, prevMax] = previousPlaybackBandRef.current;
    if (Math.abs(prevMin - playbackBandMinHz) < 0.01 && Math.abs(prevMax - playbackBandMaxHz) < 0.01) {
      return;
    }
    previousPlaybackBandRef.current = [playbackBandMinHz, playbackBandMaxHz];
    if (!isPlaying) return;
    const resumeAt = Math.min(currentOffset(), getModeDuration(mode));
    teardownGraph();
    startOffsetRef.current = resumeAt;
    setPlaybackPosition(resumeAt);
    const makeGraphFn = makeGraphRef.current;
    if (typeof makeGraphFn === "function") {
      makeGraphFn(resumeAt, mode);
    }
  }, [getModeDuration, isPlaying, mode, playbackBandMinHz, playbackBandMaxHz, teardownGraph]);

  useEffect(() => {
    const { worker, error } = createModuleWorker(new URL("./workers/residualWorker.ts", import.meta.url));
    if (!worker) {
      if (error) {
        console.warn("Residual worker unavailable; falling back to main-thread processing.", error);
      }
      residualWorkerRef.current = null;
      return;
    }
    residualWorkerRef.current = worker;
    const pendingRequests = residualPendingRef.current;

    const handleMessage = (event: MessageEvent<ResidualWorkerMessage>) => {
      const data = event.data;
      if (!data || typeof data.requestId !== "number") return;
      const pending = residualPendingRef.current.get(data.requestId);
      if (!pending) return;
      residualPendingRef.current.delete(data.requestId);
      if (data.type === "residual-ready") {
        try {
          const buffer = new AudioBuffer({
            numberOfChannels: 1,
            length: data.payload.channelData.length,
            sampleRate: data.payload.sampleRate,
          });
          buffer.getChannelData(0).set(data.payload.channelData);
          limitPeakInPlace(buffer, -0.3);
          pending.resolve(buffer);
        } catch (err) {
          pending.reject(err instanceof Error ? err : new Error("Residual conversion failed"));
        }
      } else {
        pending.reject(new Error(data.error || "Residual worker error"));
      }
    };

    const handleError = (event: ErrorEvent) => {
      residualPendingRef.current.forEach(({ reject }) => {
        reject(new Error(event.message || "Residual worker error"));
      });
      residualPendingRef.current.clear();
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.terminate();
      residualWorkerRef.current = null;
      pendingRequests.forEach(({ reject }) => {
        reject(new Error("Residual worker terminated"));
      });
      pendingRequests.clear();
    };
  }, []);

  function onChangeMode(next: Mode) {
    if (next === mode) return;
    const wasPlaying = isPlaying;
    const currentDuration = getModeDuration(mode);
    const currentPosition = wasPlaying ? currentOffset() : startOffsetRef.current;
    const clampedCurrent = Math.min(currentPosition, currentDuration > 0 ? currentDuration : currentPosition);
    const nextDuration = getModeDuration(next);
    const clamped = Math.min(clampedCurrent, nextDuration > 0 ? nextDuration : clampedCurrent);
    teardownGraph();
    bandPathOverrideRef.current = null;
    bandPathRef.current = resolveModePath(next);
    setMode(next);
    startOffsetRef.current = clamped;
    setPlaybackPosition(clamped);
    if (wasPlaying && clamped < nextDuration) makeGraph(clamped, next);
  }

  function onChangeOriginalVol(v: number) {
    setOriginalVol(v);
    if (gainRef.current && mode === "original") {
      gainRef.current.gain.value = v;
    }
  }

  function onChangeConvolvedVol(v: number) {
    setConvolvedVol(v);
    if (gainRef.current && mode === "convolvedA") {
      gainRef.current.gain.value = v;
    }
  }

  function onChangeConvolvedBVol(v: number) {
    setBandCVol(v);
    if (gainRef.current && mode === "convolvedB") {
      gainRef.current.gain.value = v;
    }
  }

  function onChangeDifferenceVol(v: number) {
    setDifferenceVol(v);
    if (gainRef.current && mode === "difference") {
      gainRef.current.gain.value = v;
    }
  }

  function resetVolumes() {
    onChangeOriginalVol(1);
    onChangeConvolvedVol(1);
    onChangeConvolvedBVol(1);
    onChangeDifferenceVol(1);
  }

  function handleIrManualTrim(startMs: number, endMs: number) {
    const original = irOriginalRef.current;
    if (!original) {
      setStatus("Load an impulse response before trimming.");
      return;
    }

    const sr = original.sampleRate;
    const startSample = Math.max(0, Math.floor((startMs / 1000) * sr));
    const endSample = Math.min(original.length, Math.floor((endMs / 1000) * sr));
    if (endSample - startSample < 32) {
      setStatus("IR trim range is too short.");
      return;
    }

    const trimmed = sliceAudioBuffer(original, startSample, endSample);
    applyProcessedIr(trimmed, `IR trimmed to ${trimmed.duration.toFixed(3)} s`);
  }

  function handleIrAutoTrim() {
    const original = irOriginalRef.current;
    if (!original) {
      setStatus("Load an impulse response before trimming.");
      return;
    }

    const sr = original.sampleRate;
    const mono = new Float32Array(original.length);
    for (let ch = 0; ch < original.numberOfChannels; ch++) {
      const data = original.getChannelData(ch);
      for (let i = 0; i < original.length; i++) mono[i] += Math.abs(data[i]);
    }
    const inv = original.numberOfChannels > 0 ? 1 / original.numberOfChannels : 1;
    for (let i = 0; i < mono.length; i++) mono[i] *= inv;

    let peak = 0;
    for (let i = 0; i < mono.length; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    if (!Number.isFinite(peak) || peak === 0) {
      setStatus("Auto trim could not detect a valid region; keeping original IR.");
      return;
    }

    const energy = mono.reduce((acc, v) => acc + v * v, 0);
    const energyTarget = energy * 0.0005;
    const amplitudeFloor = peak * 0.0001;

    let startSample = 0;
    let accum = 0;
    while (startSample < mono.length) {
      const v = mono[startSample];
      accum += v * v;
      if (accum >= energyTarget || Math.abs(v) >= amplitudeFloor) break;
      startSample++;
    }

    let endSample = mono.length - 1;
    accum = 0;
    while (endSample > startSample) {
      const v = mono[endSample];
      accum += v * v;
      if (accum >= energyTarget || Math.abs(v) >= amplitudeFloor) break;
      endSample--;
    }
    endSample++;

    const minWindow = Math.max(32, Math.round(sr * 0.05));
    if (endSample - startSample < minWindow) {
      endSample = Math.min(original.length, startSample + minWindow);
      if (endSample - startSample < minWindow) startSample = Math.max(0, endSample - minWindow);
    }

    const safety = Math.round(sr * 0.002);
    startSample = Math.max(0, startSample - safety);
    endSample = Math.min(original.length, endSample + safety);

    if (endSample - startSample < 32) {
      setStatus("Auto trim could not find a prominent region; keeping original IR.");
      return;
    }

    const trimmed = sliceAudioBuffer(original, startSample, endSample);
    applyProcessedIr(
      trimmed,
      `IR auto-trimmed to ${trimmed.duration.toFixed(3)} s (start ${((startSample / sr) * 1000).toFixed(1)} ms)`
    );
  }


  function handleIrReset() {
    const original = irOriginalRef.current;
    if (!original) return;
    const clone = cloneAudioBuffer(original);
    applyProcessedIr(clone, "IR trim reset to original length.");
  }

  function applyProcessedIr(buffer: AudioBuffer, message: string) {
    irBufRef.current = buffer;
    setIrBuffer(buffer);
    setConvolvedMatchGain(1);
    setConvolvedGainMatched(false);
    setRmsOffsetsDb((prev) => ({ ...prev, convolvedA: 0 }));
    if (matchGainRef.current) {
      matchGainRef.current.gain.value = 1;
    }
    if (mode === "convolvedA" && gainRef.current) {
      gainRef.current.gain.value = convolvedVol;
    }
    convolverLatencyRef.current = 0;
    setStatus((s) => s + `
${message}`);
  }

  function sliceAudioBuffer(buffer: AudioBuffer, startSample: number, endSample: number): AudioBuffer {
    const length = Math.max(32, endSample - startSample);
    const sliced = new AudioBuffer({
      length,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const source = buffer.getChannelData(ch);
      const target = sliced.getChannelData(ch);
      target.set(source.subarray(startSample, startSample + length));
    }
    return sliced;
  }

  function cloneAudioBuffer(buffer: AudioBuffer): AudioBuffer {
    const clone = new AudioBuffer({
      length: buffer.length,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      clone.getChannelData(ch).set(buffer.getChannelData(ch));
    }
    return clone;
  }

  async function matchConvolvedRMS() {
    const music = musicBufRef.current;
    const irB = irBufRef.current;
    const irC = irCBufRef.current;
    if (!music || (!irB && !irC)) {
      setStatus("Load music and at least one IR first.");
      return;
    }

    const analyseSlot = async (ir: AudioBuffer) => {
      const targetRate = audioCtxRef.current?.sampleRate ?? music.sampleRate;
      const dryBuffer = resampleAudioBuffer(music, targetRate);
      const wetIr = resampleAudioBuffer(ir, targetRate);
      const offlineLength = Math.max(1, dryBuffer.length + wetIr.length - 1);
      const offline = new OfflineAudioContext(dryBuffer.numberOfChannels, offlineLength, targetRate);
      const drySource = new AudioBufferSourceNode(offline, { buffer: dryBuffer });
      const conv = new ConvolverNode(offline, { buffer: wetIr, disableNormalization: false });
      const gain = new GainNode(offline, { gain: 1 });
      drySource.connect(conv).connect(gain).connect(offline.destination);
      drySource.start();
      const rendered = await offline.startRendering();

      const offset = computeAnalysisOffset(wetIr, rendered.length);
      const [dryRms, wetRms] = alignedRmsPair(dryBuffer, rendered, offset);
      let ratio = wetRms > 0 ? dryRms / wetRms : 1;
      if (!Number.isFinite(ratio) || ratio <= 0) ratio = 1;
      const clamped = Math.min(4, Math.max(0.1, ratio));
      return {
        matchGain: clamped,
        latencySeconds: offset / targetRate,
      };
    };

    setMatchingRms(true);
    if (irB) setConvolvedGainMatched(false);
    if (irC) setConvolvedBGainMatched(false);

    const statusLines: string[] = [];

    try {
      const offsetsUpdate: Partial<typeof rmsOffsetsDb> = {};
      if (irB) {
        const metrics = await analyseSlot(irB);
        setConvolvedMatchGain(metrics.matchGain);
        setConvolvedGainMatched(true);
        convolverLatencyRef.current = metrics.latencySeconds;
        if (matchGainRef.current) {
          matchGainRef.current.gain.value = metrics.matchGain;
        }
        if (mode === "convolvedA" && gainRef.current) {
          gainRef.current.gain.value = convolvedVol;
        }
        if (mode === "original" && gainRef.current) {
          gainRef.current.gain.value = originalVol;
        }
        auditionRouterRef.current?.updateTrims({ B: metrics.matchGain });
        auditionRouterRef.current?.updateLatencies({ B: metrics.latencySeconds });
        const offsetDbRaw = 20 * Math.log10(metrics.matchGain);
        const offsetDb = Number.isFinite(offsetDbRaw) ? offsetDbRaw : 0;
        offsetsUpdate.convolvedA = offsetDb;
        statusLines.push(`Convolved A RMS gain set to ${metrics.matchGain.toFixed(2)}x (${offsetDb.toFixed(2)} dB).`);
      }

      if (irC) {
        const metrics = await analyseSlot(irC);
        setConvolvedCMatchGain(metrics.matchGain);
        setConvolvedBGainMatched(true);
        convolverLatencyCRef.current = metrics.latencySeconds;
        if (matchGainCRef.current) {
          matchGainCRef.current.gain.value = metrics.matchGain;
        }
        if (mode === "convolvedB" && gainRef.current) {
          gainRef.current.gain.value = bandCVol;
        }
        auditionRouterRef.current?.updateTrims({ C: metrics.matchGain });
        auditionRouterRef.current?.updateLatencies({ C: metrics.latencySeconds });
        const offsetDbRaw = 20 * Math.log10(metrics.matchGain);
        const offsetDb = Number.isFinite(offsetDbRaw) ? offsetDbRaw : 0;
        offsetsUpdate.convolvedB = offsetDb;
        statusLines.push(`Convolved B RMS gain set to ${metrics.matchGain.toFixed(2)}x (${offsetDb.toFixed(2)} dB).`);
      }

      if (statusLines.length > 0) {
        setStatus((s) => s + `\n${statusLines.join("\n")}`);
      }
      if (Object.keys(offsetsUpdate).length > 0) {
        setRmsOffsetsDb((prev) => ({
          ...prev,
          ...offsetsUpdate,
          original: 0,
        }));
      }
    } catch (err) {
      setStatus(`RMS match failed: ${(err as Error).message}`);
    } finally {
      setMatchingRms(false);
    }
  }

  async function renderAndExport() {
    const music = musicBufRef.current;
    const ir = irBufRef.current;
    if (!music || !ir) {
      setStatus("Load music and IR first.");
      return;
    }

    const outLen = Math.max(1, music.length + ir.length - 1);
    const ch = music.numberOfChannels;
    const sr = music.sampleRate;

    const off = new OfflineAudioContext(ch, outLen, sr);
    const src = new AudioBufferSourceNode(off, { buffer: music });
    const conv = new ConvolverNode(off, { buffer: ir, disableNormalization: false });
    const gain = new GainNode(off, { gain: 1.0 });
    src.connect(conv).connect(gain).connect(off.destination);
    src.start();

    setStatus("Rendering...");
    const rendered = await off.startRendering();

    const irForAnalysis = resampleAudioBuffer(ir, sr);
    const analysisOffset = computeAnalysisOffset(irForAnalysis, rendered.length);
    const [rOrig, rConv] = alignedRmsPair(music, rendered, analysisOffset);
    const ratio = rConv > 0 ? rOrig / rConv : 1.0;
    if (ratio !== 1) scaleInPlace(rendered, Math.min(4, Math.max(0.1, ratio)));

    const wav = audioBufferToWav(rendered, 16);
    const blob = new Blob([wav], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    setStatus("Rendered. Click Download.");
  }

  async function renderAndExportDifference() {
    const music = musicBufRef.current;
    const ir = irBufRef.current;
    if (!music || !ir) {
      setStatus("Load music and IR first.");
      return;
    }

    setResidualComputing(true);

    let basis = residualBasisRef.current;
    try {
      if (!basis || basis.music !== music || basis.ir !== ir) {
        const prepared = await prepareResidualBasis(music, ir);
        if (!prepared) {
          setStatus("Difference render failed: missing buffers.");
          return;
        }
        residualBasisRef.current = prepared;
        basis = prepared;
        setLatencySamples(prepared.offset);
        setKPerCh(prepared.gains);
      }
    } catch (err) {
      console.error("Difference render preparation failed", err);
      setResidualComputing(false);
      setStatus("Difference render failed: preparation error.");
      return;
    }

    if (!basis) {
      setStatus("Difference render failed: missing buffers.");
      setResidualComputing(false);
      return;
    }

    let residual: AudioBuffer;
    try {
      residual = await computeResidualWithWorker(basis, differenceThresholdDb, {
        soloEnabled: soloBandEnabled,
        minHz: soloBandHz[0],
        maxHz: soloBandHz[1],
      });
    } catch (err) {
      console.warn("Difference export worker failed, using fallback residual", err);
      residual = ensureMonoBuffer(basis.fallbackResidual);
    }

    residualBufRef.current = residual;

    try {
      const wav = audioBufferToWav(residual, 16);
      const blob = new Blob([wav], { type: "audio/wav" });
      if (differenceDownloadUrl) {
        try {
          URL.revokeObjectURL(differenceDownloadUrl);
        } catch {
          // ignore revoke errors
        }
      }
      const url = URL.createObjectURL(blob);
      setDifferenceDownloadUrl(url);
      setStatus("Difference rendered. Click Download.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Difference render failed: ${message}`);
    } finally {
      setResidualComputing(false);
    }
  }

  const canMatchRms = Boolean(musicBufRef.current && (irBuffer || irCBuffer));
  const irBStatus = pathMetrics.B
    ? {
        latencyMs: pathMetrics.B.latencySeconds * 1000,
        trimDb: pathMetrics.B.trimDb,
      }
    : null;
  const irCStatus = pathMetrics.C
    ? {
        latencyMs: pathMetrics.C.latencySeconds * 1000,
        trimDb: pathMetrics.C.trimDb,
      }
    : null;

  return (
    <div className="app">
      <div className="app-shell">
        <header className="app-header">
          <img src={harbethLogo} alt="Harbeth Audio" className="app-logo" />
          <h1 className="app-title">SonicSuite Convolver</h1>
          <p className="app-subtitle">
            Harbeth SonicSuite: a powerful tool to convolve, compare, and analyse audio with precision.
          </p>
        </header>

        <FileInputs
          onPickMusic={onPickMusic}
          onPickIRB={onPickIRB}
          onPickIRC={onPickIRC}
          musicBuffer={musicBuffer}
          musicName={musicName}
          irBuffer={irBuffer}
          irName={irName}
          irCBuffer={irCBuffer}
          irCName={irCName}
          irMetadata={irBStatus}
          irCMetadata={irCStatus}
          sampleRate={sessionSampleRate}
        />

        {irOriginal && (
          <IRProcessingPanel
            original={irOriginal}
            processed={irBuffer}
            irName={irName}
            onManualTrim={handleIrManualTrim}
            onAutoTrim={handleIrAutoTrim}
            onReset={handleIrReset}
          />
        )}

        <section className="panel status-panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Session status</h2>
              <p className="panel-desc">Track file loading, rendering progress, and export readiness.</p>
            </div>
            {formattedKPerCh && (
              <button
                type="button"
                className="status-panel__info-button"
                onClick={() => setStatusInfoOpen((prev) => !prev)}
                aria-expanded={isStatusInfoOpen}
                aria-controls="session-status-metrics"
                aria-label={
                  isStatusInfoOpen
                    ? "Hide difference latency and per-channel gain details"
                    : "Show difference latency and per-channel gain details"
                }
              >
                ?
              </button>
            )}
          </div>
          <pre>{status}</pre>
          {formattedKPerCh && isStatusInfoOpen && (
            <div className="status-metrics" id="session-status-metrics">
              <p className="status-metrics__intro">
                Difference latency is the offset used to align the residual playback with the source track. k per channel
                lists the gain matching applied to each channel while preparing the difference render.
              </p>
              <div className="status-metrics__values">
                <div className="status-metrics__item">
                  <span className="status-metrics__label">Difference latency</span>
                  <span className="status-metrics__value">
                    {latencySamples} samples ({latencyMs.toFixed(2)} ms)
                  </span>
                </div>
                <div className="status-metrics__item">
                  <span className="status-metrics__label">k per channel</span>
                  <span className="status-metrics__value">{kPerChDisplay}</span>
                </div>
              </div>
            </div>
          )}
        </section>

        <section className="panel view-panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">Workspace view</h2>
              <p className="panel-desc">Choose between playback controls and frequency-response visualisations.</p>
            </div>
          </div>
          <div className="segmented-control" role="group" aria-label="Workspace view selector">
            <button
              type="button"
              className={`segmented-control__segment${view === "playback" ? " is-active" : ""}`}
              onClick={() => setView("playback")}
            >
              Playback Controls
            </button>
            <button
              type="button"
              className={`segmented-control__segment${view === "playback-fr" ? " is-active" : ""}`}
              onClick={() => setView("playback-fr")}
            >
              FR (Playback)
            </button>
            <button
              type="button"
              className={`segmented-control__segment${view === "frdiff" ? " is-active" : ""}`}
              onClick={() => setView("frdiff")}
            >
              FR (Difference)
            </button>
          </div>
        </section>

        {view === "playback" ? (
          <>
            <section className="panel playback-panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Playback Panel</h2>
                  <p className="panel-desc">Switch modes, control transport, and balance the convolved gain.</p>
                </div>
              </div>
              <div className={`playback-scope${isBandFrozen ? " playback-scope--frozen" : ""}`}>
                <div className="playback-scope__header">
                  <span className="playback-scope__title">Playback Scope</span>
                  <span className="playback-scope__range">{playbackBandLabel}</span>
                  {isBandFrozen ? <span className="playback-scope__badge">Frozen for test</span> : null}
                </div>
                <div className="playback-scope__presets" role="group" aria-label="Playback scope presets">
                  {BAND_PRESETS.map((preset) => {
                    const isActive = playbackPresetValue === preset.value;
                    const rangeLabel = `${formatHz(preset.range[0])} - ${formatHz(preset.range[1])}`;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        className={`playback-scope__chip${isActive ? " is-active" : ""}`}
                        onClick={() => handlePlaybackPresetSelect(preset.range)}
                        aria-pressed={isActive}
                        disabled={isBandFrozen}
                      >
                        <span className="playback-scope__chip-label">{preset.label}</span>
                        <span className="playback-scope__chip-range">{rangeLabel}</span>
                      </button>
                    );
                  })}
                </div>
                <div
                  className="frdifference-band-slider playback-scope__slider"
                  aria-label={`Playback scope frequency range ${playbackBandLabel}`}
                >
                  <div className="frdifference-band-slider__track" />
                  <div
                    className="frdifference-band-slider__selection"
                    style={{ left: `${playbackSliderStart}%`, width: `${playbackSliderSelectionWidth}%` }}
                  />
                  <input
                    type="range"
                    min={PLAYBACK_BAND_SLIDER_MIN}
                    max={PLAYBACK_BAND_SLIDER_MAX}
                    step={1}
                    value={playbackBandMinSlider}
                    onChange={handlePlaybackBandMinSlider}
                    onKeyDown={handlePlaybackScopeKeyDown}
                    aria-label="Playback band start frequency"
                    className="frdifference-band-slider__input"
                    disabled={isBandFrozen}
                  />
                  <input
                    type="range"
                    min={PLAYBACK_BAND_SLIDER_MIN}
                    max={PLAYBACK_BAND_SLIDER_MAX}
                    step={1}
                    value={playbackBandMaxSlider}
                    onChange={handlePlaybackBandMaxSlider}
                    onKeyDown={handlePlaybackScopeKeyDown}
                    aria-label="Playback band end frequency"
                    className="frdifference-band-slider__input frdifference-band-slider__input--upper"
                    disabled={isBandFrozen}
                  />
                </div>
                <div className="frdifference-band-inputs playback-scope__inputs">
                  <label className="frdifference-field">
                    <span>Start (Hz)</span>
                    <input
                      type="number"
                      min={PLAYBACK_BAND_MIN_HZ}
                      max={PLAYBACK_BAND_MAX_HZ}
                      step={0.1}
                      value={playbackBandMinHz.toFixed(1)}
                      onChange={handlePlaybackBandMinInputChange}
                      onKeyDown={handlePlaybackScopeKeyDown}
                      aria-label="Playback band start frequency"
                      className="frdifference-field-input"
                      disabled={isBandFrozen}
                    />
                  </label>
                  <label className="frdifference-field">
                    <span>End (Hz)</span>
                    <input
                      type="number"
                      min={PLAYBACK_BAND_MIN_HZ}
                      max={PLAYBACK_BAND_MAX_HZ}
                      step={0.1}
                      value={playbackBandMaxHz.toFixed(1)}
                      onChange={handlePlaybackBandMaxInputChange}
                      onKeyDown={handlePlaybackScopeKeyDown}
                      aria-label="Playback band end frequency"
                      className="frdifference-field-input"
                      disabled={isBandFrozen}
                    />
                  </label>
                </div>
              </div>
              <ModeBar
                mode={mode}
                onChangeMode={onChangeMode}
                disabledModes={modeDisableMap}
                tooltips={modeTooltips}
              />
              {mode === "difference" ? (
                <div className={`difference-selector${isDifferenceFrozen ? " difference-selector--frozen" : ""}`}>
                  <div className="difference-selector__header">
                    <span className="difference-selector__label">Difference Pair</span>
                    {isDifferenceFrozen ? <span className="playback-scope__badge">Frozen for test</span> : null}
                  </div>
                  <div className="segmented-control difference-selector__segments" role="group" aria-label="Difference pair">
                    {differenceOptions.map((option) => {
                      const isActive = differencePath === option.value;
                      const isDisabled = option.disabled || isDifferenceFrozen;
                      const reason =
                        option.value === "aMinusB"
                          ? "Load IR A and IR B to compare them."
                          : option.value === "origMinusB"
                          ? "Load IR B to compare against the original."
                          : "Load IR A to compare against the original.";
                      const tooltipSegments: string[] = [];
                      if (option.disabled) tooltipSegments.push(reason);
                      if (isDifferenceFrozen) tooltipSegments.push("Frozen during blind test.");
                      if (!option.disabled && !isDifferenceFrozen) {
                        tooltipSegments.push(`Keyboard ${option.shortcut}`);
                      }
                      const tooltip = tooltipSegments.join(" ");
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`segmented-control__segment${isActive ? " is-active" : ""}`}
                          onClick={() => handleDifferencePathChange(option.value)}
                          aria-pressed={isActive}
                          disabled={isDisabled}
                          title={tooltip || undefined}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="rms-match">
                <button
                  type="button"
                  className={`control-button button-ghost rms-match__button${isRmsMatched ? " is-matched" : ""}`}
                  onClick={matchConvolvedRMS}
                  disabled={isMatchingRms || !canMatchRms}
                  aria-pressed={isRmsMatched}
                >
                  {isMatchingRms ? "Matching..." : isRmsMatched ? "RMS Matched" : "Match RMS"}
                </button>
              </div>
              <Transport
                isPlaying={isPlaying}
                playPause={playPause}
                stopAll={stopAll}
                originalVol={originalVol}
                onChangeOriginalVol={onChangeOriginalVol}
                convolvedVol={convolvedVol}
                onChangeConvolvedVol={onChangeConvolvedVol}
                convolvedDisabled={!hasIrB}
                convolvedTooltip={modeTooltips.convolvedA}
                convolvedBVol={bandCVol}
                onChangeConvolvedBVol={setBandCVol}
                convolvedBDisabled={!hasIrC}
                convolvedBTooltip={modeTooltips.convolvedB}
                differenceVol={differenceVol}
                onChangeDifferenceVol={onChangeDifferenceVol}
                rmsOffsetsDb={rmsOffsetsDb}
                onResetVolumes={resetVolumes}
                duration={transportDuration}
                position={clampedPlaybackPosition}
                onSeek={seekTo}
                onSkipForward={() => skipBy(10)}
                onSkipBackward={() => skipBy(-10)}
              />
              {mode === "difference" && (
                <div className="inline-diff-graph">
                  <div className="panel-header" style={{ marginTop: 8 }}>
                    <div className="inline-diff-header">
                      <h3 className="panel-title" style={{ fontSize: 14 }}>Difference Quick Adjust</h3>
                      <div className="inline-diff-help-container" ref={inlineDiffHelpRef}>
                        <button
                          type="button"
                          className="inline-diff-help"
                          aria-label="What is Difference Quick Adjust?"
                          aria-expanded={isInlineDiffHelpOpen}
                          aria-controls={inlineDiffHelpPopoverId}
                          onClick={() => setInlineDiffHelpOpen((prev) => !prev)}
                        >
                          ?
                        </button>
                        {isInlineDiffHelpOpen && (
                          <div
                            className="inline-diff-help-popover"
                            id={inlineDiffHelpPopoverId}
                            role="dialog"
                            aria-modal="false"
                          >
                            <strong>Difference Quick Adjust</strong>
                            <p>Adjust absolute difference threshold while listening.</p>
                            <p>Difference detection picks how much change counts as a difference.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <FRDifference
                    compact
                    musicBuffer={musicBufRef.current}
                    irBuffer={irBuffer}
                    sampleRate={sessionSampleRate}
                    absMode={differenceAbsMode}
                    onChangeAbsMode={setDifferenceAbsMode}
                    thresholdDb={pendingDifferenceThresholdDb}
                    onChangeThresholdDb={setPendingDifferenceThresholdDb}
                    bandSoloEnabled={pendingSoloBandEnabled}
                    onChangeBandSoloEnabled={setPendingSoloBandEnabled}
                    bandMinHz={pendingSoloBandHz[0]}
                    bandMaxHz={pendingSoloBandHz[1]}
                    onChangeBandHz={(min: number, max: number) => setPendingSoloBandHz([min, max])}
                    bandMatchRmsEnabled={pendingBandMatchRmsEnabled}
                    onChangeBandMatchRmsEnabled={setPendingBandMatchRmsEnabled}
                  />
                  <div className="inline-diff-actions">
                    <button
                      type="button"
                      className="control-button button-ghost"
                      onClick={applyDifferenceThreshold}
                      disabled={!differenceControlsDirty || isResidualComputing}
                    >
                      {isResidualComputing ? "Applying..." : "Apply Threshold"}
                    </button>
                    <button
                      type="button"
                      className="control-button button-ghost"
                      onClick={resetDifferenceThreshold}
                      disabled={!differenceControlsDirty || isResidualComputing}
                    >
                      Reset
                    </button>
                    <div className="inline-diff-status" aria-live="polite">
                      {differenceControlsDirty && !isResidualComputing && "Pending changes"}
                      {isResidualComputing && "Updating difference..."}
                    </div>
                  </div>
                </div>
              )}
            </section>

            <BlindTestPanel
              mode={blindTestMode}
              onChangeMode={handleBlindModeChange}
              availableModes={availableBlindModes}
              onStart={handleBlindStart}
              onReset={handleBlindReset}
              onReveal={handleBlindReveal}
              onNext={handleBlindNext}
              onGuess={handleBlindGuess}
              onAudition={handleBlindAudition}
              canAuditionC={hasIrC}
              stats={blindStats}
              currentTrialIndex={blindCurrentIndex}
              lastLogEntry={blindLastEntry}
              seed={blindTestSeed}
              onSeedChange={handleBlindSeedChange}
              bandRangeLabel={blindPanelBandLabel}
              isReady={isBandFrozen}
            />

            <ExportBar
              renderAndExport={renderAndExport}
              downloadUrl={downloadUrl}
              renderDifference={renderAndExportDifference}
              differenceUrl={differenceDownloadUrl}
            />
          </>
        ) : view === "playback-fr" ? (
          <section className="panel frpink-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Playback FR</h2>
                <p className="panel-desc">Overlay the spectrum of the original track and its convolved version.</p>
              </div>
            </div>
            <FRPlayback musicBuffer={musicBufRef.current} irBuffer={irBuffer} irBufferB={irCBuffer} sampleRate={sessionSampleRate} />
          </section>
        ) : view === "frdiff" ? (
          <section className="panel frpink-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Playback Difference</h2>
                <p className="panel-desc">Inspect how the convolved playback deviates from the original.</p>
              </div>
            </div>
            <FRDifference
              musicBuffer={musicBufRef.current}
              irBuffer={irBuffer}
              sampleRate={sessionSampleRate}
              absMode={differenceAbsMode}
              onChangeAbsMode={setDifferenceAbsMode}
              thresholdDb={pendingDifferenceThresholdDb}
              onChangeThresholdDb={setPendingDifferenceThresholdDb}
              bandSoloEnabled={pendingSoloBandEnabled}
              onChangeBandSoloEnabled={setPendingSoloBandEnabled}
              bandMinHz={pendingSoloBandHz[0]}
              bandMaxHz={pendingSoloBandHz[1]}
              onChangeBandHz={(min: number, max: number) => setPendingSoloBandHz([min, max])}
              bandMatchRmsEnabled={pendingBandMatchRmsEnabled}
              onChangeBandMatchRmsEnabled={setPendingBandMatchRmsEnabled}
            />
          </section>
        ) : null}

        <p className="footnote">
          Notes: Playback uses Web Audio. Rendering uses OfflineAudioContext. RMS matched before export.
        </p>
      </div>
    </div>
  );
}






export default function App() {
  const passwordRequirement = (import.meta.env.VITE_APP_PAGE_PASSWORD ?? "").trim();
  const [isAuthorized, setAuthorized] = useState(() => {
    if (!passwordRequirement) return true;
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem("sonicSuiteAuthorized") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!passwordRequirement) return;
    if (typeof window === "undefined") return;
    try {
      if (isAuthorized) {
        window.sessionStorage.setItem("sonicSuiteAuthorized", "true");
      } else {
        window.sessionStorage.removeItem("sonicSuiteAuthorized");
      }
    } catch {
      // Ignore storage access errors (e.g., private browsing mode restrictions)
    }
  }, [isAuthorized, passwordRequirement]);

  if (passwordRequirement && !isAuthorized) {
    return (
      <PasswordGate
        expectedPassword={passwordRequirement}
        onUnlock={() => setAuthorized(true)}
      />
    );
  }

  return <SonicSuiteApp />;
}


async function prepareResidualBasis(music: AudioBuffer, ir: AudioBuffer): Promise<ResidualBasis | null> {
  const targetRate = music.sampleRate;
  const irForOffline = ir.sampleRate === targetRate ? ir : resampleAudioBuffer(ir, targetRate);
  const offlineLength = Math.max(1, music.length + irForOffline.length - 1);
  const offline = new OfflineAudioContext(music.numberOfChannels, offlineLength, targetRate);
  const src = new AudioBufferSourceNode(offline, { buffer: music });
  const conv = new ConvolverNode(offline, { buffer: irForOffline, disableNormalization: false });
  src.connect(conv).connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const offset = computeAnalysisOffset(irForOffline, rendered.length);
  const { residual, gains } = makeResidualBuffer(rendered, music, offset);
  limitPeakInPlace(residual, -0.3);
  return {
    music,
    ir,
    convolved: rendered,
    offset,
    gains,
    fallbackResidual: ensureMonoBuffer(residual),
  };
}

function makeResidualBuffer(
  convolved: AudioBuffer,
  original: AudioBuffer,
  offsetSamples: number
): { residual: AudioBuffer; gains: number[] } {
  const channelCount = convolved.numberOfChannels;
  const length = convolved.length;
  const sampleRate = convolved.sampleRate;
  const residual = new AudioBuffer({ numberOfChannels: channelCount, length, sampleRate });
  const gains: number[] = [];
  const delay = Math.max(0, Math.floor(offsetSamples));

  for (let ch = 0; ch < channelCount; ch++) {
    const y = convolved.getChannelData(ch);
    const originalChannelCount = original.numberOfChannels;
    const sourceChannel =
      originalChannelCount > 0 ? Math.min(ch, originalChannelCount - 1) : 0;
    const x = originalChannelCount > 0 ? original.getChannelData(sourceChannel) : null;
    const dst = residual.getChannelData(ch);
    if (!x) {
      gains.push(1);
      dst.set(y);
      continue;
    }

    const overlapStart = Math.min(Math.max(0, delay), length);
    const overlapEnd = Math.min(length, x.length + delay);

    let num = 0;
    let den = 0;
    for (let i = overlapStart; i < overlapEnd; i++) {
      const sourceIndex = i - delay;
      if (sourceIndex < 0 || sourceIndex >= x.length) continue;
      const xv = x[sourceIndex];
      const yv = y[i];
      num += xv * yv;
      den += xv * xv;
    }
    const gain = den > 1e-12 ? num / den : 1;
    gains.push(gain);

    for (let i = 0; i < length; i++) {
      const sourceIndex = i - delay;
      const xv = sourceIndex >= 0 && sourceIndex < x.length ? x[sourceIndex] : 0;
      dst[i] = y[i] - gain * xv;
    }
  }

  return { residual, gains };
}

function ensureMonoBuffer(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels <= 1) {
    return buffer;
  }
  const { length, sampleRate } = buffer;
  const mono = new AudioBuffer({ numberOfChannels: 1, length, sampleRate });
  const target = mono.getChannelData(0);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      target[i] += data[i];
    }
  }
  const inv = 1 / buffer.numberOfChannels;
  for (let i = 0; i < length; i++) {
    target[i] *= inv;
  }
  limitPeakInPlace(mono, -0.3);
  return mono;
}

// === Magnitude-threshold masking ===
function limitPeakInPlace(buf: AudioBuffer, ceilingDb = -0.3) {
  if (buf.sampleRate <= 0) return;
  const ceiling = Math.pow(10, ceilingDb / 20);
  const attack = Math.exp(-1 / (buf.sampleRate * 0.001));
  const release = Math.exp(-1 / (buf.sampleRate * 0.05));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    let env = 0;
    for (let i = 0; i < data.length; i++) {
      const absVal = Math.abs(data[i]);
      if (absVal > env) {
        env = attack * env + (1 - attack) * absVal;
      } else {
        env = release * env + (1 - release) * absVal;
      }
      const gain = env > ceiling ? ceiling / (env + 1e-12) : 1;
      data[i] *= gain;
    }
  }
}

function impulseOffset(buf: AudioBuffer): number {
  const threshold = 0.0005;
  let minIndex = buf.length;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < buf.length; i++) {
      if (Math.abs(data[i]) > threshold) {
        if (i < minIndex) minIndex = i;
        break;
      }
    }
  }
  if (!Number.isFinite(minIndex) || minIndex >= buf.length) return 0;
  return minIndex;
}

function computeAnalysisOffset(irBuffer: AudioBuffer, maxFrames: number): number {
  const raw = impulseOffset(irBuffer);
  return Math.min(raw, Math.max(0, maxFrames - 1));
}

function resampleAudioBuffer(buffer: AudioBuffer, targetRate: number): AudioBuffer {
  if (buffer.sampleRate === targetRate) return buffer;
  const duration = buffer.length / buffer.sampleRate;
  const newLength = Math.max(1, Math.round(duration * targetRate));
  const resampled = new AudioBuffer({
    length: newLength,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: targetRate,
  });
  const ratio = buffer.sampleRate / targetRate;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dest = resampled.getChannelData(ch);
    for (let i = 0; i < newLength; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = src[Math.min(idx, src.length - 1)];
      const s1 = src[Math.min(idx + 1, src.length - 1)];
      dest[i] = s0 + (s1 - s0) * frac;
    }
  }
  return resampled;
}

function rmsBuffer(buf: AudioBuffer, frameCount?: number, offset = 0): number {
  const start = Math.max(0, Math.min(offset, buf.length));
  const available = buf.length - start;
  const frames = Math.min(frameCount ?? available, available);
  if (frames <= 0) return 0;
  const channels = buf.numberOfChannels;
  if (channels === 0) return 0;
  let acc = 0;
  for (let ch = 0; ch < channels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < frames; i++) {
      const x = data[start + i];
      acc += x * x;
    }
  }
  const count = frames * channels;
  return count ? Math.sqrt(acc / count) : 0;
}

function alignedRmsPair(dry: AudioBuffer, wet: AudioBuffer, offset: number): [number, number] {
  if (dry.length === 0 || wet.length === 0) return [0, 0];
  const wetAvailable = Math.max(0, wet.length - offset);
  let frames = Math.min(dry.length, wetAvailable);
  if (frames <= 0) frames = Math.min(dry.length, wet.length);
  if (frames <= 0) return [0, 0];
  const wetOffset = Math.max(0, Math.min(offset, wet.length - frames));
  const dryOffset = 0;
  const dryRms = rmsBuffer(dry, frames, dryOffset);
  const wetRms = rmsBuffer(wet, frames, wetOffset);
  return [dryRms, wetRms];
}

function scaleInPlace(buf: AudioBuffer, g: number) {
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      let v = d[i] * g;
      if (v > 1) v = 1;
      if (v < -1) v = -1;
      d[i] = v;
    }
  }
}

function audioBufferToWav(buf: AudioBuffer, bitDepth: 16 | 24 | 32 = 16): ArrayBuffer {
  const numCh = buf.numberOfChannels;
  const len = buf.length;
  const sr = buf.sampleRate;

  const interleaved = new Float32Array(len * numCh);
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      interleaved[i * numCh + ch] = buf.getChannelData(ch)[i];
    }
  }

  let bytesPerSample: number;
  let pcm: DataView;
  if (bitDepth === 16) {
    bytesPerSample = 2;
    const out = new ArrayBuffer(interleaved.length * 2);
    pcm = new DataView(out);
    for (let i = 0; i < interleaved.length; i++) {
      const s = Math.max(-1, Math.min(1, interleaved[i]));
      pcm.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  } else if (bitDepth === 24) {
    bytesPerSample = 3;
    const out = new ArrayBuffer(interleaved.length * 3);
    pcm = new DataView(out);
    for (let i = 0; i < interleaved.length; i++) {
      const s = Math.max(-1, Math.min(1, interleaved[i]));
      const v = Math.floor(s < 0 ? s * 0x800000 : s * 0x7fffff);
      pcm.setUint8(i * 3 + 0, v & 0xff);
      pcm.setUint8(i * 3 + 1, (v >> 8) & 0xff);
      pcm.setUint8(i * 3 + 2, (v >> 16) & 0xff);
    }
  } else {
    bytesPerSample = 4;
    const out = new ArrayBuffer(interleaved.length * 4);
    pcm = new DataView(out);
    for (let i = 0; i < interleaved.length; i++) {
      pcm.setFloat32(i * 4, interleaved[i], true);
    }
  }

  const blockAlign = numCh * bytesPerSample;
  const byteRate = sr * blockAlign;
  const dataSize = pcm.buffer.byteLength;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");

  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  const format = bitDepth === 32 ? 3 : 1;
  view.setUint16(20, format, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(wav, 44).set(new Uint8Array(pcm.buffer));
  return wav;
}

function writeStr(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}


