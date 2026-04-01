const { putObject } = require("../storage/s3Client");
const path = require("path");
const mime = require("mime-types");

async function uploadRoutes(fastify) {
  fastify.post(
    "/upload",
    {
      config: {
        rateLimit: {
          max: Number.parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "20", 10),
          timeWindow: Number.parseInt(
            process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || "60000",
            10,
          ),
        },
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

      // Read folder from fields if provided
      const folder = data.fields?.folder?.value || "";

      const originalExt = path
        .extname(data.filename || "")
        .replace(".", "")
        .toLowerCase();
      const mimeExt = mime.extension(data.mimetype || "") || "";
      const extension = originalExt || mimeExt || "jpg";
      const generatedFilename = `${Date.now()}${Math.floor(Math.random() * 1000)}.${extension}`;

      const key = folder
        ? `originals/${folder}/${generatedFilename}`
        : `originals/${generatedFilename}`;

      await putObject(key, buffer, data.mimetype);

      const relativePath = key.replace(/^originals\//, "");

      return reply.code(201).send({
        key,
        size: buffer.length,
        url: `/media/upload/f_webp/${relativePath}`,
      });
    },
  );
}

module.exports = uploadRoutes;
