// Prometheus metrics for the central "Application Metrics" standard.
//
// Exposes GET /metrics in Prometheus text exposition format and records the two
// mandatory HTTP metrics (http_requests_total, http_request_duration_seconds)
// plus Node.js runtime metrics (process_*, nodejs_*) via prom-client defaults.
//
// Cardinality rule: the `route` label is the Fastify route TEMPLATE
// (e.g. /:resourceType/upload/*), never the raw URL — so the millions of
// distinct transform/file paths collapse into a single time series. Unmatched
// requests (404s with no route) are bucketed under "__unmatched__" so stray
// paths can't explode the series count either.

const client = require("prom-client");

// Single global registry. collectDefaultMetrics registers the runtime metrics
// (process_resident_memory_bytes, process_cpu_seconds_total,
// process_start_time_seconds, nodejs_eventloop_lag_seconds, …) on it too.
const register = client.register;

client.collectDefaultMetrics();

// Standard buckets mandated by the Application Metrics Standard so P95/P99 are
// comparable across every company service.
const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests.",
  labelNames: ["method", "route", "status"],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds.",
  labelNames: ["method", "route", "status"],
  buckets: DEFAULT_BUCKETS,
});

// Self-monitoring / probe paths excluded from the HTTP metrics per the standard.
const EXCLUDED_ROUTES = new Set(["/metrics", "/health", "/ready", "/live"]);

// Resolve the normalized route template for a request. Returns null when the
// request targets an excluded path (so the caller skips recording entirely).
function resolveRoute(request) {
  // Fastify exposes the matched route template here (params kept as :name, the
  // wildcard kept as *). Undefined when no route matched (404).
  const template = request.routeOptions && request.routeOptions.url;
  const rawPath = (request.url || "").split("?")[0];

  if (EXCLUDED_ROUTES.has(rawPath)) return null;
  if (template && EXCLUDED_ROUTES.has(template)) return null;

  return template || "__unmatched__";
}

// ── Worker metrics aggregation (Option B) ────────────────────────────────────
// The polished-video jobs run in a SEPARATE `worker` process with its own
// in-memory registry, so its queue_* counters are invisible to this process.
// On scrape we fetch the worker's /metrics over the internal docker network and
// merge ONLY the queue_* families — the worker's process_*/nodejs_* defaults are
// dropped because they would collide with this process's identical names and
// break the exposition. The fetch is a fast local call with a hard timeout and
// can never fail the scrape (a down/unreachable worker just yields app metrics).
const WORKER_METRICS_URL = (
  process.env.WORKER_METRICS_URL || "http://worker:9091/metrics"
).trim();
const WORKER_METRICS_TIMEOUT_MS = Math.max(
  50,
  Number.parseInt(process.env.WORKER_METRICS_TIMEOUT_MS || "800", 10) || 800,
);
const WORKER_METRICS_ENABLED =
  WORKER_METRICS_URL !== "" &&
  process.env.WORKER_METRICS_DISABLED !== "true" &&
  process.env.WORKER_METRICS_DISABLED !== "1";

// Name of the metric family a given exposition line belongs to ("" for blanks).
function metricNameOf(line) {
  if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) {
    return line.split(" ")[2] || "";
  }
  if (line !== "" && line[0] !== "#") {
    return line.split(/[ {]/)[0];
  }
  return "";
}

// Keep only `queue_*` metric families (HELP/TYPE lines + sample lines).
function filterQueueFamilies(text) {
  const kept = [];
  for (const line of text.split("\n")) {
    if (metricNameOf(line).startsWith("queue_")) kept.push(line);
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}

// Remove `queue_*` families from this process's own output. The worker is the
// single source of truth for queue_*; the app no longer imports videoMetrics so
// it shouldn't register them, but this stays as defense-in-depth: if anything in
// the app ever does, its always-zero copies would otherwise collide with the
// worker's real values on merge (duplicate HELP/TYPE → rejected scrape).
function stripQueueFamilies(text) {
  const kept = [];
  for (const line of text.split("\n")) {
    if (!metricNameOf(line).startsWith("queue_")) kept.push(line);
  }
  return kept.join("\n");
}

async function fetchWorkerQueueMetrics() {
  if (!WORKER_METRICS_ENABLED || typeof fetch !== "function") return "";
  try {
    const res = await fetch(WORKER_METRICS_URL, {
      signal: AbortSignal.timeout(WORKER_METRICS_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    return filterQueueFamilies(await res.text());
  } catch {
    // Worker down/unreachable/slow — never break the app's scrape.
    return "";
  }
}

// Wire the timing hooks and the /metrics endpoint into a Fastify instance.
function registerMetrics(app) {
  app.addHook("onRequest", (request, reply, done) => {
    request._metricsStart = process.hrtime.bigint();
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    const route = resolveRoute(request);
    if (route !== null) {
      const start = request._metricsStart;
      const seconds = start
        ? Number(process.hrtime.bigint() - start) / 1e9
        : 0;
      const labels = {
        method: request.method,
        route,
        status: String(reply.statusCode),
      };
      httpRequestDuration.observe(labels, seconds);
      httpRequestsTotal.inc(labels);
    }
    done();
  });

  // Scrape endpoint. Serializes in-memory metrics (no DB/aggregation), then
  // appends the worker's queue_* metrics fetched over the internal network.
  app.get(
    "/metrics",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      reply.header("Content-Type", register.contentType);
      const [appMetrics, workerMetrics] = await Promise.all([
        register.metrics(),
        fetchWorkerQueueMetrics(),
      ]);
      // Always drop the app's own (always-zero) queue_* families; the worker is
      // the source of truth. When the worker is unreachable, queue_* is simply
      // absent rather than reported as a misleading 0.
      return stripQueueFamilies(appMetrics) + workerMetrics;
    },
  );
}

module.exports = {
  registerMetrics,
  register,
  filterQueueFamilies,
  stripQueueFamilies,
  fetchWorkerQueueMetrics,
};
