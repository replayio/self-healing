import { z } from "zod";
import {
  DataConfigInput,
  ExternalDataConfig,
  type AccountDataConfigStatus,
  type ExternalAccountDataConfig,
} from "./contracts.ts";
import { credentialVault } from "./credentials.ts";
import { HttpError } from "./errors.ts";
import { getQuery, type Query } from "./store.ts";

export type AccountDataConfiguration =
  | { mode: "managed"; revision: 0 }
  | {
      mode: "external";
      revision: number;
      configuration: ExternalAccountDataConfig;
    };

/** The only boundary that decrypts account data-service access material. */
export interface AccountDataConfigStore {
  read(accountId: string): Promise<AccountDataConfiguration>;
  status(accountId: string): Promise<AccountDataConfigStatus>;
  put(
    accountId: string,
    input: z.infer<typeof DataConfigInput>,
  ): Promise<AccountDataConfigStatus>;
}

const Row = z.object({
  revision: z.number().int().positive(),
  fingerprint: z.string(),
  encrypted_configuration: z.string(),
});
const managed = {
  mode: "managed",
  revision: 0,
  availability: "available",
} as const;
const external = (revision: number): AccountDataConfigStatus => ({
  mode: "external",
  revision,
  availability: "unsupported",
});
const binding = (accountId: string, fingerprint: string) =>
  `account-data-config:v1:${accountId}:${fingerprint}`;

export function dataConfigStore(
  query: Query,
  vault = credentialVault(),
): AccountDataConfigStore {
  return {
    async read(accountId) {
      const [value] = await query(
        "SELECT revision, fingerprint, encrypted_configuration FROM account_data_configs WHERE account_id=$1",
        [accountId],
      );
      if (!value) return { mode: "managed", revision: 0 };
      const row = Row.parse(value);
      return {
        mode: "external",
        revision: row.revision,
        configuration: ExternalDataConfig.parse(
          JSON.parse(
            vault.decrypt(
              row.encrypted_configuration,
              binding(accountId, row.fingerprint),
            ),
          ),
        ),
      };
    },
    async status(accountId) {
      const [row] = await query(
        "SELECT revision FROM account_data_configs WHERE account_id=$1",
        [accountId],
      );
      return row
        ? external(z.number().int().positive().parse(row.revision))
        : managed;
    },
    async put(accountId, raw) {
      // Schema parsing also establishes a deterministic property order for retry fingerprints.
      const input = DataConfigInput.parse(raw);
      const serialized = JSON.stringify(input.configuration);
      const fingerprint = vault.identity(`${accountId}\0${serialized}`);
      const encrypted = vault.encrypt(
        serialized,
        binding(accountId, fingerprint),
      );
      const [row] = await query(
        `
        INSERT INTO account_data_configs(account_id, revision, fingerprint, encrypted_configuration)
        SELECT $1, 1, $2, $3 WHERE $4=0 OR EXISTS (SELECT 1 FROM account_data_configs WHERE account_id=$1)
        ON CONFLICT(account_id) DO UPDATE SET
          revision=CASE WHEN account_data_configs.fingerprint=$2 THEN account_data_configs.revision ELSE account_data_configs.revision+1 END,
          fingerprint=$2, encrypted_configuration=$3,
          updated_at=CASE WHEN account_data_configs.fingerprint=$2 THEN account_data_configs.updated_at ELSE now() END
        WHERE account_data_configs.revision=$4 OR account_data_configs.fingerprint=$2
        RETURNING revision`,
        [accountId, fingerprint, encrypted, input.expected_revision],
      );
      if (!row)
        throw new HttpError(
          409,
          "data_config_conflict",
          "Read the current configuration revision before replacing it.",
        );
      return external(z.number().int().positive().parse(row.revision));
    },
  };
}

export function getDataConfigStore(): AccountDataConfigStore {
  return dataConfigStore(getQuery());
}
