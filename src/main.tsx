import React from "react";
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
              <h3>Connect your repository</h3>
              <p>
                Install your factory and its GitHub app on the app you maintain.
                Give it access to create branches and pull requests.
              </p>
            </li>
            <li>
              <h3>Configure your account and key</h3>
              <p>
                POST your Subtext key to /api/v1/accounts. Store the returned
                Self Healing API key in your factory’s secret store and use it
                for subsequent calls. Each account gets a dedicated QA identity.
              </p>
            </li>
            <li>
              <h3>Register the project and its context</h3>
              <p>
                Use the connection API to create your QA project, then save your
                repository, deployment URLs, product context, repository
                sightmap, QA preferences, and report destinations.
              </p>
            </li>
            <li>
              <h3>Enable monitoring and the fix loop</h3>
              <p>
                Send sessions and auxiliary events through your server to Self
                Healing. Complete each session to request QA reviews, then
                retrieve the results and daily reports. The automated fix-PR
                loop is still planned.
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
          <div className="code-panel">
            <div>
              <h3>Connect your key</h3>
              <p>
                Use your deployed service URL and your Self Healing account API
                key. Discover request and response schemas in OpenAPI.
              </p>
              <a href="/api/v1/skills/operate-self-healing/SKILL.md">
                Read the operation skill ↗
              </a>
            </div>
            <pre>
              <code>{`curl "$SELF_HEALING_URL/api/v1/connection" \\\n  -H "Authorization: Bearer $SELF_HEALING_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "name": "My app",\n    "production_url": "https://app.example.com"\n  }'`}</code>
            </pre>
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
