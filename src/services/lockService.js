const Redis = require("ioredis");

let redis = null;
let redisAvailable = false;
const inMemoryLocks = new Map();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createRedisClient() {
  const redisUrl = (process.env.REDIS_URL || "").trim();
  const commonOptions = {
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  };

  if (redisUrl.startsWith("redis://") || redisUrl.startsWith("rediss://")) {
    return new Redis(redisUrl, commonOptions);
  }

  return new Redis({
    host: redisUrl || "127.0.0.1",
    port: toInt(process.env.REDIS_PORT, 6379),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASS,
    tls:
      process.env.REDIS_TLS === "true" || process.env.REDIS_TLS === "1"
        ? {}
        : undefined,
    ...commonOptions,
  });
}

function initRedis() {
  try {
    redis = createRedisClient();

    redis.on("error", () => {
      redisAvailable = false;
    });

    redis
      .connect()
      .then(() => {
        redisAvailable = true;
      })
      .catch(() => {
        redisAvailable = false;
      });
  } catch {
    redisAvailable = false;
  }
}

async function acquireLock(key) {
  const lockKey = `lock:${key}`;

  if (redisAvailable && redis) {
    const result = await redis.set(lockKey, "1", "NX", "EX", 30);
    return result === "OK";
  }

  // In-memory fallback
  if (inMemoryLocks.has(key)) {
    return false;
  }
  inMemoryLocks.set(key, Date.now());
  return true;
}

async function releaseLock(key) {
  const lockKey = `lock:${key}`;

  if (redisAvailable && redis) {
    await redis.del(lockKey);
    return;
  }

  // In-memory fallback
  inMemoryLocks.delete(key);
}

async function waitForLock(key, maxAttempts = 20, intervalMs = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    const acquired = await acquireLock(key);
    if (acquired) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function closeRedis() {
  if (redis) {
    redis.disconnect();
  }
}

module.exports = {
  createRedisClient,
  initRedis,
  acquireLock,
  releaseLock,
  waitForLock,
  closeRedis,
};
