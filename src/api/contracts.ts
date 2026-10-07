import { z } from "zod";

export const Id = z.string().uuid();
const Text = z.string().trim().min(1).max(10000);
const Url = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//.test(value), "Expected an HTTP(S) URL");
const HttpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "Expected an HTTPS URL");
const Timestamp = z.string().datetime();
const Ref = z.string().trim().min(1).max(200);
const object = z.object;
export const ErrorResponse = object({
  error: object({ code: z.string(), message: z.string(), request_id: Id }),
});
export const PageQuery = object({
  cursor: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const page = (item: z.ZodTypeAny) =>
  object({ items: z.array(item), next_cursor: Id.nullable() });
export const ProjectInput = object({
  name: z.string().trim().min(1).max(200),
  repository_url: HttpsUrl,
  production_url: HttpsUrl,
  default_branch: Ref.default("main"),
}).strict();
export const ProjectPatch = ProjectInput.partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Provide at least one field",
  );
export const Project = ProjectInput.extend({
  id: Id,
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type ProjectRecord = z.infer<typeof Project>;
export type ProjectCreate = z.infer<typeof ProjectInput>;

export const configurations = {
  integrations: object({
    subtext_project_id: Ref.optional(),
    replay_project_id: Ref.optional(),
    fullstory_org_id: Ref.optional(),
    // Desired links only; ownership must be established through Subtext.
  }).strict(),
  context: object({
    documents: z
      .array(
        object({
          title: Ref,
          url: HttpsUrl.optional(),
          content: Text.optional(),
        })
          .strict()
          .refine(
            (value) => !!value.url || !!value.content,
            "Supply url or content",
          ),
      )
      .max(100),
  }).strict(),
  sightmap: object({
    commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
    entries: z
      .array(
        object({
          path: Ref,
          purpose: Text,
          routes: z.array(Ref).max(100).default([]),
        }).strict(),
      )
      .max(1000),
  }).strict(),
  environments: object({
    environments: z
      .array(
        object({
          name: Ref,
          url: Url,
          kind: z.enum(["production", "prerelease"]),
          qa_enabled: z.boolean(),
          schedule: z.enum(["manual", "hourly", "daily"]),
        }).strict(),
      )
      .max(20)
      .refine(
        (items) =>
          new Set(items.map((item) => item.name)).size === items.length,
        "Environment names must be unique",
      ),
    test_pull_requests: z.boolean(),
  }).strict(),
  "report-settings": object({
    enabled: z.boolean(),
    cadence: z.enum(["daily", "weekly"]),
    hour_utc: z.number().int().min(0).max(23),
    weekday_utc: z.number().int().min(0).max(6).default(1),
    destinations: z
      .array(
        z.discriminatedUnion("type", [
          object({
            type: z.literal("email"),
            address: z.string().email(),
          }).strict(),
          object({
            type: z.literal("slack"),
            channel_id: Ref,
            credential_ref: Ref,
          }).strict(),
        ]),
      )
      .max(20),
  })
    .strict()
    .refine(
      (value) => !value.enabled || value.destinations.length > 0,
      "Enabled reports need a destination",
    ),
};
export type ConfigurationKind = keyof typeof configurations;

const Evidence = object({
  provider: z.enum(["fullstory", "replay"]),
  url: HttpsUrl,
  summary: Text,
});
const Bug = object({
  id: Id,
  title: Ref,
  category: z.enum(["ux", "performance", "security", "visual", "functional"]),
  status: z.enum(["open", "claimed", "fix_submitted", "verified", "dismissed"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  description: Text,
  reproduction_steps: z.array(Text),
  root_cause: Text.nullable(),
  evidence: z.array(Evidence),
  updated_at: Timestamp,
});
const Run = object({
  id: Id,
  status: z.enum(["queued", "running", "passed", "failed", "cancelled"]),
  kind: z.enum(["release", "pull_request", "fix_verification"]),
  target_url: Url,
  commit_sha: z.string(),
  bug_ids: z.array(Id),
  evidence: z.array(Evidence),
  created_at: Timestamp,
});
const Fix = object({
  id: Id,
  bug_id: Id,
  pull_request_url: HttpsUrl,
  head_sha: z.string(),
  verification_run_id: Id.nullable(),
  status: z.enum([
    "awaiting_verification",
    "verifying",
    "verified",
    "failed",
    "merged",
    "closed",
  ]),
  verified_sha: z.string().nullable(),
  created_at: Timestamp,
});
const Report = object({
  id: Id,
  period_start: Timestamp,
  period_end: Timestamp,
  summary: Text,
  behavior_trends: z.array(Text),
  friction_points: z.array(Text),
  bug_ids: z.array(Id),
  fix_ids: z.array(Id),
  evidence: z.array(Evidence),
  delivery_status: z.enum(["pending", "delivered", "failed"]),
  created_at: Timestamp,
});
const Job = object({
  id: Id,
  status: z.enum(["queued", "running", "completed", "failed"]),
  result_url: Url.nullable(),
  error: z.string().nullable(),
});
const Sha = z.string().regex(/^[a-f0-9]{40}$/);

export interface Operation {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  summary: string;
  implemented: boolean;
  public?: boolean;
  dashboard?: boolean;
  pipeline?: boolean;
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  pathParameters?: Record<string, z.ZodTypeAny>;
  response: z.ZodTypeAny;
  status?: number;
  description?: string;
}
const prefix = "/api/v1/projects/{project_id}";
const pending = (operation: Omit<Operation, "implemented">): Operation => ({
  ...operation,
  implemented: false,
});
// The connection API is Obvious's operational entry point. Auxiliary payloads use
// QA's versioned namespace/key envelope; QA validates each supported payload schema.
export const AuxiliaryArtifact = z
  .object({
    namespace: z.enum(["network", "interaction", "session"]),
    key: z.enum([
      "captured-exchanges",
      "captured-interactions",
      "metrics",
      "identity",
      "capture-context",
      "capture-producer",
    ]),
    schema_version: z.literal(1),
    payload: z.record(z.unknown()),
  })
  .strict()
  .refine(
    (artifact) =>
      ({
        network: ["captured-exchanges"],
        interaction: ["captured-interactions"],
        session: ["metrics", "identity", "capture-context", "capture-producer"],
      })[artifact.namespace].includes(artifact.key),
    "Unsupported auxiliary namespace/key pair",
  );
const ConnectionInput = object({
  start_exploration: z
    .boolean()
    .optional()
    .describe(
      "Start initial base-site QA only after user opt-in. Defaults to false for new connections; omitted on retries preserves the saved choice.",
    ),
  name: z.string().trim().min(1).max(100),
  production_url: Url,
});
const ConnectionResponse = object({
  start_exploration: z.boolean(),
  id: Id,
  qa_project_id: z.string().nullable(),
  status: z.enum(["connected", "pending"]),
});
const connectionPath = "/api/v1/connection";
function reportWebhook(channel: "slack" | "discord") {
  return z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine(
      (value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return false;
        }
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          url.search ||
          url.hash
        )
          return false;
        return channel === "slack"
          ? url.hostname === "hooks.slack.com" &&
              /^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
          : /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(url.hostname) &&
              /^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname);
      },
      `Use a valid HTTPS ${channel === "slack" ? "Slack incoming" : "Discord channel"} webhook URL`,
    );
}
export const ReportDestinationUpdate = z
  .object({
    email: z
      .object({
        addresses: z.array(z.string().trim().email().max(320)).min(1).max(100),
      })
      .strict()
      .nullable()
      .optional(),
    slack: z
      .object({ webhook_url: reportWebhook("slack") })
      .strict()
      .nullable()
      .optional(),
    discord: z
      .object({ webhook_url: reportWebhook("discord") })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Supply at least one destination to update",
  );
export const ReportDestinations = z.object({
  email: z
    .object({
      recipients: z.enum(["custom", "owner", "members"]),
      addresses: z.array(z.string()),
    })
    .nullable(),
  slack: z.object({ webhook_url_set: z.boolean() }).nullable(),
  discord: z.object({ webhook_url_set: z.boolean() }).nullable(),
});
const connectionOperations: Operation[] = [
  {
    id: "getReportDestinations",
    method: "GET",
    path: connectionPath + "/report-destinations",
    summary: "Read the destinations for completed daily reports",
    implemented: true,
    response: ReportDestinations,
    description:
      "Reads this account's QA project configuration. Webhook URLs are never returned. Configuration is not proof of delivery.",
  },
  {
    id: "updateReportDestinations",
    method: "PATCH",
    path: connectionPath + "/report-destinations",
    summary: "Configure email, Slack or Discord delivery of daily reports",
    implemented: true,
    body: ReportDestinationUpdate,
    response: ReportDestinations,
    description:
      "Updates only supplied channels; omitted channels are preserved and null disables a channel. Email uses explicit custom addresses, not the QA service account owner. Slack/Discord webhook URLs are write-only secrets. QA delivers future completed daily reports; saving does not send a test message or prove delivery.",
  },

  {
    id: "connect",
    method: "POST",
    path: connectionPath,
    summary: "Create or recover one QA project for this account",
    implemented: true,
    body: ConnectionInput,
    response: ConnectionResponse,
  },
  {
    id: "connection",
    method: "GET",
    path: connectionPath,
    summary: "Read this key's QA connection",
    implemented: true,
    response: ConnectionResponse,
  },
  {
    id: "ingestSession",
    method: "POST",
    path: connectionPath + "/sessions",
    summary:
      "Register a session and upload auxiliary data through Self Healing",
    implemented: true,
    description:
      "Use a server-side capture proxy. Retry failed uploads with identical event IDs. QA automatically schedules reviews after 15 minutes without new uploads, on its next 15-minute scheduler tick. Uploads do not seal sessions. The legacy complete field is ignored. QA validates the versioned artifact schemas.",
    body: object({
      session_url: Url,
      auxiliary_data: z.array(AuxiliaryArtifact).max(10).default([]),
      complete: z
        .boolean()
        .default(false)
        .describe(
          "Deprecated; ignored. Reviews are scheduled automatically after upload inactivity.",
        ),
    }),
    response: z
      .object({ session_id: z.string(), status: z.string() })
      .passthrough(),
  },
  {
    id: "connectionReviews",
    method: "GET",
    path: connectionPath + "/reviews",
    summary: "Read session review results and processing state",
    implemented: true,
    query: object({
      page: z.coerce.number().int().min(0).max(10000).default(0),
      reviewer: z
        .enum(["goals-and-outcomes", "friction-and-recovery"])
        .default("friction-and-recovery"),
    }),
    response: z.object({}).passthrough(),
  },
  {
    id: "connectionReport",
    method: "POST",
    path: connectionPath + "/reports",
    summary: "Read or await the scheduled daily behavior report",
    implemented: true,
    description:
      "QA generates daily reports at 08:00 UTC. This operation reads the scheduled report without rerunning or replacing existing work. Request yesterday after 08:00 UTC.",
    body: object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    response: z.object({ status: z.string() }).passthrough(),
  },
  {
    id: "connectionReports",
    method: "GET",
    path: connectionPath + "/reports",
    summary: "Read daily behavior reports and their sources",
    query: object({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    implemented: true,
    response: z.object({}).passthrough(),
  },
];
export const agentSkills = [
  {
    id: "setup-self-healing",
    name: "Set up Self Healing",
    description:
      "Provision an account, connect this project, install session capture, choose daily report destinations, and verify delivery of real session captures to Self Healing.",
    path: "/api/v1/skills/setup-self-healing/SKILL.md",
  },
  {
    id: "operate-self-healing",
    name: "Operate Self Healing",
    description:
      "Monitor bugs every 15 minutes, triage reports, record WONTFIX reasons, create fix PRs, and verify previews with QA through Self Healing.",
    path: "/api/v1/skills/operate-self-healing/SKILL.md",
  },
  {
    id: "update-self-healing",
    name: "Update Self Healing",
    description:
      "Update an existing capture package and application integration using the target release's migrations, then verify real session delivery.",
    path: "/api/v1/skills/update-self-healing/SKILL.md",
  },
] as const;
const SkillCatalog = z.object({
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      url: z.string().url(),
    }),
  ),
});
const Discovery = z.object({
  name: z.string(),
  openapi_url: z.string().url(),
  skills_url: z.string().url(),
  setup_skill_url: z.string().url(),
  instructions: z.string(),
  authentication: z.string(),
});

// Dashboard contracts are shared by the handler, browser, and OpenAPI.
export const DashboardDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (day) =>
      Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day,
    "Use a valid calendar date",
  );
const Count = z.number().int().nonnegative();
export const DashboardBug = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.string(),
  status: z.string(),
  discovered_at: z.string(),
  url: z.string().startsWith("/dashboard?tab=bugs&bug="),
  kind: z.string().nullable(),
  fix_prs: z.array(
    z.object({
      repo_full_name: z.string(),
      pr_number: z.number().int().positive(),
      url: HttpsUrl,
      state: z.string().nullable(),
    }),
  ),
});
export const DashboardEvidence = z.object({
  // QA can emit evidence without a tool name. Preserve it under a generic label.
  tool: z.string().default("Evidence"),
  params: z.record(z.unknown()).optional(),
  result: z.string().nullish(),
});
const DashboardAnalysisSection = z.object({
  text: z.string(),
  evidence: z.array(DashboardEvidence).optional(),
});
export const DashboardBugDetail = DashboardBug.extend({
  description: z.string().nullable(),
  reproduction_steps: z.string().nullable(),
  expected_behavior: z.string().nullable(),
  actual_behavior: z.string().nullable(),
  notes: z.string().nullable(),
  resolution: z.string().nullable(),
  analysis: z
    .object({
      impact: z.string().nullish(),
      root_cause: DashboardAnalysisSection.nullish(),
      chain: z.array(DashboardAnalysisSection).optional(),
      chronology: z
        .array(
          z.object({
            text: z.string().optional(),
            evidence: z.array(DashboardEvidence).optional(),
            screenshot_url: HttpsUrl.nullable().optional(),
          }),
        )
        .optional(),
    })
    .nullable(),
});
// Provider IDs are opaque QA identifiers, not local UUIDs.
export const QAId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const PipelineBug = DashboardBugDetail.extend({
  test_run_id: QAId.nullable(),
  recording_urls: z.array(HttpsUrl),
  fix_reference: HttpsUrl,
});
export const BugUpdateInput = z
  .object({
    status: z.enum(["open", "fixed", "wontfix", "invalid"]),
    reason: z.string().trim().min(1).max(20000).optional(),
  })
  .strict()
  .refine(
    (input) =>
      !["wontfix", "invalid"].includes(input.status) ||
      input.reason !== undefined,
    {
      message: "A reason is required for wontfix and invalid dispositions.",
      path: ["reason"],
    },
  );
