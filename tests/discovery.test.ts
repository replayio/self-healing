import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHandler } from "../src/api/handler.ts";
import { agentSkills, operations } from "../src/api/contracts.ts";
import { getOpenApiSpec } from "../src/api/openapi.ts";

const handler = createHandler({
  authenticate: async () => {
    throw new Error("Discovery must not authenticate");
  },
  store: () => {
    throw new Error("Discovery must not access storage");
  },
  accounts: () => {
    throw new Error("Discovery must not load credentials");
  },
});

test("an unauthenticated agent discovers setup and all served skills on the requested origin", async () => {
  for (const origin of [
    "https://self-healing.replay.io",
    "https://preview.example",
  ]) {
    const response = await handler(new Request(`${origin}/api/v1/`));
    assert.equal(response.status, 200);
    const discovery = await response.json();
    operations.find((op) => op.id === "discoverApi")!.response.parse(discovery);
    assert.equal(discovery.openapi_url, `${origin}/api/v1/openapi.json`);
    const catalogResponse = await handler(new Request(discovery.skills_url));
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    operations.find((op) => op.id === "listSkills")!.response.parse(catalog);
    assert.equal(catalog.skills.length, agentSkills.length);
    assert.equal(catalog.skills[0].url, discovery.setup_skill_url);
    const updateSkill = catalog.skills.find(
      (skill: { id: string }) => skill.id === "update-self-healing",
    );
    assert.ok(updateSkill, "existing installations can discover the update skill");
    assert.equal(
      updateSkill.url,
      `${origin}/api/v1/skills/update-self-healing/SKILL.md`,
    );
    for (const skill of catalog.skills) {
      const url = new URL(skill.url);
      assert.equal(url.origin, origin);
      const markdown = await readFile(
        new URL(`../public${url.pathname}`, import.meta.url),
        "utf8",
      );
      assert.ok(markdown.startsWith("---\n"));
      assert.ok(markdown.includes(`name: ${skill.id}`));
      assert.ok(markdown.includes("/api/v1"));
      const route = getOpenApiSpec().paths[url.pathname]!.get as {
        security: unknown[];
        operationId: string;
        responses: Record<string, { content: Record<string, unknown> }>;
      };
      assert.deepEqual(route.security, []);
      assert.equal(route.operationId, skill.id);
      assert.ok(route.responses["200"]!.content["text/markdown"]);
    }
  }
});

test("OpenAPI points agents to the same catalog and setup skill", () => {
  const spec = getOpenApiSpec();
  assert.equal(spec.externalDocs.url, agentSkills[0].path);
  assert.equal(spec["x-agent-skills"].catalog, "/api/v1/skills");
  assert.equal(spec["x-agent-skills"].setup, agentSkills[0].path);
});

test("discovery rejects unsupported methods and unknown skill routes", async () => {
  for (const path of ["/api/v1", "/api/v1/skills"]) {
    const response = await handler(
      new Request(`https://example.com${path}`, { method: "POST" }),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal(
    (await handler(new Request("https://example.com/api/v1/skills/missing")))
      .status,
    404,
  );
});
