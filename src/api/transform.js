const {
  parseParams,
  resolveQAuto,
  ValidationError,
  isVideoPath,
} = require("../utils/paramParser");
const { generateDerivedKey } = require("../utils/hashGenerator");
const { getObjectBuffer } = require("../storage/s3Client");
const {
  checkCache,
  getFromCache,
  saveToCache,
} = require("../services/cacheService");
const { acquireLock, releaseLock } = require("../services/lockService");
const { processImage } = require("../processors/imageProcessor");
const {
  snapshotCacheKey,
  previewParams,
  fullParams,
} = require("../services/videoPreprocessor");

function setMediaCacheHeaders(reply) {
  reply.header(
    "Cache-Control",
    process.env.MEDIA_CACHE_CONTROL ||
      "public, max-age=31536000, s-maxage=31536000, immutable",
  );
}

function resolveVideoTarget(request) {
  // Primary source: parsed query object.
  let rawTarget = request?.query?.target;
  if (Array.isArray(rawTarget)) {
    rawTarget = rawTarget[0];
  }

  // Fallback: parse query directly from raw URL if needed.
  if ((rawTarget == null || rawTarget === "") && request?.raw?.url) {
    const qIndex = request.raw.url.indexOf("?");
    if (qIndex !== -1) {
      const search = request.raw.url.slice(qIndex + 1);
      const params = new URLSearchParams(search);
      rawTarget = params.get("target") || "";
    }
  }

  return String(rawTarget || "")
    .trim()
    .toLowerCase();
}

async function sendOriginalFile(filePath, reply) {
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
  async function serveVideoVariantFromCache(derivedKey, variant, reply) {
    const cached = await checkCache(derivedKey);
    if (cached) {
      const { buffer, contentType } = await getFromCache(derivedKey);
      reply.header("Content-Type", contentType);
      setMediaCacheHeaders(reply);
      reply.header("X-Video-Target", variant);
      reply.header("X-Cache", "HIT");
      return reply.send(buffer);
    }

    reply.header("X-Video-Target", variant);
    reply.header("X-Cache", "MISS");
    return reply.code(503).send({
      error:
        "Video variant not ready yet. Only prebuilt variants are served; retry shortly after upload.",
    });
  }

  async function handleVideoTarget(request, reply, filePath, target) {
    const originalKey = `originals/${filePath}`;

    if (target === "snapshot") {
      const derivedKey = snapshotCacheKey(originalKey);
      return serveVideoVariantFromCache(derivedKey, "snapshot", reply);
    }

    if (target === "preview") {
      const params = previewParams();
      const derivedKey = generateDerivedKey(originalKey, params);
      return serveVideoVariantFromCache(derivedKey, "preview", reply);
    }

    // Default: full quality
    const params = fullParams();
    const derivedKey = generateDerivedKey(originalKey, params);
    return serveVideoVariantFromCache(derivedKey, "full", reply);
  }

  async function handleOriginal(request, reply) {
    const filePath = request.params["*"];
    const explicitResourceType = request.params.resourceType;

    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    if (
      explicitResourceType &&
      explicitResourceType !== "image" &&
      explicitResourceType !== "video"
    ) {
      return reply
        .code(400)
        .send({ error: "resourceType must be image or video" });
    }

    // Video target shortcuts: ?target=snapshot|preview or default full
    const isVideo =
      explicitResourceType === "video" ||
      (explicitResourceType !== "image" && isVideoPath(filePath));

    if (isVideo) {
      const target = resolveVideoTarget(request);
      const validTargets = ["snapshot", "preview", ""];
      if (!validTargets.includes(target)) {
        return reply.code(400).send({
          error:
            "Invalid target. Use snapshot, preview, or omit for full video",
        });
      }
      return handleVideoTarget(request, reply, filePath, target);
    }

    return sendOriginalFile(filePath, reply);
  }

  async function handleTransform(request, reply) {
    const filePath = request.params["*"];
    const explicitResourceType = request.params.resourceType;

    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    if (
      explicitResourceType &&
      explicitResourceType !== "image" &&
      explicitResourceType !== "video"
    ) {
      return reply
        .code(400)
        .send({ error: "resourceType must be image or video" });
    }

    // For video URLs, ignore all transformation path params and only use
    // the target query param (?target=snapshot|preview|<empty>).
    const isVideoRequest =
      explicitResourceType === "video" ||
      (explicitResourceType !== "image" && isVideoPath(filePath));

    if (isVideoRequest) {
      const target = resolveVideoTarget(request);
      const validTargets = ["snapshot", "preview", ""];
      if (!validTargets.includes(target)) {
        return reply.code(400).send({
          error:
            "Invalid target. Use snapshot, preview, or omit for full video",
        });
      }
      return handleVideoTarget(request, reply, filePath, target);
    }

    const { transformations } = request.params;

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

    // --- Resolve values BEFORE cache-key generation ---
    // Only images reach this code path. Force image output format to WebP,
    // regardless of what the client sends in f_.
    params.f = "webp";

    // q_auto[:level]: resolve to a concrete integer so the cache key is
    // deterministic (e.g. "auto:good" -> 75).
    if (typeof params.q === "string" && params.q.startsWith("auto")) {
      params.q = resolveQAuto(params.q);
    }
    // --------------------------------------------------------

    if (Object.keys(params).length === 0) {
      return sendOriginalFile(filePath, reply);
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
      // Another process is working on it - wait and serve from cache
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
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return reply.code(404).send({ error: "Original file not found" });
        }
        throw err;
      }

      // Process image (video transforms are target-only and handled above)
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
  }

  const routeConfig = {
    config: {
      rateLimit: {
        max: Number.parseInt(process.env.TRANSFORM_RATE_LIMIT_MAX || "120", 10),
        timeWindow: Number.parseInt(
          process.env.TRANSFORM_RATE_LIMIT_WINDOW_MS || "60000",
          10,
        ),
      },
    },
  };

  fastify.get("/media/upload/*", routeConfig, handleOriginal);

  fastify.get("/:resourceType/upload/*", routeConfig, handleOriginal);

  fastify.get("/media/upload/:transformations/*", routeConfig, handleTransform);

  fastify.get(
    "/:resourceType/upload/:transformations/*",
    routeConfig,
    handleTransform,
  );
}

module.exports = transformRoutes;
