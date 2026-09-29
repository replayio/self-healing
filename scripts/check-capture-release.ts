import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const packageName = "@replayio/self-healing-capture";

export async function captureReleaseStatus(
  manifest: { name: string; version: string },
  request: typeof fetch = fetch,
): Promise<{ version: string; publish: boolean }> {
  if (
    manifest.name !== packageName ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)
  ) {
    throw new Error(
      "Expected the capture package with a stable numeric version.",
    );
  }
  const response = await request(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${manifest.version}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404)
    return { version: manifest.version, publish: true };
  if (!response.ok)
    throw new Error(
      `npm version lookup failed (${response.status}); refusing to publish.`,
    );
  const published = (await response.json()) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    published.name !== manifest.name ||
    published.version !== manifest.version
  ) {
    throw new Error("npm returned unexpected package metadata.");
  }
  return { version: manifest.version, publish: false };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const manifest = JSON.parse(
    await readFile(
      new URL("../packages/capture/package.json", import.meta.url),
      "utf8",
    ),
  );
  const result = await captureReleaseStatus(manifest);
  console.log(
    result.publish
      ? `Publish ${packageName}@${result.version}`
      : `${packageName}@${result.version} already exists; skipping.`,
  );
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\npublish=${result.publish}\n`,
    );
  }
}
