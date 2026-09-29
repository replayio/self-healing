import { z } from "zod";
import { ReportDestinations, ReportDestinationUpdate } from "./contracts.ts";
import { HttpError } from "./errors.ts";
import type { qaClient } from "./qa.ts";

const QaWebhook = z.object({ webhookUrlSet: z.boolean() });
const QaProject = z.object({
  id: z.string(),
  summary_destinations: z
    .object({
      email: z
        .object({
          recipients: z.enum(["owner", "members", "custom"]),
          addresses: z.array(z.string()),
        })
        .nullish(),
      slack: QaWebhook.nullish(),
      discord: QaWebhook.nullish(),
    })
    .nullable(),
});

// QA owns destination persistence and delivery. Never relay a whole project response:
// even privileged provider responses must not expose webhook URLs or other secrets.
export function reportDestinations(
  qa: ReturnType<typeof qaClient>,
  projectId: string,
) {
  const path = `/api/projects/${encodeURIComponent(projectId)}`;
  const result = (raw: unknown) => {
    const parsed = QaProject.safeParse(raw);
    if (!parsed.success || parsed.data.id !== projectId)
      throw new HttpError(
        503,
        "qa_contract_changed",
        "QA returned unexpected report destination settings.",
      );
    const d = parsed.data.summary_destinations;
    return ReportDestinations.parse({
      email: d?.email ?? null,
      slack: d?.slack ? { webhook_url_set: d.slack.webhookUrlSet } : null,
      discord: d?.discord ? { webhook_url_set: d.discord.webhookUrlSet } : null,
    });
  };
  return {
    async read() {
      return result(await qa(path));
    },
    async update(input: unknown) {
      const update = ReportDestinationUpdate.parse(input);
      const destinations = {
        ...(update.email === undefined
          ? {}
          : {
              email:
                update.email === null
                  ? null
                  : {
                      recipients: "custom",
                      addresses: [
                        ...new Set(
                          update.email.addresses.map((a) => a.toLowerCase()),
                        ),
                      ],
                    },
            }),
        ...(update.slack === undefined
          ? {}
          : {
              slack:
                update.slack === null
                  ? null
                  : { webhookUrl: update.slack.webhook_url },
            }),
        ...(update.discord === undefined
          ? {}
          : {
              discord:
                update.discord === null
                  ? null
                  : { webhookUrl: update.discord.webhook_url },
            }),
      };
      return result(
        await qa(
          path,
          { action: "update-settings", summary_destinations: destinations },
          undefined,
          "PATCH",
        ),
      );
    },
  };
}
