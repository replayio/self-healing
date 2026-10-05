import type { AccountDataConfigStore } from "../../src/api/data-config.ts";

// Existing provider fixtures model managed accounts; external routing has its own integration tests.
export const managedDataConfigs = (): AccountDataConfigStore => ({
  read: async () => ({ mode: "managed", revision: 0 }),
  status: async () => ({
    mode: "managed",
    revision: 0,
    availability: "available",
  }),
  put: async () => {
    throw new Error("Configuration writes are not part of this fixture");
  },
});
