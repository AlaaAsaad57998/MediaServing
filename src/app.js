const fastify = require("fastify");
const path = require("path");
const { promises: fs } = require("fs");
const cors = require("@fastify/cors");
const multipart = require("@fastify/multipart");
const rateLimit = require("@fastify/rate-limit");
const sharp = require("sharp");
const { authHook } = require("./middleware/auth");
const uploadRoutes = require("./api/upload");
const transformRoutes = require("./api/transform");
const { createRedisClient, initRedis } = require("./services/lockService");
const { ValidationError } = require("./utils/paramParser");

// Tune libvips internal cache so Sharp reuses decoded frames across requests.
// memory: MB of decoded pixel data to keep; items: max number of cached ops.
sharp.cache({ memory: 128, files: 20, items: 500 });

const TEST_PAGE_PATH = path.resolve(__dirname, "..", "test.html");
const COMPARE_PAGE_PATH = path.resolve(__dirname, "..", "compare.html");

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCorsOrigin(value) {
  if (!value) return true;

  const normalized = value.trim();
  if (normalized === "true" || normalized === "*") {
    return true;
  }

  const origins = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (origins.length === 0) return true;
  if (origins.length === 1) return origins[0];

  return (origin, cb) => {
    if (!origin || origins.includes(origin)) {
      cb(null, true);
      return;
    }
    cb(new Error("Not allowed by CORS"), false);
  };
}

function buildApp(opts = {}) {
  const app = fastify({
    logger: true,
    trustProxy: process.env.TRUST_PROXY !== "false",
    ...opts,
  });

  let rateLimitRedis;
  if ((process.env.RATE_LIMIT_STORE || "redis") === "redis") {
    try {
      rateLimitRedis = createRedisClient();
      rateLimitRedis.on("error", () => {
        app.log.warn("Rate limit Redis unavailable; limits may degrade");
      });
      rateLimitRedis.connect().catch(() => {
        app.log.warn("Rate limit Redis connection failed; limits may degrade");
      });
    } catch {
      app.log.warn("Rate limit Redis init failed; using plugin defaults");
    }
  }

  app.register(cors, {
    origin: parseCorsOrigin(process.env.CORS_ORIGIN),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-API-Key", "Range"],
    exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
  });

  app.register(rateLimit, {
    global: true,
    max: toInt(process.env.RATE_LIMIT_MAX, 120),
    timeWindow: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    redis: rateLimitRedis,
    nameSpace: process.env.RATE_LIMIT_NAMESPACE || "rl:media-serving",
    keyGenerator(request) {
      const apiKey = request.headers["x-api-key"];
      return apiKey ? `k:${apiKey}` : `ip:${request.ip}`;
    },
    errorResponseBuilder(request, context) {
      return {
        error: "Too Many Requests",
        message: `Rate limit exceeded, retry in ${context.after}`,
        statusCode: 429,
      };
    },
  });

  // Register multipart support (120 MB file size limit — supports video uploads)
  const maxFileSize =
    Number.parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || "120", 10) *
    1024 *
    1024;
  app.register(multipart, { limits: { fileSize: maxFileSize } });

  // Global auth hook
  app.addHook("preHandler", authHook);

  // Health check (no auth — skipped by authHook)
  app.get("/health", { config: { rateLimit: false } }, async () => ({
    status: "ok",
  }));

  async function serveTestPage(reply) {
    try {
      const html = await fs.readFile(TEST_PAGE_PATH, "utf8");
      const apiKeyLiteral = JSON.stringify(process.env.API_KEY || "");
      const hydratedHtml = html.replace(/"__TEST_API_KEY__"/g, apiKeyLiteral);
      return reply.type("text/html; charset=utf-8").send(hydratedHtml);
    } catch {
      return reply.code(404).send({ error: "test.html not found" });
    }
  }

  async function serveComparePage(reply) {
    try {
      let html = await fs.readFile(COMPARE_PAGE_PATH, "utf8");
      html = html.replace(
        /"__TEST_API_KEY__"/g,
        JSON.stringify(process.env.API_KEY || ""),
      );
      html = html.replace(
        /"__CLOUDINARY_CLOUD_NAME__"/g,
        JSON.stringify(process.env.CLOUDINARY_CLOUD_NAME || ""),
      );
      html = html.replace(
        /"__CLOUDINARY_PRESET__"/g,
        JSON.stringify(process.env.CLOUDINARY_UPLOAD_PRESET || ""),
      );
      return reply.type("text/html; charset=utf-8").send(html);
    } catch {
      return reply.code(404).send({ error: "compare.html not found" });
    }
  }

  // Public test panel route for deployment checks.
  app.get("/test", { config: { rateLimit: false } }, async (_, reply) =>
    serveTestPage(reply),
  );

  app.get("/test.html", { config: { rateLimit: false } }, async (_, reply) =>
    serveTestPage(reply),
  );

  // Benchmark comparison page.
  app.get("/compare", { config: { rateLimit: false } }, async (_, reply) =>
    serveComparePage(reply),
  );

  app.get("/compare.html", { config: { rateLimit: false } }, async (_, reply) =>
    serveComparePage(reply),
  );

  // Routes
  app.register(uploadRoutes);
  app.register(transformRoutes);

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(400).send({ error: error.message });
    }

    if (error.statusCode === 413) {
      return reply.code(413).send({ error: "File too large" });
    }

    request.log.error(error);
    reply.code(500).send({ error: "Internal server error" });
  });

  // Initialize Redis (non-blocking)
  initRedis();

  app.addHook("onClose", async () => {
    if (rateLimitRedis) {
      rateLimitRedis.disconnect();
    }
  });

  return app;
}

module.exports = { buildApp };
