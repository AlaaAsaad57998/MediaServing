const { putObject } = require("../storage/s3Client");
const path = require("path");
const mime = require("mime-types");
const { isVideoFile } = require("../utils/paramParser");
const {
  getVariantUrls,
  snapshotCacheKey,
  webpCacheKey,
  SNAPSHOT_SECOND,
  instantCacheKey,
  createInstantVariant,
  createWebpPosterVariant,
} = require("../services/videoPreprocessor");
const { getStoryUrls } = require("../services/storyVideoService");
const { probeMedia, extractSnapshot } = require("../processors/videoProcessor");
const { isWebPlayable } = require("../utils/mediaProbe");
const { checkCache, saveToCache } = require("../services/cacheService");
const { enqueueVideoJob } = require("../services/videoQueue");

const IMAGE_MAX_MB = Number.parseInt(process.env.IMAGE_MAX_FILE_SIZE_MB || "10", 10) || 10;
const VIDEO_MAX_MB = Number.parseInt(process.env.VIDEO_MAX_FILE_SIZE_MB || "10", 10) || 10;
const MAX_VIDEO_DURATION_SECONDS = Number.parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || "60", 10) || 60;
const MEDIA_MULTIPART_LIMIT_BYTES = Math.max(IMAGE_MAX_MB, VIDEO_MAX_MB) * 1024 * 1024;

function maxBytesForType(resourceType) {
  return (resourceType === "video" ? VIDEO_MAX_MB : IMAGE_MAX_MB) * 1024 * 1024;
}

