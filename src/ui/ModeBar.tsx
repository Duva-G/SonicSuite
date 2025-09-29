export type Mode = "original" | "convolved" | "difference";

type Props = {
  mode: Mode;
  onChangeMode: (m: Mode) => void;
};

export default function ModeBar({ mode, onChangeMode }: Props) {
  const cls = (m: Mode) => `segmented-control__segment${mode === m ? " is-active" : ""}`;

  return (
    <div className="segmented-control" role="group" aria-label="Playback mode selector">
      <button type="button" className={cls("original")} onClick={() => onChangeMode("original")}>
        Original
      </button>
      <button type="button" className={cls("convolved")} onClick={() => onChangeMode("convolved")}>
        Convolved
      </button>
      <button type="button" className={cls("difference")} onClick={() => onChangeMode("difference")}>
        Difference
      </button>
    </div>
  );
}