const { parseParams, ValidationError } = require("../utils/paramParser");
const { generateDerivedKey } = require("../utils/hashGenerator");
const { getObjectBuffer } = require("../storage/s3Client");
const {
  checkCache,
  getFromCache,
  saveToCache,
} = require("../services/cacheService");
const { acquireLock, releaseLock } = require("../services/lockService");
const { processImage } = require("../processors/imageProcessor");

function setMediaCacheHeaders(reply) {
  reply.header(
    "Cache-Control",
    process.env.MEDIA_CACHE_CONTROL ||
      "public, max-age=31536000, s-maxage=31536000, immutable",
  );
}

async function sendOriginalImage(filePath, reply) {
  const originalKey = `originals/${filePath}`;

  try {
    const original = await getObjectBuffer(originalKey);
    reply.header(
      "Content-Type",
      original.contentType || "application/octet-stream",
    );
    setMediaCacheHeaders(reply);
    reply.header("X-Cache", "BYPASS");
    return reply.send(original.buffer);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return reply.code(404).send({ error: "Original file not found" });
    }
    throw err;
  }
}

async function transformRoutes(fastify) {
  fastify.get(
    "/media/upload/*",
    {
      config: {
        rateLimit: {
          max: Number.parseInt(
            process.env.TRANSFORM_RATE_LIMIT_MAX || "120",
            10,
          ),
          timeWindow: Number.parseInt(
            process.env.TRANSFORM_RATE_LIMIT_WINDOW_MS || "60000",
            10,
          ),
        },
      },
    },
    async (request, reply) => {
      const filePath = request.params["*"];

      if (!filePath) {
        return reply.code(400).send({ error: "File path is required" });
      }

      return sendOriginalImage(filePath, reply);
    },
  );

  fastify.get(
    "/media/upload/:transformations/*",
    {
      config: {
        rateLimit: {
          max: Number.parseInt(
            process.env.TRANSFORM_RATE_LIMIT_MAX || "120",
            10,
          ),
          timeWindow: Number.parseInt(
            process.env.TRANSFORM_RATE_LIMIT_WINDOW_MS || "60000",
            10,
          ),
        },
      },
    },
    async (request, reply) => {
      const { transformations } = request.params;
      const filePath = request.params["*"];

      if (!filePath) {
        return reply.code(400).send({ error: "File path is required" });
      }

      // Parse transformation params
      let params;
      try {
        params = parseParams(transformations);
      } catch (err) {
        if (err instanceof ValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      if (Object.keys(params).length === 0) {
        return sendOriginalImage(filePath, reply);
      }

      const originalKey = `originals/${filePath}`;
      const derivedKey = generateDerivedKey(originalKey, params);

      // Check if derived version already exists
      const cached = await checkCache(derivedKey);
      if (cached) {
        const { buffer, contentType } = await getFromCache(derivedKey);
        reply.header("Content-Type", contentType);
        setMediaCacheHeaders(reply);
        reply.header("X-Cache", "HIT");
        return reply.send(buffer);
      }

      // Acquire lock to prevent duplicate processing
      const lockAcquired = await acquireLock(derivedKey);
      if (!lockAcquired) {
        // Another process is working on it — wait and serve from cache
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const recheck = await checkCache(derivedKey);
        if (recheck) {
          const { buffer, contentType } = await getFromCache(derivedKey);
          reply.header("Content-Type", contentType);
          setMediaCacheHeaders(reply);
          reply.header("X-Cache", "HIT");
          return reply.send(buffer);
        }
        return reply
          .code(503)
          .send({ error: "Processing in progress, try again shortly" });
      }

      try {
        // Double-check cache after acquiring lock
        const rechecked = await checkCache(derivedKey);
        if (rechecked) {
          const { buffer, contentType } = await getFromCache(derivedKey);
          reply.header("Content-Type", contentType);
          setMediaCacheHeaders(reply);
          reply.header("X-Cache", "HIT");
          return reply.send(buffer);
        }

        // Fetch original
        let original;
        try {
          original = await getObjectBuffer(originalKey);
        } catch (err) {
          if (
            err.name === "NoSuchKey" ||
            err.$metadata?.httpStatusCode === 404
          ) {
            return reply.code(404).send({ error: "Original file not found" });
          }
          throw err;
        }

        // Process image
        const { buffer, contentType } = await processImage(
          original.buffer,
          params,
        );

        // Save to cache
        await saveToCache(derivedKey, buffer, contentType);

        reply.header("Content-Type", contentType);
        setMediaCacheHeaders(reply);
        reply.header("X-Cache", "MISS");
        return reply.send(buffer);
      } finally {
        await releaseLock(derivedKey);
      }
    },
  );
}

module.exports = transformRoutes;
