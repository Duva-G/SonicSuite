type Props = {
  bandRangeLabel?: string | null;
  onOpenRoundTests?: () => void;
  availableModes?: {
    ABX: boolean;
    ACX: boolean;
    BCX: boolean;
    ABCX: boolean;
  };
  [legacyProp: string]: unknown;
};

export default function BlindTestPanel({ bandRangeLabel, onOpenRoundTests, availableModes }: Props) {
  const hasIrA = availableModes?.ABX ?? false;
  const hasIrB = availableModes?.ACX ?? false;
  const hasBoth = availableModes?.ABCX ?? false;
  const canLaunch = Boolean(onOpenRoundTests);
  const statusItems = [
    { label: "Load IR A", ready: hasIrA },
    { label: "Load IR B", ready: hasIrB },
    { label: hasBoth ? "Tri-stimulus enabled" : "Tri-stimulus locked until both IRs load", ready: hasBoth },
  ];

  return (
    <section className="panel blind-panel">
      <div className="blind-panel__surface">
        <div className="blind-panel__section">
          <div className="blind-panel__section-header">
            <h3>Round Tests</h3>
            <p>Configure O/A/B comparisons with seeded randomization, loudness-matched snippets, and per-round scoring.</p>
          </div>

          <div className="blind-panel__meta-row">
            {bandRangeLabel ? (
              <span className="blind-panel__chip" aria-live="polite">
                Current playback band: <strong>{bandRangeLabel}</strong>
              </span>
            ) : null}
            <span className="blind-panel__chip blind-panel__chip--status">
              {statusItems.filter((item) => item.ready).length}/{statusItems.length} ready
            </span>
          </div>

          <ul className="blind-panel__status-list" aria-label="Preparation status">
            {statusItems.map((item) => (
              <li key={item.label} className={`blind-panel__status-item${item.ready ? " is-ready" : ""}`}>
                <span className="blind-panel__bullet" />
                {item.label}
              </li>
            ))}
          </ul>
        </div>

        <div className="blind-panel__actions">
          <button
            type="button"
            className="control-button blind-panel__button"
            onClick={onOpenRoundTests}
            disabled={!canLaunch}
          >
            Open Round Tests
          </button>
        </div>
      </div>
    </section>
  );
}
