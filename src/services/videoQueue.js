const IORedis = require("ioredis");

const QUEUE_NAME = "video-processing";

function buildJobOptions(originalKey) {
  return {
    jobId: originalKey, // dedup: re-enqueues for the same original collapse
    attempts: Number.parseInt(process.env.VIDEO_JOB_ATTEMPTS || "3", 10) || 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  };
}

function createQueueConnection() {
  const url = (process.env.REDIS_URL || "").trim();
  // BullMQ requires maxRetriesPerRequest: null on its blocking connection.
  const common = { maxRetriesPerRequest: null };
  if (url.startsWith("redis://") || url.startsWith("rediss://")) {
    return new IORedis(url, common);
  }
  return new IORedis({
    host: url || "127.0.0.1",
    port: Number.parseInt(process.env.REDIS_PORT || "6379", 10) || 6379,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASS,
    tls:
      process.env.REDIS_TLS === "true" || process.env.REDIS_TLS === "1"
        ? {}
        : undefined,
    ...common,
  });
}

let queue = null;
function getVideoQueue() {
  if (queue) return queue;
  try {
    const { Queue } = require("bullmq");
    queue = new Queue(QUEUE_NAME, { connection: createQueueConnection() });
  } catch {
    queue = null;
  }
  return queue;
}

async function enqueueVideoJob({ originalKey, relativePath, story }, logger) {
  const q = getVideoQueue();
  if (!q) {
    (logger || console).warn(
      { originalKey },
      "Video queue unavailable; skipping enqueue (variant will warm on backfill/first view)",
    );
    return;
  }
  try {
    await q.add(
      "polish",
      { originalKey, relativePath, story: story === true },
      buildJobOptions(originalKey),
    );
  } catch (err) {
    (logger || console).error(
      { originalKey, error: err.message },
      "Failed to enqueue video job",
    );
  }
}

module.exports = {
  QUEUE_NAME,
  buildJobOptions,
  createQueueConnection,
  getVideoQueue,
  enqueueVideoJob,
};
