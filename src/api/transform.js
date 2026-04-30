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
  getCacheMetadata,
  saveToCache,
} = require("../services/cacheService");
const { acquireLock, releaseLock } = require("../services/lockService");
const { processImage } = require("../processors/imageProcessor");
const {
  processVideo,
  extractSnapshot,
} = require("../processors/videoProcessor");
const {
  snapshotCacheKey,
  webpCacheKey,
  createWebpPosterVariant,
  previewParams,
  fullParams,
  SNAPSHOT_SECOND,
} = require("../services/videoPreprocessor");
const {
  storyVideoCacheKey,
  storyFallbackVideoCacheKey,
  storyFallbackVideoParams,
  storyVideoParams,
} = require("../services/storyVideoService");

function setMediaCacheHeaders(reply) {
  reply.header(
    "Cache-Control",
    process.env.MEDIA_CACHE_CONTROL ||
      "public, max-age=31536000, s-maxage=31536000, immutable",
  );
}

function setVideoDeliveryHeaders(reply) {
  reply.header("Accept-Ranges", "bytes");
}

function parseSingleRangeHeader(rangeHeader, totalLength) {
  if (!rangeHeader) return { kind: "none" };
  if (typeof rangeHeader !== "string") return { kind: "invalid" };

  const normalized = rangeHeader.trim().toLowerCase();
  if (!normalized.startsWith("bytes=")) return { kind: "invalid" };

  const rawValue = normalized.slice("bytes=".length);
  if (!rawValue || rawValue.includes(",")) return { kind: "invalid" };

  const [startRaw, endRaw] = rawValue.split("-");
  if (startRaw === undefined || endRaw === undefined) {
    return { kind: "invalid" };
  }

  let start;
  let end;

  if (startRaw === "") {
    const suffixLength = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { kind: "invalid" };
    }

    const effectiveLength = Math.min(suffixLength, totalLength);
    start = Math.max(totalLength - effectiveLength, 0);
    end = totalLength - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    if (!Number.isFinite(start) || start < 0 || start >= totalLength) {
      return { kind: "unsatisfiable" };
    }

    if (endRaw === "") {
      end = totalLength - 1;
    } else {
      end = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(end) || end < start) {
        return { kind: "invalid" };
      }
      end = Math.min(end, totalLength - 1);
    }
  }

  return {
    kind: "partial",
    start,
    end,
    contentLength: end - start + 1,
    headerValue: `bytes ${start}-${end}/${totalLength}`,
    storageRange: `bytes=${start}-${end}`,
  };
}

function applyVideoBodyHeaders(reply, contentType, variantName, cacheStatus) {
  reply.header("Content-Type", contentType);
  setMediaCacheHeaders(reply);
  setVideoDeliveryHeaders(reply);
  reply.header("X-Video-Target", variantName);
  reply.header("X-Cache", cacheStatus);
}

function sendVideoBuffer(
  reply,
  { buffer, contentType, variantName, cacheStatus, range, totalLength },
) {
  applyVideoBodyHeaders(reply, contentType, variantName, cacheStatus);

  if (range?.kind === "partial") {
    reply.code(206);
    reply.header("Content-Range", range.headerValue);
    reply.header("Content-Length", String(range.contentLength));
    return reply.send(buffer);
  }

  reply.header("Content-Length", String(totalLength ?? buffer.length));
  return reply.send(buffer);
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
async function serveFromCacheOrWait(derivedKey, reply, opts = {}) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const hit = await checkCache(derivedKey);
  if (hit) {
    if (opts.video === true) {
      const metadata = await getCacheMetadata(derivedKey);
      const totalLength = Number(metadata.contentLength || 0);
      const range = parseSingleRangeHeader(opts.rangeHeader, totalLength);

      if (range.kind === "invalid" || range.kind === "unsatisfiable") {
        reply.code(416);
        setVideoDeliveryHeaders(reply);
        reply.header("Content-Range", `bytes */${totalLength}`);
        return reply.send({ error: "Requested range not satisfiable" });
      }

      const { buffer, contentType } = await getFromCache(derivedKey, {
        range: range.kind === "partial" ? range.storageRange : undefined,
      });

      return sendVideoBuffer(reply, {
        buffer,
        contentType,
        variantName: opts.variantName,
        cacheStatus: "HIT",
        range,
        totalLength,
      });
    }

    const { buffer, contentType } = await getFromCache(derivedKey);
    reply.header("Content-Type", contentType);
    setMediaCacheHeaders(reply);
    reply.header("X-Cache", "HIT");
    return reply.send(buffer);
  }
  opts.log?.warn(
    {
      service: "media-serving",
      component: "TransformRoute",
      env: process.env.NODE_ENV,
      derived_key: derivedKey,
    },
    "Lock wait timeout — processing still in progress, returning 503",
  );
  return reply
    .code(503)
    .send({ error: "Processing in progress, try again shortly" });
}

