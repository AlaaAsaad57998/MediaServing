const { parseParams, resolveQAuto } = require("../utils/paramParser");
const { generateDerivedKey } = require("../utils/hashGenerator");
const { getObjectBuffer } = require("../storage/s3Client");
const { checkCache, saveToCache } = require("./cacheService");
const {
  processVideo,
  extractSnapshot,
} = require("../processors/videoProcessor");
const crypto = require("crypto");

const SNAPSHOT_SECOND = 1;
const PREVIEW_DURATION = 10;

const VIDEO_TRANSFORM_PRESETS = {
  full: { name: "full", transform: "w_1280,h_630,f_webm,vc_auto,q_80,c_fit" },
  preview: {
    name: "preview",
    transform: "w_400,h_600,f_webm,vc_auto,q_70,c_fill",
  },
};

function snapshotCacheKey(originalKey) {
  const hash = crypto
    .createHash("sha256")
    .update(`${originalKey}|snapshot@${SNAPSHOT_SECOND}s`)
    .digest("hex");
  return `derived/${hash}/snapshot.webp`;
}

function previewParams() {
  const params = parseParams(VIDEO_TRANSFORM_PRESETS.preview.transform);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  params.so = 0;
  params.eo = PREVIEW_DURATION;
  return params;
}

function fullParams() {
  const params = parseParams(VIDEO_TRANSFORM_PRESETS.full.transform);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  return params;
}

async function preprocessVideo(originalKey, relativePath, logger) {
  let originalBuffer;
  try {
    const original = await getObjectBuffer(originalKey);
    originalBuffer = original.buffer;
  } catch (err) {
    logger.error(
      { error: err.message },
      "Failed to fetch original for video preprocessing",
    );
    return;
  }

  // 1) Snapshot
  try {
    const snapKey = snapshotCacheKey(originalKey);
    const cached = await checkCache(snapKey);
    if (cached) {
      logger.info({ derivedKey: snapKey }, "Snapshot already cached, skipping");
    } else {
      const { buffer, contentType } = await extractSnapshot(
        originalBuffer,
        SNAPSHOT_SECOND,
      );
      await saveToCache(snapKey, buffer, contentType);
      logger.info(
        { derivedKey: snapKey, size: buffer.length },
        "Snapshot created",
      );
    }
  } catch (err) {
    logger.error({ error: err.message }, "Failed to create snapshot");
  }

  // 2) Preview (first 10 seconds)
  try {
    const params = previewParams();
    const derivedKey = generateDerivedKey(originalKey, params);
    const cached = await checkCache(derivedKey);
    if (cached) {
      logger.info({ derivedKey }, "Preview already cached, skipping");
    } else {
      const { buffer, contentType } = await processVideo(
        originalBuffer,
        params,
      );
      await saveToCache(derivedKey, buffer, contentType);
      logger.info({ derivedKey, size: buffer.length }, "Preview created");
    }
  } catch (err) {
    logger.error({ error: err.message }, "Failed to create preview");
  }

  // 3) Full HD
  try {
    const params = fullParams();
    const derivedKey = generateDerivedKey(originalKey, params);
    const cached = await checkCache(derivedKey);
    if (cached) {
      logger.info({ derivedKey }, "Full variant already cached, skipping");
    } else {
      const { buffer, contentType } = await processVideo(
        originalBuffer,
        params,
      );
      await saveToCache(derivedKey, buffer, contentType);
      logger.info({ derivedKey, size: buffer.length }, "Full variant created");
    }
  } catch (err) {
    logger.error({ error: err.message }, "Failed to create full variant");
  }
}

function getVariantUrls(relativePath) {
  return {
    full: `/video/upload/${relativePath}`,
    video: `/video/upload/${relativePath}`,
    snapshot: `/video/upload/${relativePath}?target=snapshot`,
    preview: `/video/upload/${relativePath}?target=preview`,
  };
}

module.exports = {
  preprocessVideo,
  getVariantUrls,
  snapshotCacheKey,
  previewParams,
  fullParams,
  SNAPSHOT_SECOND,
  VIDEO_TRANSFORM_PRESETS,
};
