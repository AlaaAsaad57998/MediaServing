/**
 * Stats routes — serve the operational statistics dashboard and proxy
 * Loki queries so the browser never needs direct access to Loki.
 *
 * Environment variables consumed:
 *   LOKI_QUERY_URL   Base URL of the Loki HTTP API reachable from this container.
 *                    e.g. "http://loki:3100" or "http://host.docker.internal:3100"
 *                    Defaults to "http://loki:3100".
 *                    Ignored when GRAFANA_URL + GRAFANA_TOKEN are set.
 *
 *   GRAFANA_URL      Base URL of the Grafana instance reachable from this container.
 *                    e.g. "http://host.docker.internal:3001"
 *                    When set together with GRAFANA_TOKEN, all Loki queries are
 *                    routed through Grafana's datasource proxy instead of hitting
 *                    Loki directly.  Takes priority over LOKI_QUERY_URL.
 *
 *   GRAFANA_TOKEN    Grafana service-account token (Bearer) used to authenticate
 *                    requests to the Grafana API and datasource proxy.
 *                    Never logged or forwarded to the browser.
 *
 *   GRAFANA_LOKI_UID Optional: explicit Loki datasource UID inside Grafana.
 *                    If omitted the UID is discovered automatically on first use
 *                    by querying GET /api/datasources and cached for the process
 *                    lifetime.
 *
 *   APP_NAME         Docker container name used as the Loki label selector.
 *                    Defaults to "mediaserving-app-1".
 */

"use strict";

const { promises: fs } = require("fs");
const path = require("path");

const STATS_PAGE_PATH = path.resolve(__dirname, "..", "..", "stats.html");
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
const LOKI_FETCH_TIMEOUT_MS = 20_000;

