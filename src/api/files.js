const path = require("path");
const { Transform } = require("stream");
const {
  uploadStream,
  getObjectStream,
} = require("../storage/s3Client");
const { ValidationError } = require("../utils/paramParser");

// Accepted spreadsheet extensions and their canonical content types. The
// extension is the first gate (browsers report inconsistent mimetypes for
// Office files), and the file's magic bytes are verified on top — see
// EXCEL_CONTAINER_BY_EXT and createExcelContentValidator below.
const EXCEL_CONTENT_TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
};

// Expected binary container per extension. Verifying the leading magic bytes
// against this defeats a renamed file (e.g. evil.bin → evil.xlsx).
//   zip  = OOXML (xlsx/xlsm/xlsb): a ZIP archive — starts with "PK\x03\x04"
//   ole2 = legacy xls: an OLE2 compound file — starts with D0 CF 11 E0 A1 B1 1A E1
const EXCEL_CONTAINER_BY_EXT = {
  xlsx: "zip",
  xlsm: "zip",
  xlsb: "zip",
  xls: "ole2",
};

const SIGNATURE_BYTES = 8;

class ExcelContentError extends Error {
  constructor() {
    super("File content does not match a valid Excel file");
    this.code = "EXCEL_INVALID_CONTENT";
    this.statusCode = 400;
  }
}

// Identify the binary container from the first bytes of the file.
function detectContainerKind(head) {
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b && // "PK"
    ((head[2] === 0x03 && head[3] === 0x04) ||
      (head[2] === 0x05 && head[3] === 0x06) || // empty archive
      (head[2] === 0x07 && head[3] === 0x08)) // spanned archive
  ) {
    return "zip";
  }
  if (
    head.length >= 8 &&
    head[0] === 0xd0 &&
    head[1] === 0xcf &&
    head[2] === 0x11 &&
    head[3] === 0xe0 &&
    head[4] === 0xa1 &&
    head[5] === 0xb1 &&
    head[6] === 0x1a &&
    head[7] === 0xe1
  ) {
    return "ole2";
  }
  return "unknown";
}

// A pass-through stream that verifies the leading magic bytes match
// `expectedKind` before letting any data through, then forwards the rest
// untouched. Only the first few bytes are buffered, so it stays memory-flat for
// huge files. On mismatch it errors with ExcelContentError, which aborts the
// in-flight S3 upload.
function createExcelContentValidator(expectedKind) {
  let head = Buffer.alloc(0);
  let verified = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (verified) return cb(null, chunk);
      head = head.length ? Buffer.concat([head, chunk]) : chunk;
      if (head.length < SIGNATURE_BYTES) return cb();
      if (detectContainerKind(head) !== expectedKind) {
        return cb(new ExcelContentError());
      }
      verified = true;
      const buffered = head;
      head = Buffer.alloc(0);
      cb(null, buffered);
    },
    flush(cb) {
      // Stream ended before a full signature (tiny/empty file). A real
      // spreadsheet is always larger than the signature, so this is a reject.
      if (verified) return cb();
      if (detectContainerKind(head) !== expectedKind) {
        return cb(new ExcelContentError());
      }
      this.push(head);
      cb();
    },
  });
}

// Huge files are expected here, so the limit is much higher than the media
// uploads. The file is streamed straight to S3, never buffered in memory.
const EXCEL_MAX_FILE_SIZE_BYTES =
  Number.parseInt(process.env.UPLOAD_EXCEL_MAX_FILE_SIZE_MB || "512", 10) *
  1024 *
  1024;

const excelRateLimit = {
  max: Number.parseInt(process.env.UPLOAD_EXCEL_RATE_LIMIT_MAX || "20", 10),
  timeWindow: Number.parseInt(
    process.env.UPLOAD_EXCEL_RATE_LIMIT_WINDOW_MS ||
      process.env.UPLOAD_RATE_LIMIT_WINDOW_MS ||
      "60000",
    10,
  ),
};

function excelExtension(filename) {
  return path.extname(filename || "").replace(".", "").toLowerCase();
}

function isExcelFile(filename) {
  return Object.prototype.hasOwnProperty.call(
    EXCEL_CONTENT_TYPES,
    excelExtension(filename),
  );
}

// Strip surrounding slashes and reject path-traversal so a caller can't write
// outside the originals/ prefix via "../".
function sanitizeFolder(folder) {
  const cleaned = String(folder || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";
  if (cleaned.split("/").some((segment) => segment === "..")) {
    throw new ValidationError("Invalid folder");
  }
  return cleaned;
}

// Same traversal guard for the download path (the wildcard after /file/upload/).
function sanitizeFilePath(filePath) {
  const cleaned = String(filePath || "").replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").some((segment) => segment === "..")) {
    return null;
  }
  return cleaned;
}

// Prefer an explicit public base (e.g. behind a CDN/proxy); otherwise derive
// from the request. trustProxy is on, so request.protocol already honours
// X-Forwarded-Proto, and the Host header carries any non-default port.
function buildAbsoluteUrl(request, pathname) {
  const configured = process.env.PUBLIC_BASE_URL;
  const base = configured
    ? configured.replace(/\/+$/, "")
    : `${request.protocol}://${request.headers.host}`;
  return `${base}${pathname}`;
}

