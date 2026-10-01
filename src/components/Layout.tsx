import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Theme } from "../lib/theme";
import { Link, useRouter } from "../lib/router";
import { ThemeToggle } from "./ThemeToggle";

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <path d="M6 6l12 12M18 6 6 18" />
      ) : (
        <path d="M3 6h18M3 12h18M3 18h18" />
      )}
    </svg>
  );
}

export function Layout({
  theme,
  setTheme,
  children,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { path } = useRouter();
  const headerRef = useRef<HTMLElement>(null);

  // Navigating is the usual reason the menu was opened, so arriving somewhere dismisses it.
  useEffect(() => setMenuOpen(false), [path]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header ref={headerRef}>
        <Link to="/" className="brand" aria-label="Self Healing home">
          <img className="brand-icon" src="/images/replay-logo.svg" alt="" />
          Self Healing
        </Link>
        <span className="badge">Developer preview</span>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MenuIcon open={menuOpen} />
        </button>
        <nav
          id="main-nav"
          aria-label="Main navigation"
          data-open={menuOpen || undefined}
        >
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
    </>
  );
}
