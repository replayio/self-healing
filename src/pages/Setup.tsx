import { useState } from "react";
import { Link } from "../lib/router";

const svgBase = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

export function SetupPage() {
  const prompt = `Read the API at ${window.location.origin}/api/v1 and follow its setup skill to set up Self Healing for this project.`;
  const [copyStatus, setCopyStatus] = useState("");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus("Copied. Paste it into your Obvious factory agent.");
    } catch {
      setCopyStatus("Select the prompt above and copy it manually.");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <p className="eyebrow eyebrow--label">GET STARTED</p>
        <h1 className="page-title">Set up Self Healing in Obvious</h1>
        <p className="page-subtitle">
          Paste one prompt into your Obvious factory agent. It sets up the
          self-healing loop in your software factory.
        </p>
      </div>

      <div className="setup-prompt">
        <div className="prompt-heading">
          <span className="prompt-label">OBVIOUS AGENT PROMPT</span>
          <button
            className="copy-btn"
            type="button"
            onClick={copyPrompt}
            aria-label="Copy prompt"
            title="Copy prompt"
          >
            {copyStatus.startsWith("Copied") ? (
              <svg {...svgBase}>
                <path d="m5 12 4 4L19 6" />
              </svg>
            ) : (
              <svg {...svgBase}>
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
              </svg>
            )}
          </button>
        </div>
        <pre className="prompt-code">
          <code>{prompt}</code>
        </pre>
        {copyStatus && (
          <p className="copy-status" role="status">
            {copyStatus}
          </p>
        )}
      </div>

      <section className="page-section">
        <h2>How it works</h2>
        <ol className="setup-list">
          <li>
            <h3>Give Obvious the prompt</h3>
            <p>
              Obvious's factory agent reads the API and setup skill, inspects
              your project, and asks for anything it needs.
            </p>
          </li>
          <li>
            <h3>Connect your account</h3>
            <p>
              Provide a Subtext key through Obvious's secure input. The factory
              agent provisions an account and stores the returned API key in
              Obvious's secret store.
            </p>
          </li>
          <li>
            <h3>Verify a real session</h3>
            <p>
              The factory agent connects the project, installs session capture
              and event forwarding, then confirms real sessions are flowing.
            </p>
          </li>
        </ol>
      </section>

      <section className="page-section">
        <h2>Resources</h2>
        <div className="skill-links">
          <Link to="/skills/setup-self-healing">
            Setup skill <span>The walkthrough Obvious follows to set up the loop</span>
          </Link>
          <Link to="/skills/operate-self-healing">
            Operation skill <span>Session reviews and daily reports</span>
          </Link>
          <Link to="/skills">
            All skills <span>Browse the complete skill catalog</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
