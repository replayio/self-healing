import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const apiGroups = [
  [
    "Project setup",
    "Projects, provider links, context, sightmaps, environments, and report preferences.",
    "Available",
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
      <header>
        <a className="brand" href="/" aria-label="Self Healing home">
          <span className="brand-icon">↻</span> self healing
          <span className="badge">Developer preview</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#setup">Setup</a>
          <a href="#api">API</a>
          <a href="https://github.com/replayio/self-healing">GitHub ↗</a>
        </nav>
      </header>
      <main>
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
            The foundation is live in this scaffold: project configuration and
            API contracts. Provider automation is coming next.
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
                The intended onboarding uses a Subtext account and a single API
                key. For this preview, your service operator provisions a Self
                Healing key. Keep it in your factory’s secret store.
              </p>
            </li>
            <li>
              <h3>Register the project and its context</h3>
              <p>
                Use the API to save your repository, deployment URLs, product
                context, repository sightmap, QA preferences, and report
                destinations.
              </p>
            </li>
            <li>
              <h3>Enable monitoring and the fix loop</h3>
              <p>
                Once provider adapters are available, follow the returned
                Fullstory installation instructions, consume new bugs, submit
                fix PRs, and watch verification results. Choose email or Slack
                for reports.
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
                <span
                  className={
                    status === "Available" ? "status available" : "status"
                  }
                >
                  {status}
                </span>
                <h3>{name}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
          <div className="code-panel">
            <div>
              <h3>Start with a project</h3>
              <p>
                Use your deployed service URL and an operator-provisioned key.
                Discover request and response schemas in OpenAPI.
              </p>
              <a href="/api/v1/skills/operate-self-healing/SKILL.md">
                Read the operation skill ↗
              </a>
            </div>
            <pre>
              <code>{`curl "$SELF_HEALING_URL/api/v1/projects" \\\n  -H "Authorization: Bearer $SELF_HEALING_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "name": "My app",\n    "repository_url": "https://github.com/team/app",\n    "production_url": "https://app.example.com"\n  }'`}</code>
            </pre>
          </div>
          <p className="contract-note">
            Contract-only endpoints return <code>501 not_implemented</code>.
            Saving configuration does not start monitoring, schedule reports, or
            queue QA. Recordings remain with their providers; this foundation
            stores project metadata and configuration.
          </p>
        </section>
      </main>
      <footer>
        <a className="brand" href="/">
          ↻ self healing
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
