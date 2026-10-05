import { HttpError } from "./errors.ts";

export class QARequestError extends HttpError {
  constructor(readonly upstreamStatus: number) {
    super(
      [400, 409, 413, 429].includes(upstreamStatus) ? upstreamStatus : 503,
      "qa_request_failed",
      `QA rejected the request (HTTP ${upstreamStatus}).`,
      { upstream_status: upstreamStatus },
    );
  }
}

/** Account-bound QA transport. Only session registration overrides its bearer credential. */
export interface QAClient {
  (
    path: string,
    body?: unknown,
    token?: string,
    method?: "GET" | "POST" | "PATCH",
  ): Promise<unknown>;
}
export interface QAServiceAccess {
  origin: string;
  token?: string;
}

export function qaClient(
  env = process.env,
  request: typeof fetch = fetch,
): QAClient {
  return createQAClient(
    {
      origin: env.REPLAY_QA_URL ?? "https://qa.replay.io",
      token: env.REPLAY_QA_API_TOKEN,
    },
    request,
  );
}

export function createQAClient(
  access: QAServiceAccess,
  request: typeof fetch = fetch,
): QAClient {
  const defaultToken = access.token;
  let origin: URL;
  try {
    origin = new URL(access.origin);
  } catch {
    throw new HttpError(
      503,
      "qa_unavailable",
      "QA origin must be an HTTPS origin.",
    );
  }
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
  return async (
    path: string,
    body?: unknown,
    token = defaultToken,
    method?: "GET" | "POST" | "PATCH",
  ): Promise<unknown> => {
    if (!token)
      throw new HttpError(
        503,
        "qa_unavailable",
        "QA credentials are not configured.",
      );
    if (!path.startsWith("/api/") || path.startsWith("//"))
      throw new Error("Invalid QA API path");
    const target = new URL(path, origin);
    if (
      target.origin !== origin.origin ||
      !target.pathname.startsWith("/api/") ||
      target.hash
    )
      throw new Error("Invalid QA API path");
    let response: Response;
    try {
      response = await request(target, {
        method: method ?? (body === undefined ? "GET" : "POST"),
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
    if (!response.ok) throw new QARequestError(response.status);
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
