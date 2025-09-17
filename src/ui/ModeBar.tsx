export type Mode = "original" | "convolved";

type Props = {
  mode: Mode;
  onChangeMode: (m: Mode) => void;
};

export default function ModeBar({ mode, onChangeMode }: Props) {
  const originalClass = `segmented-control__segment${mode === "original" ? " is-active" : ""}`;
  const convolvedClass = `segmented-control__segment${mode === "convolved" ? " is-active" : ""}`;

  return (
    <div className="segmented-control" role="group" aria-label="Playback mode selector">
      <button type="button" className={originalClass} onClick={() => onChangeMode("original")}>
        Original
      </button>
      <button type="button" className={convolvedClass} onClick={() => onChangeMode("convolved")}>
        Convolved
      </button>
    </div>
  );
}