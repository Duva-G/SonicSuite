import { useEffect, useRef, useState } from "react";
import WaveformPlot from "./WaveformPlot";

type Props = {
  onPickMusic: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPickIR: (e: React.ChangeEvent<HTMLInputElement>) => void;
  musicBuffer: AudioBuffer | null;
  musicName: string;
  irBuffer: AudioBuffer | null;
  irName: string;
};

export default function FileInputs({ onPickMusic, onPickIR, musicBuffer, musicName, irBuffer, irName }: Props) {
  const [showMusicWave, setShowMusicWave] = useState(false);
  const [showIrWave, setShowIrWave] = useState(false);
  const tipsRef = useRef<HTMLDivElement | null>(null);
  const [showTips, setShowTips] = useState(false);

  useEffect(() => {
    if (musicBuffer) {
      setShowMusicWave(true);
    } else {
      setShowMusicWave(false);
    }
  }, [musicBuffer]);

  useEffect(() => {
    if (irBuffer) {
      setShowIrWave(true);
    } else {
      setShowIrWave(false);
    }
  }, [irBuffer]);


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
            ?
          </button>
          {showTips && (
            <div className="panel-help__popover" role="dialog" aria-label="Import tips">
              <h3 className="panel-help__title">Import tips</h3>
              <p className="panel-help__text"><strong>Music:</strong> WAV/AIFF, 44.1-96 kHz, 24-bit+. Avoid MP3/AAC.</p>
              <p className="panel-help__text"><strong>Impulse Response:</strong> WAV/AIFF at the same sample rate as the session.</p>
            </div>
          )}
        </div>
      </div>
      <div className="file-card-grid">
        <div className="file-card-stack">
          <label className="file-card">
            <div className="file-card__icon" aria-hidden="true">
              ♫
            </div>
            <div className="file-card__copy">
              <span className="file-card__title">Music WAV</span>
              <span className="file-card__subtitle">Upload the track you want to convolve.</span>
            </div>
            <span className="file-card__action">Choose file</span>
            <input
              className="file-card__input"
              type="file"
              accept=".wav,audio/wav"
              onChange={onPickMusic}
            />
          </label>
          {musicBuffer && (
            <div className="waveform-section">
              <div className="waveform-header">
                <span className="waveform-title">{musicName || "Music waveform"}</span>
                <button
                  type="button"
                  className="control-button button-ghost waveform-toggle"
                  onClick={() => setShowMusicWave((v) => !v)}
                >
                  {showMusicWave ? "Hide waveform" : "Show waveform"}
                </button>
              </div>
              {showMusicWave && (
                <div className="waveform-plot">
                  <WaveformPlot buffer={musicBuffer} color="#5ac8fa" title={musicName || "Music"} />
                </div>
              )}
            </div>
          )}
        </div>
        <div className="file-card-stack">
          <label className="file-card">
            <div className="file-card__icon" aria-hidden="true">
              IR
            </div>
            <div className="file-card__copy">
              <span className="file-card__title">Impulse response WAV</span>
              <span className="file-card__subtitle">Choose the acoustic fingerprint to apply.</span>
            </div>
            <span className="file-card__action">Choose file</span>
            <input className="file-card__input" type="file" accept=".wav,audio/wav" onChange={onPickIR} />
          </label>
          {irBuffer && (
            <div className="waveform-section">
              <div className="waveform-header">
                <span className="waveform-title">{irName || "Impulse response"}</span>
                <button
                  type="button"
                  className="control-button button-ghost waveform-toggle"
                  onClick={() => setShowIrWave((v) => !v)}
                >
                  {showIrWave ? "Hide waveform" : "Show waveform"}
                </button>
              </div>
              {showIrWave && (
                <div className="waveform-plot">
                  <WaveformPlot buffer={irBuffer} color="#ff9f0a" title={irName || "Impulse response"} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
