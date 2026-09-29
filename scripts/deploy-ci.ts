import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { deploymentConfig, syncRuntimeSecrets, target } from "./lib/deploy.ts";

async function deploy() {
  const config = deploymentConfig(process.env);
  // No API keys for customers or Infisical credentials are copied into Netlify.
  await syncRuntimeSecrets(config);
  console.log("Synced production database secret to Netlify Functions.");
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, {
      env: process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    // Never print raw CLI/database errors or output: these may contain credentials.
    if (result.error || result.status !== 0)
      throw new Error(`Deployment step failed: ${args[0]}`);
    return result.stdout;
  };
  run(["--import", "tsx", "scripts/migrate.ts"]);
  console.log("Applied database migration.");
  const output = run([
    "node_modules/netlify-cli/bin/run.js",
    "deploy",
    "--no-build",
    "--prod",
    "--site",
    config.siteId,
    "--json",
  ]);
  const deployed = JSON.parse(output) as {
    deploy_id?: string;
    deploy_url?: string;
  };
  if (!deployed.deploy_id || !/^[a-f0-9]{24}$/.test(deployed.deploy_id))
    throw new Error("Netlify did not return a deploy ID");
  // Test the immutable deploy origin so initial DNS/TLS setup cannot hide a broken release.
  const origin = `https://${deployed.deploy_id}--replay-self-healing.netlify.app`;
  for (const [path, expected] of [
    ["/", "<title>"],
    ["/api/v1/health", '"status":"ok"'],
    ["/api/v1/openapi.json", '"openapi":'],
    ["/api/v1/skills/setup-self-healing/SKILL.md", "name: setup-self-healing"],
  ]) {
    const response = await fetch(origin + path, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || !(await response.text()).includes(expected!))
      throw new Error(`Smoke check failed: ${path}`);
  }
  run(["--import", "tsx", "scripts/enable-session-reviews.ts"]);
  console.log(
    "Enabled automatic reviews for existing provisioned connections.",
  );
  const protectedResponse = await fetch(origin + "/api/v1/projects", {
    signal: AbortSignal.timeout(30_000),
  });
  if (protectedResponse.status !== 401)
    throw new Error("Unauthenticated API smoke check failed");
  console.log(
    `Deployed ${deployed.deploy_id}; public endpoints and authentication boundary verified.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Deployed to https://${target.domain}\n\nImmutable deploy: ${origin}\n\nPublic smoke checks passed. Connection processing requires SELF_HEALING_SECRET, LOOPQA_ADMIN_TOKEN and the QA bridge deployment. Public smoke checks do not exercise paid provider work.\n`,
    );
}
void deploy().catch((error) => {
  // Only our own sanitized messages above are safe; other exceptions are opaque.
  console.error(
    "Deployment failed. Verify target configuration and inspect the Netlify deploy status.",
  );
  if (
    error instanceof Error &&
    /^(Missing |Refusing |DATABASE_URL must|Invalid DATABASE_URL|Netlify (GET|PUT|POST|DELETE)|Netlify site|Deployment step|Smoke check|Unauthenticated API)/.test(
      error.message,
    )
  )
    console.error(error.message);
  process.exitCode = 1;
});
