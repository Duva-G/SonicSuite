export type Mode = "original" | "convolved";

type Props = {
  mode: Mode;
  onChangeMode: (m: Mode) => void;
};

export default function ModeBar({ mode, onChangeMode }: Props) {
  return (
    <section style={{ marginBottom: 12 }}>
      <button
        onClick={() => onChangeMode("original")}
        style={{ marginRight: 4, fontWeight: mode === "original" ? 700 : 400 }}
      >
        Original
      </button>
      <button
        onClick={() => onChangeMode("convolved")}
        style={{ fontWeight: mode === "convolved" ? 700 : 400 }}
      >
        Convolved
      </button>
    </section>
  );
}
