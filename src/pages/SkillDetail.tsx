import { useEffect, useState } from "react";
import { Link } from "../lib/router";
import { Markdown } from "../lib/markdown";

function titleCase(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SkillDetailPage({ id }: { id: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState(() => titleCase(id));

  useEffect(() => {
    setContent(null);
    setError("");
    setName(titleCase(id));
    fetch(`/api/v1/skills/${id}/SKILL.md`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.text();
      })
      .then((text) => {
        const nameMatch = text.match(/^name:\s*(.+)/m);
        const descMatch = text.match(/^description:\s*(.+)/m);
        if (nameMatch) {
          const raw = nameMatch[1]!.trim();
          setName(raw.includes("-") ? titleCase(raw) : raw);
        }
        const body = text.replace(/^(name|description):.*\n?/gm, "").trim();
        setContent(descMatch ? descMatch[1] + "\n\n" + body : body);
      })
      .catch(() => setError("Could not load this skill."));
  }, [id]);

  const rawUrl = `/api/v1/skills/${id}/SKILL.md`;

  return (
    <div className="page">
      <div className="page-header">
        <Link to="/skills" className="page-back">
          ← All skills
        </Link>
        <h1 className="page-title">{name}</h1>
      </div>

      {error && <p className="page-error">{error}</p>}
      {!content && !error && <p className="page-loading">Loading...</p>}
      {content && (
        <article className="skill-doc">
          <Markdown text={content} />
        </article>
      )}

      <aside className="raw-links">
        <h3>Raw endpoint</h3>
        <a href={rawUrl} target="_blank" rel="noopener noreferrer">
          {rawUrl} ↗
        </a>
      </aside>
    </div>
  );
}
