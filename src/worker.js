require("./config/env");
const { Worker } = require("bullmq");
const { QUEUE_NAME, createQueueConnection } = require("./services/videoQueue");
const { generatePolishedVariants } = require("./services/videoJobs");
const { jobsTotal, jobDuration } = require("./services/videoMetrics");

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
      jobsTotal.inc({ result: "success" });
      logger.info({ originalKey }, "Video job complete");
    } catch (err) {
      jobsTotal.inc({ result: "failure" });
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

async function shutdown(signal) {
  logger.info({ signal }, "Worker shutting down");
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

logger.info({ queue: QUEUE_NAME, concurrency }, "Video worker started");
