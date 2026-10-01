import type { ReactNode } from "react";
import type { Theme } from "../lib/theme";
import { Link, useRouter } from "../lib/router";
import { ThemeToggle } from "./ThemeToggle";

export function Layout({
  theme,
  setTheme,
  children,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  children: ReactNode;
}) {
  const { path } = useRouter();

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header>
        <Link to="/" className="brand" aria-label="Self Healing home">
          <img className="brand-icon" src="/images/replay-logo.svg" alt="" />
          Self Healing
        </Link>
        <span className="badge">Developer preview</span>
        <nav aria-label="Main navigation">
          <Link to="/setup">
            <span aria-hidden="true">＋</span> Setup
          </Link>
          <Link to="/api">
            <span aria-hidden="true">⌘</span> API reference
          </Link>
          <Link to="/skills">
            <span aria-hidden="true">☰</span> Skills
          </Link>
          <a href="https://github.com/replayio/self-healing">
            <span aria-hidden="true">↗</span> GitHub
          </a>
        </nav>
        <div className="sidebar-footer">
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <a className="qa-link" href="https://qa.replay.io">
            Open Replay QA <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      {path !== "/" && (
        <footer>
          <Link to="/" className="brand">
            <img className="brand-icon" src="/images/replay-logo.svg" alt="" />
            Self Healing
          </Link>
          <p>Understand the experience. Improve the software.</p>
          <a href="https://github.com/replayio/self-healing">Source & setup ↗</a>
        </footer>
      )}
    </>
  );
}