function isFileTooLargeError(err) {
  return err?.statusCode === 413 || err?.code === "FST_REQ_FILE_TOO_LARGE";
}

async function filesRoutes(fastify) {
  // ── Upload ───────────────────────────────────────────────────────────────
  // POST /upload/excel?folder=<folder>   (folder may also be a form field that
  // precedes the file). The file part is streamed directly to S3.
  fastify.post(
    "/upload/excel",
    { config: { rateLimit: excelRateLimit } },
    async (request, reply) => {
      // Folder via query is streaming-safe (known before the file arrives).
      let folder =
        typeof request.query?.folder === "string" ? request.query.folder : "";
      let uploaded = null;

      for await (const part of request.parts({
        limits: { fileSize: EXCEL_MAX_FILE_SIZE_BYTES },
      })) {
        if (part.type === "field") {
          // Only honoured if it arrives before the file (we stream, so we can't
          // wait for a trailing field). Query param takes precedence.
          if (part.fieldname === "folder" && !folder) {
            folder = String(part.value ?? "");
          }
          continue;
        }

        if (part.type !== "file") continue;

        // Only one file per request; drain any extras so the stream finishes.
        if (uploaded) {
          part.file.resume();
          continue;
        }

        if (!isExcelFile(part.filename)) {
          part.file.resume();
          return reply.code(400).send({
            error: "Only Excel files are allowed (.xlsx, .xls, .xlsm, .xlsb)",
          });
        }

        const ext = excelExtension(part.filename);
        const sanitizedFolder = sanitizeFolder(folder);
        const generatedFilename = `${Date.now()}${Math.floor(
          Math.random() * 1000,
        )}.${ext}`;
        const key = sanitizedFolder
          ? `originals/${sanitizedFolder}/${generatedFilename}`
          : `originals/${generatedFilename}`;
        const contentType = EXCEL_CONTENT_TYPES[ext];

        // Verify the file's magic bytes match the claimed type as the bytes
        // stream past, on the way to S3. .pipe() does not forward source
        // errors, so bridge them (e.g. the 413 emitted on size-limit breach).
        const validator = createExcelContentValidator(
          EXCEL_CONTAINER_BY_EXT[ext],
        );
        part.file.on("error", (streamErr) => validator.destroy(streamErr));
        const validatedStream = part.file.pipe(validator);

        try {
          await uploadStream(key, validatedStream, contentType);
        } catch (err) {
          if (err?.code === "EXCEL_INVALID_CONTENT") {
            part.file.destroy(); // reject early — don't drain a huge bad file
            return reply.code(400).send({
              error:
                "File content does not match a valid Excel file (.xlsx, .xls, .xlsm, .xlsb)",
            });
          }
          if (isFileTooLargeError(err) || part.file.truncated) {
            return reply.code(413).send({ error: "File too large" });
          }
          throw err;
        }

        // Belt-and-suspenders: catch a truncation that didn't surface as an error.
        if (part.file.truncated) {
          return reply.code(413).send({ error: "File too large" });
        }

        uploaded = {
          key,
          filename: generatedFilename,
          originalName: part.filename,
          contentType,
        };
      }

      if (!uploaded) {
        return reply.code(400).send({ error: "File is required" });
      }

      const relativePath = uploaded.key.replace(/^originals\//, "");
      const url = buildAbsoluteUrl(request, `/file/upload/${relativePath}`);

      request._logExtra = {
        component: "ExcelUploadRoute",
        resource_type: "file",
        s3_key: uploaded.key,
      };

      return reply.code(201).send({
        url,
        key: uploaded.key,
        filename: uploaded.filename,
        originalName: uploaded.originalName,
        contentType: uploaded.contentType,
      });
    },
  );

  // ── Download ──────────────────────────────────────────────────────────────
  // GET /file/upload/*  — streams the stored original back to the client.
  // Public (allowlisted in authHook) so the returned URL is directly usable.
  fastify.get(
    "/file/upload/*",
    { config: { rateLimit: excelRateLimit } },
    async (request, reply) => {
      const filePath = sanitizeFilePath(request.params["*"]);
      if (!filePath) {
        return reply.code(400).send({ error: "File path is required" });
      }

      const ext = excelExtension(filePath);
      const key = `originals/${filePath}`;

      let response;
      try {
        response = await getObjectStream(key);
      } catch (err) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
          return reply.code(404).send({ error: "File not found" });
        }
        throw err;
      }

      reply.header(
        "Content-Type",
        response.ContentType ||
          EXCEL_CONTENT_TYPES[ext] ||
          "application/octet-stream",
      );
      if (response.ContentLength != null) {
        reply.header("Content-Length", String(response.ContentLength));
      }
      reply.header(
        "Content-Disposition",
        `attachment; filename="${path.basename(filePath)}"`,
      );

      // Stream the S3 body straight through — no buffering for huge files.
      return reply.send(response.Body);
    },
  );
}

module.exports = filesRoutes;
