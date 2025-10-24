import type { CompareMode, RatingStyle, SessionRound, SessionSummary, VariantId } from "./session";
import { getVariantLabel, getVariantsForMode } from "./session";

type Props = {
  summary: SessionSummary;
  rounds: SessionRound[];
  mode: CompareMode;
  ratingStyle: RatingStyle;
  canRetestAB: boolean;
  onRetestAB: () => void;
  onRestart: () => void;
  onExport: () => void;
};

type VariantMetric = {
  id: VariantId;
  label: string;
  wins?: number;
  losses?: number;
  winRate?: number;
  meanScore?: number;
};

export default function ResultsPanel({
  summary,
  rounds,
  mode,
  ratingStyle,
  canRetestAB,
  onRetestAB,
  onRestart,
  onExport,
}: Props) {
  const variants = getVariantsForMode(mode);
  const variantMetrics = computeMetrics(summary, rounds.length, variants, ratingStyle);
  const preferredLabel = summary.preferred ? getVariantLabel(summary.preferred) : "n/a";
  const leastPreferredLabel = summary.leastPreferred ? getVariantLabel(summary.leastPreferred) : "n/a";

  return (
    <div className="blind-results">
      <header className="blind-results__header">
        <h3 className="blind-results__title">Test Results</h3>
        <p className="blind-results__subtitle">
          Preferred Variant: <strong>{preferredLabel}</strong> • Least Preferred: <strong>{leastPreferredLabel}</strong>
        </p>
      </header>

      <section className="blind-results__section">
        <table className="blind-results__table">
          <thead>
            <tr>
              <th scope="col">Variant</th>
              {ratingStyle === "pairwise" ? (
                <>
                  <th scope="col">Wins</th>
                  <th scope="col">Losses</th>
                  <th scope="col">Win rate</th>
                </>
              ) : (
                <th scope="col">Mean score</th>
              )}
            </tr>
          </thead>
          <tbody>
            {variantMetrics.map((metric) => (
              <tr key={metric.id}>
                <th scope="row">{metric.label}</th>
                {ratingStyle === "pairwise" ? (
                  <>
                    <td>{metric.wins ?? 0}</td>
                    <td>{metric.losses ?? 0}</td>
                    <td>{metric.winRate != null ? `${(metric.winRate * 100).toFixed(1)}%` : "—"}</td>
                  </>
                ) : (
                  <td>{metric.meanScore != null ? metric.meanScore.toFixed(2) : "—"}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="blind-results__actions">
        <button type="button" className="control-button button-ghost" onClick={onRetestAB} disabled={!canRetestAB}>
          Retest A vs B
        </button>
        <button type="button" className="control-button button-ghost" onClick={onRestart}>
          Test Another Track
        </button>
        <button type="button" className="control-button" onClick={onExport}>
          Export CSV
        </button>
      </footer>
    </div>
  );
}

function computeMetrics(
  summary: SessionSummary,
  roundCount: number,
  variants: VariantId[],
  ratingStyle: RatingStyle,
): VariantMetric[] {
  return variants.map((id) => {
    const label = getVariantLabel(id);
    if (ratingStyle === "pairwise") {
      const wins = summary.winsByVariant[id] ?? 0;
      const losses = summary.lossesByVariant[id] ?? 0;
      const total = wins + losses;
      const winRate = total > 0 ? wins / total : roundCount > 0 ? wins / roundCount : 0;
      return { id, label, wins, losses, winRate };
    }
    const meanScore = summary.meansByVariant[id] ?? null;
    return { id, label, meanScore: meanScore ?? undefined };
  });
}
