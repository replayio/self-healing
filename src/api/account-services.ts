import { getAccountService } from "./accounts.ts";
import {
  getDataConfigStore,
  type AccountDataConfigStore,
} from "./data-config.ts";
import { getConnectionService } from "./connections.ts";
import { createQAClient, type QAClient } from "./qa.ts";
import { HttpError } from "./errors.ts";

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
    const configuration = await (
      dependencies.dataConfigs ?? getDataConfigStore
    )().status(accountId);
    if (configuration.mode === "external") {
      // Do not send a guessed routing header to an older QA deployment: it may ignore it
      // and persist customer data in managed storage. Add an explicit external adapter here.
      throw new HttpError(
        501,
        "external_qa_not_implemented",
        "External QA data services are not implemented. No QA request was sent.",
      );
    }
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
