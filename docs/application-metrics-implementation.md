# Application Metrics — Implementation Notes

Implements the company **Application Metrics Standard** (`Application Metrics Standard.md`)
for this Fastify/Node.js service. Scope: HTTP metrics + Node.js runtime metrics +
the `GET /metrics` scrape endpoint + the central Prometheus target file.

Date: 2026-06-27

---

## What was done

### 1. Added `prom-client`
- `package.json`: added `prom-client@^15.1.3`.
- `pnpm-lock.yaml` updated via `pnpm install` (the Docker build runs
  `pnpm install --frozen-lockfile`, so the lockfile **must** be committed or the
  image build fails).
- Side effect: pnpm pruned two extraneous packages that were present in
  `node_modules` but never declared in `package.json`
  (`@aws-sdk/client-rekognition`, `@aws-sdk/client-textract`). Confirmed nothing
  in `src/` imports them, so this is a harmless cleanup.

### 2. New metrics plugin — `src/middleware/metrics.js`
- Registers prom-client **default runtime metrics** (`process_resident_memory_bytes`,
  `process_cpu_seconds_total`, `process_start_time_seconds`,
  `nodejs_eventloop_lag_seconds`, …).
- Defines the two mandatory HTTP metrics with the exact standard labels and buckets:
  - `http_requests_total` — Counter, labels `method`, `route`, `status`.
  - `http_request_duration_seconds` — Histogram, same labels,
    buckets `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
- `method` uppercase (Fastify default), `status` coerced to **string**.
- **Cardinality protection (the important part):** the `route` label is the
  Fastify route *template* (`request.routeOptions.url`), e.g.
  `/:resourceType/upload/*` — never the raw URL. So the millions of distinct
  transform/file delivery URLs collapse into one time series. Unmatched
  requests (404s with no route) are bucketed under `__unmatched__` so stray
  paths can't explode the series count either.
- Exposes `GET /metrics` returning Prometheus text format. Cheap by design —
  it only serializes in-memory metrics (no DB, no external calls, no aggregation
  on scrape), per standard §13.

### 3. Excluded self-monitoring paths
`/metrics`, `/health`, `/ready`, `/live` are excluded from the HTTP counters/histogram
(standard §7). Only `/metrics` and `/health` actually exist today; the other two
are excluded pre-emptively.

### 4. Wired into `src/app.js`
- `registerMetrics(app)` is called **before** the global auth `preHandler` hook.
- Timing uses `process.hrtime.bigint()` in a dedicated `onRequest`/`onResponse`
  pair (separate from the existing Pino logging hooks).

### 5. Allowlisted `/metrics` in `src/middleware/auth.js`
Added `request.url === "/metrics"` to the auth allowlist so the central Prometheus
can scrape without an `X-API-Key`. The route also sets `rateLimit: false`.

### 6. Prometheus target file
Created `observability/prometheus/targets/media-serving.json` with the mandatory
(`service`, `env`, `runtime`) and recommended (`stack`, `server`) labels.
**Contains two placeholders that must be filled in** (see Open items).

---

## Verification done

Smoke-tested via Fastify `inject` (no S3/Redis needed):
- `GET /metrics` → `200`, `Content-Type: text/plain; version=0.0.4; charset=utf-8`.
- Runtime metrics present (`process_*`, `nodejs_eventloop_lag_seconds`).
- A request to a bogus path was recorded as `route="__unmatched__"` (cardinality
  guard working).
- `/health` produced **no** HTTP metric series (exclusion working).

Not yet verified against a live deployment / real Prometheus scrape (see checklist below).

---

## Deployment topology (discovered on the server)

- Host is an AWS EC2 instance (`ip-172-31-38-164`, default VPC subnet `172.31.x`).
- `mediaserving-app-1` (`media-serving:latest`) runs on network `mediaserving_default`,
  published `0.0.0.0:4001->3000`.
- `observability-prometheus` (prom/prometheus) runs on `observability_default`,
  bound `127.0.0.1:9090`, alongside Grafana, Loki, node-exporter, cAdvisor, Alertmanager.
- Prometheus discovers targets via **`file_sd_configs`** reading
  `/etc/prometheus/targets/*.json` (host path `/var/www/opt/observability/prometheus/targets/`),
  under job `application-services`, `metrics_path: /metrics`, `scrape_interval: 15s`.
- App containers are **not** attached to the observability network. The existing
  Node service (`trydos-chat`) is scraped via **`host.docker.internal:<published-host-port>`**
  (the Docker host gateway). → media-serving target is **`host.docker.internal:4001`**.
- The committed `media-serving.json` now matches the `chat-app.json` label shape
  (`service`, `stack`, `env`, `runtime`, `alert_email_group`). **The live file must
  be placed at `/var/www/opt/observability/prometheus/targets/media-serving.json`
  on the server** — the in-repo copy is the source of truth / template.

## Open items — need input or follow-up

## Decisions taken

- **`env` label = `staging`** — matches the rest of this box (chat-app, node-exporter
  are `staging`). Even though media-serving runs `NODE_ENV=production`, the team
  filters this host as the staging environment in Grafana.
- **Security: parity with chat-app (no code change).** Port 4001 is the public
  media-delivery API and cannot be firewalled. `trydos-chat` already exposes its
  metrics the same way (public `0.0.0.0:3005`), so `/metrics` being reachable on
  4001 matches current precedent. This is a known deviation from §10 to revisit
  when §10 is enforced platform-wide (preferred future fix: app-level private-IP
  guard using `request.socket.remoteAddress`, or a dedicated internal metrics port).

## Open items — need follow-up

1. **Buckets vs. slow video delivery:** cold-cache FFmpeg delivery can exceed the
   top 10s bucket; those land in `+Inf`. Standard allows custom buckets "with a
   clear architectural reason" — decide later whether to raise the ceiling.

2. **Extra label for video `?target=`?** Currently only `method/route/status` are
   used (strict standard compliance). A bounded `target` label would be useful but
   technically adds a 4th HTTP label — needs sign-off from the metrics owners.

3. **Queue metrics:** video preprocessing is synchronous/in-process (no Bull/
   Horizon queue), so `queue_jobs_*` metrics were not added. Revisit if a real
   background queue is introduced.

---

## Post-deploy acceptance checklist (from standard §14)

Run after deploying the image and adding the target to Prometheus:

```bash
# On/near the server:
curl http://SERVER_HOST:4001/metrics | head
curl http://SERVER_HOST:4001/metrics | grep http_requests_total
```

In Prometheus / Grafana:
```promql
up{service="media-serving"}                                   # expect 1
sum(rate(http_requests_total{service="media-serving"}[5m]))   # request rate
histogram_quantile(0.95,
  sum by (le, route) (
    rate(http_request_duration_seconds_bucket{service="media-serving"}[5m])
  ))                                                           # P95 latency
```

Then confirm request-rate and P95 panels populate in the central
**Application Metrics** Grafana dashboard.
