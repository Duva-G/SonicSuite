import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import FullscreenModal from "./FullscreenModal";
import FRMusicPink from "./FRMusicPink";
import WaveformPlot from "./WaveformPlot";
import InView from "./InView";
import MetaChips, { type MetaChip } from "./MetaChips";

type Props = {
  onPickMusic: (e: ChangeEvent<HTMLInputElement>) => void;
  onPickIRB: (e: ChangeEvent<HTMLInputElement>) => void;
  onPickIRC: (e: ChangeEvent<HTMLInputElement>) => void;
  musicBuffer: AudioBuffer | null;
  musicName: string;
  irBuffer: AudioBuffer | null;
  irName: string;
  irCBuffer: AudioBuffer | null;
  irCName: string;
  irMetadata?: {
    latencyMs: number | null;
    trimDb: number | null;
  } | null;
  irCMetadata?: {
    latencyMs: number | null;
    trimDb: number | null;
  } | null;
  sampleRate: number;
};

type BufferMeta = {
  durationLabel: string;
  durationSeconds: number;
  sampleRateLabel: string;
  sampleRateValue: number;
  channelsLabel: string;
  channelCount: number;
};

export default function FileInputs({
  onPickMusic,
  onPickIRB,
  onPickIRC,
  musicBuffer,
  musicName,
  irBuffer,
  irName,
  irCBuffer,
  irCName,
  irMetadata,
  irCMetadata,
  sampleRate,
}: Props) {
  const [showMusicWave, setShowMusicWave] = useState(false);
  const [showMusicPink, setShowMusicPink] = useState(false);
  const [showMusicFull, setShowMusicFull] = useState(false);
  const [showIrWave, setShowIrWave] = useState(false);
  const [showIrFull, setShowIrFull] = useState(false);
  const [showIrCWave, setShowIrCWave] = useState(false);
  const [showIrCFull, setShowIrCFull] = useState(false);
  const [isMusicDropping, setIsMusicDropping] = useState(false);
  const [isIrDropping, setIsIrDropping] = useState(false);
  const [isIrCDropping, setIsIrCDropping] = useState(false);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const irInputRef = useRef<HTMLInputElement | null>(null);
  const irCInputRef = useRef<HTMLInputElement | null>(null);
  const tipsRef = useRef<HTMLDivElement | null>(null);
  const [showTips, setShowTips] = useState(false);

  const musicMeta = useMemo(() => formatBufferMeta(musicBuffer), [musicBuffer]);
  const irMeta = useMemo(() => formatBufferMeta(irBuffer), [irBuffer]);
  const irCMeta = useMemo(() => formatBufferMeta(irCBuffer), [irCBuffer]);

  const musicChips = useMemo<MetaChip[]>(() => buildBaseChips(musicMeta), [musicMeta]);
  const irChips = useMemo<MetaChip[]>(
    () => buildIrChips(irMeta, irMetadata, sampleRate),
    [irMeta, irMetadata, sampleRate]
  );
  const irCChips = useMemo<MetaChip[]>(
    () => buildIrChips(irCMeta, irCMetadata, sampleRate),
    [irCMeta, irCMetadata, sampleRate]
  );

  const irSampleRateWarning = useMemo(() => getSampleRateWarning(irMeta, sampleRate), [irMeta, sampleRate]);
  const irCSampleRateWarning = useMemo(() => getSampleRateWarning(irCMeta, sampleRate), [irCMeta, sampleRate]);

  useEffect(() => {
    if (musicBuffer) {
      setShowMusicWave(true);
    } else {
      setShowMusicWave(false);
      setShowMusicPink(false);
      setShowMusicFull(false);
    }
  }, [musicBuffer]);

  useEffect(() => {
    if (irBuffer) {
      setShowIrWave(true);
    } else {
      setShowIrWave(false);
      setShowIrFull(false);
    }
  }, [irBuffer]);

  useEffect(() => {
    if (irCBuffer) {
      setShowIrCWave(true);
    } else {
      setShowIrCWave(false);
      setShowIrCFull(false);
    }
  }, [irCBuffer]);

  useEffect(() => {
    if (!showTips) return;

    function handlePointer(event: PointerEvent) {
      if (!tipsRef.current) return;
      if (!tipsRef.current.contains(event.target as Node)) {
        setShowTips(false);
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setShowTips(false);
    }

    window.addEventListener("pointerdown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [showTips]);

  const handleMusicDragEnter = (event: DragEvent<HTMLLabelElement>) =>
    handleDragEnter(event, setIsMusicDropping);
  const handleMusicDragOver = (event: DragEvent<HTMLLabelElement>) =>
    handleDragOver(event, setIsMusicDropping);
  const handleMusicDragLeave = (event: DragEvent<HTMLLabelElement>) =>
    handleDragLeave(event, setIsMusicDropping);
  const handleMusicDrop = (event: DragEvent<HTMLLabelElement>) =>
    handleDrop(event, setIsMusicDropping, (file) => {
      if (musicInputRef.current) {
        musicInputRef.current.value = "";
      }
      emitSyntheticChange(file, onPickMusic);
    });

  const handleIrDragEnter = (event: DragEvent<HTMLLabelElement>) => handleDragEnter(event, setIsIrDropping);
  const handleIrDragOver = (event: DragEvent<HTMLLabelElement>) => handleDragOver(event, setIsIrDropping);
  const handleIrDragLeave = (event: DragEvent<HTMLLabelElement>) => handleDragLeave(event, setIsIrDropping);
  const handleIrDrop = (event: DragEvent<HTMLLabelElement>) =>
    handleDrop(event, setIsIrDropping, (file) => {
      if (irInputRef.current) {
        irInputRef.current.value = "";
      }
      emitSyntheticChange(file, onPickIRB);
    });

  const handleIrCDragEnter = (event: DragEvent<HTMLLabelElement>) =>
    handleDragEnter(event, setIsIrCDropping);
  const handleIrCDragOver = (event: DragEvent<HTMLLabelElement>) =>
    handleDragOver(event, setIsIrCDropping);
  const handleIrCDragLeave = (event: DragEvent<HTMLLabelElement>) =>
    handleDragLeave(event, setIsIrCDropping);
  const handleIrCDrop = (event: DragEvent<HTMLLabelElement>) =>
    handleDrop(event, setIsIrCDropping, (file) => {
      if (irCInputRef.current) {
        irCInputRef.current.value = "";
      }
      emitSyntheticChange(file, onPickIRC);
    });

  return (
    <section className="panel file-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Source files</h2>
          <p className="panel-desc">Load a dry mix and an impulse response to start sculpting.</p>
        </div>
        <div className="panel-help" ref={tipsRef}>
          <button
            type="button"
            className="panel-help__button"
            aria-label="Import tips"
            onClick={() => setShowTips((v) => !v)}
          >
            M
          </button>
          {showTips && (
            <div className="panel-help__popover" role="dialog" aria-label="Import tips">
              <h3 className="panel-help__title">Import tips</h3>
              <p className="panel-help__text">
                <strong>Music:</strong> WAV/AIFF, 44.1-96 kHz, 24-bit+. Avoid MP3/AAC.
              </p>
              <p className="panel-help__text">
                <strong>Impulse Response:</strong> WAV/AIFF at the same sample rate as the session.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="file-card-grid">
        <div className="file-card-stack">
          <label
            className={`file-card${isMusicDropping ? " file-card--dropping" : ""}`}
            onDragEnter={handleMusicDragEnter}
            onDragOver={handleMusicDragOver}
            onDragLeave={handleMusicDragLeave}
            onDrop={handleMusicDrop}
          >
            <div className="file-card__icon" aria-hidden="true">
              M
            </div>
            <div className="file-card__copy">
              <span className="file-card__title">Music WAV</span>
              <span className="file-card__subtitle">Upload the track you want to convolve.</span>
            </div>
            <span className="file-card__action">Choose file</span>
            {isMusicDropping && <div className="file-card__drop-indicator">Drop to load</div>}
            <input
              ref={musicInputRef}
              className="file-card__input"
              type="file"
              accept=".wav,audio/wav"
              onChange={onPickMusic}
            />
          </label>
          {musicBuffer && (
            <>
              <div className="file-status" aria-live="polite">
                <span className="file-status__label">Selected file</span>
                <span className="file-status__value" title={musicName || "Music waveform"}>
                  {musicName || "Music waveform"}
                </span>
                <MetaChips chips={musicChips} aria-label="Music file metadata" />
              </div>
              <div className="waveform-section">
                <div className="waveform-header">
                  <div className="waveform-title">
                    <span className="waveform-title__name" title={musicName || "Music waveform"}>
                      {musicName || "Music waveform"}
                    </span>
                    {musicMeta && <span className="waveform-title__meta">{musicMeta.durationLabel}</span>}
                  </div>
                  <div className="waveform-toolbar" role="toolbar" aria-label="Music waveform controls">
                    <div className="segmented-control" role="group" aria-label="Music view toggles">
                      <button
                        type="button"
                        className="segmented-control__button"
                        aria-pressed={showMusicWave}
                        onClick={() => setShowMusicWave((v) => !v)}
                      >
                        Waveform
                      </button>
                      <button
                        type="button"
                        className="segmented-control__button"
                        aria-pressed={showMusicPink}
                        onClick={() => setShowMusicPink((v) => !v)}
                      >
                        Spectrum vs Pink
                      </button>
                    </div>
                    <button
                      type="button"
                      className="segmented-control__button segmented-control__button--action"
                      onClick={() => setShowMusicFull(true)}
                    >
                      Full screen
                    </button>
                  </div>
                </div>
                {showMusicWave && (
                  <InView
                    className="waveform-plot"
                    fallback={<PlotSkeleton label="Loading waveform..." />}
                    rootMargin="200px"
                  >
                    <WaveformPlot
                      buffer={musicBuffer}
                      color="#5ac8fa"
                      title={musicName || "Music"}
                    />
                  </InView>
                )}
                {showMusicPink && (
                  <InView
                    className="waveform-plot"
                    fallback={<PlotSkeleton label="Preparing comparison..." />}
                    rootMargin="200px"
                  >
                    <FRMusicPink musicBuffer={musicBuffer} sampleRate={sampleRate} />
                  </InView>
                )}
              </div>
            </>
          )}
        </div>
        <div className="file-card-stack">
          <label
            className={`file-card${isIrDropping ? " file-card--dropping" : ""}`}
            onDragEnter={handleIrDragEnter}
            onDragOver={handleIrDragOver}
            onDragLeave={handleIrDragLeave}
            onDrop={handleIrDrop}
          >
            <div className="file-card__icon" aria-hidden="true">
              IR
            </div>
            <div className="file-card__copy">
              <span className="file-card__title">Impulse response WAV</span>
              <span className="file-card__subtitle">Choose the acoustic fingerprint to apply.</span>
            </div>
            <span className="file-card__action">Choose file</span>
            {isIrDropping && <div className="file-card__drop-indicator">Drop to load</div>}
            <input
              ref={irInputRef}
              className="file-card__input"
              type="file"
              accept=".wav,audio/wav"
              onChange={onPickIRB}
            />
          </label>
          {irBuffer && (
            <>
              <div className="file-status" aria-live="polite">
                <span className="file-status__label">Selected file</span>
                <span className="file-status__value" title={irName || "Impulse response"}>
                  {irName || "Impulse response"}
                </span>
                <MetaChips chips={irChips} aria-label="Impulse response metadata" />
                {irSampleRateWarning && (
                  <div className="file-warning" role="status">
                    {irSampleRateWarning}
                  </div>
                )}
              </div>
              <div className="waveform-section">
                <div className="waveform-header">
                  <div className="waveform-title">
                    <span className="waveform-title__name" title={irName || "Impulse response"}>
                      {irName || "Impulse response"}
                    </span>
                    {irMeta && <span className="waveform-title__meta">{irMeta.durationLabel}</span>}
                  </div>
                  <div className="waveform-toolbar" role="toolbar" aria-label="Impulse response controls">
                    <div className="segmented-control" role="group" aria-label="Impulse response view toggles">
                      <button
                        type="button"
                        className="segmented-control__button"
                        aria-pressed={showIrWave}
                        onClick={() => setShowIrWave((v) => !v)}
                      >
                        Waveform
                      </button>
                    </div>
                    <button
                      type="button"
                      className="segmented-control__button segmented-control__button--action"
                      onClick={() => setShowIrFull(true)}
                    >
                      Full screen
                    </button>
                  </div>
                </div>
                {showIrWave && (
                  <InView
                    className="waveform-plot"
                    fallback={<PlotSkeleton label="Loading waveform..." />}
                    rootMargin="200px"
                  >
                    <WaveformPlot
                      buffer={irBuffer}
                      color="#ff9f0a"
                      title={irName || "Impulse response"}
                    />
                  </InView>
                )}
              </div>
            </>
          )}
        </div>
        <div className="file-card-stack">
          <label
            className={`file-card${isIrCDropping ? " file-card--dropping" : ""}`}
            onDragEnter={handleIrCDragEnter}
            onDragOver={handleIrCDragOver}
            onDragLeave={handleIrCDragLeave}
            onDrop={handleIrCDrop}
          >
            <div className="file-card__icon" aria-hidden="true">
              IR
            </div>
            <div className="file-card__copy">
              <span className="file-card__title">Impulse response C (optional)</span>
              <span className="file-card__subtitle">Load a second IR to compare.</span>
            </div>
            <span className="file-card__action">Choose file</span>
            {isIrCDropping && <div className="file-card__drop-indicator">Drop to load</div>}
            <input
              ref={irCInputRef}
              className="file-card__input"
              type="file"
              accept=".wav,audio/wav"
              onChange={onPickIRC}
            />
          </label>
          {irCBuffer && (
            <>
              <div className="file-status" aria-live="polite">
                <span className="file-status__label">Selected file</span>
                <span className="file-status__value" title={irCName || "Impulse response C"}>
                  {irCName || "Impulse response C"}
                </span>
                <MetaChips chips={irCChips} aria-label="Impulse response C metadata" />
                {irCSampleRateWarning && (
                  <div className="file-warning" role="status">
                    {irCSampleRateWarning}
                  </div>
                )}
              </div>
              <div className="waveform-section">
                <div className="waveform-header">
                  <div className="waveform-title">
                    <span className="waveform-title__name" title={irCName || "Impulse response C"}>
                      {irCName || "Impulse response C"}
                    </span>
                    {irCMeta && <span className="waveform-title__meta">{irCMeta.durationLabel}</span>}
                  </div>
                  <div className="waveform-toolbar" role="toolbar" aria-label="Impulse response C controls">
                    <div className="segmented-control" role="group" aria-label="Impulse response C view toggles">
                      <button
                        type="button"
                        className="segmented-control__button"
                        aria-pressed={showIrCWave}
                        onClick={() => setShowIrCWave((v) => !v)}
                      >
                        Waveform
                      </button>
                    </div>
                    <button
                      type="button"
                      className="segmented-control__button segmented-control__button--action"
                      onClick={() => setShowIrCFull(true)}
                    >
                      Full screen
                    </button>
                  </div>
                </div>
                {showIrCWave && (
                  <InView
                    className="waveform-plot"
                    fallback={<PlotSkeleton label="Loading waveform..." />}
                    rootMargin="200px"
                  >
                    <WaveformPlot
                      buffer={irCBuffer}
                      color="#ff453a"
                      title={irCName || "Impulse response C"}
                    />
                  </InView>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <FullscreenModal isOpen={showMusicFull} onClose={() => setShowMusicFull(false)} title={musicName || "Music"}>
        {musicBuffer && (
          <div className="fullscreen-modal__plot">
            <WaveformPlot buffer={musicBuffer} color="#5ac8fa" title={musicName || "Music"} />
          </div>
        )}
      </FullscreenModal>
      <FullscreenModal
        isOpen={showIrFull}
        onClose={() => setShowIrFull(false)}
        title={irName || "Impulse response"}
      >
        {irBuffer && (
          <div className="fullscreen-modal__plot">
            <WaveformPlot buffer={irBuffer} color="#ff9f0a" title={irName || "Impulse response"} />
          </div>
        )}
      </FullscreenModal>
      <FullscreenModal
        isOpen={showIrCFull}
        onClose={() => setShowIrCFull(false)}
        title={irCName || "Impulse response C"}
      >
        {irCBuffer && (
          <div className="fullscreen-modal__plot">
            <WaveformPlot buffer={irCBuffer} color="#ff453a" title={irCName || "Impulse response C"} />
          </div>
        )}
      </FullscreenModal>
    </section>
  );
}

function PlotSkeleton({ label }: { label: string }) {
  return (
    <div className="plot-skeleton" role="status" aria-live="polite">
      {label}
    </div>
  );
}

function formatBufferMeta(buffer: AudioBuffer | null): BufferMeta | null {
  if (!buffer) return null;
  const durationSeconds = buffer.duration;
  const sampleRateValue = Math.round(buffer.sampleRate);
  const channelCount = buffer.numberOfChannels;
  const channelLabel = channelCount === 1 ? "Mono" : channelCount === 2 ? "Stereo" : `${channelCount} ch`;
  return {
    durationLabel: `${durationSeconds.toFixed(2)} s`,
    durationSeconds,
    sampleRateLabel: formatSampleRate(sampleRateValue),
    sampleRateValue,
    channelsLabel: channelLabel,
    channelCount,
  };
}

function buildBaseChips(meta: BufferMeta | null): MetaChip[] {
  if (!meta) return [];
  return [
    { label: meta.durationLabel },
    { label: meta.sampleRateLabel },
    { label: meta.channelsLabel },
  ];
}

function buildIrChips(
  meta: BufferMeta | null,
  metadata: { latencyMs: number | null; trimDb: number | null } | null | undefined,
  sessionSampleRate: number
): MetaChip[] {
  if (!meta) return [];
  const chips = buildBaseChips(meta);
  const latency = formatLatencyMs(metadata?.latencyMs);
  if (latency) {
    chips.push({ label: `Latency ${latency}` });
  }
  const trim = formatTrimDb(metadata?.trimDb);
  if (trim) {
    chips.push({ label: `Trim ${trim}` });
  }
  const warningChip = createSampleRateChip(meta, sessionSampleRate);
  if (warningChip) {
    chips.push(warningChip);
  }
  return chips;
}

function createSampleRateChip(meta: BufferMeta | null, sessionSampleRate: number): MetaChip | null {
  if (!meta) return null;
  if (!Number.isFinite(sessionSampleRate) || sessionSampleRate <= 0) return null;
  const sessionValue = Math.round(sessionSampleRate);
  if (sessionValue === meta.sampleRateValue) return null;
  return {
    label: `Session ${formatSampleRate(sessionValue)}`,
    tone: "warning",
  };
}

function getSampleRateWarning(meta: BufferMeta | null, sessionSampleRate: number) {
  if (!meta) return null;
  const chip = createSampleRateChip(meta, sessionSampleRate);
  if (!chip) return null;
  const sessionLabel = formatSampleRate(Math.round(sessionSampleRate));
  return `File is ${meta.sampleRateLabel}; session is ${sessionLabel}. Resampling will be applied.`;
}

function formatLatencyMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ms`;
}

function formatTrimDb(db: number | null | undefined) {
  if (db == null || !Number.isFinite(db)) return null;
  const normalized = Math.abs(db) < 0.05 ? 0 : Math.round(db * 10) / 10;
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(1)} dB`;
}

function formatSampleRate(value: number) {
  return `${value.toLocaleString()} Hz`;
}

function emitSyntheticChange(file: File, handler: (event: ChangeEvent<HTMLInputElement>) => void) {
  const fileList = createFileList(file);
  const target = { files: fileList } as unknown as HTMLInputElement;
  const syntheticEvent = {
    target,
    currentTarget: target,
  } as ChangeEvent<HTMLInputElement>;
  handler(syntheticEvent);
}

function createFileList(file: File): FileList {
  const fileList = {
    0: file,
    length: 1,
    item(index: number) {
      return index === 0 ? file : null;
    },
  } as unknown as FileList;
  return fileList;
}

function handleDragEnter<T extends HTMLElement>(event: DragEvent<T>, setDropping: (value: boolean) => void) {
  event.preventDefault();
  setDropping(true);
}

function handleDragOver<T extends HTMLElement>(event: DragEvent<T>, setDropping: (value: boolean) => void) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  setDropping(true);
}

function handleDragLeave<T extends HTMLElement>(event: DragEvent<T>, setDropping: (value: boolean) => void) {
  event.preventDefault();
  const nextTarget = event.relatedTarget as Node | null;
  if (nextTarget && event.currentTarget.contains(nextTarget)) {
    return;
  }
  setDropping(false);
}

function handleDrop<T extends HTMLElement>(
  event: DragEvent<T>,
  setDropping: (value: boolean) => void,
  onFile: (file: File) => void
) {
  event.preventDefault();
  setDropping(false);
  const { files } = event.dataTransfer;
  if (!files || files.length === 0) {
    return;
  }
  const file = files[0];
  if (file) {
    onFile(file);
  }
}
