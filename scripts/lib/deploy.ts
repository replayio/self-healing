export const target = {
  siteId: "48d9b72b-7125-484b-8082-1021cbc84456",
  accountSlug: "replay",
  domain: "self-healing.replay.io",
  databaseHost: "ep-patient-block-arwlhper.c-4.us-west-2.aws.neon.tech",
};

export function deploymentConfig(env: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const token = required("NETLIFY_AUTH_TOKEN");
  const siteId = required("NETLIFY_SITE_ID");
  const accountSlug = required("NETLIFY_ACCOUNT_SLUG");
  const databaseUrl = required("DATABASE_URL");
  if (siteId !== target.siteId || accountSlug !== target.accountSlug) {
    throw new Error(
      "Refusing to deploy to a site other than the provisioned Self Healing site",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname.replace("-pooler.", ".") !== target.databaseHost
  ) {
    throw new Error(
      "DATABASE_URL must reference the provisioned Self Healing database",
    );
  }
  const runtime = Object.fromEntries(
    [
      "SELF_HEALING_SECRET",
      "REPLAY_QA_PROVISIONING_TOKEN",
      "REPLAY_QA_URL",
      "SELF_HEALING_URL",
    ].flatMap((name) => (env[name] ? [[name, env[name]!]] : [])),
  );
  return { token, siteId, accountSlug, databaseUrl, runtime };
}

type EnvValue = {
  context: string;
  value: string;
  context_parameter?: string | null;
};
type EnvRecord = { key: string; scopes: string[]; values: EnvValue[] };
export function productionValues(existing: EnvValue[], value: string) {
  // Preserve branch/preview values. Never install production credentials into "all".
  return [
    ...existing.filter(
      (item) => item.context !== "production" && item.context !== "all",
    ),
    { context: "production", value },
  ];
}

export function netlifyApi(token: string, request: typeof fetch = fetch) {
  return async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(`https://api.netlify.com/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      throw new Error(`Netlify ${method} request failed`);
    }
    if (!response.ok)
      throw new Error(
        `Netlify ${method} request returned HTTP ${response.status}`,
      );
    if (response.status === 204) return undefined;
    return response.json();
  };
}

export async function syncRuntimeSecrets(
  config: ReturnType<typeof deploymentConfig>,
  request: typeof fetch = fetch,
) {
  const api = netlifyApi(config.token, request);
  const site = (await api(`/sites/${config.siteId}`)) as {
    account_slug: string;
    custom_domain: string;
  };
  if (
    site.account_slug !== target.accountSlug ||
    site.custom_domain !== target.domain
  ) {
    throw new Error(
      "Netlify site ownership/domain does not match Self Healing",
    );
  }
  const path = `/accounts/${config.accountSlug}/env`;
  const query = `?site_id=${config.siteId}`;
  const records = (await api(path + query)) as EnvRecord[];
  const previous = records.find((record) => record.key === "DATABASE_URL");
  const record: EnvRecord = {
    key: "DATABASE_URL",
    scopes: ["functions"],
    values: productionValues(previous?.values ?? [], config.databaseUrl),
  };
  if (previous) await api(`${path}/DATABASE_URL${query}`, "PUT", record);
  else await api(path + query, "POST", [record]);
  for (const [key, value] of Object.entries(config.runtime)) {
    const existing = records.find((item) => item.key === key);
    const record = {
      key,
      scopes: ["functions"],
      values: productionValues(existing?.values ?? [], value),
    };
    if (existing) await api(`${path}/${key}${query}`, "PUT", record);
    else await api(path + query, "POST", [record]);
  }
  // Remove the retired credential map if an operator previously installed one.
  // This dedicated site no longer accepts these keys in any context.
  for (const key of ["SELF_HEALING_API_KEYS", "REPLAY_QA_API_TOKEN"]) {
    if (records.some((item) => item.key === key))
      await api(`${path}/${key}${query}`, "DELETE");
  }
}
