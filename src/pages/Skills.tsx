import { useEffect, useState } from "react";
import { Link } from "../lib/router";

interface Skill {
  id: string;
  name: string;
  description: string;
  url: string;
}

function displayName(name: string): string {
  if (!name.includes("-")) return name;
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/v1/skills")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: { skills: Skill[] }) => setSkills(data.skills))
      .catch(() => setError("Could not load skills."));
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <p className="eyebrow eyebrow--label">AGENT RESOURCES</p>
        <h1 className="page-title">Skills</h1>
        <p className="page-subtitle">
          Step-by-step guides your coding agent can follow to set up and operate
          Self Healing.
        </p>
      </div>

      {error && <p className="page-error">{error}</p>}
      {!skills && !error && <p className="page-loading">Loading skills...</p>}
      {skills && (
        <div className="skill-links">
          {skills.map((s) => (
            <Link to={`/skills/${s.id}`} key={s.id}>
              {displayName(s.name)} <span>{s.description}</span>
            </Link>
          ))}
        </div>
      )}

      <aside className="raw-links">
        <h3>Raw endpoint</h3>
        <a href="/api/v1/skills" target="_blank" rel="noopener noreferrer">
          /api/v1/skills ↗
        </a>
      </aside>
    </div>
  );
}
