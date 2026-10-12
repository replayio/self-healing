/** Marker denotes capture loss, never an original application value. */
const MARKER = "[qa_redacted]";
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
// Bodies are strings inside the exchange JSON: include their second layer of escaping.
const embedded = (json: string) => bytes(json) - 2;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = {
  value: Json;
  parent?: Node;
  key: string;
  size: number;
  removed?: boolean;
};

function shortenText(text: string, budget: number): string {
  let low = 0,
    high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(text.slice(0, mid) + MARKER) <= budget) low = mid;
    else high = mid - 1;
  }
  // Do not split a surrogate pair at the truncation boundary.
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low) + MARKER;
}

/** Keep JSON valid and retain small identity fields before sacrificing containing subtrees. */
function shortenBody(text: string, budget: number): string {
  if (bytes(text) <= budget) return text;
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    return shortenText(text, budget);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return JSON.stringify(MARKER);
  }
  let size = bytes(serialized);
  if (size <= budget) return serialized;
  const root: Node = { value, key: "", size: 0 };
  const nodes: Node[] = [root];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.value !== null && typeof node.value === "object") {
      for (const [key, child] of Object.entries(node.value))
        nodes.push({ value: child, key, parent: node, size: 0 });
    }
  }
  const replacementSize = embedded(JSON.stringify(MARKER));
  const replace = (node: Node) => {
    size -= node.size - replacementSize;
    node.value = MARKER;
    node.removed = true;
    if (node.parent)
      Object.defineProperty(node.parent.value, node.key, {
        value: MARKER,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  };
  const leaves = nodes.filter((node) => typeof node.value === "string");
  for (const node of leaves) node.size = embedded(JSON.stringify(node.value));
  leaves.sort((a, b) => b.size - a.size);
  for (const node of leaves) {
    if (size <= budget) break;
    if (node.size > replacementSize) replace(node);
  }
  if (size > budget) {
    // Compute subtree costs bottom-up once, then discard disjoint largest subtrees.
    for (const node of nodes)
      node.size =
        node.value !== null && typeof node.value === "object"
          ? 2 + Math.max(0, Object.keys(node.value).length - 1)
          : embedded(JSON.stringify(node.value));
    for (let i = nodes.length - 1; i > 0; i--) {
      const node = nodes[i]!,
        parent = node.parent!;
      parent.size +=
        node.size +
        (Array.isArray(parent.value)
          ? 0
          : embedded(JSON.stringify(node.key)) + 1);
    }
    const containers = nodes
      .filter(
        (node) =>
          node !== root &&
          node.value !== null &&
          typeof node.value === "object",
      )
      .sort((a, b) => b.size - a.size);
    for (const node of [...containers, root]) {
      if (size <= budget) break;
      let ancestor = node.parent;
      while (ancestor && !ancestor.removed) ancestor = ancestor.parent;
      if (!ancestor && node.size > replacementSize) replace(node);
    }
  }
  return JSON.stringify(root.value);
}

export interface Redaction {
  request_body?: true;
  response_body?: true;
  metadata?: true;
}
interface Exchange {
  method: string;
  url: string;
  request_body: string | null;
  response_body: string | null;
  request_headers: Record<string, string>;
  response_headers: Record<string, string>;
  redacted?: Redaction;
}

/** Bound the entire serialized exchange, not just its unescaped body text. */
export function redactExchange<T extends Exchange>(
  original: T,
  limit: number,
): T & { redacted?: Redaction } {
  const exchange = { ...original };
  if (bytes(exchange) <= limit) return exchange;
  exchange.redacted = { ...exchange.redacted };
  const fields = ["request_body", "response_body"] as const;
  for (const field of [...fields].sort(
    (a, b) => bytes(exchange[b]) - bytes(exchange[a]),
  )) {
    if (bytes(exchange) <= limit) break;
    const body = exchange[field];
    if (body === null) continue;
    exchange.redacted[field] = true;
    const other = field === "request_body" ? "response_body" : "request_body";
    const available =
      limit -
      bytes({
        ...exchange,
        [field]: null,
        [other]: null,
        redacted: { ...exchange.redacted, [other]: true },
      }) +
      8;
    const budget = Math.max(
      bytes(JSON.stringify(MARKER)),
      Math.min(
        bytes(body),
        available - Math.min(bytes(exchange[other]), Math.floor(available / 2)),
      ),
    );
    exchange[field] = shortenBody(body, budget);
  }
  if (bytes(exchange) > limit) {
    // Pathological headers/URLs still retain an exchange, with explicitly degraded identity.
    exchange.redacted.metadata = true;
    exchange.request_headers = {};
    exchange.response_headers = {};
    if (bytes(exchange.method) > 128) exchange.method = MARKER;
    if (bytes(exchange) > limit) {
      const budget = limit - bytes(exchange) + bytes(exchange.url);
      exchange.url = shortenText(exchange.url, Math.max(bytes(MARKER), budget));
      // Truncation inside an authority can produce an invalid URL (for example brackets in a host).
      try {
        new URL(exchange.url);
      } catch {
        exchange.url = "https://qa-redacted.invalid/";
      }
    }
  }
  if (bytes(exchange) > limit)
    throw new Error("Network capture limit cannot hold exchange metadata");
  return exchange;
}
