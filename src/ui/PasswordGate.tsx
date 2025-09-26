import { useState, type FormEvent } from "react";

type Props = {
  expectedPassword: string;
  onUnlock: () => void;
};

export default function PasswordGate({ expectedPassword, onUnlock }: Props) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (input.trim() === expectedPassword) {
      setError("");
      setInput("");
      onUnlock();
    } else {
      setError("Incorrect password. Please try again.");
      setInput("");
    }
  }

  return (
    <div className="password-gate">
      <div
        className="password-gate__content"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-gate-headline"
      >
        <div className="password-gate__icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" className="password-gate__lock">
            <path
              d="M22 26v-5.5a10 10 0 0 1 20 0V26"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
            />
            <rect
              x="16"
              y="26"
              width="32"
              height="26"
              rx="9"
              fill="currentColor"
              opacity="0.16"
            />
            <path
              d="M24 26h16a8 8 0 0 1 8 8v10a8 8 0 0 1-8 8H24a8 8 0 0 1-8-8V34a8 8 0 0 1 8-8Z"
              fill="currentColor"
            />
            <circle cx="32" cy="39" r="4" fill="#0a84ff" />
          </svg>
        </div>
        <h1 id="password-gate-headline" className="password-gate__headline">
          This content is protected.
        </h1>
        <p className="password-gate__subtitle">Enter the access password to continue.</p>
        <form className="password-gate__form" onSubmit={handleSubmit}>
          <label htmlFor="password-input" className="password-gate__sr-only">
            Password
          </label>
          <input
            id="password-input"
            className="password-gate__input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Enter password"
            required
          />
          <button type="submit" className="password-gate__submit" aria-label="Unlock">
            <span className="password-gate__submit-label">Unlock</span>
            <svg viewBox="0 0 24 24" className="password-gate__submit-icon" aria-hidden="true">
              <path
                d="M6 12h12m0 0-5-5m5 5-5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
        {error ? <p className="password-gate__error">{error}</p> : null}
        <p className="password-gate__note">Need access? Contact your SonicSuite admin.</p>
      </div>
    </div>
  );
}
