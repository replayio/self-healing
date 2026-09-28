import { HttpError } from "./errors.ts";

export function qaClient(env = process.env, request: typeof fetch = fetch) {
  const origin = env.REPLAY_QA_URL ?? "https://qa.replay.io";
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HttpError(
      503,
      "qa_unavailable",
      "REPLAY_QA_URL must be an HTTPS origin.",
    );
  const token = env.REPLAY_QA_API_TOKEN;
  if (!token)
    throw new HttpError(
      503,
      "qa_unavailable",
      "QA service credentials are not configured.",
    );
  return async (body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(
        new URL("/.netlify/functions/self-healing", origin),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(25_000),
        },
      );
    } catch {
      throw new HttpError(
        503,
        "qa_unavailable",
        "QA did not respond. Retry the same request.",
      );
    }
    if (!response.ok) {
      const status = [400, 409, 413, 429].includes(response.status)
        ? response.status
        : 503;
      throw new HttpError(
        status,
        "qa_request_failed",
        `QA rejected the request (HTTP ${response.status}).`,
      );
    }
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
