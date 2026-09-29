import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const apiGroups = [
  [
    "Project configuration",
    "Projects, provider links, context, sightmaps, environments, and report preferences.",
    "Key-scoped configuration",
  ],
  [
    "User understanding",
    "Session analysis, evidence-backed bugs, behavior trends, and periodic reports.",
    "Contract defined",
  ],
  [
    "Verified fixes",
    "Worker claims, fix PRs, commit-specific verification, and release or PR QA.",
    "Contract defined",
  ],
  [
    "Factory coordination",
    "Resumable event polling and asynchronous job status.",
    "Contract defined",
  ],
];
function App() {
  const prompt = `Read the API at ${window.location.origin}/api/v1 and follow its setup skill to set up Self Healing for this project.`;
  const [copyStatus, setCopyStatus] = useState("");
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyStatus("Copied. Paste it into Obvious or your coding agent.");
    } catch {
      setCopyStatus("Select the prompt above and copy it manually.");
    }
  }
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header>
        <a className="brand" href="/" aria-label="Self Healing home">
          <img className="brand-icon" src="/images/replay-logo.svg" alt="" />
          Self Healing
        </a>
        <span className="badge">Developer preview</span>
        <nav aria-label="Main navigation">
          <a href="#setup">
            <span aria-hidden="true">＋</span> Setup
          </a>
          <a href="#api">
            <span aria-hidden="true">⌘</span> API reference
          </a>
          <a href="https://github.com/replayio/self-healing">
            <span aria-hidden="true">↗</span> GitHub
          </a>
        </nav>
        <a className="qa-link" href="https://qa.replay.io">
          Open Replay QA <span aria-hidden="true">↗</span>
        </a>
      </header>
      <main id="main-content" tabIndex={-1}>
        <section className="hero">
          <p className="eyebrow">
            FULLSTORY + REPLAY QA + YOUR SOFTWARE FACTORY
          </p>
          <h1>
            Real user problems.
            <br />
            <span>Verified fixes.</span>
          </h1>
          <p className="intro">
            Connect what users experience to what your software factory builds.
            Self Healing coordinates session insights, QA, and fix verification
            through one API.
          </p>
          <div className="actions">
            <a className="button" href="#setup">
              Set up your factory <span>→</span>
            </a>
            <a className="secondary" href="/api/v1/openapi.json">
              Explore the API ↗
            </a>
          </div>
          <div className="setup-prompt">
            <label htmlFor="setup-prompt">
              Paste this into Obvious or your coding agent
            </label>
            <textarea
              id="setup-prompt"
              readOnly
              value={prompt}
              onFocus={(event) => event.currentTarget.select()}
              rows={3}
              spellCheck={false}
            />
            <div className="prompt-actions">
              <button className="button" type="button" onClick={copyPrompt}>
                Copy setup prompt
              </button>
              <a
                className="text-link"
                href="/api/v1/skills/setup-self-healing/SKILL.md"
              >
                Preview the setup skill ↗
              </a>
            </div>
            <p className="copy-status" role="status">
              {copyStatus}
            </p>
          </div>
          <p className="preview-note">
            Provision an account, connect its QA project, send captured
            sessions, and retrieve reviews and daily behavior reports.
          </p>
        </section>
        <section className="flow" aria-label="How self healing works">
          <article>
            <span className="step">01 / UNDERSTAND</span>
            <h2>See where users struggle</h2>
            <p>
              Fullstory sessions surface friction, performance problems, and
              broken experiences.
            </p>
          </article>
          <article>
            <span className="step">02 / FIX</span>
            <h2>Give your factory the evidence</h2>
            <p>
              Replay QA supplies reproduction and root-cause evidence. Your
              coding agent writes the PR.
            </p>
          </article>
          <article>
            <span className="step">03 / VERIFY</span>
            <h2>Close the loop with QA</h2>
            <p>
              Validate the exact fix commit, review the PR, and follow behavior
              trends over time.
            </p>
          </article>
        </section>
        <section id="setup" className="setup section">
          <div>
            <p className="eyebrow">GET CONNECTED</p>
            <h2>
              One integration.
              <br />A continuous feedback loop.
            </h2>
            <p className="section-copy">
              Bring a software factory like Obvious, or use a coding agent for a
              more manual workflow. Choose the capabilities your team needs.
            </p>
            <a
              className="text-link"
              href="/api/v1/skills/setup-self-healing/SKILL.md"
            >
              Read the setup skill ↗
            </a>
          </div>
          <ol className="setup-list">
            <li>
              <h3>Give your agent the prompt</h3>
              <p>
                Your agent reads the API and setup skill, inspects this project,
                and asks for any missing setup information.
              </p>
            </li>
            <li>
              <h3>Connect your account</h3>
              <p>
                Supply a Subtext key through your agent’s secure secret input.
                The agent provisions a Self Healing account and stores its
                returned API key on your server.
              </p>
            </li>
            <li>
              <h3>Verify a real session</h3>
              <p>
                The agent connects the project, installs session capture and
                auxiliary-event forwarding, then checks a completed session’s QA
                review. Daily reports follow through the same API.
              </p>
            </li>
          </ol>
        </section>
        <section id="api" className="section api-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">BUILT FOR AGENTS</p>
              <h2>A single REST interface.</h2>
            </div>
            <a className="text-link" href="/api/v1/openapi.json">
              OpenAPI specification ↗
            </a>
          </div>
          <div className="api-grid">
            {apiGroups.map(([name, description, status]) => (
              <article key={name}>
                <span className="status">{status}</span>
                <h3>{name}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
          <div className="skill-links" aria-label="Agent resources">
            <a href="/api/v1">
              API starting point <span>Discovery and authentication</span>
            </a>
            <a href="/api/v1/skills">
              Skill catalog <span>All available skills as JSON</span>
            </a>
            <a href="/api/v1/skills/setup-self-healing/SKILL.md">
              Setup skill <span>Initial integration and verification</span>
            </a>
            <a href="/api/v1/skills/operate-self-healing/SKILL.md">
              Operation skill <span>Session reviews and daily reports</span>
            </a>
          </div>
          <p className="contract-note">
            The connection API requires QA callback support and server
            credentials to be configured. Session reviews and daily reports run
            in QA; all Subtext access goes through Self Healing. The broader
            fix, event-stream, and notification APIs remain planned and return{" "}
            <code>501 not_implemented</code>.
          </p>
        </section>
      </main>
      <footer>
        <a className="brand" href="/">
          <img className="brand-icon" src="/images/replay-logo.svg" alt="" />
          Self Healing
        </a>
        <p>Understand the experience. Improve the software.</p>
        <a href="https://github.com/replayio/self-healing">Source & setup ↗</a>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
