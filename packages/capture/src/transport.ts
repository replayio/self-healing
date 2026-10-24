/** QA's versioned auxiliary artifact envelope. Consumers need no package dependency. */
export interface Artifact {
  namespace: string;
  key: string;
  schema_version: number;
  payload: Record<string, unknown>;
}
export interface CaptureBatch {
  session_url: string;
  auxiliary_data: Artifact[];
}
export const DEFAULT_MAX_NETWORK_CAPTURE_BYTES = 1_000_000;

/** Derive the upload budget from the capture limit, allowing one full exchange plus its envelope. */
export function uploadBatchBytes(
  sessionUrl: string,
  maxNetworkCaptureBytes = DEFAULT_MAX_NETWORK_CAPTURE_BYTES,
): number {
  return (
    maxNetworkCaptureBytes +
    new TextEncoder().encode(
      JSON.stringify({
        session_url: sessionUrl,
        auxiliary_data: [
          {
            namespace: "network",
            key: "captured-exchanges",
            schema_version: 1,
            payload: { version: 1, exchanges: [] },
          },
        ],
      }),
    ).byteLength
  );
}

/** Split between whole events, preserving IDs and payloads for identical retries. */
export function splitBatches(
  input: CaptureBatch,
  maxNetworkCaptureBytes = DEFAULT_MAX_NETWORK_CAPTURE_BYTES,
): string[] {
  const maxBytes = uploadBatchBytes(input.session_url, maxNetworkCaptureBytes);
  const encode = (artifacts: Artifact[]) =>
    JSON.stringify({
      session_url: input.session_url,
      auxiliary_data: artifacts,
    });
  const fits = (artifacts: Artifact[]) =>
    new TextEncoder().encode(encode(artifacts)).byteLength <= maxBytes;
  const result: string[] = [];
  let pending: Artifact[] = [];
  for (const artifact of input.auxiliary_data) {
    const field =
      artifact.namespace === "network" && artifact.key === "captured-exchanges"
        ? "exchanges"
        : artifact.namespace === "interaction" &&
            artifact.key === "captured-interactions"
          ? "interactions"
          : artifact.namespace === "session" &&
              artifact.key === "capture-context"
            ? "pages"
            : undefined;
    const entries = field ? artifact.payload[field] : undefined;
    if (field && Array.isArray(entries) && entries.length > 0) {
      let chunk: unknown[] = [];
      const withEntries = (values: unknown[]): Artifact => ({
        ...artifact,
        payload: { ...artifact.payload, [field]: values },
      });
      for (const entry of entries) {
        const candidate = [...chunk, entry];
        if (fits([...pending, withEntries(candidate)])) {
          chunk = candidate;
          continue;
        }
        if (chunk.length) pending.push(withEntries(chunk));
        if (pending.length) {
          result.push(encode(pending));
          pending = [];
        }
        if (!fits([withEntries([entry])]))
          throw new Error(
            `A ${artifact.namespace}/${artifact.key} event exceeds the ${maxBytes}-byte upload limit`,
          );
        chunk = [entry];
      }
      if (chunk.length) pending.push(withEntries(chunk));
    } else {
      if (!fits([artifact]))
        throw new Error(
          `Artifact ${artifact.namespace}/${artifact.key} exceeds the upload limit`,
        );
      if (!fits([...pending, artifact])) {
        result.push(encode(pending));
        pending = [];
      }
      pending.push(artifact);
    }
    // QA accepts at most ten artifacts per registration.
    if (pending.length >= 10) {
      result.push(encode(pending));
      pending = [];
    }
  }
  if (pending.length) result.push(encode(pending));
  return result;
}

/** Binary or NUL-containing bodies cannot be represented in the text-only capture schema. */
export function decodeCaptureBody(bytes: ArrayBuffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}
