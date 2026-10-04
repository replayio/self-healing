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

/** Publication has already succeeded; registry propagation is a separate status. */
export async function waitForCaptureVisibility(
  manifest: { name: string; version: string },
  request: typeof fetch = fetch,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 5_000)),
): Promise<"visible" | "pending"> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await pause();
    try {
      if (!(await captureReleaseStatus(manifest, request)).publish)
        return "visible";
    } catch {
      // A registry read failure cannot undo npm's accepted publication.
    }
  }
  return "pending";
}
