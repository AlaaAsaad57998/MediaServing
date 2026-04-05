const { putObject } = require("../storage/s3Client");
const path = require("path");
const mime = require("mime-types");

function resolveExtension(filename, mimetype) {
  const originalExt = path
    .extname(filename || "")
    .replace(".", "")
    .toLowerCase();
  const mimeExt = mime.extension(mimetype || "") || "";
  return originalExt || mimeExt || "jpg";
}

async function saveUploadedImage(buffer, filename, mimetype, folder) {
  const extension = resolveExtension(filename, mimetype);
  const generatedFilename = `${Date.now()}${Math.floor(Math.random() * 1000)}.${extension}`;
  const key = folder
    ? `originals/${folder}/${generatedFilename}`
    : `originals/${generatedFilename}`;

  await putObject(key, buffer, mimetype);

  const relativePath = key.replace(/^originals\//, "");

  return {
    key,
    size: buffer.length,
    url: `/media/upload/f_webp/${relativePath}`,
  };
}

const uploadRateLimit = {
  max: Number.parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "20", 10),
  timeWindow: Number.parseInt(
    process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || "60000",
    10,
  ),
};

const bulkMultipartLimits = {
  files: Number.parseInt(process.env.UPLOAD_BULK_MAX_FILES || "50", 10),
  fileSize: 10 * 1024 * 1024,
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
      );

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
          return reply.code(400).send({ error: "One or more uploaded files are empty" });
        }

        const item = await saveUploadedImage(
          buffer,
          part.filename,
          part.mimetype,
          folder,
        );
        items.push(item);
      }

      if (items.length === 0) {
        return reply.code(400).send({ error: "At least one file is required" });
      }

      const urls = items.map((i) => i.url);

      return reply.code(201).send({ urls, items });
    },
  );
}

module.exports = uploadRoutes;
