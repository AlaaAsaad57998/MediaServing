const { getObjectBuffer } = require("../storage/s3Client");
const { checkCache, saveToCache } = require("./cacheService");
const { processVideo } = require("../processors/videoProcessor");
const { generateDerivedKey } = require("../utils/hashGenerator");
const { previewParams, fullParams } = require("./videoPreprocessor");
const {
  storyVideoCacheKey,
  storyFallbackVideoCacheKey,
  storyVideoParams,
  storyFallbackVideoParams,
} = require("./storyVideoService");

const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.VIDEO_PREPROCESS_CONCURRENCY || "4", 10) || 4,
);

async function runWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const results = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function generatePolishedVariants(originalKey, relativePath, opts, logger) {
  const original = await getObjectBuffer(originalKey);
  const buf = original.buffer;

  const make = (derivedKey, params, label) => async () => {
    if (await checkCache(derivedKey)) {
      logger.info({ derivedKey }, `${label} already cached, skipping`);
      return;
    }
    const { buffer, contentType } = await processVideo(buf, params);
    await saveToCache(derivedKey, buffer, contentType);
    logger.info({ derivedKey, size: buffer.length }, `${label} created`);
  };

  let tasks;
  if (opts && opts.story === true) {
    tasks = [
      make(storyVideoCacheKey(originalKey), storyVideoParams(), "Story variant"),
      make(
        storyFallbackVideoCacheKey(originalKey),
        storyFallbackVideoParams(),
        "Story fallback variant",
      ),
    ];
  } else {
    const pv = previewParams();
    const fv = fullParams();
    tasks = [
      make(generateDerivedKey(originalKey, pv), pv, "Preview"),
      make(generateDerivedKey(originalKey, fv), fv, "Full variant"),
    ];
  }

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  const failures = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  if (failures.length > 0) {
    for (const f of failures) {
      logger.error({ error: f?.message }, "Video variant generation failed");
    }
    throw new Error("One or more video variants failed to generate");
  }
}

module.exports = { generatePolishedVariants };
