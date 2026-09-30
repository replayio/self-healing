import test from "node:test";
import assert from "node:assert/strict";
import { sessionSightmap } from "../src/api/session-sightmap.ts";
import { QARequestError } from "../src/api/qa.ts";

test("sightmap conversion preserves global/view context and resolves nested selector alternatives", async () => {
  const context = await sessionSightmap(async (path) => {
    assert.equal(path, "/api/projects/project%2Fone/sightmap");
    return {
      doc: {
        memory: ["App context"],
        components: [
          {
            name: "Nav",
            selector: "nav",
            source: "nav.tsx",
            tags: ["navigation"],
          },
        ],
        views: [
          {
            memory: ["Page context"],
            components: [
              {
                name: "Form",
                selector: ["form, .editor"],
                children: [
                  {
                    name: "Save",
                    selector: ':is(button, a), [data-label="Save, now"]',
                    memory: ["Saves changes"],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  }, "project/one");
  assert.deepEqual(context, {
    memory: ["App context", "Page context"],
    sightmap: [
      {
        name: "Nav",
        selectors: ["nav"],
        source: "nav.tsx",
        tags: ["navigation"],
      },
      { name: "Form", selectors: ["form", ".editor"] },
      {
        name: "Save",
        selectors: [
          "form :is(button, a)",
          'form [data-label="Save, now"]',
          ".editor :is(button, a)",
          '.editor [data-label="Save, now"]',
        ],
        memory: ["Saves changes"],
      },
    ],
  });
});

test("only missing maps are optional; malformed maps and provider failures remain explicit", async () => {
  assert.deepEqual(
    await sessionSightmap(async () => {
      throw new QARequestError(404);
    }, "one"),
    {},
  );
  assert.deepEqual(
    await sessionSightmap(async () => ({ doc: null }), "one"),
    {},
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      sessionSightmap(async () => {
        throw new QARequestError(status);
      }, "one"),
      QARequestError,
    );
  }
  await assert.rejects(
    sessionSightmap(
      async () => ({ doc: { views: [{ components: [{ name: "Broken" }] }] } }),
      "one",
    ),
    /invalid project sightmap/,
  );
});
