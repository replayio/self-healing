import { getAccountService } from "./accounts.ts";
import {
  getDataConfigStore,
  type AccountDataConfigStore,
} from "./data-config.ts";
import { getConnectionService } from "./connections.ts";
import { createQAClient, type QAClient } from "./qa.ts";
import { requireAccountWork } from "./account-policy.ts";

export interface AccountServices {
  qa: QAClient;
  subtextKey: string;
  connections: ReturnType<typeof getConnectionService>;
}
export type AccountServiceResolver = (
  authenticatedAccountId: string,
) => Promise<AccountServices>;

/** Compose service adapters once per authenticated request, never in individual operations. */
export function accountServiceResolver(
  dependencies: {
    accounts?: typeof getAccountService;
    dataConfigs?: () => AccountDataConfigStore;
    connections?: typeof getConnectionService;
    qaOrigin?: string;
    request?: typeof fetch;
  } = {},
): AccountServiceResolver {
  return async (accountId) => {
    await requireAccountWork(accountId, (dependencies.dataConfigs ?? getDataConfigStore)());
    const credentials = await (
      dependencies.accounts ?? getAccountService
    )().credentials(accountId);
    const qa = createQAClient(
      {
        origin:
          dependencies.qaOrigin ??
          process.env.REPLAY_QA_URL ??
          "https://qa.replay.io",
        token: credentials.qaToken,
      },
      dependencies.request,
    );
    return {
      qa,
      subtextKey: credentials.subtextKey,
      connections: (dependencies.connections ?? getConnectionService)(
        credentials.qaToken,
        qa,
      ),
    };
  };
}
