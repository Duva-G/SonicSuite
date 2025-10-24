import { useId, useMemo, useState, type FormEvent } from "react";
import type { CompareMode, RandomizationMode, RatingStyle } from "./session";

type ModeOption = {
  value: CompareMode;
  label: string;
  disabled: boolean;
};

export type StartFormValues = {
  mode: CompareMode;
  rounds: number;
  snippetLength: number;
  randomization: RandomizationMode;
  seed: string;
  lufsMatch: boolean;
  crossfadeMs: number;
  anonymize: boolean;
  ratingStyle: RatingStyle;
  enableConfidence: boolean;
  fixedStartSeconds: number;
};

type Props = {
  modeAvailability: Partial<Record<CompareMode, boolean>>;
  defaults: StartFormValues;
  onSubmit: (values: StartFormValues) => void;
  onCancel: () => void;
  musicName?: string | null;
  irAName?: string | null;
  irBName?: string | null;
};

const MODE_LABEL: Record<CompareMode, string> = {
  OA: "O vs A",
  OB: "O vs B",
  AB: "A vs B",
  OAB: "O vs A vs B",
};

const RANDOMIZATION_LABEL: Record<RandomizationMode, string> = {
  stratified: "Stratified",
  random: "Pure random",
  fixed: "Fixed loop",
};

const CROSSFADE_OPTIONS = [0, 50, 75, 100];