export const FixPrInput = z
  .object({
    bug_id: QAId,
    pr_url: z
      .string()
      .url()
      .regex(
        /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/[1-9][0-9]*$/,
      ),
  })
  .strict();
export const VerificationInput = FixPrInput.extend({
  head_sha: Sha,
  preview_url: HttpsUrl,
}).strict();
export const BugVerification = VerificationInput.extend({
  run_id: QAId,
  status: z.string(),
  outcome_status: z.string().nullable(),
  outcome_reason: z.string().nullable(),
  bugs_found_count: Count,
  recording_urls: z.array(HttpsUrl),
  created_at: z.string(),
});
export const BugVerifications = z.object({
  items: z.array(BugVerification),
  page: Count,
  has_more: z.boolean(),
});
// QA aggregate responses are validated server-side before projection into the dashboard API.
export const QABugAggregates = z.object({
  project_id: z.string(),
  statuses: z.array(
    z.object({ status: z.string(), total: Count, in_period: Count }),
  ),
});
export const QASessionAggregateCounts = z.object({
  sessions: Count,
  reviewed_sessions: Count,
  sessions_with_bugs: Count,
  sessions_with_observations: Count,
  sessions_with_both: Count,
});
export const QASessionAggregates = z.object({
  project_id: z.string(),
  all_time_sessions: Count,
  totals: QASessionAggregateCounts,
  series: z.array(
    QASessionAggregateCounts.extend({
      start: z.string().datetime({ offset: true }),
    }),
  ),
});
export const DashboardOverview = z.object({
  name: z.string(),
  open_bugs: Count,
  fixed_bugs: Count,
  wontfix_bugs: Count,
  invalid_bugs: Count,
  closed_bugs: Count,
  new_open_bugs: Count,
  sessions: Count,
  sessions_24h: Count,
  serious_sessions_24h: Count,
  days: z.array(
    z.object({
      day: DashboardDay,
      sessions: Count,
      reviewed_sessions: Count,
      bug_sessions: Count,
      serious_sessions: Count,
      both_sessions: Count,
    }),
  ),
});
export const DashboardBugs = z.object({
  items: z.array(DashboardBug),
  total: Count,
  page: Count,
  has_more: z.boolean(),
});
export const DashboardSession = z.object({
  session_id: z.string(),
  session_url: z.string().url(),
  user_email: z.string().nullable(),
  first_received_at: z.string(),
  last_received_at: z.string(),
});
export const DashboardSessions = z.object({
  sessions: z.array(DashboardSession),
  page: z.number(),
  has_more: z.boolean(),
});
export const DashboardSessionDetail = z.object({
  session: DashboardSession,
  timeline: z.string(),
  interactions: z.array(
    z.object({ timestamp: z.number().nonnegative(), text: z.string() }),
  ),
});
export const DashboardSessionSnapshot = z.object({
  tree: z.string(),
  images: z.array(
    z.object({
      data: z.string(),
      mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    }),
  ),
});
const DashboardSessionId = z.string().min(1).max(256);
export const DashboardReports = z.object({
  older: DashboardDay.nullable(),
  newer: DashboardDay.nullable(),
  latest_attempt: z
    .object({ day: DashboardDay, status: z.string() })
    .nullable(),
  run: z
    .object({
      day: DashboardDay,
      status: z.string(),
      timezone: z.string(),
      sessions: Count.nullable(),
      reviewed_sessions: Count.nullable(),
      output: z
        .object({
          overview: z.string(),
          findings: z.array(
            z.object({
              category: z.enum(["User trends", "Friction", "New bugs"]),
              title: z.string().optional(),
              text: z.string(),
              bugs: z.array(DashboardBug),
            }),
          ),
        })
        .nullable(),
      bugs: z.array(
        DashboardBug.extend({
          is_duplicate: z.boolean(),
          impacted_sessions: Count.nullable(),
        }),
      ),
    })
    .nullable(),
});

