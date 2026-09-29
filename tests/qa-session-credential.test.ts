import test from "node:test";
import assert from "node:assert/strict";
import { qaSessionCredential } from "../src/api/qa-session-credential.ts";

test("QA registration uses the structured credential, independent of explanatory text", () => {
  assert.equal(
    qaSessionCredential({
      registration_token: "lqs_token",
      instructions: "unrelated lqs_other",
    }),
    "lqs_token",
  );
});

test("the prior QA response remains usable during rollout", () => {
  assert.equal(
    qaSessionCredential({
      instructions: "Bearer lqs_old; store lqs_old server-side",
    }),
    "lqs_old",
  );
});

test("invalid, missing, or ambiguous credentials never become stored tokens", () => {
  for (const response of [
    null,
    {},
    { registration_token: "" },
    { registration_token: "bad", instructions: "lqs_old" },
    { instructions: "no token" },
    { instructions: "lqs_one lqs_two" },
  ]) {
    assert.throws(() => qaSessionCredential(response), /registration token/);
  }
});
