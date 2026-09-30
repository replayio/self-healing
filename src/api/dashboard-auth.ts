import { createHash, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { HttpError } from "./errors.ts";
import type { Query } from "./store.ts";

// New name avoids collisions with legacy unpartitioned cookies.
export const DASHBOARD_COOKIE = "__Host-sh-dashboard-v2";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
const Row = z.object({ account_id: z.string().uuid() });
function cookieToken(request: Request) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${DASHBOARD_COOKIE}=`))
      ?.slice(DASHBOARD_COOKIE.length + 1) ?? ""
  );
}
export function dashboardCookie(value: string, age = 86400) {
  return `${DASHBOARD_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${age}`;
}
export function requireDashboardOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new HttpError(
      403,
      "invalid_origin",
      "Open the dashboard on this service's origin.",
    );
}
export function dashboardAuth(
  query: Query,
  origin = process.env.SELF_HEALING_URL ?? "https://self-healing.replay.io",
) {
  const base = new URL(origin);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new HttpError(
      503,
      "dashboard_unavailable",
      "SELF_HEALING_URL must be an HTTPS origin.",
    );
  return {
    async launch(account: string) {
      await query(
        "DELETE FROM dashboard_sessions WHERE expires_at <= now()",
        [],
      );
      const ticket = token();
      const [row] = await query(
        `INSERT INTO dashboard_sessions(token_hash,account_id,kind,expires_at)
        VALUES($1,$2,'launch',now()+interval '5 minutes') RETURNING expires_at`,
        [hash(ticket), account],
      );
      const expires = z
        .object({ expires_at: z.coerce.date() })
        .parse(row).expires_at;
      // The fragment never reaches HTTP access logs or the Referer header.
      return {
        url: new URL(`/dashboard#ticket=${ticket}`, base).href,
        expires_at: expires.toISOString(),
        session_ttl_seconds: 86400 as const,
      };
    },
    async redeem(ticket: string) {
      const session = token();
      const rows = await query(
        `INSERT INTO dashboard_sessions(token_hash,account_id,kind,expires_at)
        SELECT $2,account_id,'browser',now()+interval '24 hours' FROM dashboard_sessions
        WHERE token_hash=$1 AND kind='launch' AND expires_at > now() RETURNING account_id`,
        [hash(ticket), hash(session)],
      );
      if (!rows.length)
        throw new HttpError(
          401,
          "expired_link",
          "This dashboard link has expired. Request a new link from your factory.",
        );
      return session;
    },
    async authenticate(request: Request) {
      const value = cookieToken(request);
      if (!/^[a-f0-9]{64}$/.test(value))
        throw new HttpError(
          401,
          "dashboard_session_required",
          "Open a fresh dashboard link from your factory.",
        );
      const [row] = await query(
        `SELECT account_id FROM dashboard_sessions
        WHERE token_hash=$1 AND kind='browser' AND expires_at > now()`,
        [hash(value)],
      );
      if (!row)
        throw new HttpError(
          401,
          "dashboard_session_expired",
          "Your dashboard session has expired. Request a new link from your factory.",
        );
      return { accountId: Row.parse(row).account_id };
    },
    async logout(request: Request) {
      await query(
        "DELETE FROM dashboard_sessions WHERE token_hash=$1 AND kind='browser'",
        [hash(cookieToken(request))],
      );
    },
  };
}
export function getDashboardAuth() {
  if (!process.env.DATABASE_URL)
    throw new HttpError(
      503,
      "storage_unavailable",
      "Database is not configured.",
    );
  const sql = neon(process.env.DATABASE_URL);
  return dashboardAuth(async (text, values) => await sql(text, values));
}
