/**
 * Iframe wrappers can append a query string to the whole src, after our fragment:
 * /dashboard#ticket=<code>?_ts=1790787600000
 * URLSearchParams alone includes that suffix in the ticket. Read the complete
 * issued code up to the next URL delimiter; never truncate an undelimited value.
 * The server still validates the code and checks its stored hash and expiry.
 */
export function dashboardTicket(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("ticket");
  if (value === null) return null;
  return /^([a-f0-9]{64})(?=[?&#]|$)/.exec(value)?.[1] ?? value;
}
