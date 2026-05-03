/**
 * Stats routes — serve the operational statistics dashboard and proxy
 * Loki queries so the browser never needs direct access to Loki.
 *
 * Environment variables consumed:
 *   LOKI_QUERY_URL  Base URL of the Loki HTTP API reachable from this container.
 *                   e.g. "http://loki:3100" or "http://host.docker.internal:3100"
 *                   Defaults to "http://loki:3100".
 *   APP_NAME        Docker container name used as the Loki label selector.
 *                   Defaults to "mediaserving-app-1".
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
        return reply
          .code(400)
          .send({
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
        return reply
          .code(400)
          .send({
            error: "start and end must be valid Unix millisecond timestamps",
          });
      }
      if (endMs - startMs > MAX_RANGE_MS) {
        return reply
          .code(400)
          .send({ error: "Time range exceeds 7-day maximum" });
      }

      // Loki uses nanoseconds for time parameters
      const startNs = String(Math.floor(startMs) * 1_000_000);
      const endNs = String(Math.floor(endMs) * 1_000_000);

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

      let lokiPath;
      const queryParams = new URLSearchParams();

      if (type === "top_files") {
        // Aggregated count per (file_path, resource_type, transformed) over the range.
        // Instant query evaluated at `end` time; range window equals the selected duration.
        const logStream = `(${basePipeline}${searchFilter})`;
        const lokiQuery = `sum by (file_path, resource_type, transformed) (count_over_time(${logStream} [${rangeStr}]))`;
        lokiPath = "/loki/api/v1/query";
        queryParams.set("query", lokiQuery);
        queryParams.set("time", endNs);
      } else if (type === "warm_cold") {
        // Aggregated count per (transformed, resource_type) for warm/cold ratio.
        const logStream = `(${basePipeline} | transformed=~"warm|cold")`;
        const lokiQuery = `sum by (transformed, resource_type) (count_over_time(${logStream} [${rangeStr}]))`;
        lokiPath = "/loki/api/v1/query";
        queryParams.set("query", lokiQuery);
        queryParams.set("time", endNs);
      } else {
        // Raw log stream query for error/warn entries — up to 2000 entries,
        // newest first so the frontend gets the most recent occurrences.
        const lokiQuery = `${basePipeline} | status_code >= 400`;
        lokiPath = "/loki/api/v1/query_range";
        queryParams.set("query", lokiQuery);
        queryParams.set("start", startNs);
        queryParams.set("end", endNs);
        queryParams.set("limit", "2000");
        queryParams.set("direction", "backward");
      }

      const lokiUrl = `${lokiBaseUrl}${lokiPath}?${queryParams.toString()}`;

      try {
        const resp = await fetch(lokiUrl, {
          headers: { Accept: "application/json" },
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
              query_type: type,
            },
            "Loki returned non-2xx response",
          );
          return reply
            .code(502)
            .send({
              error: "Loki query failed",
              loki_status: resp.status,
              detail: body.slice(0, 200),
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
            loki_url: lokiBaseUrl,
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
