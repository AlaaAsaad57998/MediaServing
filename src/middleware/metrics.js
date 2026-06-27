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

  // Scrape endpoint. Cheap by design: just serializes in-memory metrics — no
  // DB queries, no external calls, no aggregation on scrape.
  app.get(
    "/metrics",
    { config: { rateLimit: false } },
    async (_request, reply) => {
      reply.header("Content-Type", register.contentType);
      return register.metrics();
    },
  );
}

module.exports = { registerMetrics, register };
