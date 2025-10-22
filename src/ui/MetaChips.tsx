import type { AriaAttributes } from "react";

export type MetaChip = {
  label: string;
  tone?: "warning" | "info";
};

type Props = {
  chips: MetaChip[];
} & Pick<AriaAttributes, "aria-label">;

export default function MetaChips({ chips, "aria-label": ariaLabel }: Props) {
  if (!chips.length) return null;

  return (
    <div className="meta-chip-row" role="list" aria-label={ariaLabel}>
      {chips.map((chip, index) => (
        <span
          key={`${chip.label}-${index}`}
          className={`meta-chip${chip.tone ? ` meta-chip--${chip.tone}` : ""}`}
          role="listitem"
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