export const operations: Operation[] = [
  {
    id: "pipelineBugs",
    method: "GET",
    path: "/api/v1/connection/bugs",
    pipeline: true,
    implemented: true,
    summary: "List open bugs for factory triage",
    query: z
      .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
      .strict(),
    response: DashboardBugs,
  },
  {
    id: "pipelineBug",
    method: "GET",
    path: "/api/v1/connection/bug",
    pipeline: true,
    implemented: true,
    summary: "Read a bug report and recording references",
    query: z.object({ bug_id: QAId }).strict(),
    response: PipelineBug,
  },
  {
    id: "pipelineUpdateBug",
    method: "PATCH",
    path: "/api/v1/connection/bugs/{bug_id}",
    pathParameters: { bug_id: QAId },
    pipeline: true,
    implemented: true,
    summary: "Update a bug's disposition",
    description:
      "Sets an owned QA bug to open, fixed, wontfix or invalid. A reason is required for wontfix and invalid; reasons use QA's WONTFIX reason field for wontfix and append to QA notes for other statuses. Identical retries skip completed writes. Fixed is a factory disposition after confirming the fix landed, not a QA verification verdict. PR association remains a separate operation.",
    body: BugUpdateInput,
    response: PipelineBug,
  },
  {
    id: "pipelineAssociatePr",
    method: "POST",
    path: "/api/v1/connection/bugs/fix-prs",
    pipeline: true,
    implemented: true,
    summary: "Associate a factory-authored PR with a bug",
    description:
      "Idempotently stores the PR association for an owned bug and returns its updated report. Call once for each bug the PR fixes. No QA GitHub integration is required. Does not change bug status or assert PR state.",
    body: FixPrInput,
    response: PipelineBug,
  },
  {
    id: "pipelineVerify",
    method: "POST",
    path: "/api/v1/connection/bug-verifications",
    pipeline: true,
    implemented: true,
    summary: "Rerun a bug's original QA journey against a preview",
    description:
      "Requires a bug ID and an available original journey. Associates the PR with the bug and supplies the bug report to QA without requiring a GitHub integration. Call once for each bug fixed by the PR. Stores PR/head/preview references in the QA run goal; the factory must confirm the deployed preview matches the SHA. Creation is not idempotent: after an uncertain response, list runs before retrying. Does not mark the bug fixed or attest to the preview's commit.",
    body: VerificationInput,
    response: BugVerification,
    status: 201,
  },
  {
    id: "pipelineVerifications",
    method: "GET",
    path: "/api/v1/connection/bug-verifications",
    pipeline: true,
    implemented: true,
    summary: "Read preview verification runs for a bug",
    query: z
      .object({
        bug_id: QAId,
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .strict(),
    response: BugVerifications,
  },
  {
    id: "createDashboardSession",
    method: "POST",
    path: "/api/v1/dashboard-sessions",
    summary: "Create a dashboard launch link",
    implemented: true,
    response: z.object({
      url: HttpsUrl,
      expires_at: Timestamp,
      session_ttl_seconds: z.literal(604800),
    }),
    description:
      "Call server-side with the account bearer key. The link can be opened multiple times for seven days. Each opening establishes a read-only browser session lasting seven days. Do not publish launch links; request a fresh one when needed.",
  },
  {
    id: "redeemDashboardSession",
    method: "POST",
    path: "/api/v1/dashboard/redeem",
    public: true,
    summary: "Exchange a launch ticket for a browser cookie",
    implemented: true,
    body: z
      .object({
        ticket: z
          .string()
          .regex(
            /^[a-f0-9]{64}$/,
            "This dashboard link is incomplete or malformed. Ask your factory for a new dashboard link.",
          ),
      })
      .strict(),
    response: z.object({ ok: z.literal(true) }),
    description:
      "Browser-only exchange. Requires the same Origin as this service. Creates an independent browser session and sets a Secure, HttpOnly, SameSite=None, Partitioned cookie without consuming the link.",
  },
  {
    id: "logoutDashboard",
    public: true,
    description:
      "Same-origin browser-only logout; deletes the current cookie session if present and clears the cookie. Idempotent when already signed out.",
    method: "POST",
    path: "/api/v1/dashboard/logout",
    dashboard: true,
    summary: "End the current dashboard browser session",
    implemented: true,
    response: z.object({ ok: z.literal(true) }),
  },
  {
    id: "dashboardOverview",
    method: "GET",
    path: "/api/v1/dashboard/overview",
    dashboard: true,
    summary: "Read dashboard counts and 30 daily session columns",
    implemented: true,
    response: DashboardOverview,
    description:
      "All-time project bug counts by open, fixed, wontfix and invalid status, plus session counts; open means open or reopened. Closed means fixed, wontfix, invalid or pr-closed (unconfirmed bugs are excluded). New open bugs were discovered in the last 24 hours. The rolling last-24-hour session and serious-session counts use first-received timestamps; success rate is the share without a detected serious issue (undefined for zero sessions). UTC daily buckets use QA session first-received time. Bug shares use confirmed QA reviewer-associated bugs; serious means the friction reviewer recorded impact=blocked. Sessions with no review are not evidence of success.",
  },
  {
    id: "dashboardBugs",
    method: "GET",
    path: "/api/v1/dashboard/bugs",
    dashboard: true,
    summary:
      "List open or closed bugs with kinds, fix PRs and dashboard report links",
    implemented: true,
    query: z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        status: z.enum(["open", "closed"]).default("open"),
      })
      .strict(),
    response: DashboardBugs,
  },
  {
    id: "dashboardBug",
    method: "GET",
    path: "/api/v1/dashboard/bug",
    dashboard: true,
    summary: "Read a bug report belonging to the connected project",
    implemented: true,
    query: z
      .object({
        bug_id: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
      })
      .strict(),
    response: DashboardBugDetail,
  },
  {
    id: "dashboardSessions",
    method: "GET",
    path: "/api/v1/dashboard/sessions",
    dashboard: true,
    implemented: true,
    summary: "List captured sessions by first-received UTC day",
    query: z
      .object({
        day: DashboardDay,
        page: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .strict(),
    response: DashboardSessions,
  },
  {
    id: "dashboardSession",
    method: "GET",
    path: "/api/v1/dashboard/session",
    dashboard: true,
    implemented: true,
    summary: "Read a captured session's Subtext interaction timeline",
    query: z.object({ session_id: DashboardSessionId }).strict(),
    response: DashboardSessionDetail,
  },
  {
    id: "dashboardSessionSnapshot",
    method: "GET",
    path: "/api/v1/dashboard/session-snapshot",
    dashboard: true,
    implemented: true,
    summary:
      "Read Subtext screenshots and component tree at a session timestamp",
    query: z
      .object({
        session_id: DashboardSessionId,
        timestamp: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    response: DashboardSessionSnapshot,
  },
  {
    id: "dashboardReports",
    method: "GET",
    path: "/api/v1/dashboard/reports",
    dashboard: true,
    summary: "Read daily reports and navigate report history",
    implemented: true,
    query: z.object({ day: DashboardDay.optional() }).strict(),
    response: DashboardReports,
  },

  {
    id: "discoverApi",
    method: "GET",
    path: "/api/v1",
    summary: "Start here: API and agent setup instructions",
    implemented: true,
    public: true,
    response: Discovery,
  },
  {
    id: "listSkills",
    method: "GET",
    path: "/api/v1/skills",
    summary: "List public agent skills and their download URLs",
    implemented: true,
    public: true,
    response: SkillCatalog,
  },
  {
    id: "provisionAccount",
    method: "POST",
    path: "/api/v1/accounts",
    public: true,
    implemented: true,
    summary: "Provision an account with a dedicated QA identity",
    description:
      "Validate a Subtext key and return a Self Healing API key. Repeat with the same Subtext key to recover the same account and API key. All subsequent requests use the returned API key.",
    body: z
      .object({ subtext_api_key: z.string().min(1).max(4096).regex(/^\S+$/) })
      .strict(),
    response: z.object({ account_id: Id, api_key: z.string() }),
  },
  ...connectionOperations,
  {
    id: "health",
    method: "GET",
    path: "/api/v1/health",
    summary: "Service liveness (not provider or database readiness)",
    implemented: true,
    public: true,
    response: object({
      status: z.literal("ok"),
      version: z.literal("0.1.0"),
      stage: z.literal("scaffold"),
    }),
  },
  {
    id: "createProject",
    method: "POST",
    path: "/api/v1/projects",
    summary: "Register a project",
    implemented: true,
    body: ProjectInput,
    response: Project,
    status: 201,
  },
  {
    id: "listProjects",
    method: "GET",
    path: "/api/v1/projects",
    summary: "List account projects",
    implemented: true,
    query: PageQuery,
    response: page(Project),
  },
  {
    id: "getProject",
    method: "GET",
    path: prefix,
    summary: "Read a project",
    implemented: true,
    response: Project,
  },
  {
    id: "updateProject",
    method: "PATCH",
    path: prefix,
    summary: "Update project metadata",
    implemented: true,
    body: ProjectPatch,
    response: Project,
  },
  ...Object.entries(configurations).flatMap(([kind, schema]): Operation[] => [
    {
      id: `get-${kind}`,
      method: "GET",
      path: `${prefix}/${kind}`,
      summary: `Read ${kind}`,
      implemented: true,
      response: schema,
    },
    {
      id: `put-${kind}`,
      method: "PUT",
      path: `${prefix}/${kind}`,
      summary: `Replace ${kind} configuration`,
      implemented: true,
      body: schema,
      response: schema,
      description:
        "Persists desired configuration only. Does not provision providers, run QA, or schedule/deliver reports. PUT replaces the entire resource and can be retried.",
    },
  ]),
  pending({
    id: "getAccount",
    method: "GET",
    path: "/api/v1/account",
    summary: "Read linked Subtext account and provisioning status",
    response: object({
      id: Ref,
      subtext_account_id: Ref.nullable(),
      status: z.enum(["action_required", "ready"]),
      provisioning_url: HttpsUrl.nullable(),
    }),
  }),
  pending({
    id: "getStatus",
    method: "GET",
    path: `${prefix}/status`,
    summary: "Read provider readiness and setup actions",
    response: object({
      ready: z.boolean(),
      required_actions: z.array(Text),
      providers: z.array(
        object({
          provider: z.enum(["subtext", "fullstory", "replay"]),
          status: z.enum(["not_configured", "pending", "ready", "error"]),
        }),
      ),
    }),
  }),
  pending({
    id: "setupMonitoring",
    method: "POST",
    path: `${prefix}/monitoring/setup`,
    summary: "Provision Fullstory monitoring through Subtext and Replay QA",
    body: object({
      rotate_registration_token: z.boolean().default(false),
    }).strict(),
    response: object({
      instructions: Text,
      fullstory_org_id: Ref,
      registration_token: z.string(),
      expires_at: Timestamp.nullable(),
    }),
    description:
      "Planned: return one-time, write-only registration credentials and project-specific installation instructions. Never expose the factory API key to browser code.",
  }),
  pending({
    id: "listSessions",
    method: "GET",
    path: `${prefix}/sessions`,
    summary: "List analyzed user sessions without copying recordings",
    query: PageQuery,
    response: page(
      object({
        id: Id,
        provider_session_id: Ref,
        recording_url: HttpsUrl,
        started_at: Timestamp,
        summary: Text,
        bug_ids: z.array(Id),
      }),
    ),
  }),
  pending({
    id: "analyzeSessions",
    method: "POST",
    path: `${prefix}/sessions/analyze`,
    summary: "Request analysis of a session window",
    body: object({ start: Timestamp, end: Timestamp })
      .strict()
      .refine(
        (value) => Date.parse(value.start) < Date.parse(value.end),
        "start must precede end",
      ),
    response: Job,
    status: 202,
  }),
  pending({
    id: "listBugs",
    method: "GET",
    path: `${prefix}/bugs`,
    summary: "Read the actionable bug stream",
    query: PageQuery.extend({ status: Bug.shape.status.optional() }),
    response: page(Bug),
  }),
  pending({
    id: "getBug",
    method: "GET",
    path: `${prefix}/bugs/{bug_id}`,
    summary: "Read reproduction, root cause, and recording evidence",
    response: Bug,
  }),
  pending({
    id: "claimBug",
    method: "POST",
    path: `${prefix}/bugs/{bug_id}/claim`,
    summary: "Atomically lease a bug to one factory worker",
    body: object({
      worker_id: Ref,
      lease_seconds: z.number().int().min(60).max(3600),
    }).strict(),
    response: object({ claim_id: Id, expires_at: Timestamp }),
    description:
      "Planned: 409 if another active claim exists. An expired lease permits another worker to claim the bug.",
  }),
  pending({
    id: "dismissBug",
    method: "POST",
    path: `${prefix}/bugs/{bug_id}/dismiss`,
    summary: "Dismiss a false positive, duplicate, or accepted issue",
    body: object({
      reason: z.enum(["false_positive", "duplicate", "wontfix"]),
      explanation: Text,
      duplicate_bug_id: Id.optional(),
    }).strict(),
    response: Bug,
  }),
  pending({
    id: "submitFix",
    method: "POST",
    path: `${prefix}/bugs/{bug_id}/fixes`,
    summary: "Register a factory-authored PR and queue verification",
    body: object({
      claim_id: Id,
      pull_request_url: HttpsUrl,
      head_sha: Sha,
      preview_url: HttpsUrl,
    }).strict(),
    response: Fix,
    status: 202,
    description:
      "Planned: the factory creates the PR. Only provider evidence for this exact head SHA can produce verified status; the caller cannot mark a fix verified.",
  }),
  pending({
    id: "listFixes",
    method: "GET",
    path: `${prefix}/fixes`,
    summary: "List fix PRs and verification status",
    query: PageQuery,
    response: page(Fix),
  }),
  pending({
    id: "getFix",
    method: "GET",
    path: `${prefix}/fixes/{fix_id}`,
    summary: "Read a fix and its verification run",
    response: Fix,
  }),
  pending({
    id: "verifyFix",
    method: "POST",
    path: `${prefix}/fixes/{fix_id}/verify`,
    summary: "Verify a new PR head and invalidate earlier verification",
    body: object({ head_sha: Sha, preview_url: HttpsUrl }).strict(),
    response: Run,
    status: 202,
  }),
  pending({
    id: "startRun",
    method: "POST",
    path: `${prefix}/qa/runs`,
    summary: "Run QA against a release or PR preview",
    body: object({
      kind: z.enum(["release", "pull_request"]),
      target_url: HttpsUrl,
      commit_sha: Sha,
      pull_request_url: HttpsUrl.optional(),
    })
      .strict()
      .refine(
        (value) => value.kind !== "pull_request" || !!value.pull_request_url,
        "PR runs require pull_request_url",
      ),
    response: Run,
    status: 202,
  }),
  pending({
    id: "listRuns",
    method: "GET",
    path: `${prefix}/qa/runs`,
    summary: "List QA runs",
    query: PageQuery,
    response: page(Run),
  }),
  pending({
    id: "getRun",
    method: "GET",
    path: `${prefix}/qa/runs/{run_id}`,
    summary: "Read QA results and evidence",
    response: Run,
  }),
  pending({
    id: "cancelRun",
    method: "POST",
    path: `${prefix}/qa/runs/{run_id}/cancel`,
    summary: "Cancel a QA run",
    response: Run,
  }),
  pending({
    id: "createReport",
    method: "POST",
    path: `${prefix}/reports`,
    summary: "Queue behavior, trend, bug, and fix-progress report",
    body: object({
      period_start: Timestamp,
      period_end: Timestamp,
      deliver: z.boolean().default(false),
    })
      .strict()
      .refine(
        (value) =>
          Date.parse(value.period_start) < Date.parse(value.period_end),
        "period_start must precede period_end",
      ),
    response: Job,
    status: 202,
  }),
  pending({
    id: "listReports",
    method: "GET",
    path: `${prefix}/reports`,
    summary: "List periodic behavior reports",
    query: PageQuery,
    response: page(Report),
  }),
  pending({
    id: "getReport",
    method: "GET",
    path: `${prefix}/reports/{report_id}`,
    summary: "Read a report with source evidence and delivery status",
    response: Report,
  }),
  pending({
    id: "listEvents",
    method: "GET",
    path: `${prefix}/events`,
    summary: "Poll durable events and resume from a saved cursor",
    query: PageQuery,
    response: page(
      object({
        id: Id,
        type: z.enum([
          "bug.created",
          "bug.updated",
          "fix.updated",
          "qa.completed",
          "report.ready",
          "report.delivery_failed",
        ]),
        resource_id: Id,
        created_at: Timestamp,
      }),
    ),
    description:
      "Planned: cursor follows append order, delivery is at least once; deduplicate by event ID. A stale cursor returns 410. Polling is the initial factory notification interface.",
  }),
  pending({
    id: "getJob",
    method: "GET",
    path: `${prefix}/jobs/{job_id}`,
    summary: "Poll asynchronous provider work",
    response: Job,
  }),
];

export const GatewayRpc = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.enum([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]),
    params: z.record(z.unknown()).optional(),
  })
  .strict();
export const GatewayCall = z
  .object({
    name: z.enum([
      "review-open",
      "review-zoom",
      "review-snapshot",
      "review-close",
    ]),
    arguments: z.record(z.unknown()).optional(),
  })
  .strict();

// review-open may carry semantic context, but alternate session selectors are
// deliberately excluded: the gateway authorizes only its registered URL.
export const GatewayReviewOpenArguments = z
  .object({
    url: z.string().optional(),
    session_url: z.string().optional(),
    sessionUrl: z.string().optional(),
    sightmap: z
      .array(
        z
          .object({
            name: z.string().min(1),
            selectors: z.array(z.string().min(1)).min(1),
            source: z.string().optional(),
            memory: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
            parentChain: z.array(z.string()).optional(),
            properties: z
              .array(
                z
                  .object({
                    name: z.string().min(1),
                    extract: z.string().min(1),
                    description: z.string().min(1).optional(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
    memory: z.array(z.string()).optional(),
  })
  .strict();
