require("./config/env");
const http = require("http");
const client = require("prom-client");
const { Worker } = require("bullmq");
const { QUEUE_NAME, createQueueConnection } = require("./services/videoQueue");
const { generatePolishedVariants } = require("./services/videoJobs");
const { jobsProcessed, jobsFailed, jobDuration } = require("./services/videoMetrics");

// The worker is a separate process with its own in-memory prom-client registry.
// Register the runtime metrics (process_*/nodejs_*) here too so Prometheus can
// scrape worker resource usage, and expose them over a tiny /metrics endpoint —
// the web `app` process cannot see this process's counters.
client.collectDefaultMetrics();

// Minimal structured logger (pino-style JSON) — pino is not a direct dependency.
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const configuredLevel = process.env.LOG_LEVEL || "info";
const configuredLevelNum = LEVELS[configuredLevel] ?? LEVELS.info;

function makeLogger() {
  function write(levelLabel, levelNum, objOrMsg, msg) {
    if (levelNum < configuredLevelNum) return;
    const isObj = objOrMsg !== null && typeof objOrMsg === "object";
    const entry = {
      level: levelNum,
      time: Date.now(),
      ...(isObj ? objOrMsg : {}),
      msg: isObj ? msg : objOrMsg,
    };
    const line = JSON.stringify(entry);
    if (levelNum >= LEVELS.error) {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
  return {
    trace: (o, m) => write("trace", LEVELS.trace, o, m),
    debug: (o, m) => write("debug", LEVELS.debug, o, m),
    info:  (o, m) => write("info",  LEVELS.info,  o, m),
    warn:  (o, m) => write("warn",  LEVELS.warn,  o, m),
    error: (o, m) => write("error", LEVELS.error, o, m),
    fatal: (o, m) => write("fatal", LEVELS.fatal, o, m),
  };
}

const logger = makeLogger();
const concurrency = Math.max(
  1,
  Number.parseInt(process.env.VIDEO_PREPROCESS_CONCURRENCY || "4", 10) || 4,
);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { originalKey, relativePath, story } = job.data;
    logger.info({ originalKey, story }, "Processing video job");
    const end = jobDuration.startTimer();
    try {
      await generatePolishedVariants(originalKey, relativePath, { story }, logger);
      jobsProcessed.inc();
      logger.info({ originalKey }, "Video job complete");
    } catch (err) {
      jobsFailed.inc();
      throw err;
    } finally {
      end();
    }
  },
  { connection: createQueueConnection(), concurrency },
);

worker.on("failed", (job, err) => {
  logger.error(
    {
      originalKey: job?.data?.originalKey,
      attempts: job?.attemptsMade,
      error: err?.message,
    },
    "Video job failed",
  );
});

worker.on("error", (err) => {
  logger.error({ error: err?.message }, "Worker error");
});

// ── Metrics endpoint ─────────────────────────────────────────────────────────
// Prometheus pull model: expose this process's registry on its own port so the
// queue_* and worker runtime metrics are scrapeable as a separate target.
const METRICS_PORT = Math.max(
  1,
  Number.parseInt(process.env.WORKER_METRICS_PORT || "9091", 10) || 9091,
);
const metricsServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/metrics" || req.url === "/")) {
    try {
      const body = await client.register.metrics();
      res.writeHead(200, { "Content-Type": client.register.contentType });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err && err.message ? err.message : err));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});
metricsServer.on("error", (err) => {
  logger.error({ error: err?.message, port: METRICS_PORT }, "Metrics server error");
});
metricsServer.listen(METRICS_PORT, () => {
  logger.info({ port: METRICS_PORT }, "Worker metrics endpoint listening");
});

async function shutdown(signal) {
  logger.info({ signal }, "Worker shutting down");
  metricsServer.close();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

logger.info({ queue: QUEUE_NAME, concurrency }, "Video worker started");
