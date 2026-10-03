/** Generic local-state evidence. Values are reduced before entering capture buffers. */
export type CapturedValue =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "string" | "number" | "opaque"; redacted: true }
  | {
      type: "object";
      fields: Array<{ name: string; value: CapturedValue }>;
      truncated: boolean;
    }
  | { type: "array"; items: CapturedValue[]; truncated: boolean }
  | { type: "truncated" };

// Static field names remain useful; dynamic names may themselves carry user data or tokens.
export function storageLabel(name: string, fallback: string): string {
  return /^[a-zA-Z_$][a-zA-Z_$-]{0,39}$/.test(name) ? name : fallback;
}
export function captureValue(input: unknown): CapturedValue {
  let remaining = 128;
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): CapturedValue {
    if (--remaining < 0 || depth > 8) return { type: "truncated" };
    if (value === null) return { type: "null" };
    if (typeof value === "boolean") return { type: "boolean", value };
    if (typeof value === "number") return { type: "number", redacted: true };
    if (typeof value === "string") {
      if (value.length <= 64_000 && /^[\s]*[\[{]/.test(value)) {
        try {
          return visit(JSON.parse(value), depth + 1);
        } catch {
          /* plain string */
        }
      }
      return { type: "string", redacted: true };
    }
    if (typeof value !== "object") return { type: "opaque", redacted: true };
    if (seen.has(value)) return { type: "truncated" };
    seen.add(value);
    if (Array.isArray(value))
      return {
        type: "array",
        items: value.slice(0, 16).map((item) => visit(item, depth + 1)),
        truncated: value.length > 16,
      };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return { type: "opaque", redacted: true };
    const keys = Object.keys(value);
    return {
      type: "object",
      fields: keys.slice(0, 32).map((key, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return {
          name: storageLabel(key, `field-${i}`),
          value:
            descriptor && "value" in descriptor
              ? visit(descriptor.value, depth + 1)
              : { type: "opaque", redacted: true },
        };
      }),
      truncated: keys.length > 32,
    };
  }
  return visit(input, 0);
}
export interface LocalEntry {
  slot: string;
  name: string;
  path?: string[];
  value: CapturedValue;
}
export interface LocalArea {
  area: "localStorage" | "sessionStorage" | "cookie" | "indexedDB";
  observable: boolean;
  truncated: boolean;
  entries: LocalEntry[];
}
export function createStorageObserver() {
  const slots = new Map<string, string>();
  return (
    browser: Window,
  ): { areas: LocalArea[]; http_only_cookies: "unobservable" } => {
    const areas = (["localStorage", "sessionStorage", "cookie"] as const).map(
      (area) => {
        try {
          const entries: LocalEntry[] = [];
          let truncated = false;
          let bytes = 0;
          const add = (key: string, value: unknown) => {
            const identity = area + ":" + key;
            let slot = slots.get(identity);
            if (!slot && slots.size < 512) {
              slot = `slot-${slots.size}`;
              slots.set(identity, slot);
            }
            if (!slot) {
              truncated = true;
              return;
            }
            const entry: LocalEntry = {
              slot,
              name: storageLabel(key, slot),
              value: captureValue(value),
            };
            const size = new TextEncoder().encode(
              JSON.stringify(entry),
            ).byteLength;
            if (bytes + size > 4096) {
              entry.value = { type: "truncated" };
              truncated = true;
            }
            bytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
            if (bytes <= 4096) entries.push(entry);
            else truncated = true;
          };
          if (area === "cookie") {
            const cookies = browser.document.cookie
              .split(";")
              .filter((item) => item.trim());
            truncated = cookies.length > 32;
            for (const cookie of cookies.slice(0, 32)) {
              const end = cookie.indexOf("=");
              if (end < 0) continue;
              // Cookie contents are opaque, even when they resemble JSON.
              add(cookie.slice(0, end).trim(), undefined);
            }
          } else {
            const storage = browser[area];
            truncated = storage.length > 32;
            for (let i = 0; i < Math.min(storage.length, 32); i++) {
              const key = storage.key(i);
              if (key !== null) add(key, storage.getItem(key));
            }
          }
          return {
            area,
            observable: true,
            truncated,
            entries: entries.sort((a, b) => a.slot.localeCompare(b.slot)),
          };
        } catch {
          return { area, observable: false, truncated: false, entries: [] };
        }
      },
    );
    return { areas, http_only_cookies: "unobservable" };
  };
}

/** Observe same-document writes too: the native storage event only reaches other documents. */
export function watchStorageWrites(
  browser: Window,
  changed: () => void,
): () => void {
  let prototype: object;
  try {
    prototype = Object.getPrototypeOf(browser.localStorage);
  } catch {
    return () => {};
  }
  const restores: Array<() => void> = [];
  for (const name of ["setItem", "removeItem", "clear"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (
      !descriptor ||
      typeof descriptor.value !== "function" ||
      !descriptor.configurable
    )
      continue;
    const original = descriptor.value;
    const wrapper = function (this: Storage, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      try {
        changed();
      } catch {
        /* instrumentation cannot affect application writes */
      }
      return result;
    };
    try {
      Object.defineProperty(prototype, name, { ...descriptor, value: wrapper });
      restores.push(() => {
        if (Object.getOwnPropertyDescriptor(prototype, name)?.value === wrapper)
          Object.defineProperty(prototype, name, descriptor);
      });
    } catch {
      /* lifecycle snapshots still work when instrumentation is unavailable */
    }
  }
  return () => restores.forEach((restore) => restore());
}
