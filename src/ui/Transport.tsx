type Props = {
  isPlaying: boolean;
  playPause: () => void;
  stopAll: () => void;
  originalVol: number;
  onChangeOriginalVol: (v: number) => void;
  convolvedVol: number;
  onChangeConvolvedVol: (v: number) => void;
};

export default function Transport({
  isPlaying,
  playPause,
  stopAll,
  originalVol,
  onChangeOriginalVol,
  convolvedVol,
  onChangeConvolvedVol,
}: Props) {
  return (
    <section className="panel transport-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Transport</h2>
          <p className="panel-desc">Preview your mix, pause to tweak, and reset in a click.</p>
        </div>
      </div>
      <div className="transport-controls">
        <button type="button" className="control-button button-primary" onClick={playPause}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button type="button" className="control-button button-ghost" onClick={stopAll}>
          Stop
        </button>
      </div>
      <div className="volume-group">
        <label className="volume-control">
          <span className="volume-label">Original Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={originalVol}
              onChange={(e) => onChangeOriginalVol(parseFloat(e.target.value))}
            />
            <span className="volume-value">{originalVol.toFixed(2)}×</span>
          </div>
        </label>
        <label className="volume-control">
          <span className="volume-label">Convolved Volume</span>
          <div className="volume-slider">
            <input
              className="volume-slider__input"
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={convolvedVol}
              onChange={(e) => onChangeConvolvedVol(parseFloat(e.target.value))}
            />
            <span className="volume-value">{convolvedVol.toFixed(2)}×</span>
          </div>
        </label>
      </div>
    </section>
  );
}
