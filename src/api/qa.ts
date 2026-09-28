import { HttpError } from "./errors.ts";

export function qaClient(env = process.env, request: typeof fetch = fetch) {
  const origin = new URL(env.REPLAY_QA_URL ?? "https://qa.replay.io");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new HttpError(
      503,
      "qa_unavailable",
      "REPLAY_QA_URL must be an HTTPS origin.",
    );
  if (!env.REPLAY_QA_API_TOKEN)
    throw new HttpError(
      503,
      "qa_unavailable",
      "QA service credentials are not configured.",
    );
  return async (
    path: string,
    body?: unknown,
    token = env.REPLAY_QA_API_TOKEN,
  ): Promise<unknown> => {
    if (!path.startsWith("/api/") || path.startsWith("//"))
      throw new Error("Invalid QA API path");
    let response: Response;
    try {
      response = await request(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new HttpError(
        503,
        "qa_unavailable",
        "QA did not respond. Retry the same request.",
      );
    }
    if (!response.ok)
      throw new HttpError(
        [400, 409, 413, 429].includes(response.status) ? response.status : 503,
        "qa_request_failed",
        `QA rejected the request (HTTP ${response.status}).`,
      );
    try {
      return await response.json();
    } catch {
      throw new HttpError(
        503,
        "qa_unavailable",
        "QA returned an invalid response.",
      );
    }
  };
}
