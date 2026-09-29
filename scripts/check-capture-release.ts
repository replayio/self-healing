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
