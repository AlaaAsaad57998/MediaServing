const { parseParams, resolveQAuto } = require("../utils/paramParser");
const { generateDerivedKey } = require("../utils/hashGenerator");
const { getObjectBuffer } = require("../storage/s3Client");
const { checkCache, saveToCache } = require("./cacheService");
const {
  processVideo,
  extractSnapshot,
  extractRawFrame,
  processStoryHls,
} = require("../processors/videoProcessor");
const crypto = require("crypto");
const sharp = require("sharp");
const { storyAssetKey } = require("./storyVideoService");

const SNAPSHOT_SECOND = 1;
const PREVIEW_DURATION = Math.max(
  1,
  Number.parseInt(process.env.PREVIEW_DURATION_SECONDS || "6", 10) || 6,
);
const WEBP_POSTER_SECOND = Math.max(
  0,
  Number.parseFloat(process.env.WEBP_POSTER_SECOND || "1") || 1,
);
const WEBP_POSTER_WIDTH = Math.max(
  1,
  Number.parseInt(process.env.WEBP_POSTER_WIDTH || "720", 10) || 720,
);
const WEBP_POSTER_QUALITY = Math.max(
  1,
  Math.min(
    100,
    Number.parseInt(process.env.WEBP_POSTER_QUALITY || "75", 10) || 75,
  ),
);
const VIDEO_PREPROCESS_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.VIDEO_PREPROCESS_CONCURRENCY || "4", 10) || 4,
);

const VIDEO_TRANSFORM_PRESETS = {
  full: {
    name: "full",
    transform:
      process.env.FULL_VARIANT_TRANSFORM ||
      "w_1280,h_630,f_mp4,vc_h264,q_80,c_fit",
  },
  preview: {
    name: "preview",
    transform:
      process.env.PREVIEW_VARIANT_TRANSFORM ||
      "w_400,h_600,f_mp4,vc_h264,q_65,c_fill",
  },
};

function snapshotCacheKey(originalKey) {
  const hash = crypto
    .createHash("sha256")
    .update(`${originalKey}|snapshot@${SNAPSHOT_SECOND}s`)
    .digest("hex");
  return `derived/${hash}/snapshot.webp`;
}

function webpCacheKey(originalKey) {
  const hash = crypto
    .createHash("sha256")
    .update(
      `${originalKey}|webp-poster@v1|t=${WEBP_POSTER_SECOND}|w=${WEBP_POSTER_WIDTH}|q=${WEBP_POSTER_QUALITY}`,
    )
    .digest("hex");
  return `derived/${hash}/poster.webp`;
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

async function createWebpPosterVariant(originalBuffer) {
  const frameBuffer = await extractRawFrame(originalBuffer, WEBP_POSTER_SECOND);
  const webpBuffer = await sharp(frameBuffer)
    .rotate()
    .resize({ width: WEBP_POSTER_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_POSTER_QUALITY })
    .toBuffer();

  return {
    buffer: webpBuffer,
    contentType: "image/webp",
  };
}

async function runWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const results = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;

      const task = tasks[index];
      try {
        const value = await task();
        results[index] = { status: "fulfilled", value };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function preprocessVideo(originalKey, relativePath, logger, opts = {}) {
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

  const snapshotTask = async () => {
    const snapKey = snapshotCacheKey(originalKey);
    const cached = await checkCache(snapKey);
    if (cached) {
      logger.info({ derivedKey: snapKey }, "Snapshot already cached, skipping");
      return;
    }
    const { buffer, contentType } = await extractSnapshot(
      originalBuffer,
      SNAPSHOT_SECOND,
    );
    await saveToCache(snapKey, buffer, contentType);
    logger.info(
      { derivedKey: snapKey, size: buffer.length },
      "Snapshot created",
    );
  };

  const webpTask = async () => {
    const derivedKey = webpCacheKey(originalKey);
    const cached = await checkCache(derivedKey);
    if (cached) {
      logger.info({ derivedKey }, "WebP poster already cached, skipping");
      return;
    }

    const { buffer, contentType } =
      await createWebpPosterVariant(originalBuffer);
    await saveToCache(derivedKey, buffer, contentType);
    logger.info({ derivedKey, size: buffer.length }, "WebP poster created");
  };

  const tasks = [snapshotTask, webpTask];

  if (opts.story === true) {
    tasks.push(async () => {
      const baseQueryPath = `/video/upload/${relativePath}`;
      const masterKey = storyAssetKey(originalKey, "master.m3u8");
      const cached = await checkCache(masterKey);
      if (cached) {
        logger.info(
          { derivedKey: masterKey },
          "Story HLS already cached, skipping",
        );
        return;
      }

      const { assets } = await processStoryHls(originalBuffer, baseQueryPath);
      await Promise.all(
        assets.map((asset) =>
          saveToCache(
            storyAssetKey(originalKey, asset.name),
            asset.buffer,
            asset.contentType,
          ),
        ),
      );
      logger.info(
        { derivedKey: masterKey, assetCount: assets.length },
        "Story HLS assets created",
      );
    });
  } else {
    tasks.push(
      async () => {
        const params = previewParams();
        const derivedKey = generateDerivedKey(originalKey, params);
        const cached = await checkCache(derivedKey);
        if (cached) {
          logger.info({ derivedKey }, "Preview already cached, skipping");
          return;
        }
        const { buffer, contentType } = await processVideo(
          originalBuffer,
          params,
        );
        await saveToCache(derivedKey, buffer, contentType);
        logger.info({ derivedKey, size: buffer.length }, "Preview created");
      },
      async () => {
        const params = fullParams();
        const derivedKey = generateDerivedKey(originalKey, params);
        const cached = await checkCache(derivedKey);
        if (cached) {
          logger.info({ derivedKey }, "Full variant already cached, skipping");
          return;
        }
        const { buffer, contentType } = await processVideo(
          originalBuffer,
          params,
        );
        await saveToCache(derivedKey, buffer, contentType);
        logger.info(
          { derivedKey, size: buffer.length },
          "Full variant created",
        );
      },
    );
  }

  const taskResults = await runWithConcurrency(
    tasks,
    VIDEO_PREPROCESS_CONCURRENCY,
  );
  const failures = taskResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);

  if (failures.length > 0) {
    for (const failure of failures) {
      logger.error(
        { error: failure?.message },
        "Video variant generation failed",
      );
    }
    throw new Error("One or more video variants failed to generate");
  }
}

function getVariantUrls(relativePath) {
  return {
    full: `/video/upload/${relativePath}`,
    video: `/video/upload/${relativePath}`,
    snapshot: `/video/upload/${relativePath}?target=snapshot`,
    preview: `/video/upload/${relativePath}?target=preview`,
    webp: `/video/upload/${relativePath}?target=webp`,
  };
}

module.exports = {
  preprocessVideo,
  getVariantUrls,
  snapshotCacheKey,
  webpCacheKey,
  createWebpPosterVariant,
  previewParams,
  fullParams,
  SNAPSHOT_SECOND,
  VIDEO_TRANSFORM_PRESETS,
};