// Escape user input before embedding inside a LogQL regex filter.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function statsRoutes(fastify) {
  const lokiBaseUrl = (
    process.env.LOKI_QUERY_URL || "http://loki:3100"
  ).replace(/\/$/, "");
  const containerName = process.env.APP_NAME || "mediaserving-app-1";

  // ── Grafana datasource proxy (optional, preferred over direct Loki) ────────
  const grafanaBaseUrl = (process.env.GRAFANA_URL || "").replace(/\/$/, "");
  const grafanaToken = process.env.GRAFANA_TOKEN || "";
  const useGrafana = !!(grafanaBaseUrl && grafanaToken);

  // Loki datasource UID inside Grafana — resolved once and cached.
  let _lokiDsUid = (process.env.GRAFANA_LOKI_UID || "").trim();

  async function resolveLokiDsUid() {
    if (_lokiDsUid) return _lokiDsUid;
    const resp = await fetch(`${grafanaBaseUrl}/api/datasources`, {
      headers: { Authorization: `Bearer ${grafanaToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`Grafana /api/datasources returned HTTP ${resp.status}`);
    }
    const list = await resp.json();
    const loki = list.find((ds) => ds.type === "loki");
    if (!loki) throw new Error("No Loki datasource found in Grafana");
    _lokiDsUid = loki.uid;
    fastify.log.info(
      { lokiDsUid: _lokiDsUid },
      "Resolved Loki datasource UID from Grafana",
    );
    return _lokiDsUid;
  }

  /**
   * Build the full Loki request URL and headers.
   * When useGrafana is true the request is routed through Grafana's datasource
   * proxy so the token stays server-side and CORS is not an issue.
   */
  async function buildLokiRequest(lokiPath, queryParams) {
    if (useGrafana) {
      const uid = await resolveLokiDsUid();
      return {
        url: `${grafanaBaseUrl}/api/datasources/proxy/uid/${uid}${lokiPath}?${queryParams}`,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${grafanaToken}`,
        },
      };
    }
    return {
      url: `${lokiBaseUrl}${lokiPath}?${queryParams}`,
      headers: { Accept: "application/json" },
    };
  }

  // ── HTML page serving ──────────────────────────────────────────────────

  async function serveStatsPage(reply) {
    try {
      const html = await fs.readFile(STATS_PAGE_PATH, "utf8");
      const hydrated = html
        .replace(
          /"__STATS_API_KEY__"/g,
          JSON.stringify(process.env.API_KEY || ""),
        )
        .replace(/"__APP_NAME__"/g, JSON.stringify(containerName));
      return reply.type("text/html; charset=utf-8").send(hydrated);
    } catch {
      return reply.code(404).send({ error: "stats.html not found" });
    }
  }

  fastify.get("/stats", { config: { rateLimit: false } }, async (_, reply) =>
    serveStatsPage(reply),
  );

  fastify.get(
    "/stats.html",
    { config: { rateLimit: false } },
    async (_, reply) => serveStatsPage(reply),
  );

  // ── Loki query proxy ───────────────────────────────────────────────────

  fastify.get(
    "/stats/query",
    { config: { rateLimit: false } },
    async (request, reply) => {
      const { type, start, end, resource_type, search } = request.query;

      // Validate type
      if (!["top_files", "warm_cold", "errors"].includes(type)) {
        return reply.code(400).send({
          error: "Invalid type. Must be one of: top_files, warm_cold, errors",
        });
      }

      // Validate time range (Unix milliseconds)
      const startMs = Number(start);
      const endMs = Number(end);
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        startMs >= endMs
      ) {
        return reply.code(400).send({
          error: "start and end must be valid Unix millisecond timestamps",
        });
      }
      if (endMs - startMs > MAX_RANGE_MS) {
        return reply
          .code(400)
          .send({ error: "Time range exceeds 7-day maximum" });
      }

      // Loki accepts ISO-8601 (RFC3339) strings for all time parameters.
      // We use them instead of nanosecond integers to avoid Number precision
      // loss — 1.78e21 ns is far beyond MAX_SAFE_INTEGER (~9e15).
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();

      // Range string for LogQL range-vector selector (seconds)
      const rangeSeconds = Math.ceil((endMs - startMs) / 1000);
      const rangeStr = `${rangeSeconds}s`;

      // Resource type filter
      const rt =
        resource_type && ["image", "video"].includes(resource_type)
          ? resource_type
          : null;
      const rtFilter = rt
        ? `| resource_type="${rt}"`
        : `| resource_type=~"image|video"`;

      // Optional file-path search (server-side, applied inside count_over_time)
      const safeSearch = search ? escapeRegex(String(search)) : null;
      const searchFilter = safeSearch
        ? ` | file_path=~"(?i).*${safeSearch}.*"`
        : "";

      // Base log-stream pipeline (shared by all query types)
      const baseLabels = `{container_name="${containerName}"}`;
      const basePipeline = `${baseLabels} | json | message="request completed" | component="TransformRoute" ${rtFilter}`;

      // Warm/cold metrics count only successful responses (status < 400).
      // Errors and warnings are intentionally excluded so they do not inflate
      // the "cold" counter — they are tracked separately in the errors query.
      const successPipeline = `${basePipeline} | status_code < 400`;

      let lokiPath;
      const queryParams = new URLSearchParams();

      if (type === "top_files") {
        // Aggregated count per (file_path, resource_type, transformed) over the range.
        // Instant query evaluated at `end` time; range window equals the selected duration.
        const logStream = `(${successPipeline}${searchFilter})`;
        const lokiQuery = `sum by (file_path, resource_type, transformed) (count_over_time(${logStream} [${rangeStr}]))`;
        lokiPath = "/loki/api/v1/query";
        queryParams.set("query", lokiQuery);
        queryParams.set("time", endIso);
      } else if (type === "warm_cold") {
        // Aggregated count per (transformed, resource_type) for warm/cold ratio.
        const logStream = `(${successPipeline} | transformed=~"warm|cold")`;
        const lokiQuery = `sum by (transformed, resource_type) (count_over_time(${logStream} [${rangeStr}]))`;
        lokiPath = "/loki/api/v1/query";
        queryParams.set("query", lokiQuery);
        queryParams.set("time", endIso);
      } else {
        // Raw log stream query for error/warn entries — up to 2000 entries,
        // newest first so the frontend gets the most recent occurrences.
        // transformed is not meaningful for failed requests (treated as N/A).
        const lokiQuery = `${basePipeline} | status_code >= 400`;
        lokiPath = "/loki/api/v1/query_range";
        queryParams.set("query", lokiQuery);
        queryParams.set("start", startIso);
        queryParams.set("end", endIso);
        queryParams.set("limit", "2000");
        queryParams.set("direction", "backward");
      }

      let lokiReqUrl, lokiReqHeaders;
      try {
        const req = await buildLokiRequest(lokiPath, queryParams.toString());
        lokiReqUrl = req.url;
        lokiReqHeaders = req.headers;
      } catch (err) {
        request.log.error(
          {
            service: "media-serving",
            component: "StatsRoute",
            error_message: err.message,
          },
          "Failed to build Loki request (Grafana UID resolution failed)",
        );
        return reply
          .code(502)
          .send({
            error: "Failed to resolve Loki datasource",
            detail: err.message,
          });
      }

      try {
        const resp = await fetch(lokiReqUrl, {
          headers: lokiReqHeaders,
          signal: AbortSignal.timeout(LOKI_FETCH_TIMEOUT_MS),
        });

        if (!resp.ok) {
          const body = await resp.text();
          request.log.warn(
            {
              service: "media-serving",
              component: "StatsRoute",
              loki_status: resp.status,
              loki_body: body.slice(0, 400),
              // Omit URL to avoid leaking credentials in logs
              loki_backend: useGrafana ? "grafana-proxy" : lokiBaseUrl,
              query_type: type,
            },
            "Loki returned non-2xx response",
          );
          return reply.code(502).send({
            error: "Loki query failed",
            loki_status: resp.status,
            detail: body.slice(0, 400),
          });
        }

        const data = await resp.json();
        return reply.send(data);
      } catch (err) {
        request.log.error(
          {
            service: "media-serving",
            component: "StatsRoute",
            env: process.env.NODE_ENV,
            error_message: err.message,
            query_type: type,
            loki_backend: useGrafana ? "grafana-proxy" : lokiBaseUrl,
          },
          "Failed to reach Loki",
        );
        return reply
          .code(502)
          .send({ error: "Failed to reach Loki", detail: err.message });
      }
    },
  );
}

module.exports = statsRoutes;
