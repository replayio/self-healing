import { z } from "zod";
import { HttpError } from "./errors.ts";
import { QARequestError, type qaClient } from "./qa.ts";

type Component = {
  name: string;
  selector: string | string[];
  source?: string;
  memory?: string[];
  tags?: string[];
  children?: Component[];
};
const Component: z.ZodType<Component> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    selector: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    source: z.string().optional(),
    memory: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    children: z.array(Component).optional(),
  }),
);
const Sightmap = z.object({
  doc: z
    .object({
      components: z.array(Component).optional(),
      memory: z.array(z.string()).optional(),
      views: z.array(
        z.object({
          components: z.array(Component).optional(),
          memory: z.array(z.string()).optional(),
        }),
      ),
    })
    .nullable(),
});

// Match sightmap's selector-list semantics: commas inside CSS functions,
// attribute values and escaped strings are not alternative separators.
function selectors(value: string): string[] {
  const parts: string[] = [];
  let start = 0,
    depth = 0,
    quote = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === "," && !depth) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  return [...parts, value.slice(start)].map((s) => s.trim()).filter(Boolean);
}

export async function sessionSightmap(
  qa: ReturnType<typeof qaClient>,
  projectId: string,
) {
  let value: unknown;
  try {
    value = await qa(`/api/projects/${encodeURIComponent(projectId)}/sightmap`);
  } catch (error) {
    // A project may not have generated a map yet. Other failures must not
    // silently discard its semantic context.
    if (error instanceof QARequestError && error.upstreamStatus === 404)
      return {};
    throw error;
  }
  const parsed = Sightmap.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      503,
      "qa_contract_changed",
      "QA returned an invalid project sightmap.",
    );
  const doc = parsed.data.doc;
  if (!doc) return {};
  const sightmap: Array<
    Omit<Component, "selector" | "children"> & { selectors: string[] }
  > = [];
  const seen = new Set<string>();
  function visit(components: Component[] = [], parents: string[] = []) {
    for (const { selector, children, ...component } of components) {
      const alternatives = (
        Array.isArray(selector) ? selector : [selector]
      ).flatMap(selectors);
      const resolved = parents.length
        ? parents.flatMap((parent) =>
            alternatives.map((child) => `${parent} ${child}`),
          )
        : alternatives;
      // The canonical Sightmap corpus keeps the first definition of each name.
      if (!seen.has(component.name)) {
        seen.add(component.name);
        sightmap.push({ ...component, selectors: resolved });
      }
      visit(children, resolved);
    }
  }
  visit(doc.components);
  for (const view of doc.views) visit(view.components);
  return {
    sightmap,
    memory: [
      ...(doc.memory ?? []),
      ...doc.views.flatMap((view) => view.memory ?? []),
    ],
  };
}
