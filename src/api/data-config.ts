import { z } from "zod";
import { DataConfigInput, DataConfigStatus, type AccountDataConfigStatus } from "./contracts.ts";
import { getAccountService } from "./accounts.ts";
import { createQAClient, type QAClient } from "./qa.ts";

/** QA owns persistence. Self Healing forwards only with the authenticated account's QA token. */
export interface AccountDataConfigStore {
  status(accountId: string): Promise<AccountDataConfigStatus>;
  put(accountId: string, input: z.infer<typeof DataConfigInput>): Promise<AccountDataConfigStatus>;
}

export function dataConfigStore(client: (accountId: string) => Promise<QAClient>): AccountDataConfigStore {
  return {
    async status(accountId) {
      const qa = await client(accountId);
      return DataConfigStatus.parse(await qa("/api/account-data-config"));
    },
    async put(accountId, raw) {
      const input = DataConfigInput.parse(raw);
      const qa = await client(accountId);
      return DataConfigStatus.parse(await qa("/api/account-data-config", input, undefined, "PUT"));
    },
  };
}

export function getDataConfigStore(): AccountDataConfigStore {
  return dataConfigStore(async accountId => {
    const { qaToken } = await getAccountService().credentials(accountId);
    return createQAClient({ origin: process.env.REPLAY_QA_URL ?? "https://qa.replay.io", token: qaToken });
  });
}