export default function StartBlindTest({
  modeAvailability,
  defaults,
  onSubmit,
  onCancel,
  musicName,
  irAName,
  irBName,
}: Props) {
  const [form, setForm] = useState<StartFormValues>(defaults);
  const seedFieldId = useId();
  const fixedStartId = useId();
  const roundsId = useId();
  const snippetId = useId();

  const modeOptions = useMemo<ModeOption[]>(() => {
    const entries: ModeOption[] = (Object.keys(MODE_LABEL) as CompareMode[]).map((mode) => ({
      value: mode,
      label: MODE_LABEL[mode],
      disabled: modeAvailability[mode] === false,
    }));
    return entries;
  }, [modeAvailability]);

  const canStart = useMemo(() => {
    const availability = modeAvailability[form.mode] !== false;
    return availability;
  }, [form.mode, modeAvailability]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canStart) return;
    const sanitized: StartFormValues = {
      ...form,
      seed: form.seed.trim(),
      rounds: clampNumber(form.rounds, 1, 30),
      snippetLength: clampNumber(form.snippetLength, 5, 15),
      crossfadeMs: CROSSFADE_OPTIONS.includes(form.crossfadeMs) ? form.crossfadeMs : defaults.crossfadeMs,
      randomization: form.randomization,
      fixedStartSeconds: Number.isFinite(form.fixedStartSeconds) ? Math.max(0, form.fixedStartSeconds) : 0,
    };
    if (sanitized.mode !== "OAB") {
      sanitized.ratingStyle = "pairwise";
    }
    onSubmit(sanitized);
  };

  const showRatingStyle = form.mode === "OAB";
  const showFixedStart = form.randomization === "fixed";

  const handleChange = <K extends keyof StartFormValues>(key: K, value: StartFormValues[K]) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  return (
    <form className="blind-start" onSubmit={handleSubmit}>
      <div className="blind-start__grid">
        <section className="blind-start__surface">
          <div className="blind-fieldset">
            <p className="blind-fieldset__title">Select variants</p>
            <div className="blind-pill-group" role="radiogroup" aria-label="Select variants">
              {modeOptions.map((option) => (
                <label key={option.value} className={`blind-pill${option.disabled ? " is-disabled" : ""}`}>
                  <input
                    type="radio"
                    name="blind-mode"
                    value={option.value}
                    checked={form.mode === option.value}
                    onChange={() => handleChange("mode", option.value)}
                    disabled={option.disabled}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="blind-input-row">
            <label className="blind-input" htmlFor={roundsId}>
              <span className="blind-input__label">Rounds (1-30)</span>
              <input
                id={roundsId}
                type="number"
                min={1}
                max={30}
                value={form.rounds}
                onChange={(event) => handleChange("rounds", parseInt(event.target.value, 10) || defaults.rounds)}
                className="blind-input__control"
              />
            </label>

            <label className="blind-input" htmlFor={snippetId}>
              <span className="blind-input__label">Snippet length (s)</span>
              <input
                id={snippetId}
                type="number"
                min={5}
                max={15}
                value={form.snippetLength}
                onChange={(event) =>
                  handleChange("snippetLength", parseInt(event.target.value, 10) || defaults.snippetLength)
                }
                className="blind-input__control"
              />
            </label>

            <label className="blind-input" htmlFor={seedFieldId}>
              <span className="blind-input__label">Seed (optional)</span>
              <input
                id={seedFieldId}
                type="text"
                placeholder="Random if empty"
                value={form.seed}
                onChange={(event) => handleChange("seed", event.target.value)}
                className="blind-input__control"
              />
            </label>
          </div>
        </section>

        <section className="blind-start__surface">
          <div className="blind-fieldset">
            <p className="blind-fieldset__title">Randomization</p>
            <div className="blind-pill-group" role="radiogroup" aria-label="Randomization mode">
              {(Object.keys(RANDOMIZATION_LABEL) as RandomizationMode[]).map((value) => (
                <label key={value} className="blind-pill">
                  <input
                    type="radio"
                    name="randomization"
                    value={value}
                    checked={form.randomization === value}
                    onChange={() => handleChange("randomization", value)}
                  />
                  <span>{RANDOMIZATION_LABEL[value]}</span>
                </label>
              ))}
            </div>
          </div>
          {showFixedStart && (
            <div className="blind-input-row blind-input-row--narrow">
              <label className="blind-input blind-input--compact" htmlFor={fixedStartId}>
                <span className="blind-input__label">Fixed start (s)</span>
                <input
                  id={fixedStartId}
                  type="number"
                  min={0}
                  value={form.fixedStartSeconds}
                  onChange={(event) => handleChange("fixedStartSeconds", parseFloat(event.target.value) || 0)}
                  className="blind-input__control"
                />
              </label>
            </div>
          )}
          <div className="blind-switch-row">
            <label className="blind-switch">
              <input
                type="checkbox"
                checked={form.lufsMatch}
                onChange={(event) => handleChange("lufsMatch", event.target.checked)}
              />
              <span>LUFS match variants</span>
            </label>
            <label className="blind-switch">
              <input
                type="checkbox"
                checked={form.anonymize}
                onChange={(event) => handleChange("anonymize", event.target.checked)}
              />
              <span>Anonymize variant labels</span>
            </label>
            <label className="blind-switch">
              <input
                type="checkbox"
                checked={form.enableConfidence}
                onChange={(event) => handleChange("enableConfidence", event.target.checked)}
              />
              <span>Capture confidence (pairwise)</span>
            </label>
          </div>
        </section>

        <section className="blind-start__surface">
          <div className="blind-fieldset">
            <p className="blind-fieldset__title">Playback</p>
            <div className="blind-pill-group" role="radiogroup" aria-label="Crossfade duration">
              {CROSSFADE_OPTIONS.map((value) => (
                <label key={value} className="blind-pill">
                  <input
                    type="radio"
                    name="crossfade"
                    value={value}
                    checked={form.crossfadeMs === value}
                    onChange={() => handleChange("crossfadeMs", value)}
                  />
                  <span>{value} ms crossfade</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {showRatingStyle ? (
          <section className="blind-start__surface">
            <div className="blind-fieldset">
              <p className="blind-fieldset__title">Rating style</p>
              <div className="blind-pill-group" role="radiogroup" aria-label="Rating style">
                <label className="blind-pill">
                  <input
                    type="radio"
                    name="ratingStyle"
                    value="rank"
                    checked={form.ratingStyle === "rank"}
                    onChange={() => handleChange("ratingStyle", "rank")}
                  />
                  <span>Rank 1-3 (no ties)</span>
                </label>
                <label className="blind-pill">
                  <input
                    type="radio"
                    name="ratingStyle"
                    value="score"
                    checked={form.ratingStyle === "score"}
                    onChange={() => handleChange("ratingStyle", "score")}
                  />
                  <span>Score 1-5</span>
                </label>
              </div>
            </div>
          </section>
        ) : null}

        <section className="blind-start__surface blind-start__surface--summary blind-start__surface--span">
          <div className="blind-fieldset">
            <p className="blind-fieldset__title">Selection</p>
            <dl className="blind-start__names">
              <div>
                <dt>Music WAV</dt>
                <dd>{musicName || "Not loaded"}</dd>
              </div>
              <div>
                <dt>IR A</dt>
                <dd>{irAName || "Not loaded"}</dd>
              </div>
              <div>
                <dt>IR B</dt>
                <dd>{irBName || "Not loaded"}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      <footer className="blind-start__footer">
        <button type="button" className="control-button button-ghost blind-start__button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="control-button blind-start__button blind-start__button--primary" disabled={!canStart}>
          Start Test
        </button>
      </footer>
    </form>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

