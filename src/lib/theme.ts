import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const THEME_KEY = "replay_theme";

function getStored(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(t: Theme): "light" | "dark" {
  if (t !== "system") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyToDOM(eff: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", eff);
  document.documentElement.classList.toggle("dark", eff === "dark");
}

export function useTheme() {
  const [theme, raw] = useState<Theme>(getStored);
  const [eff, setEff] = useState<"light" | "dark">(() =>
    resolveTheme(getStored()),
  );

  const setTheme = useCallback((next: Theme) => {
    raw(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    const e = resolveTheme(next);
    setEff(e);
    applyToDOM(e);
  }, []);

  useEffect(() => {
    applyToDOM(resolveTheme(theme));
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const e = resolveTheme("system");
      setEff(e);
      applyToDOM(e);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, effectiveTheme: eff, setTheme };
}
