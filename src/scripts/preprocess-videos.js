#!/usr/bin/env node

/**
 * Video Backfill Script
 *
 * Scans S3 for every video under originals/ and generates the three prebuilt
 * variants (full, preview, snapshot) that are normally created at upload time.
 * Run this once after a migration to pre-warm the cache for all existing videos.
 *
 * Usage:
 *   node src/scripts/preprocess-videos.js [options]
 *
 * Options:
 *   --dry-run          List videos without processing them
 *   --concurrency <n>  Parallel workers (default: 2)
 *   --prefix <path>    Only process videos under this S3 key prefix
 *                      e.g. --prefix originals/product/videos/
 *
 * Environment variables:
 *   S3_* vars (already configured for the project)
 *   REDIS_URL (optional — used by cacheService for storing derived keys)
 */

// ── Load project env ────────────────────────────────────────────────────────
require("../config/env");

const { s3, BUCKET, getObjectBuffer } = require("../storage/s3Client");
const { checkCache, saveToCache } = require("../services/cacheService");
const {
  preprocessVideo,
  snapshotCacheKey,
  previewParams,
  fullParams,
  SNAPSHOT_SECOND,
} = require("../services/videoPreprocessor");
const { generateDerivedKey } = require("../utils/hashGenerator");
const { ListObjectsV2Command } = require("@aws-sdk/client-s3");

// ── Supported video extensions ───────────────────────────────────────────────
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "flv",
  "wmv",
  "m4v",
  "3gp",
  "ogv",
]);

function isVideoKey(key) {
  const ext = key.split(".").pop().toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

// ── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { dryRun: false, concurrency: 2, prefix: "originals/" };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--concurrency":
        opts.concurrency = Math.max(1, parseInt(args[++i], 10) || 2);
        break;
      case "--prefix":
        opts.prefix = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

// ── S3 list helpers ───────────────────────────────────────────────────────────
async function* listVideoKeys(prefix) {
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const res = await s3.send(cmd);
    for (const obj of res.Contents || []) {
      if (isVideoKey(obj.Key)) {
        yield obj.Key;
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function runPool(items, concurrency, fn) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item !== undefined) await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

// ── Check if all three variants are already cached ────────────────────────────
async function allVariantsCached(originalKey) {
  const snapKey = snapshotCacheKey(originalKey);
  const previewKey = generateDerivedKey(originalKey, previewParams());
  const fullKey = generateDerivedKey(originalKey, fullParams());

  const [snapCached, previewCached, fullCached] = await Promise.all([
    checkCache(snapKey),
    checkCache(previewKey),
    checkCache(fullKey),
  ]);

  return snapCached && previewCached && fullCached;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);

  console.log("=== Video Backfill ===");
  console.log(`  Bucket  : ${BUCKET}`);
  console.log(`  Prefix  : ${opts.prefix}`);
  console.log(`  Workers : ${opts.concurrency}`);
  if (opts.dryRun) console.log("  Mode    : DRY RUN (no processing)");
  console.log("");

  // Collect all video keys first so we can show totals
  process.stdout.write("Scanning S3 for videos … ");
  const videoKeys = [];
  for await (const key of listVideoKeys(opts.prefix)) {
    videoKeys.push(key);
  }
  console.log(`found ${videoKeys.length} video(s)\n`);

  if (videoKeys.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (opts.dryRun) {
    for (const key of videoKeys) console.log("  •", key);
    return;
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  // Fake logger that writes to stdout
  const logger = {
    info: (obj, msg) => {}, // suppress per-variant noise; we log at video level
    error: (obj, msg) => console.error(`    [error] ${msg}`, obj),
    warn: (obj, msg) => console.warn(`    [warn]  ${msg}`, obj),
  };

  await runPool(videoKeys, opts.concurrency, async (originalKey) => {
    const relativePath = originalKey.replace(/^originals\//, "");
    const label = `[${processed + skipped + failed + 1}/${videoKeys.length}] ${relativePath}`;

    try {
      if (await allVariantsCached(originalKey)) {
        console.log(`  ✓ SKIP  ${label} (all variants cached)`);
        skipped++;
        return;
      }

      console.log(`  ⟳ PROC  ${label}`);
      await preprocessVideo(originalKey, relativePath, logger);
      console.log(`  ✓ DONE  ${label}`);
      processed++;
    } catch (err) {
      console.error(`  ✗ FAIL  ${label} — ${err.message}`);
      failed++;
    }
  });

  console.log("\n=== Summary ===");
  console.log(`  Processed : ${processed}`);
  console.log(`  Skipped   : ${skipped} (already cached)`);
  console.log(`  Failed    : ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
