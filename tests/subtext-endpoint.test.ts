import test from "node:test";
import assert from "node:assert/strict";
import { subtextEndpoint } from "../src/api/subtext-endpoint.ts";

test("Subtext defaults to production and accepts explicit EU and staging endpoints", () => {
  assert.equal(subtextEndpoint(), "https://api.fullstory.com/mcp/subtext");
  for (const host of ["api.eu1.fullstory.com", "api.staging.fullstory.com"])
    assert.equal(
      subtextEndpoint(`https://${host}/mcp/subtext`),
      `https://${host}/mcp/subtext`,
    );
});
test("public provisioning cannot direct credentials to arbitrary URLs", () => {
  for (const url of [
    "http://api.staging.fullstory.com/mcp/subtext",
    "https://127.0.0.1/mcp/subtext",
    "https://api.fullstory.com.attacker.example/mcp/subtext",
    "https://api.fullstory.com/me",
  ])
    assert.throws(() => subtextEndpoint(url));
});
