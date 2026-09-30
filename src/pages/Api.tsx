import { Link } from "../lib/router";

const apiGroups = [
  [
    "Project configuration",
    "Projects, providers, context, sightmaps, environments, and report preferences.",
    "Key-scoped",
  ],
  [
    "User understanding",
    "Session analysis, evidence-backed bugs, behavior trends, and periodic reports.",
    "Contract defined",
  ],
  [
    "Verified fixes",
    "Fix PRs, commit-level verification, and release QA.",
    "Contract defined",
  ],
  [
    "Factory coordination",
    "Event polling and asynchronous job status.",
    "Contract defined",
  ],
];

export function ApiPage() {
  return (
    <div className="page">
      <div className="page-header">
        <p className="eyebrow eyebrow--label">BUILT FOR AGENTS</p>
        <h1 className="page-title">API reference</h1>
        <p className="page-subtitle">
          A single REST interface. Your agent reads the OpenAPI spec and
          discovers everything it needs.
        </p>
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

      <section className="page-section">
        <h2>Quick links</h2>
        <div className="skill-links">
          <a href="/api/v1">
            API starting point <span>Discovery and authentication</span>
          </a>
          <a
            href="/api/v1/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
          >
            OpenAPI specification <span>Full machine-readable spec</span>
          </a>
          <Link to="/skills">
            Skill catalog <span>Setup, operation, and integration guides</span>
          </Link>
        </div>
      </section>

      <p className="contract-note">
        Session reviews and daily reports run in QA; all Subtext access goes
        through Self Healing. The fix, event-stream, and notification APIs are
        planned and currently return <code>501</code>.
      </p>

      <aside className="raw-links">
        <h3>Raw endpoints</h3>
        <a href="/api/v1" target="_blank" rel="noopener noreferrer">/api/v1 ↗</a>
        <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">/api/v1/openapi.json ↗</a>
        <a href="/api/v1/skills" target="_blank" rel="noopener noreferrer">/api/v1/skills ↗</a>
      </aside>
    </div>
  );
}
