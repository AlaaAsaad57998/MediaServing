#!/usr/bin/env node
/**
 * fetch-and-upload.js
 *
 * Downloads a video (or image) from a remote URL and uploads it to this
 * MediaServing instance, returning the public_id and all variant URLs.
 *
 * Usage:
 *   node src/scripts/fetch-and-upload.js <url> [options]
 *
 * Options:
 *   --folder <name>   Subfolder to store in (default: "fetched")
 *   --story           Also generate HLS story renditions
 *   --api-url <url>   Base URL of the MediaServing instance
 *                     (default: http://localhost:3000)
 *   --api-key <key>   API key (default: reads API_KEY from .env)
 *   --filename <name> Override the saved filename (keeps original ext)
 *
 * Examples:
 *   node src/scripts/fetch-and-upload.js "https://example.com/video.mp4"
 *   node src/scripts/fetch-and-upload.js "https://example.com/video.mp4" --story --folder stories
 *   node src/scripts/fetch-and-upload.js "https://..." --api-url https://media_server.ramaaz.dev --api-key YOUR_KEY
 */

"use strict";

require("../config/env");

const https = require("https");
const http = require("http");
const path = require("path");
const { Readable } = require("stream");

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    url: null,
    folder: "fetched",
    story: false,
    apiUrl: process.env.MEDIA_SERVING_URL || "http://localhost:3000",
    apiKey: process.env.API_KEY || "",
    filename: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("http://") || a.startsWith("https://")) {
      opts.url = a;
    } else if (a === "--folder" && args[i + 1]) {
      opts.folder = args[++i];
    } else if (a === "--story") {
      opts.story = true;
    } else if (a === "--api-url" && args[i + 1]) {
      opts.apiUrl = args[++i].replace(/\/$/, "");
    } else if (a === "--api-key" && args[i + 1]) {
      opts.apiKey = args[++i];
    } else if (a === "--filename" && args[i + 1]) {
      opts.filename = args[++i];
    } else if (!opts.url) {
      // treat first unrecognised positional as the URL
      opts.url = a;
    }
  }

  return opts;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Follow up to 5 redirects and resolve to a readable response stream.
 * Returns { stream, contentType, contentLength, finalUrl }.
 */
function fetchStream(rawUrl, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) {
      return reject(new Error("Too many redirects"));
    }

    const parsed = new URL(rawUrl);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.get(rawUrl, { timeout: 30000 }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); // drain
        const next = new URL(headers.location, rawUrl).href;
        return resolve(fetchStream(next, redirectsLeft - 1));
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(
          new Error(`Remote server returned HTTP ${statusCode} for ${rawUrl}`),
        );
      }

      resolve({
        stream: res,
        contentType: headers["content-type"] || "application/octet-stream",
        contentLength: headers["content-length"]
          ? parseInt(headers["content-length"], 10)
          : null,
        finalUrl: rawUrl,
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Connection timed out while fetching remote URL"));
    });
  });
}

// ── Filename helpers ──────────────────────────────────────────────────────────

const MIME_TO_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

function guessExtension(contentType, rawUrl, overrideName) {
  if (overrideName) {
    const ext = path.extname(overrideName).replace(".", "");
    if (ext) return ext;
  }

  // Try from URL path (before query string)
  try {
    const urlPath = new URL(rawUrl).pathname;
    const urlExt = path.extname(urlPath).replace(".", "").toLowerCase();
    if (urlExt && urlExt.length <= 5) return urlExt;
  } catch {
    /* ignore */
  }

  // Fall back to content-type
  const base = (contentType || "").split(";")[0].trim().toLowerCase();
  if (MIME_TO_EXT[base]) return MIME_TO_EXT[base];

  return "bin";
}

function buildFilename(overrideName, ext) {
  if (overrideName) {
    const existing = path.extname(overrideName);
    return existing ? overrideName : `${overrideName}.${ext}`;
  }
  return `${Date.now()}.${ext}`;
}

// ── Multipart form builder ────────────────────────────────────────────────────

/**
 * Builds a multipart/form-data body from a readable stream + metadata.
 * Returns { boundary, bodyStream } where bodyStream is a Node.js Readable.
 */
