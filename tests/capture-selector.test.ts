import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { interactionSelector as SelectorFunction } from "../packages/capture/src/interaction-selector.ts";
// Serialize the package's TypeScript output, without tsx's Node-only function-name helpers.
const interactionSelector = new Function(
  ts.transpileModule(
    readFileSync(
      new URL(
        "../packages/capture/src/interaction-selector.ts",
        import.meta.url,
      ),
      "utf8",
    ).replace("export function", "function"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText + "; return interactionSelector;",
)() as typeof SelectorFunction;

test("captured selectors uniquely identify the original element using Playwright", async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const fixtures = [
      {
        name: "unique test ID",
        html: '<button data-testid="save">Save</button>',
        target: "button",
        expected: '[data-testid="save"]',
      },
      {
        name: "duplicate test IDs fall through to ID",
        html: '<button data-testid="save">Save</button><button data-testid="save" id="right">Save</button>',
        target: "#right",
        expected: "#right",
      },
      {
        name: "duplicate IDs and labels use ancestor scope",
        html: '<section id="left"><button id="same" aria-label="Close"></button></section><section id="right"><button id="same" aria-label="Close"></button></section>',
        target: "#right button",
        expected: "#right #same",
      },
      {
        name: "text selectors are preserved",
        html: "<button>  Save <span>changes</span> </button><button>Cancel</button>",
        target: "button:first-child",
        expected: 'button:has-text("Save changes")',
      },
      {
        name: "case-insensitive substring text matches are ambiguous",
        html: "<button>Save</button><button>SAVE AS</button>",
        target: "button:first-child",
        structural: true,
      },
      {
        name: "text ignores script contents",
        html: "<button>Save<script>secret</script></button><button>Cancel</button>",
        target: "button:first-child",
        expected: 'button:has-text("Save")',
      },
      {
        name: "repeated text can be scoped",
        html: '<div id="left"><button>Close</button></div><div id="right"><button>Close</button></div>',
        target: "#right button",
        expected: '#right button:has-text("Close")',
      },
      {
        name: "anonymous icon buttons use structural positions",
        html: "<div><button><svg></svg></button><button><svg></svg></button></div>",
        target: "button:nth-child(2)",
        structural: true,
      },
      {
        name: "duplicate IDs alone never pass",
        html: '<button id="duplicate"></button><button id="duplicate"></button>',
        target: "button:nth-child(2)",
        structural: true,
      },
      {
        name: "escaped attributes",
        html: '<button aria-label="A &quot;quote&quot; &#10; slash\\">X</button><button>X</button>',
        target: "button:first-child",
      },
      {
        name: "oversized attributes fall through",
        html: `<button data-testid="${"x".repeat(2100)}" id="short">X</button>`,
        target: "button",
        expected: "#short",
      },
      {
        name: "very long duplicate text needs structure",
        html: `<button>${"x".repeat(510)}</button><button>${"x".repeat(510)}</button>`,
        target: "button:nth-child(2)",
        structural: true,
      },
    ];
    for (const fixture of fixtures)
      await t.test(fixture.name, async () => {
        await page.setContent(fixture.html);
        const target = page.locator(fixture.target);
        const selector = await target.evaluate(interactionSelector);
        assert.ok(selector);
        if (fixture.expected) assert.equal(selector, fixture.expected);
        if (fixture.structural) assert.match(selector, /nth-of-type/);
        assert.equal(await page.locator(selector).count(), 1);
        const original = await target.elementHandle();
        assert.equal(
          await page
            .locator(selector)
            .evaluate((element, expected) => element === expected, original),
          true,
        );
      });
    await t.test(
      "open shadow descendants participate in uniqueness and structural resolution",
      async () => {
        await page.setContent(
          '<button aria-label="Close"></button><div id="host"></div>',
        );
        await page.locator("#host").evaluate((host) => {
          host.attachShadow({ mode: "open" }).innerHTML =
            '<button aria-label="Close"></button><button aria-label="Close"></button>';
        });
        for (const target of [
          page.locator("body > button"),
          page.locator("#host button").nth(1),
        ]) {
          const selector = await target.evaluate(interactionSelector);
          assert.ok(selector);
          assert.equal(await page.locator(selector).count(), 1);
          assert.equal(
            await page
              .locator(selector)
              .evaluate(
                (element, expected) => element === expected,
                await target.elementHandle(),
              ),
            true,
          );
        }
      },
    );
    await t.test(
      "detached and closed-shadow targets remain unresolved",
      async () => {
        assert.equal(
          await page.evaluate(
            interactionSelector,
            await page.evaluateHandle(() => document.createElement("button")),
          ),
          null,
        );
        const closed = await page.evaluateHandle(() => {
          const host = document.createElement("div");
          document.body.append(host);
          const root = host.attachShadow({ mode: "closed" });
          const target = document.createElement("button");
          root.append(target);
          return target;
        });
        assert.equal(await closed.evaluate(interactionSelector), null);
      },
    );
  } finally {
    await browser.close();
  }
});
