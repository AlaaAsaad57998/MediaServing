#!/usr/bin/env node

/**
 * Cloudinary → S3 Migration Script
 *
 * Migrates original images and videos from a Cloudinary account to S3,
 * streaming directly without local disk storage.
 *
 * Usage:
 *   node src/scripts/migrate-cloudinary.js [options]
 *
 * Options:
 *   --dry-run           List resources without uploading
 *   --limit <n>         Max assets to process (default: 20, 0 = unlimited)
 *   --resume            Resume from last checkpoint
 *   --resource-type <t> "image", "video", or "all" (default: "all")
 *   --concurrency <n>   Parallel uploads (default: 5)
 *
 * Environment variables (add to .env or export):
 *   CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_API_NAME
 *   S3_* vars (already configured for the project)
 */

// ── Load project env ────────────────────────────────────────────────
require("../config/env");

const fs = require("fs");
const path = require("path");
const { putObject, objectExists } = require("../storage/s3Client");
const { Upload } = require("@aws-sdk/lib-storage");
const { s3, BUCKET } = require("../storage/s3Client");

// ── Configuration ───────────────────────────────────────────────────

const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_API_NAME;

const CHECKPOINT_FILE =
  process.env.NODE_ENV === "production"
    ? "/tmp/.migration-cursor.json"
    : path.resolve(__dirname, "../../.migration-cursor.json");

const ALLOWED_IMAGE_FORMATS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "bmp",
  "tiff",
  "tif",
  "svg",
]);

const ALLOWED_VIDEO_FORMATS = new Set([
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "m4v",
  "ogv",
]);

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB

// ── CLI argument parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    dryRun: false,
    limit: 20,
    resume: false,
    resourceType: "all", // "image" | "video" | "all"
    concurrency: 5,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--resource-type":
        opts.resourceType = args[++i];
        break;
      case "--concurrency":
        opts.concurrency = parseInt(args[++i], 10);
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

// ── Cloudinary Admin API helpers ────────────────────────────────────

function buildAuthHeader() {
  const credentials = Buffer.from(
    `${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`,
  ).toString("base64");
  return `Basic ${credentials}`;
}

async function fetchCloudinaryPage(resourceType, nextCursor, maxResults) {
  const url = new URL(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/${resourceType}`,
  );
  url.searchParams.set("type", "upload");
  url.searchParams.set("max_results", String(maxResults));
  if (nextCursor) {
    url.searchParams.set("next_cursor", nextCursor);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: buildAuthHeader() },
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("retry-after") || "60", 10);
    console.warn(
      `  ⚠ Cloudinary rate limit hit. Waiting ${retryAfter}s …`,
    );
    await sleep(retryAfter * 1000);
    return fetchCloudinaryPage(resourceType, nextCursor, maxResults);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Cloudinary API error ${response.status}: ${body}`,
    );
  }

  return response.json();
}

// ── Retry & concurrency helpers ─────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 3, baseDelay = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err.message?.includes("429") || err.name === "TooManyRequestsException";
      const isNetwork =
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ENOTFOUND" ||
        err.message?.includes("fetch failed");

      if (attempt === retries || (!isRateLimit && !isNetwork)) {
        throw err;
      }

      const delay = isRateLimit
        ? 60_000
        : baseDelay * Math.pow(2, attempt - 1);
      console.warn(
        `  ⚠ Attempt ${attempt}/${retries} failed (${err.message}). Retrying in ${Math.round(delay / 1000)}s …`,
      );
      await sleep(delay);
    }
  }
}

function createPool(concurrency) {
  let active = 0;
  const queue = [];

  function next() {
    if (queue.length === 0 || active >= concurrency) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        active--;
        next();
      });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ── Checkpoint persistence ──────────────────────────────────────────

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
    }
  } catch {
    // corrupted checkpoint, start fresh
  }
  return null;
}

function saveCheckpoint(data) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
}

function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
  } catch {
    // ignore
  }
}

