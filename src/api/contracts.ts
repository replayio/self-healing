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
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
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
        session: ["metrics", "identity", "capture-context"],
      })[artifact.namespace].includes(artifact.key),
    "Unsupported auxiliary namespace/key pair",
  );
const ConnectionInput = object({
  name: z.string().trim().min(1).max(100),
  production_url: Url,
});
const ConnectionResponse = object({
  id: Id,
  qa_project_id: z.string().nullable(),
  status: z.enum(["connected", "pending"]),
});
const connectionPath = "/api/v1/connection";
const connectionOperations: Operation[] = [
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
      "Provision an account, connect this project, install session capture, and verify the first review.",
    path: "/api/v1/skills/setup-self-healing/SKILL.md",
  },
  {
    id: "operate-self-healing",
    name: "Operate Self Healing",
    description:
      "Forward session captures, read automatic reviews and daily reports, and handle retries and blocked work.",
    path: "/api/v1/skills/operate-self-healing/SKILL.md",
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

export const operations: Operation[] = [
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
