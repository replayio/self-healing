import type { Theme } from "../lib/theme";

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

function SunIcon() {
  return (
    <svg {...svgBase}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...svgBase}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...svgBase}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const THEME_OPTIONS: {
  value: Theme;
  label: string;
  Icon: () => React.JSX.Element;
}[] = [
  { value: "light", label: "Light Mode", Icon: SunIcon },
  { value: "dark", label: "Dark Mode", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
];

export function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
}) {
  const current =
    THEME_OPTIONS.find((o) => o.value === theme) ?? THEME_OPTIONS[2]!;
  const idx = THEME_OPTIONS.indexOf(current);
  const next = THEME_OPTIONS[(idx + 1) % THEME_OPTIONS.length]!;

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => setTheme(next.value)}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      title={`Theme: ${current.label}`}
    >
      <current.Icon />
      <span>{current.label}</span>
    </button>
  );
}