function stampLogExtra(
  request,
  { isVideo, filePath, cacheStatus, videoTarget },
) {
  request._logExtra = {
    component: "TransformRoute",
    resource_type: isVideo ? "video" : "image",
    file_path: filePath,
    ...(isVideo && videoTarget != null && { video_target: videoTarget }),
    transformed: cacheStatus === "HIT" ? "warm" : "cold",
    cache_status: String(cacheStatus),
    pre_processed: cacheStatus === "HIT" ? "yes" : "no",
  };
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
      await handleVideo(request, reply, filePath);
    } else {
      await handleImage(request, reply, filePath, params, request.log);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  IMAGE — accept Cloudinary params but always force f=webp,
  //          except explicit SVG passthrough requests (f_svg).
  // ──────────────────────────────────────────────────────────────────────

  async function handleImage(request, reply, filePath, params, log) {
    const isSvgFile = path.extname(filePath).toLowerCase() === ".svg";

    // Explicit SVG output should return the original source untouched.
    if (params.f === "svg" && isSvgFile) {
      return sendOriginal(request, filePath, reply);
    }

    // Always output webp regardless of f_ param
    params.f = "webp";

    // Resolve q_auto to a concrete integer for deterministic cache keys
    if (typeof params.q === "string" && params.q.startsWith("auto")) {
      params.q = resolveQAuto(params.q);
    }

    if (Object.keys(params).length === 0) {
      return sendOriginal(request, filePath, reply);
    }

    const originalKey = `originals/${filePath}`;
    const derivedKey = generateDerivedKey(originalKey, params);

    if (await checkCache(derivedKey)) {
      const { buffer, contentType } = await getFromCache(derivedKey);
      reply.header("Content-Type", contentType);
      setMediaCacheHeaders(reply);
      reply.header("X-Cache", "HIT");
      stampLogExtra(request, { isVideo: false, filePath, cacheStatus: "HIT" });
      return reply.send(buffer);
    }

    const locked = await acquireLock(derivedKey);
    if (!locked) return serveFromCacheOrWait(derivedKey, reply, { log });

    try {
      if (await checkCache(derivedKey)) {
        const { buffer, contentType } = await getFromCache(derivedKey);
        reply.header("Content-Type", contentType);
        setMediaCacheHeaders(reply);
        reply.header("X-Cache", "HIT");
        stampLogExtra(request, {
          isVideo: false,
          filePath,
          cacheStatus: "HIT",
        });
        return reply.send(buffer);
      }

      let original;
      try {
        original = await getObjectBuffer(originalKey);
      } catch (err) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return reply.code(404).send({ error: "Original file not found" });
        }
        log?.error(
          {
            service: "media-serving",
            component: "TransformRoute",
            env: process.env.NODE_ENV,
            file_path: filePath,
            exception: err.constructor?.name || "Error",
            error_message: err.message,
          },
          "Failed to fetch original from S3",
        );
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
      stampLogExtra(request, { isVideo: false, filePath, cacheStatus: "MISS" });
      return reply.send(buffer);
    } finally {
      await releaseLock(derivedKey);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  VIDEO — ignore URL transforms, serve prebuilt variants via ?target=
  // ──────────────────────────────────────────────────────────────────────

  async function handleVideo(request, reply, filePath) {
    const originalKey = `originals/${filePath}`;
    const target = resolveVideoTarget(request);
    const validTargets = [
      "snapshot",
      "preview",
      "webp",
      "story",
      "story-fallback",
      "",
    ];
    if (!validTargets.includes(target)) {
      return reply.code(400).send({
        error:
          "Invalid target. Use snapshot, preview, webp, story, story-fallback, or omit for full video",
      });
    }

    // Resolve the derived cache key and variant name from the target
    let derivedKey;
    let variantName;
    let variantParams;
    if (target === "snapshot") {
      derivedKey = snapshotCacheKey(originalKey);
      variantName = "snapshot";
    } else if (target === "webp") {
      derivedKey = webpCacheKey(originalKey);
      variantName = "webp";
    } else if (target === "preview") {
      variantParams = previewParams();
      derivedKey = generateDerivedKey(originalKey, variantParams);
      variantName = "preview";
    } else if (target === "story") {
      variantParams = storyVideoParams();
      derivedKey = storyVideoCacheKey(originalKey);
      variantName = "story";
    } else if (target === "story-fallback") {
      variantParams = storyFallbackVideoParams();
      derivedKey = storyFallbackVideoCacheKey(originalKey);
      variantName = "story-fallback";
    } else {
      variantParams = fullParams();
      derivedKey = generateDerivedKey(originalKey, variantParams);
      variantName = "full";
    }

    const allowsRange = variantName !== "snapshot" && variantName !== "webp";

    // ── 1. Cache hit (fast path) ────────────────────────────────────────
    if (await checkCache(derivedKey)) {
      if (allowsRange) {
        const metadata = await getCacheMetadata(derivedKey);
        const totalLength = Number(metadata.contentLength || 0);
        const range = parseSingleRangeHeader(
          request.headers.range,
          totalLength,
        );

        if (range.kind === "invalid" || range.kind === "unsatisfiable") {
          reply.code(416);
          setVideoDeliveryHeaders(reply);
          reply.header("Content-Range", `bytes */${totalLength}`);
          return reply.send({ error: "Requested range not satisfiable" });
        }

        const { buffer, contentType } = await getFromCache(derivedKey, {
          range: range.kind === "partial" ? range.storageRange : undefined,
        });

        stampLogExtra(request, {
          isVideo: true,
          filePath,
          cacheStatus: "HIT",
          videoTarget: variantName,
        });
        return sendVideoBuffer(reply, {
          buffer,
          contentType,
          variantName,
          cacheStatus: "HIT",
          range,
          totalLength,
        });
      }

      const { buffer, contentType } = await getFromCache(derivedKey);
      reply.header("Content-Type", contentType);
      setMediaCacheHeaders(reply);
      setVideoDeliveryHeaders(reply);
      reply.header("X-Video-Target", variantName);
      reply.header("X-Cache", "HIT");
      stampLogExtra(request, {
        isVideo: true,
        filePath,
        cacheStatus: "HIT",
        videoTarget: variantName,
      });
      return reply.send(buffer);
    }

    // ── 2. Acquire lock — prevent duplicate processing ──────────────────
    const locked = await acquireLock(derivedKey);
    if (!locked) {
      return serveFromCacheOrWait(derivedKey, reply, {
        video: true,
        rangeHeader: allowsRange ? request.headers.range : undefined,
        variantName,
        log: request.log,
      });
    }

    try {
      // Double-check after acquiring lock (another worker may have just finished)
      if (await checkCache(derivedKey)) {
        if (allowsRange) {
          const metadata = await getCacheMetadata(derivedKey);
          const totalLength = Number(metadata.contentLength || 0);
          const range = parseSingleRangeHeader(
            request.headers.range,
            totalLength,
          );

          if (range.kind === "invalid" || range.kind === "unsatisfiable") {
            reply.code(416);
            setVideoDeliveryHeaders(reply);
            reply.header("Content-Range", `bytes */${totalLength}`);
            return reply.send({ error: "Requested range not satisfiable" });
          }

          const { buffer, contentType } = await getFromCache(derivedKey, {
            range: range.kind === "partial" ? range.storageRange : undefined,
          });

          stampLogExtra(request, {
            isVideo: true,
            filePath,
            cacheStatus: "HIT",
            videoTarget: variantName,
          });
          return sendVideoBuffer(reply, {
            buffer,
            contentType,
            variantName,
            cacheStatus: "HIT",
            range,
            totalLength,
          });
        }

        const { buffer, contentType } = await getFromCache(derivedKey);
        reply.header("Content-Type", contentType);
        setMediaCacheHeaders(reply);
        setVideoDeliveryHeaders(reply);
        reply.header("X-Video-Target", variantName);
        reply.header("X-Cache", "HIT");
        stampLogExtra(request, {
          isVideo: true,
          filePath,
          cacheStatus: "HIT",
          videoTarget: variantName,
        });
        return reply.send(buffer);
      }

      // ── 3. Fetch original from S3 ─────────────────────────────────────
      let originalBuffer;
      try {
        const original = await getObjectBuffer(originalKey);
        originalBuffer = original.buffer;
      } catch (err) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
          return reply.code(404).send({ error: "Original file not found" });
        }
        request.log.error(
          {
            service: "media-serving",
            component: "TransformRoute",
            env: process.env.NODE_ENV,
            request_id: request.id,
            file_path: filePath,
            video_target: variantName,
            exception: err.constructor?.name || "Error",
            error_message: err.message,
          },
          "Failed to fetch video original from S3",
        );
        throw err;
      }

      // ── 4. Process the requested variant ─────────────────────────────
      let buffer, contentType;
      if (variantName === "snapshot") {
        ({ buffer, contentType } = await extractSnapshot(
          originalBuffer,
          SNAPSHOT_SECOND,
        ));
      } else if (variantName === "webp") {
        ({ buffer, contentType } =
          await createWebpPosterVariant(originalBuffer));
      } else if (variantName === "story") {
        ({ buffer, contentType } = await processVideo(
          originalBuffer,
          variantParams,
        ));
      } else {
        ({ buffer, contentType } = await processVideo(
          originalBuffer,
          variantParams,
        ));
      }

      await saveToCache(derivedKey, buffer, contentType);

      if (allowsRange) {
        const range = parseSingleRangeHeader(
          request.headers.range,
          buffer.length,
        );
        if (range.kind === "invalid" || range.kind === "unsatisfiable") {
          reply.code(416);
          setVideoDeliveryHeaders(reply);
          reply.header("Content-Range", `bytes */${buffer.length}`);
          return reply.send({ error: "Requested range not satisfiable" });
        }

        const responseBuffer =
          range.kind === "partial"
            ? buffer.subarray(range.start, range.end + 1)
            : buffer;

        stampLogExtra(request, {
          isVideo: true,
          filePath,
          cacheStatus: "MISS",
          videoTarget: variantName,
        });
        return sendVideoBuffer(reply, {
          buffer: responseBuffer,
          contentType,
          variantName,
          cacheStatus: "MISS",
          range,
          totalLength: buffer.length,
        });
      }

      reply.header("Content-Type", contentType);
      setMediaCacheHeaders(reply);
      setVideoDeliveryHeaders(reply);
      reply.header("X-Video-Target", variantName);
      reply.header("X-Cache", "MISS");
      stampLogExtra(request, {
        isVideo: true,
        filePath,
        cacheStatus: "MISS",
        videoTarget: variantName,
      });
      return reply.send(buffer);
    } finally {
      await releaseLock(derivedKey);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Serve original (no transformations)
  // ──────────────────────────────────────────────────────────────────────

  async function sendOriginal(request, filePath, reply) {
    const originalKey = `originals/${filePath}`;
    try {
      const { buffer, contentType } = await getObjectBuffer(originalKey);
      reply.header("Content-Type", contentType || "application/octet-stream");
      setMediaCacheHeaders(reply);
      reply.header("X-Cache", "BYPASS");
      stampLogExtra(request, {
        isVideo: false,
        filePath,
        cacheStatus: "BYPASS",
      });
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
  //   - Images: all params used EXCEPT format (always webp),
  //             unless f_svg is requested for a .svg source (serve original)
  //   - Videos: all URL params ignored, only ?target= matters

  fastify.get("/:resourceType/upload/*", routeConfig, handleRequest);
}

module.exports = transformRoutes;