function buildMultipart(fileStream, filename, mimeType, folder) {
  const boundary = `----MediaServingBoundary${Date.now().toString(16)}`;
  const CRLF = "\r\n";

  // Preamble: folder field (if set) then file part header
  let preamble = "";
  if (folder) {
    preamble +=
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="folder"${CRLF}${CRLF}` +
      `${folder}${CRLF}`;
  }
  preamble +=
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`;

  const epilogue = `${CRLF}--${boundary}--${CRLF}`;

  const bodyStream = new Readable({ read() {} });
  bodyStream.push(preamble);

  fileStream.on("data", (chunk) => bodyStream.push(chunk));
  fileStream.on("end", () => {
    bodyStream.push(epilogue);
    bodyStream.push(null);
  });
  fileStream.on("error", (err) => bodyStream.destroy(err));

  return { boundary, bodyStream };
}

// ── Upload to MediaServing ────────────────────────────────────────────────────

function uploadStream(bodyStream, boundary, opts) {
  return new Promise((resolve, reject) => {
    const uploadPath = "/upload" + (opts.story ? "?story=true" : "");
    const parsed = new URL(opts.apiUrl + uploadPath);
    const transport = parsed.protocol === "https:" ? https : http;

    const reqOpts = {
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-API-Key": opts.apiKey,
        // Do NOT set Content-Length — we stream from an unknown-length download
        "Transfer-Encoding": "chunked",
      },
      timeout: 600000, // 10 min — story HLS encoding takes time
    };

    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(body);
        } catch {
          return reject(
            new Error(
              `Non-JSON response (HTTP ${res.statusCode}): ${body.slice(0, 300)}`,
            ),
          );
        }
        if (res.statusCode >= 400) {
          return reject(
            new Error(
              `Upload failed (HTTP ${res.statusCode}): ${json.error || body}`,
            ),
          );
        }
        resolve({ statusCode: res.statusCode, data: json });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Upload request timed out (>10 min)"));
    });

    bodyStream.pipe(req);
  });
}

// ── Progress ticker ───────────────────────────────────────────────────────────

function startTicker(label) {
  let dots = 0;
  const iv = setInterval(() => {
    dots = (dots + 1) % 4;
    process.stdout.write(`\r${label}${".".repeat(dots)}   `);
  }, 500);
  return () => {
    clearInterval(iv);
    process.stdout.write("\r");
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.url) {
    console.error(
      "Usage: node src/scripts/fetch-and-upload.js <url> [options]",
    );
    process.exit(1);
  }

  if (!opts.apiKey) {
    console.error(
      "ERROR: No API key found.\n" +
        "  Set API_KEY in .env.development, or pass --api-key <key>",
    );
    process.exit(1);
  }

  console.log("=== fetch-and-upload ===");
  console.log(
    `  Remote URL : ${opts.url.slice(0, 80)}${opts.url.length > 80 ? "…" : ""}`,
  );
  console.log(`  Target API : ${opts.apiUrl}`);
  console.log(`  Folder     : ${opts.folder}`);
  console.log(`  Story mode : ${opts.story}`);
  console.log("");

  // 1. Fetch remote file
  let stopTicker = startTicker("Connecting to remote server");
  let remote;
  try {
    remote = await fetchStream(opts.url);
    stopTicker();
  } catch (err) {
    stopTicker();
    console.error("ERROR fetching remote URL:", err.message);
    process.exit(1);
  }

  const ext = guessExtension(remote.contentType, opts.url, opts.filename);
  const filename = buildFilename(opts.filename, ext);
  const mimeType =
    remote.contentType.split(";")[0].trim() || `application/${ext}`;
  const sizeLabel = remote.contentLength
    ? `${(remote.contentLength / 1024 / 1024).toFixed(1)} MB`
    : "unknown size";

  console.log(`  Content-Type : ${mimeType}`);
  console.log(`  Size         : ${sizeLabel}`);
  console.log(`  Filename     : ${filename}`);
  console.log("");

  // 2. Stream-pipe: download → multipart → upload
  const { boundary, bodyStream } = buildMultipart(
    remote.stream,
    filename,
    mimeType,
    opts.folder,
  );

  const label = opts.story
    ? "Uploading + generating HLS story renditions (may take several minutes)"
    : "Uploading + processing";
  stopTicker = startTicker(label);

  let result;
  try {
    result = await uploadStream(bodyStream, boundary, opts);
    stopTicker();
  } catch (err) {
    stopTicker();
    console.error("ERROR uploading:", err.message);
    process.exit(1);
  }

  const { data } = result;
  const publicId = (data.key || "").replace(/^originals\//, "");

  console.log("=== Upload complete ===\n");
  console.log(`  public_id       : ${publicId}`);
  console.log(`  key             : ${data.key}`);
  console.log(
    `  size            : ${data.size ? (data.size / 1024 / 1024).toFixed(2) + " MB" : "-"}`,
  );
  if (data.durationSeconds != null) {
    console.log(`  duration        : ${data.durationSeconds.toFixed(1)}s`);
  }
  console.log(`  url             : ${opts.apiUrl}${data.url}`);

  if (data.variants) {
    console.log("\n  Variants:");
    for (const [k, v] of Object.entries(data.variants)) {
      console.log(`    ${k.padEnd(12)}: ${opts.apiUrl}${v}`);
    }
  }

  if (data.story?.variants) {
    console.log("\n  Story:");
    for (const [k, v] of Object.entries(data.story.variants)) {
      console.log(`    ${k.padEnd(12)}: ${opts.apiUrl}${v}`);
    }
  }

  console.log("\n  Full JSON response:");
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