function isTrueLike(value) {
  if (Array.isArray(value)) return isTrueLike(value[0]);
  if (value == null) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function resolveExtension(filename, mimetype) {
  const originalExt = path
    .extname(filename || "")
    .replace(".", "")
    .toLowerCase();
  const mimeExt = mime.extension(mimetype || "") || "";
  return originalExt || mimeExt || "jpg";
}

async function saveUploadedImage(
  buffer,
  filename,
  mimetype,
  folder,
  opts = {},
) {
  const extension = resolveExtension(filename, mimetype);
  const generatedFilename = `${Date.now()}${Math.floor(Math.random() * 1000)}.${extension}`;
  const key = folder
    ? `originals/${folder}/${generatedFilename}`
    : `originals/${generatedFilename}`;

  await putObject(key, buffer, mimetype);

  const relativePath = key.replace(/^originals\//, "");

  const isVideo = isVideoFile(filename, mimetype);
  const resourceType = isVideo ? "video" : "image";

  const result = {
    key,
    size: buffer.length,
    type: resourceType,
    url:
      folder === "customers/profile"
        ? `/${relativePath}`
        : `/${resourceType}/upload/${relativePath}`,
  };

  if (isVideo) {
    result.variants = getVariantUrls(relativePath);
    if (opts.story === true) {
      result.story = {
        enabled: true,
        variants: getStoryUrls(relativePath),
      };
    }
  }

  return result;
}

const uploadRateLimit = {
  max: Number.parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "20", 10),
  timeWindow: Number.parseInt(
    process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || "60000",
    10,
  ),
};

// Bulk uploads are batched by clients (galleries, migrations) and legitimately
// fire far more requests per window than single uploads, so they get a wider
// allowance to avoid spurious 429s. Falls back to the single-upload window.
const bulkUploadRateLimit = {
  max: Number.parseInt(process.env.UPLOAD_BULK_RATE_LIMIT_MAX || "100", 10),
  timeWindow: Number.parseInt(
    process.env.UPLOAD_BULK_RATE_LIMIT_WINDOW_MS ||
      process.env.UPLOAD_RATE_LIMIT_WINDOW_MS ||
      "60000",
    10,
  ),
};

const STORY_VIDEO_MAX_SIZE_BYTES = 10 * 1024 * 1024;

async function validateStoryVideoConstraints(buffer, filename, mimetype) {
  if (!isVideoFile(filename, mimetype)) {
    return { ok: true, durationSeconds: null };
  }

  if (buffer.length > STORY_VIDEO_MAX_SIZE_BYTES) {
    return {
      ok: false,
      error: "Story video size must be 10 MB or less",
    };
  }

  return { ok: true, durationSeconds: null };
}

const bulkMultipartLimits = {
  files: Number.parseInt(process.env.UPLOAD_BULK_MAX_FILES || "50", 10),
  fileSize: MEDIA_MULTIPART_LIMIT_BYTES,
};

async function uploadRoutes(fastify) {
  fastify.post(
    "/upload",
    {
      config: {
        rateLimit: uploadRateLimit,
      },
    },
    async (request, reply) => {
      const storyMode = isTrueLike(request.query?.story);

      // Collect all parts first so the folder field is available regardless
      // of whether it appears before or after the file in the stream.
      const collectedFields = {};
      let filePart = null;
      try {
        for await (const part of request.parts({ limits: { fileSize: MEDIA_MULTIPART_LIMIT_BYTES } })) {
          if (part.type === "field") {
            collectedFields[part.fieldname] =
              typeof part.value === "string"
                ? part.value
                : String(part.value ?? "");
          } else if (part.type === "file" && filePart === null) {
            filePart = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
          } else if (part.type === "file") {
            await part.toBuffer(); // drain unexpected extra files
          }
        }
      } catch (err) {
        if (err.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "File exceeds the size limit" });
        }
        throw err;
      }

      if (!filePart) {
        return reply.code(400).send({ error: "File is required" });
      }

      const { buffer, filename: dataFilename, mimetype: dataMimetype } = filePart;

      if (buffer.length === 0) {
        return reply.code(400).send({ error: "Uploaded file is empty" });
      }

      // Per-type size check after buffering.
      const detectedType = isVideoFile(dataFilename, dataMimetype) ? "video" : "image";
      if (buffer.length > maxBytesForType(detectedType)) {
        return reply.code(413).send({
          error: `${detectedType} exceeds the ${detectedType === "video" ? VIDEO_MAX_MB : IMAGE_MAX_MB} MB limit`,
        });
      }

      let storyVideoDurationSeconds = null;
      if (storyMode) {
        const validation = await validateStoryVideoConstraints(
          buffer,
          dataFilename,
          dataMimetype,
        );
        if (!validation.ok) {
          return reply.code(400).send({ error: validation.error });
        }
        storyVideoDurationSeconds = validation.durationSeconds;
      }

      const folder = collectedFields.folder || "";

      const item = await saveUploadedImage(
        buffer,
        dataFilename,
        dataMimetype,
        folder,
        { story: storyMode },
      );

      if (item.type === "video") {
        let info;
        try {
          info = await probeMedia(buffer);
        } catch (err) {
          return reply.code(400).send({ error: "Unreadable video file" });
        }
        if (info.durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
          return reply.code(400).send({
            error: `Video duration must be ${MAX_VIDEO_DURATION_SECONDS}s or less`,
          });
        }
        item.durationSeconds = info.durationSeconds;

        // Synchronous, cheap: posters (needed immediately by image targets).
        try {
          const snapKey = snapshotCacheKey(item.key);
          if (!(await checkCache(snapKey))) {
            const snap = await extractSnapshot(buffer, SNAPSHOT_SECOND);
            await saveToCache(snapKey, snap.buffer, snap.contentType);
          }
          const posterKey = webpCacheKey(item.key);
          if (!(await checkCache(posterKey))) {
            const poster = await createWebpPosterVariant(buffer);
            await saveToCache(posterKey, poster.buffer, poster.contentType);
          }
        } catch (err) {
          request.log.error({ s3_key: item.key, error: err.message }, "Poster generation failed");
        }

        // Synchronous only when the source won't play in a browser as-is.
        if (!isWebPlayable(info)) {
          try {
            const instant = await createInstantVariant(buffer);
            await saveToCache(instantCacheKey(item.key), instant.buffer, instant.contentType);
          } catch (err) {
            request.log.error({ s3_key: item.key, error: err.message }, "Instant variant generation failed");
          }
        }

        // Heavy polished variants go to the queue (non-blocking).
        await enqueueVideoJob(
          { originalKey: item.key, relativePath: item.key.replace(/^originals\//, ""), story: storyMode },
          request.log,
        );
      }

      request._logExtra = {
        component: "UploadRoute",
        resource_type: item.type,
        s3_key: item.key,
        file_size_bytes: buffer.length,
      };
      return reply.code(201).send(item);
    },
  );

  fastify.post(
    "/upload/bulk",
    {
      config: {
        rateLimit: bulkUploadRateLimit,
      },
    },
    async (request, reply) => {
      const storyMode = isTrueLike(request.query?.story);

      // Collect all parts first so the folder field is available regardless
      // of whether it appears before or after the files in the stream.
      const collectedFields = {};
      const collectedFiles = [];
      try {
        for await (const part of request.parts({
          limits: bulkMultipartLimits,
        })) {
          if (part.type === "field") {
            collectedFields[part.fieldname] =
              typeof part.value === "string"
                ? part.value
                : String(part.value ?? "");
            continue;
          }

          if (part.type !== "file") {
            continue;
          }

          const buffer = await part.toBuffer();

          if (buffer.length === 0) {
            return reply
              .code(400)
              .send({ error: "One or more uploaded files are empty" });
          }

          collectedFiles.push({ buffer, filename: part.filename, mimetype: part.mimetype });
        }
      } catch (err) {
        if (err.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "File exceeds the size limit" });
        }
        throw err;
      }

      const folder = collectedFields.folder || "";
      const items = [];
      // Keep per-file buffers in sync with items for video processing below.
      const fileBuffers = [];

      for (const { buffer, filename, mimetype } of collectedFiles) {
        // Per-type size check after buffering.
        const detectedType = isVideoFile(filename, mimetype) ? "video" : "image";
        if (buffer.length > maxBytesForType(detectedType)) {
          return reply.code(413).send({
            error: `${detectedType} exceeds the ${detectedType === "video" ? VIDEO_MAX_MB : IMAGE_MAX_MB} MB limit`,
          });
        }

        let storyVideoDurationSeconds = null;
        if (storyMode) {
          const validation = await validateStoryVideoConstraints(
            buffer,
            filename,
            mimetype,
          );
          if (!validation.ok) {
            return reply.code(400).send({ error: validation.error });
          }
          storyVideoDurationSeconds = validation.durationSeconds;
        }

        const item = await saveUploadedImage(
          buffer,
          filename,
          mimetype,
          folder,
          { story: storyMode },
        );

        if (item.type === "video") {
          let info;
          try {
            info = await probeMedia(buffer);
          } catch {
            return reply.code(400).send({ error: "Unreadable video file" });
          }
          if (info.durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
            return reply.code(400).send({
              error: `Video duration must be ${MAX_VIDEO_DURATION_SECONDS}s or less`,
            });
          }
          item.durationSeconds = info.durationSeconds;
          item._info = info; // stash for post-loop processing
        }

        items.push(item);
        fileBuffers.push(buffer);
      }

      if (items.length === 0) {
        return reply.code(400).send({ error: "At least one file is required" });
      }

      // Per-video: cheap poster + instant (failures are non-fatal per file),
      // then enqueue heavy polished variants.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type !== "video") continue;
        const buffer = fileBuffers[i];
        const info = item._info;
        delete item._info; // remove internal stash before response

        try {
          const snapKey = snapshotCacheKey(item.key);
          if (!(await checkCache(snapKey))) {
            const snap = await extractSnapshot(buffer, SNAPSHOT_SECOND);
            await saveToCache(snapKey, snap.buffer, snap.contentType);
          }
          const posterKey = webpCacheKey(item.key);
          if (!(await checkCache(posterKey))) {
            const poster = await createWebpPosterVariant(buffer);
            await saveToCache(posterKey, poster.buffer, poster.contentType);
          }
        } catch (err) {
          request.log.error({ s3_key: item.key, error: err.message }, "Poster generation failed");
        }

        if (!isWebPlayable(info)) {
          try {
            const instant = await createInstantVariant(buffer);
            await saveToCache(instantCacheKey(item.key), instant.buffer, instant.contentType);
          } catch (err) {
            request.log.error({ s3_key: item.key, error: err.message }, "Instant variant generation failed");
          }
        }

        // Always enqueue — even if posters/instant failed above.
        await enqueueVideoJob(
          { originalKey: item.key, relativePath: item.key.replace(/^originals\//, ""), story: storyMode },
          request.log,
        );
      }

      // Return only public ID with extension, without folder segments.
      const urls = items.map((i) => path.basename(i.key));
      const totalFileSize = items.reduce((sum, i) => sum + (i.size || 0), 0);
      request._logExtra = {
        component: "UploadRoute",
        file_count: items.length,
        total_file_size_bytes: totalFileSize,
      };
      if (urls?.length > 1) return reply.code(201).send({ urls });
      else return reply.code(201).send({ url: urls[0] });
    },
  );
}

module.exports = uploadRoutes;