// ── Download from Cloudinary ────────────────────────────────────────

async function downloadAsBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed ${response.status}: ${url}`);
  }
  const arrayBuf = await response.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ── Upload to S3 (with multipart for large files) ───────────────────

async function uploadToS3(key, buffer, contentType) {
  if (buffer.length > MULTIPART_THRESHOLD) {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      },
      partSize: 10 * 1024 * 1024, // 10 MB parts
      leavePartsOnError: false,
    });
    return upload.done();
  }
  return putObject(key, buffer, contentType);
}

// ── Format helpers ──────────────────────────────────────────────────

function isAllowedFormat(format, resourceType) {
  const f = (format || "").toLowerCase();
  if (resourceType === "image") return ALLOWED_IMAGE_FORMATS.has(f);
  if (resourceType === "video") return ALLOWED_VIDEO_FORMATS.has(f);
  return false;
}

function formatContentType(format, resourceType) {
  const f = (format || "").toLowerCase();
  if (resourceType === "video") {
    const videoMap = {
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      mkv: "video/x-matroska",
      m4v: "video/mp4",
      ogv: "video/ogg",
    };
    return videoMap[f] || "video/mp4";
  }
  const imageMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    svg: "image/svg+xml",
  };
  return imageMap[f] || "image/jpeg";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Main migration logic ────────────────────────────────────────────

async function migrateResourceType(resourceType, opts, stats) {
  const pageSize = Math.min(opts.limit > 0 ? opts.limit : 500, 500);
  let nextCursor = null;
  let processed = 0;

  // Resume support
  if (opts.resume) {
    const checkpoint = loadCheckpoint();
    if (
      checkpoint &&
      checkpoint.resourceType === resourceType &&
      checkpoint.nextCursor
    ) {
      nextCursor = checkpoint.nextCursor;
      processed = checkpoint.processedCount || 0;
      stats.skipped += processed;
      console.log(
        `  ↻ Resuming ${resourceType} from cursor (${processed} already processed)`,
      );
    }
  }

  const pool = createPool(opts.concurrency);

  let hasMore = true;

  while (hasMore) {
    // Check global limit
    if (opts.limit > 0 && stats.total >= opts.limit) break;

    const remaining =
      opts.limit > 0 ? opts.limit - stats.total : pageSize;
    const fetchSize = Math.min(remaining, pageSize);

    console.log(
      `\n  Fetching up to ${fetchSize} ${resourceType} resources …`,
    );

    const page = await withRetry(() =>
      fetchCloudinaryPage(resourceType, nextCursor, fetchSize),
    );

    const resources = page.resources || [];
    if (resources.length === 0) break;

    // Filter to allowed formats
    const filtered = resources.filter((r) =>
      isAllowedFormat(r.format, resourceType),
    );

    const skippedFormats = resources.length - filtered.length;
    if (skippedFormats > 0) {
      console.log(
        `  ⏩ Skipped ${skippedFormats} non-media files (unsupported format)`,
      );
    }

    // Process assets concurrently
    const tasks = filtered.map((resource) =>
      pool(async () => {
        // Check global limit inside task
        if (opts.limit > 0 && stats.total >= opts.limit) return;

        stats.total++;
        const index = stats.total;
        const totalLabel =
          opts.limit > 0 ? opts.limit : "?";

        const publicId = resource.public_id;
        const format = resource.format;
        const s3Key = `originals/${publicId}.${format}`;
        const secureUrl = resource.secure_url;
        const sizeLabel = resource.bytes
          ? formatBytes(resource.bytes)
          : "?";

        // Dry-run mode
        if (opts.dryRun) {
          console.log(
            `  [${index}/${totalLabel}] 🔍 ${publicId}.${format} (${sizeLabel}) → ${s3Key}`,
          );
          stats.success++;
          return;
        }

        try {
          // Idempotency check
          const exists = await withRetry(() => objectExists(s3Key));
          if (exists) {
            console.log(
              `  [${index}/${totalLabel}] ⏭ ${publicId}.${format} (already in S3)`,
            );
            stats.skipped++;
            return;
          }

          // Download original from Cloudinary (no transformations)
          const buffer = await withRetry(() => downloadAsBuffer(secureUrl));
          const contentType = formatContentType(format, resourceType);

          // Upload to S3
          await withRetry(() => uploadToS3(s3Key, buffer, contentType));

          console.log(
            `  [${index}/${totalLabel}] ✓ ${publicId}.${format} (${formatBytes(buffer.length)})`,
          );
          stats.success++;
        } catch (err) {
          console.error(
            `  [${index}/${totalLabel}] ✗ ${publicId}.${format} — ${err.message}`,
          );
          stats.failed++;
          stats.failures.push({
            publicId,
            format,
            resourceType,
            error: err.message,
          });
        }
      }),
    );

    await Promise.all(tasks);

    // Pagination
    nextCursor = page.next_cursor || null;
    processed += resources.length;
    hasMore = !!nextCursor;

    // Save checkpoint after each page
    if (!opts.dryRun && hasMore) {
      saveCheckpoint({
        resourceType,
        nextCursor,
        processedCount: processed,
        timestamp: new Date().toISOString(),
      });
    }

    // Small delay between pages to respect rate limits
    if (hasMore) await sleep(500);
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  // ── Validate credentials ──────────────────────────────────────────
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET || !CLOUDINARY_CLOUD_NAME) {
    console.error(
      "Missing Cloudinary credentials. Set CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, and CLOUDINARY_API_NAME in your .env file.",
    );
    process.exit(1);
  }

  // ── Print config ──────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║      Cloudinary → S3 Migration                  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(
    `  Cloud:        ${CLOUDINARY_CLOUD_NAME}`,
  );
  console.log(`  Mode:         ${opts.dryRun ? "DRY RUN (no uploads)" : "LIVE"}`);
  console.log(
    `  Limit:        ${opts.limit > 0 ? opts.limit + " assets" : "unlimited"}`,
  );
  console.log(`  Resource:     ${opts.resourceType}`);
  console.log(`  Concurrency:  ${opts.concurrency}`);
  console.log(`  Resume:       ${opts.resume ? "yes" : "no"}`);
  console.log(`  S3 Bucket:    ${BUCKET}`);
  console.log();

  const stats = {
    total: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  const resourceTypes =
    opts.resourceType === "all"
      ? ["image", "video"]
      : [opts.resourceType];

  const startTime = Date.now();

  for (const rt of resourceTypes) {
    console.log(`\n─── Migrating ${rt} resources ───`);
    await migrateResourceType(rt, opts, stats);

    // Reset cursor between resource types
    if (opts.resourceType === "all" && !opts.dryRun) {
      clearCheckpoint();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("\n══════════════════════════════════════════════════");
  console.log("  Migration Summary");
  console.log("══════════════════════════════════════════════════");
  console.log(`  Total processed:  ${stats.total}`);
  console.log(`  Successful:       ${stats.success}`);
  console.log(`  Skipped (exists): ${stats.skipped}`);
  console.log(`  Failed:           ${stats.failed}`);
  console.log(`  Duration:         ${elapsed}s`);

  if (stats.failures.length > 0) {
    console.log("\n  Failed items:");
    for (const f of stats.failures) {
      console.log(`    - ${f.publicId}.${f.format} (${f.resourceType}): ${f.error}`);
    }
  }

  // Clean up checkpoint on successful completion
  if (stats.failed === 0 && !opts.dryRun) {
    clearCheckpoint();
    console.log("\n  ✓ Migration complete. Checkpoint cleared.");
  } else if (stats.failed > 0) {
    console.log(
      "\n  ⚠ Some items failed. Run with --resume to retry remaining.",
    );
  }

  if (opts.dryRun) {
    console.log("\n  ℹ This was a dry run. No files were uploaded.");
  }

  console.log();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
