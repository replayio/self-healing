import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureReleaseStatus } from "./check-capture-release.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
function npm(args: string[], quiet = false): boolean {
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
      stdio: quiet ? "ignore" : "inherit",
    },
  );
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
  npm(["test"]);
  npm(["run", "build"]);
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
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!(await captureReleaseStatus(manifest)).publish) {
        console.log(`Published ${manifest.name}@${status.version}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(
      "npm accepted the publish, but the version is not visible yet. Check the registry before retrying.",
    );
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
