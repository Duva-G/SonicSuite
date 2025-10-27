export type Mode = "original" | "convolvedA" | "convolvedB" | "difference";

type Props = {
  mode: Mode;
  onChangeMode: (m: Mode) => void;
  disabledModes?: Partial<Record<Mode, boolean>>;
  tooltips?: Partial<Record<Mode, string>>;
};

const LABELS: Record<Mode, string> = {
  original: "Original",
  convolvedA: "Convolved A",
  convolvedB: "Convolved B",
  difference: "Difference",
};

export default function ModeBar({ mode, onChangeMode, disabledModes, tooltips }: Props) {
  return (
    <div className="segmented-control mode-bar__segments" role="group" aria-label="Playback mode selector">
      {(Object.keys(LABELS) as Mode[]).map((key) => {
        const isActive = mode === key;
        const isDisabled = Boolean(disabledModes?.[key]);
        const className = `segmented-control__segment${isActive ? " is-active" : ""}`;
        return (
          <button
            key={key}
            type="button"
            className={className}
            onClick={() => onChangeMode(key)}
            aria-pressed={isActive}
            disabled={isDisabled}
            title={tooltips?.[key]}
          >
            {LABELS[key]}
          </button>
        );
      })}
    </div>
  );
}
