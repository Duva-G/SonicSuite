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

const MODE_LABEL: Record<CompareMode, string> = {
  OA: "O vs A",
  OB: "O vs B",
  AB: "A vs B",
  OAB: "Original vs A vs B",
};

const RATING_STYLE_LABEL: Record<RatingStyle, string> = {
  pairwise: "Pairwise",
  rank: "Ranking",
  score: "Score",
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
  const ratedRounds = rounds.filter((round) => round.rating != null);
  const completedRounds = ratedRounds.length;
  const totalRounds = rounds.length;
  const completionRate = totalRounds > 0 ? Math.round((completedRounds / totalRounds) * 100) : 0;
  const variantAppearances = computeVariantAppearances(rounds);

  return (
    <div className="blind-panel blind-results">
      <div className="blind-panel__surface">
        <header className="blind-results__header">
          <span className="blind-results__eyebrow">Round test complete</span>
          <h3 className="blind-results__title">Test Results</h3>
          <p className="blind-results__subtitle">
            Preferred variant <strong>{preferredLabel}</strong> | Least preferred <strong>{leastPreferredLabel}</strong>
          </p>
          <div className="blind-results__pill-row" aria-hidden={totalRounds === 0}>
            <span className="blind-results__pill">
              {completedRounds} of {totalRounds} rounds submitted
              {totalRounds > 0 ? ` (${completionRate}% complete)` : ""}
            </span>
            <span className="blind-results__pill">Mode: {MODE_LABEL[mode] ?? mode}</span>
            <span className="blind-results__pill">Rating: {RATING_STYLE_LABEL[ratingStyle] ?? ratingStyle}</span>
          </div>
        </header>

        <section className="blind-results__metrics" aria-label="Variant performance">
          {variantMetrics.map((metric) => {
            const isPreferred = summary.preferred === metric.id;
            const isLeast = summary.leastPreferred === metric.id;
            const appearances = variantAppearances[metric.id] ?? 0;
            const primaryLabel = ratingStyle === "pairwise" ? "Win rate" : "Mean score";
            const primaryValue =
              ratingStyle === "pairwise"
                ? formatWinRate(metric.winRate)
                : formatMeanScore(metric.meanScore);
            const detailMetrics =
              ratingStyle === "pairwise"
                ? [
                    { label: "Wins", value: metric.wins ?? 0 },
                    { label: "Losses", value: metric.losses ?? 0 },
                    { label: "Rounds heard", value: appearances },
                  ]
                : [{ label: "Rounds scored", value: appearances }];
            return (
              <article
                key={metric.id}
                className={`blind-results__metric-card${isPreferred ? " is-preferred" : ""}${isLeast ? " is-least" : ""}`}
              >
                <header className="blind-results__metric-header">
                  <span className="blind-results__metric-label">{metric.label}</span>
                  {isPreferred ? <span className="blind-results__metric-tag">Preferred</span> : null}
                  {!isPreferred && isLeast ? (
                    <span className="blind-results__metric-tag is-muted">Least preferred</span>
                  ) : null}
                </header>
                <div className="blind-results__metric-value">
                  <span>{primaryValue}</span>
                  <small>{primaryLabel}</small>
                </div>
                <dl className="blind-results__metric-details">
                  {detailMetrics.map((entry) => (
                    <div key={`${metric.id}-${entry.label}`} className="blind-results__metric-detail">
                      <dt>{entry.label}</dt>
                      <dd>{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              </article>
            );
          })}
        </section>

        <section className="blind-results__rounds" aria-label="Round breakdown">
          <div className="blind-results__section-header">
            <h4>Round breakdown</h4>
            <span>{completedRounds > 0 ? `Showing ${completedRounds} recorded rounds` : "No rounds recorded"}</span>
          </div>
          {completedRounds > 0 ? (
            <ul className="blind-results__round-list">
              {ratedRounds.map((round) => {
                const outcome = describeRoundOutcome(round);
                return (
                  <li key={round.index} className="blind-results__round">
                    <div className="blind-results__round-head">
                      <span className="blind-results__round-index">Round {round.index + 1}</span>
                      <span className="blind-results__round-time">
                        {formatSeconds(round.startSeconds)} - {formatSeconds(round.endSeconds)}
                      </span>
                    </div>
                    <div className="blind-results__round-outcome">{outcome.summary}</div>
                    {outcome.detail ? <div className="blind-results__round-detail">{outcome.detail}</div> : null}
                    <div className="blind-results__round-order">
                      Order: {round.variantOrder.map((variant) => getVariantLabel(variant)).join(" > ")}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="blind-results__empty">
              <p>No rounds were submitted in this session.</p>
            </div>
          )}
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

function computeVariantAppearances(rounds: SessionRound[]): Partial<Record<VariantId, number>> {
  const counts: Partial<Record<VariantId, number>> = {};
  rounds.forEach((round) => {
    round.variantOrder.forEach((variant) => {
      counts[variant] = (counts[variant] ?? 0) + 1;
    });
  });
  return counts;
}

function describeRoundOutcome(round: SessionRound): { summary: string; detail?: string } {
  const rating = round.rating;
  if (!rating) {
    return { summary: "No rating submitted" };
  }
  if (rating.type === "pairwise") {
    const choiceLabel = getVariantLabel(rating.choice);
    const confidenceLabel = rating.confidence ? `Confidence: ${capitalize(rating.confidence)}` : null;
    return {
      summary: `Chose ${choiceLabel}`,
      detail: confidenceLabel ?? undefined,
    };
  }
  if (rating.type === "rank") {
    const entries = Object.entries(rating.ranking).sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
    const summaryLabel =
      entries.length > 0 ? `Top choice: ${getVariantLabel(entries[0][0] as VariantId)}` : "Ranking recorded";
    const detail = entries
      .map(([variant, rank]) => `${formatRank(rank)} ${getVariantLabel(variant as VariantId)}`)
      .join(" | ");
    return { summary: summaryLabel, detail: detail || undefined };
  }
  if (rating.type === "score") {
    const entries = Object.entries(rating.scores).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const topEntry = entries[0];
    const summaryLabel =
      topEntry != null
        ? `Highest score: ${getVariantLabel(topEntry[0] as VariantId)} (${topEntry[1].toFixed(1)})`
        : "Scores recorded";
    const detail = entries
      .map(([variant, score]) => `${getVariantLabel(variant as VariantId)} ${score.toFixed(1)}`)
      .join(" | ");
    return { summary: summaryLabel, detail: detail || undefined };
  }
  return { summary: "No rating submitted" };
}

function formatWinRate(winRate?: number) {
  if (winRate == null || !Number.isFinite(winRate)) {
    return "--";
  }
  return `${(winRate * 100).toFixed(1)}%`;
}

function formatMeanScore(mean?: number) {
  if (mean == null || !Number.isFinite(mean)) {
    return "--";
  }
  return mean.toFixed(2);
}

function formatSeconds(value: number) {
  if (!Number.isFinite(value)) {
    return "0:00";
  }
  const clamped = Math.max(0, value);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function capitalize(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatRank(rank: number) {
  const suffix = rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th";
  return `${rank}${suffix}`;
}
