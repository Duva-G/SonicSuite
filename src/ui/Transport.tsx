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
    <section style={{ marginBottom: 12 }}>
      <button onClick={playPause}>{isPlaying ? "Pause" : "Play"}</button>
      <button onClick={stopAll} style={{ marginLeft: 8 }}>
        Stop
      </button>
      <label style={{ marginLeft: 16 }}>
        Volume:
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={vol}
          onChange={(e) => onChangeVol(parseFloat(e.target.value))}
        />
        <span> {vol.toFixed(2)}×</span>
      </label>
    </section>
  );
}