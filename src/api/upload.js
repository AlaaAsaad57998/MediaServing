const { putObject } = require("../storage/s3Client");
const path = require("path");
const mime = require("mime-types");
const { isVideoFile } = require("../utils/paramParser");
const {
  preprocessVideo,
  getVariantUrls,
} = require("../services/videoPreprocessor");
const { getStoryUrls } = require("../services/storyVideoService");
const { probeDuration } = require("../processors/videoProcessor");

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
    url: `/${resourceType}/upload/${relativePath}`,
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

const maxFileSize =
  Number.parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || "100", 10) *
  1024 *
  1024;

const bulkMultipartLimits = {
  files: Number.parseInt(process.env.UPLOAD_BULK_MAX_FILES || "50", 10),
  fileSize: maxFileSize,
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
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({ error: "File is required" });
      }

      const chunks = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        return reply.code(400).send({ error: "Uploaded file is empty" });
      }

      const folder = data.fields?.folder?.value || "";

      const item = await saveUploadedImage(
        buffer,
        data.filename,
        data.mimetype,
        folder,
        { story: storyMode },
      );

      if (item.type === "video") {
        item.durationSeconds = await probeDuration(buffer).catch(() => 0);
        try {
          await preprocessVideo(
            item.key,
            item.key.replace(/^originals\//, ""),
            request.log,
            { story: storyMode },
          );
        } catch (err) {
          request.log.error(
            { error: err.message },
            "Video preprocessing failed",
          );
          return reply.code(500).send({ error: "Video processing failed" });
        }
      }

      return reply.code(201).send(item);
    },
  );

  fastify.post(
    "/upload/bulk",
    {
      config: {
        rateLimit: uploadRateLimit,
      },
    },
    async (request, reply) => {
      const storyMode = isTrueLike(request.query?.story);
      let folder = "";
      const items = [];

      for await (const part of request.parts({
        limits: bulkMultipartLimits,
      })) {
        if (part.type === "field") {
          if (part.fieldname === "folder") {
            folder =
              typeof part.value === "string"
                ? part.value
                : String(part.value ?? "");
          }
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

        const item = await saveUploadedImage(
          buffer,
          part.filename,
          part.mimetype,
          folder,
          { story: storyMode },
        );

        if (item.type === "video") {
          item.durationSeconds = await probeDuration(buffer).catch(() => 0);
        }

        items.push(item);
      }

      if (items.length === 0) {
        return reply.code(400).send({ error: "At least one file is required" });
      }

      const videoItems = items.filter((i) => i.type === "video");
      if (videoItems.length > 0) {
        const results = await Promise.allSettled(
          videoItems.map((i) =>
            preprocessVideo(
              i.key,
              i.key.replace(/^originals\//, ""),
              request.log,
              { story: storyMode },
            ),
          ),
        );
        const failed = results.find((r) => r.status === "rejected");
        if (failed) {
          request.log.error(
            { error: failed.reason?.message },
            "Video preprocessing failed during bulk upload",
          );
          return reply.code(500).send({ error: "Video processing failed" });
        }
      }

      const urls = items.map((i) => i.url);

      return reply.code(201).send({ urls, items });
    },
  );
}

module.exports = uploadRoutes;
