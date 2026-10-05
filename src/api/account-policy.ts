import { getDataConfigStore, type AccountDataConfigStore } from "./data-config.ts";
import { HttpError } from "./errors.ts";

/** Shared admission boundary for requests and authenticated provider callbacks. */
export async function requireAccountWork(
  accountId: string,
  store: AccountDataConfigStore = getDataConfigStore(),
): Promise<void> {
  const configuration = await store.status(accountId);
  if (configuration.mode === "external") {
    throw new HttpError(
      501,
      "external_qa_not_implemented",
      "External QA data services are not implemented. No provider work request was sent.",
    );
  }
}
