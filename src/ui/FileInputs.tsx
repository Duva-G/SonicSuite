type Props = {
  onPickMusic: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPickIR: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

export default function FileInputs({ onPickMusic, onPickIR }: Props) {
  return (
    <section className="panel file-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Source files</h2>
          <p className="panel-desc">Load a dry mix and an impulse response to start sculpting.</p>
        </div>
      </div>
      <div className="file-card-grid">
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
      </div>
    </section>
  );
}