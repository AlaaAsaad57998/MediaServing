const path = require("path");
const {
  parseChainedTransformations,
  resolveQAuto,
  ValidationError,
  isVideoPath,
  isTransformationSegment,
  VALID_IMAGE_FORMATS,
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

/**
 * Parse the wildcard path after `upload/` into Cloudinary-style chained
 * transformation segments and a file path (public_id).
 *
 * URL pattern: /<resource_type>/upload/<t1>/<t2>/.../<public_id>
 *
 * A segment is treated as a transformation group when every comma-separated
 * token matches a known transformation key (w_300, h_200, fl_lossy, etc.).
 * The first non-transformation segment (and everything after it) forms the
 * file path.
 */
function parsePath(wildcard) {
  if (!wildcard) return { transformationSegments: [], filePath: "" };

  const segments = wildcard.split("/").filter(Boolean);
  let filePathStart = 0;

  for (let i = 0; i < segments.length; i++) {
    if (isTransformationSegment(segments[i])) {
      filePathStart = i + 1;
    } else {
      break;
    }
  }

  return {
    transformationSegments: segments.slice(0, filePathStart),
    filePath: segments.slice(filePathStart).join("/"),
  };
}

function resolveVideoTarget(request) {
  let rawTarget = request?.query?.target;
  if (Array.isArray(rawTarget)) {
    rawTarget = rawTarget[0];
  }

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

/** Wait for another worker to finish, then serve from cache or 503. */
async function serveFromCacheOrWait(derivedKey, reply) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const hit = await checkCache(derivedKey);
  if (hit) {
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

async function transformRoutes(fastify) {
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

  // ──────────────────────────────────────────────────────────────────────
  //  Unified request handler
  // ──────────────────────────────────────────────────────────────────────

  async function handleRequest(request, reply) {
    let resourceType = request.params.resourceType;
    const wildcard = request.params["*"];

    if (!wildcard) {
      return reply.code(400).send({ error: "File path is required" });
    }

    const { transformationSegments, filePath } = parsePath(wildcard);

    if (!filePath) {
      return reply.code(400).send({ error: "File path is required" });
    }

    // "media" is a legacy alias — auto-detect from file extension
    if (!resourceType || resourceType === "media") {
      resourceType = isVideoPath(filePath) ? "video" : "image";
    }

    if (resourceType !== "image" && resourceType !== "video") {
      return reply
        .code(400)
        .send({ error: "resourceType must be image or video" });
    }

    // Parse transformations (to validate them) but usage differs per type
    let params;
    try {
      params =
        transformationSegments.length > 0
          ? parseChainedTransformations(transformationSegments)
          : {};
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    const isVideo =
      resourceType === "video" || (!resourceType && isVideoPath(filePath));

    if (isVideo) {
      // VIDEO: ignore all URL transform params, only use ?target= query param
      return handleVideo(request, reply, filePath);
    }
    return handleImage(reply, filePath, params);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  IMAGE — accept Cloudinary params but always force f=webp
  // ──────────────────────────────────────────────────────────────────────

  async function handleImage(reply, filePath, params) {
    // Always output webp regardless of f_ param
    params.f = "webp";

    // Resolve q_auto to a concrete integer for deterministic cache keys
    if (typeof params.q === "string" && params.q.startsWith("auto")) {
      params.q = resolveQAuto(params.q);
    }

    if (Object.keys(params).length === 0) {
      return sendOriginal(filePath, reply);
    }

    const originalKey = `originals/${filePath}`;
    const derivedKey = generateDerivedKey(originalKey, params);

    if (await checkCache(derivedKey)) {
      const { buffer, contentType } = await getFromCache(derivedKey);
      reply.header("Content-Type", contentType);
      setMediaCacheHeaders(reply);
      reply.header("X-Cache", "HIT");
      return reply.send(buffer);
    }

    const locked = await acquireLock(derivedKey);
    if (!locked) return serveFromCacheOrWait(derivedKey, reply);

    try {
      if (await checkCache(derivedKey)) {
        const { buffer, contentType } = await getFromCache(derivedKey);
        reply.header("Content-Type", contentType);
        setMediaCacheHeaders(reply);
        reply.header("X-Cache", "HIT");
        return reply.send(buffer);
      }

      let original;
      try {
        original = await getObjectBuffer(originalKey);
      } catch (err) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return reply.code(404).send({ error: "Original file not found" });
        }
        throw err;
      }

      const { buffer, contentType } = await processImage(
        original.buffer,
        params,
      );
      await saveToCache(derivedKey, buffer, contentType);

      reply.header("Content-Type", contentType);
      setMediaCacheHeaders(reply);
      reply.header("X-Cache", "MISS");
      return reply.send(buffer);
    } finally {
      await releaseLock(derivedKey);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  VIDEO — ignore URL transforms, serve prebuilt variants via ?target=
  // ──────────────────────────────────────────────────────────────────────

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

  async function handleVideo(request, reply, filePath) {
    const originalKey = `originals/${filePath}`;
    const target = resolveVideoTarget(request);
    const validTargets = ["snapshot", "preview", ""];
    if (!validTargets.includes(target)) {
      return reply.code(400).send({
        error: "Invalid target. Use snapshot, preview, or omit for full video",
      });
    }

    if (target === "snapshot") {
      const derivedKey = snapshotCacheKey(originalKey);
      return serveVideoVariantFromCache(derivedKey, "snapshot", reply);
    }

    if (target === "preview") {
      const params = previewParams();
      const derivedKey = generateDerivedKey(originalKey, params);
      return serveVideoVariantFromCache(derivedKey, "preview", reply);
    }

    // Default: full quality prebuilt variant
    const params = fullParams();
    const derivedKey = generateDerivedKey(originalKey, params);
    return serveVideoVariantFromCache(derivedKey, "full", reply);
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Serve original (no transformations)
  // ──────────────────────────────────────────────────────────────────────

  async function sendOriginal(filePath, reply) {
    const originalKey = `originals/${filePath}`;
    try {
      const { buffer, contentType } = await getObjectBuffer(originalKey);
      reply.header("Content-Type", contentType || "application/octet-stream");
      setMediaCacheHeaders(reply);
      reply.header("X-Cache", "BYPASS");
      return reply.send(buffer);
    } catch (err) {
      if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return reply.code(404).send({ error: "Original file not found" });
      }
      throw err;
    }
  }

  // ── Route registration ─────────────────────────────────────────────────
  // Accepts Cloudinary-style URLs; transforms parsed but:
  //   - Images: all params used EXCEPT format (always webp)
  //   - Videos: all URL params ignored, only ?target= matters

  fastify.get("/:resourceType/upload/*", routeConfig, handleRequest);
}

module.exports = transformRoutes;
