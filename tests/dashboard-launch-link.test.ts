import test from "node:test";
import assert from "node:assert/strict";
import { dashboardTicket } from "../src/dashboard/launch-link.ts";
import { operations } from "../src/api/contracts.ts";

const ticket = "a1".repeat(32);
const redeem = operations.find(operation => operation.id === "redeemDashboardSession")!.body!;

test("iframe query suffix does not become part of the dashboard access code", () => {
  const src = `https://self-healing.replay.io/dashboard#ticket=${ticket}?_ts=1790787600000`;
  const hash = new URL(src).hash;
  const old = new URLSearchParams(hash.slice(1)).get("ticket");
  assert.equal(old!.length, 82);
  assert.equal(redeem.safeParse({ ticket: old }).success, false);
  assert.equal(dashboardTicket(hash), ticket);
  assert.deepEqual(redeem.parse({ ticket: dashboardTicket(hash) }), { ticket });
});

test("normal links, wrapper parameters and encoded delimiters retain the issued ticket", () => {
  for (const suffix of ["", "&embed=true", "?embed=true&theme=light", "#preview", "%3F_ts%3D1790787600000", "%26embed%3Dtrue"])
    assert.equal(dashboardTicket(`#ticket=${ticket}${suffix}`), ticket);
  assert.equal(dashboardTicket(`#embed=true&ticket=${ticket}`), ticket);
  assert.equal(dashboardTicket(new URL(`https://example.com/dashboard?embed=true#ticket=${ticket}`).hash), ticket);
});

test("malformed codes remain invalid rather than being blindly truncated or replaced", () => {
  for (const value of [ticket.slice(1), ticket + "a".repeat(18), "z".repeat(64), ticket.slice(0, 63) + "?embed=true", ticket.toUpperCase()]) {
    assert.equal(dashboardTicket(`#ticket=${value}`), value);
    assert.equal(redeem.safeParse({ ticket: dashboardTicket(`#ticket=${value}`) }).success, false);
  }
  assert.equal(dashboardTicket(""), null);
  assert.equal(dashboardTicket("#embed=true"), null);
  assert.equal(dashboardTicket("#ticket="), "");
});
