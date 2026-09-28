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
      // Only expose our bridge's fixed recovery hints, never arbitrary upstream text.
      let code = "qa_request_failed";
      let message = `QA rejected the request (HTTP ${response.status}).`;
      try {
        const body: unknown = await response.json();
        const error =
          body && typeof body === "object" && "error" in body
            ? body.error
            : undefined;
        if (error === "Session is complete; no additional batches accepted") {
          code = "session_complete";
          message = "This session is sealed. Stop sending new batches.";
        } else if (error === "Another batch is being processed; retry") {
          code = "upload_busy";
          message = "Retry the same batch after the current upload finishes.";
        } else if (
          error === "Review capacity unavailable; retry completion later"
        ) {
          code = "qa_capacity";
          message =
            "Retry the same completion request when QA capacity is available.";
        }
      } catch {
        /* No raw upstream errors are returned. */
      }
      throw new HttpError(status, code, message);
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
