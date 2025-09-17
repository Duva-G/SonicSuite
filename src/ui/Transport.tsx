type Props = {
  isPlaying: boolean;
  playPause: () => void;
  stopAll: () => void;
  vol: number;
  onChangeVol: (v: number) => void;
};

export default function Transport({
  isPlaying,
  playPause,
  stopAll,
  vol,
  onChangeVol,
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
      <label className="volume-control">
        <span className="volume-label">Volume</span>
        <div className="volume-slider">
          <input
            className="volume-slider__input"
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={vol}
            onChange={(e) => onChangeVol(parseFloat(e.target.value))}
          />
          <span className="volume-value">{vol.toFixed(2)}×</span>
        </div>
      </label>
    </section>
  );
}