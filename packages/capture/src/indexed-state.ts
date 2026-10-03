import {
  captureValue,
  storageLabel,
  type LocalArea,
  type LocalEntry,
} from "./local-state.js";

/** Read existing stores without upgrading databases or delaying application work. */
export async function readIndexedState(browser: Window): Promise<LocalArea> {
  const area: LocalArea = {
    area: "indexedDB",
    observable: true,
    truncated: false,
    entries: [],
  };
  const connections = new Set<IDBDatabase>();
  const transactions = new Set<IDBTransaction>();
  let stopped = false;
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  const cleanup = () => {
    stopped = true;
    for (const tx of transactions) {
      try {
        tx.abort();
      } catch {
        /* already complete */
      }
    }
    for (const db of connections) db.close();
  };
  const timeout = new Promise<LocalArea>((resolve) => {
    timer = setTimeout(() => {
      area.truncated = true;
      cleanup();
      resolve(area);
    }, 500);
  });
  const scan = async () => {
    try {
      const factory = browser.indexedDB;
      if (!factory?.databases) {
        area.observable = false;
        return area;
      }
      const databases = await factory.databases();
      if (stopped) return area;
      area.truncated = databases.length > 16;
      for (const info of databases.slice(0, 16)) {
        if (stopped) break;
        if (!info.name) continue;
        await new Promise<void>((resolve) => {
          const open = factory.open(info.name!);
          // A database could have been deleted since enumeration. Never recreate it.
          open.onupgradeneeded = () => open.transaction?.abort();
          open.onerror = open.onblocked = () => {
            area.truncated = true;
            resolve();
          };
          open.onsuccess = () => {
            const db = open.result;
            if (stopped) {
              db.close();
              resolve();
              return;
            }
            connections.add(db);
            db.onversionchange = () => {
              area.truncated = true;
              db.close();
            };
            const names = Array.from(db.objectStoreNames);
            if (!names.length) {
              db.close();
              resolve();
              return;
            }
            if (names.length > 16) area.truncated = true;
            try {
              const tx = db.transaction(names.slice(0, 16), "readonly");
              transactions.add(tx);
              const finish = () => {
                transactions.delete(tx);
                db.close();
                resolve();
              };
              tx.oncomplete = finish;
              tx.onabort = tx.onerror = () => {
                area.truncated = true;
                finish();
              };
              for (const name of names.slice(0, 16)) {
                const request = tx.objectStore(name).openCursor();
                request.onerror = () => {
                  area.truncated = true;
                };
                request.onsuccess = () => {
                  if (stopped) return;
                  const cursor = request.result;
                  if (!cursor) return;
                  if (area.entries.length >= 32) {
                    area.truncated = true;
                    return;
                  }
                  const slot = `slot-${area.entries.length}`;
                  // Record keys may identify users. Retain the store path, not the primary key.
                  const entry: LocalEntry = {
                    slot,
                    name: storageLabel(name, slot),
                    path: [
                      storageLabel(db.name, "database"),
                      storageLabel(name, "store"),
                    ],
                    value: captureValue(cursor.value),
                  };
                  const size = new TextEncoder().encode(
                    JSON.stringify(entry),
                  ).byteLength;
                  if (bytes + size > 4096) {
                    area.truncated = true;
                    return;
                  }
                  bytes += size;
                  area.entries.push(entry);
                  cursor.continue();
                };
              }
            } catch {
              area.truncated = true;
              db.close();
              resolve();
            }
          };
        });
      }
    } catch {
      area.observable = false;
    }
    return area;
  };
  try {
    return await Promise.race([scan(), timeout]);
  } finally {
    clearTimeout(timer!);
    cleanup();
  }
}
