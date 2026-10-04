import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureReleaseStatus,
  waitForCaptureVisibility,
} from "./check-capture-release.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
function npm(args: string[], quiet = false, buffered = false): boolean {
  // Keep child scripts on the same Node installation as this release script.
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
  const cli = process.env.npm_execpath;
  const result = spawnSync(
    cli ? process.execPath : "npm",
    cli ? [cli, ...args] : args,
    {
      cwd: root,
      env,
      stdio: buffered ? "pipe" : quiet ? "ignore" : "inherit",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (buffered && (result.status !== 0 || result.error || result.signal)) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(`npm ${args[0]} interrupted (${result.signal}).`);
  if (result.status !== 0 && !quiet)
    throw new Error(`npm ${args[0]} failed (${result.status}).`);
  return result.status === 0;
}

export async function publishCapture(dryRun: boolean) {
  if (!dryRun && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "Run from an interactive terminal so npm can request login and 2FA.",
    );
  }
  const manifest = JSON.parse(
    await readFile(join(root, "packages/capture/package.json"), "utf8"),
  );
  const status = await captureReleaseStatus(manifest);
  if (!status.publish) {
    console.log(`${manifest.name}@${status.version} is already published.`);
    return;
  }
  console.log("Running release tests...");
  npm(["test"], false, true);
  console.log("Tests passed. Building release...");
  npm(["run", "build"], false, true);
  console.log("Build passed. Packing release...");
  const directory = await mkdtemp(join(tmpdir(), "self-healing-release-"));
  try {
    npm([
      "pack",
      "--workspace",
      manifest.name,
      "--ignore-scripts",
      "--pack-destination",
      directory,
    ]);
    const artifact = join(
      directory,
      `replayio-self-healing-capture-${status.version}.tgz`,
    );
    if (
      !dryRun &&
      !npm(["whoami", "--registry=https://registry.npmjs.org"], true)
    ) {
      npm([
        "login",
        "--auth-type=web",
        "--registry=https://registry.npmjs.org",
      ]);
    }
    npm([
      "publish",
      artifact,
      "--access=public",
      "--registry=https://registry.npmjs.org",
      ...(dryRun ? ["--dry-run"] : []),
    ]);
    if (dryRun) return;
    console.log(
      `npm accepted ${manifest.name}@${status.version}. Checking registry visibility...`,
    );
    const visibility = await waitForCaptureVisibility(manifest);
    if (visibility === "visible") {
      console.log(
        `Published ${manifest.name}@${status.version} (verified on npm).`,
      );
    } else {
      console.log(
        `Publication accepted; registry visibility is still pending. npm processing can take several minutes. No republish is needed. Check with: npm view ${manifest.name}@${status.version} version`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run"))
    throw new Error("Usage: npm run capture:publish [-- --dry-run]");
  await publishCapture(args.includes("--dry-run"));
}
