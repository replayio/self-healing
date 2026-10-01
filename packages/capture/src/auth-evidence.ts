/** Only presence leaves the browser; raw keys remain local and Web Storage values are never read. */
export type StorageArea = "localStorage" | "sessionStorage" | "cookie";
export interface StorageAlias {
  area: StorageArea;
  key: string;
  alias: string;
}
export function createStorageObserver(aliases: StorageAlias[] = []) {
  if (aliases.length > 64)
    throw new Error("At most 64 storage aliases are supported");
  const slots = new Map<string, string>();
  for (const item of aliases) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(item.alias))
      throw new Error("Storage aliases must be non-sensitive lowercase labels");
  }
  return (browser: Window) => {
    const areas = (["localStorage", "sessionStorage", "cookie"] as const).map(
      (area) => {
        try {
          const names: string[] = [];
          let truncated = false;
          if (area === "cookie") {
            // document.cookie necessarily returns values; discard them locally without buffering.
            const cookies = browser.document.cookie.split(";");
            truncated = cookies.length > 32;
            for (const cookie of cookies.slice(0, 32)) {
              const end = cookie.indexOf("=");
              if (end >= 0) names.push(cookie.slice(0, end).trim());
            }
          } else {
            const storage = browser[area];
            truncated = storage.length > 32;
            for (let i = 0; i < Math.min(storage.length, 32); i++) {
              const key = storage.key(i);
              if (key !== null) names.push(key);
            }
          }
          const entries = names.map((key) => {
            const identity = area + ":" + key;
            let slot = slots.get(identity);
            if (!slot && slots.size < 512) {
              slot = "slot-" + slots.size;
              slots.set(identity, slot);
            }
            const alias = aliases.find(
              (item) => item.area === area && item.key === key,
            )?.alias;
            return slot
              ? { slot, ...(alias ? { alias } : {}), present: true }
              : null;
          });
          return {
            area,
            observable: true,
            truncated: truncated || entries.includes(null),
            entries: entries
              .filter((entry) => entry !== null)
              .sort((a, b) => a.slot.localeCompare(b.slot)),
          };
        } catch {
          return { area, observable: false, truncated: false, entries: [] };
        }
      },
    );
    return { areas, http_only_cookies: "unobservable" as const };
  };
}
