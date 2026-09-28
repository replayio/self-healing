# Obvious → Self Healing → QA

## Connection

Obvious's server supplies the user's Subtext API key. No customer-facing Self Healing key is issued.

```sh
curl "$SELF_HEALING_URL/api/v1/connection" \
  -H "Authorization: Bearer $SUBTEXT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"My app","production_url":"https://app.example.com"}'
```

Repeat this exact request to recover a timeout or provisioning failure. Each validated key maps to one connection UUID and one deterministic QA project ID. Different settings for the same key return 409 rather than silently creating a second project. `GET /api/v1/connection` returns provisioning state. The QA project belongs to the configured QA service account and starts with a 20-credit project budget; its billing account must have capacity for work to run.

Self Healing validates the key against Subtext on each customer request. A keyed fingerprint isolates that key's data. It stores an AES-256-GCM encrypted copy for background QA access, with the fingerprint as authenticated context. The root encryption secret stays in Infisical/Netlify Functions. QA receives only a connection-scoped gateway capability, never the customer's key. Keys for the same Fullstory organization still make separate connections. Key rotation preserving a connection is not implemented: don't substitute a new key expecting it to find the old project.

## Capture and auxiliary events

Install Fullstory in the user's app. Adapt QA's existing Fullstory capture shim so its **same-origin server proxy** forwards to `POST /api/v1/connection/sessions`. The proxy holds the Subtext key server-side. It must authenticate/authorize its app's capture requests and apply capture masking; never embed the Subtext key in browser code. See QA's `src/guidance/user-session/setup.md` for the capture producers. Use Self Healing as their destination, not QA's session registration route.

```json
{
  "session_url": "https://app.fullstory.com/ui/ORG/client-session/123:456",
  "auxiliary_data": [{
    "namespace": "network",
    "key": "captured-exchanges",
    "schema_version": 1,
    "payload": {
      "version": 1,
      "exchanges": [{
        "id": "337f9038-8657-4d90-8fd3-6a5320740e4d",
        "captured_at": 1790618401000,
        "source_timestamp": 1000,
        "method": "GET",
        "url": "https://app.example.com/api/items",
        "status": 500,
        "request_headers": {},
        "request_body": null,
        "response_headers": {"content-type":"application/json"},
        "response_body": "{\"error\":\"unavailable\"}"
      }]
    }
  }],
  "complete": false
}
```

Batches are limited to 256 KiB including the envelope. Preserve event UUIDs on retries; split large captures into ordered batches. QA's existing schema and aggregate limits apply (5,000 network exchanges/interactions, 10 MB per artifact). Supported namespace/key pairs are `network/captured-exchanges`, `interaction/captured-interactions`, `session/metrics`, `session/identity`, and `session/capture-context`, all version 1. QA remains the artifact store; Self Healing owns the external interface and forwards validated uploads. Upload producers must redact credentials, sensitive headers, and private fields from bodies, URLs, and input values before forwarding. This is not a zero-data-retention path.

After the session ends and all auxiliary batches have succeeded, send the same session URL with `auxiliary_data: []` and `complete: true`. The server proxy must persist and retry this finalization request; browser unload alone is not reliable. QA seals the session and queues goals/outcomes and friction/recovery reviews. Retry an identical batch or completion after transport errors; durable receipts recover the prior result. Different uploads to a sealed session return 409. Completion does not mean review success: review work is asynchronous and may be quota- or credit-blocked. Friction reviews can request reproduction journeys using QA's existing settings.

This initial path is **push ingestion**: the app/proxy reports session URLs. Merely providing a key does not install browser capture or discover historical sessions. A Subtext session-discovery poller and backfill remain follow-up work.

## Reviews and daily reports

- `GET /api/v1/connection/reviews?reviewer=friction-and-recovery&page=0` (also `goals-and-outcomes`) returns QA's review results and task state.
- A daily summarizer is enabled at connection setup, using QA's existing default report prompt, UTC timezone, and 08:00 schedule. QA's scheduler executes it over the previous day's data.
- `POST /api/v1/connection/reports` with `{"day":"YYYY-MM-DD"}` requests yesterday's report after 08:00 UTC, with automatic scheduling semantics: an existing report is not replaced on retry; `not_eligible` means no daily report was queued yet.
- `GET /api/v1/connection/reports?day=YYYY-MM-DD` reads a specific day, including processing status and evidence; omit `day` for the latest report and day-navigation metadata.

These result endpoints expose QA's native response envelopes. Email/Slack delivery, cross-day analytics, key rotation, retrospective discovery, and fix-PR orchestration are not implemented by this slice.

## Deployment and migration

Merge/deploy the companion QA bridge and this service together. Add `SELF_HEALING_SECRET` (32 random bytes, base64), `REPLAY_QA_API_TOKEN` (private service account), and optional `REPLAY_QA_URL` to Self Healing's production Infisical environment. CI syncs them only to production Functions. Keep previews isolated. Back up the root secret: changing it changes fingerprints and makes encrypted credentials unreadable. Do not rotate it without a data migration.

QA's `SELF_HEALING_URL` defaults to `https://self-healing.replay.io`; set it to the Self Healing Netlify origin until custom DNS/TLS is ready. The QA deployment allows this variable through its existing Infisical sync. Its workers no longer fall back to global `SUBTEXT_API_KEY`/`SUBTEXT_ENDPOINT`. Existing QA user-session projects without a Self Healing source will stop processing sessions; provision/migrate those connections before rolling this change into an environment that uses them. Existing-project adoption is not implemented by this slice.

QA's bridge is `POST /.netlify/functions/self-healing`, authenticated with its existing private QA API token. The source gateway is `POST /api/internal/connections/{connection_id}/subtext`, authenticated by a connection-scoped capability. It forwards only MCP initialization, tool listing, and the four read-oriented review tools used by QA, to the fixed Subtext endpoint. Redirects are disabled. Self Healing does not log customer keys or upstream errors. QA uses its standard backend request recorder; no customer Subtext key reaches that recorder.

Acceptance before enabling customer traffic: connect a real key twice and see one QA project; upload a real session with redacted network events; complete it and obtain a real review; obtain a report for a completed day. Verify QA's worker endpoint points to Self Healing and no provider credential reaches QA. Automated tests use mocked providers and do not establish live Subtext compatibility or account billing readiness.
