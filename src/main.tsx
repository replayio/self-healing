import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, useRouter } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Layout } from "./components/Layout";
import { LandingPage } from "./pages/Landing";
import { SetupPage } from "./pages/Setup";
import { ApiPage } from "./pages/Api";
import { SkillsPage } from "./pages/Skills";
import { SkillDetailPage } from "./pages/SkillDetail";
import "./style.css";

const Dashboard = React.lazy(() => import("./dashboard/Dashboard"));

interface Route {
  pattern: RegExp;
  render: (params: Record<string, string>) => React.ReactNode;
}

const routes: Route[] = [
  { pattern: /^\/setup$/, render: () => <SetupPage /> },
  { pattern: /^\/api$/, render: () => <ApiPage /> },
  { pattern: /^\/skills\/(?<id>[^/]+)$/, render: ({ id }) => <SkillDetailPage id={id!} /> },
  { pattern: /^\/skills$/, render: () => <SkillsPage /> },
  { pattern: /^/, render: () => <LandingPage /> },
];

function resolveRoute(path: string): React.ReactNode {
  for (const route of routes) {
    const match = path.match(route.pattern);
    if (match) return route.render(match.groups ?? {});
  }
  return <LandingPage />;
}

function App() {
  const { theme, setTheme } = useTheme();
  const { path } = useRouter();

  return (
    <Layout theme={theme} setTheme={setTheme}>
      {resolveRoute(path)}
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider>
      {window.location.pathname.replace(/\/$/, "") === "/dashboard" ? (
        <React.Suspense fallback={<p role="status">Opening dashboard...</p>}>
          <Dashboard />
        </React.Suspense>
      ) : (
        <App />
      )}
    </RouterProvider>
  </React.StrictMode>,
);
