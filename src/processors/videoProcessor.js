const { spawn } = require("child_process");
const { promises: fs } = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const sharp = require("sharp");

const FFMPEG_BIN = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG_X264_PRESET = process.env.FFMPEG_X264_PRESET || "superfast";
const FFMPEG_X265_PRESET = process.env.FFMPEG_X265_PRESET || "superfast";
const FFMPEG_VP9_DEADLINE = process.env.FFMPEG_VP9_DEADLINE || "realtime";
const FFMPEG_VP9_CPU_USED = process.env.FFMPEG_VP9_CPU_USED || "6";
const FFMPEG_THREADS = Math.max(
  0,
  Number.parseInt(process.env.FFMPEG_THREADS || "2", 10) || 2,
);
const STORY_HLS_X264_PRESET = process.env.STORY_HLS_X264_PRESET || "superfast";
const STORY_HLS_SEGMENT_SECONDS = Math.max(
  2,
  Number.parseInt(process.env.STORY_HLS_SEGMENT_SECONDS || "4", 10) || 4,
);
const STORY_HLS_TRANSCODE_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.STORY_HLS_TRANSCODE_CONCURRENCY || "3", 10) || 3,
);

// ── helpers ────────────────────────────────────────────────────────────────

function tmpPath(ext) {
  return path.join(
    os.tmpdir(),
    `ms_${crypto.randomBytes(8).toString("hex")}.${ext}`,
  );
}

async function cleanup(...files) {
  for (const f of files) {
    try {
      await fs.unlink(f);
    } catch {
      /* best-effort */
    }
  }
}

// ── probe ──────────────────────────────────────────────────────────────────

function probe(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      inputPath,
    ];
    const proc = spawn(FFPROBE_BIN, args);
    const chunks = [];
    const errorChunks = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => errorChunks.push(d));
    proc.on("close", (code) => {
      if (code !== 0) {
        const stderrMsg = Buffer.concat(errorChunks).toString();
        const errorMsg = stderrMsg || `ffprobe exited with code ${code}`;
        return reject(new Error(`ffprobe failed: ${errorMsg}`));
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
      }
    });
    proc.on("error", (err) => {
      reject(new Error(`ffprobe process error: ${err.message}`));
    });
  });
}

// ── dominant colour (for pad background) ───────────────────────────────────

async function extractDominantColor(inputPath) {
  // Grab a single frame and run Sharp stats on it
  const frameBuf = await extractFrame(inputPath, 0);
  const { dominant } = await sharp(frameBuf).stats();
  return `0x${dominant.r.toString(16).padStart(2, "0")}${dominant.g.toString(16).padStart(2, "0")}${dominant.b.toString(16).padStart(2, "0")}`;
}

function extractFrame(inputPath, timeSec) {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss",
      String(timeSec),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ];
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`frame extract failed (${code})`));
      resolve(Buffer.concat(chunks));
    });
    proc.on("error", reject);
  });
}

function isLikelyPlaylist(name) {
  return name.toLowerCase().endsWith(".m3u8");
}

function isLikelySegment(name) {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".ts") || lower.endsWith(".m4s") || lower.endsWith(".mp4")
  );
}

function sanitizeAssetName(assetName) {
  const name = String(assetName || "").trim();
  if (!name) return "master.m3u8";
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid story asset name");
  }
  return name;
}

function storyAssetContentType(assetName) {
  const name = sanitizeAssetName(assetName);
  if (isLikelyPlaylist(name)) return "application/vnd.apple.mpegurl";
  if (name.toLowerCase().endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

function buildStoryMasterPlaylist(baseQueryPath, renditions) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const r of renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.w}x${r.h},CODECS=\"avc1.4d401f,mp4a.40.2\"`,
      `${baseQueryPath}?target=story&asset=${encodeURIComponent(`${r.name}.m3u8`)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function rewritePlaylistUris(playlistText, baseQueryPath) {
  const lines = playlistText.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    return `${baseQueryPath}?target=story&asset=${encodeURIComponent(trimmed)}`;
  });
  return `${rewritten.join("\n")}\n`;
}

async function runWithConcurrency(items, workerFn, concurrency) {
  if (!Array.isArray(items) || items.length === 0) return;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await workerFn(items[index]);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// ── codec / format mapping ─────────────────────────────────────────────────

function resolveCodecAndFormat(params, probeInfo) {
  // Output container
  let container = "mp4";
  let ext = "mp4";
  let vcodec = "libx264";
  let acodec = "aac";

  // f_auto / explicit format
  const fmt = params.f;
  if (fmt === "webm") {
    container = "webm";
    ext = "webm";
    vcodec = "libvpx-vp9";
    acodec = "libopus";
  } else if (fmt === "mp4" || !fmt || fmt === "auto") {
    container = "mp4";
    ext = "mp4";
  }

  // vc_auto – pick optimal codec for the container
  if (params.vc === "auto") {
    if (container === "mp4") {
      vcodec = "libx264"; // widest HW-decode support, fast encode
    } else {
      vcodec = "libvpx-vp9";
    }
  } else if (params.vc === "h265" || params.vc === "hevc") {
    vcodec = "libx265";
  } else if (params.vc === "h264") {
    vcodec = "libx264";
  } else if (params.vc === "vp9") {
    vcodec = "libvpx-vp9";
    container = "webm";
    ext = "webm";
    acodec = "libopus";
  }

  // Keep container+codec combinations valid to avoid ffmpeg failures.
  if (container === "webm" && (vcodec === "libx264" || vcodec === "libx265")) {
    vcodec = "libvpx-vp9";
    acodec = "libopus";
  }
  if (container === "mp4" && vcodec === "libvpx-vp9") {
    container = "webm";
    ext = "webm";
    acodec = "libopus";
  }

  return { container, ext, vcodec, acodec };
}

// ── quality mapping ────────────────────────────────────────────────────────

function resolveCrf(params, vcodec) {
  // q_auto / explicit
  const q = params.q;

  // quality presets → CRF (lower = better)
  const presets = { eco: 32, low: 28, good: 23, best: 18 };

  let crf;
  if (typeof q === "string" && q.startsWith("auto")) {
    const level = q.includes(":") ? q.split(":")[1] : "good";
    crf = presets[level] ?? presets.good;
  } else if (typeof q === "number") {
    // Map quality 1-100 → CRF 51-0 (inverted)
    crf = Math.round(51 - (q / 100) * 51);
  } else {
    crf = presets.good; // sensible default
  }

  // VP9 uses a different CRF range (0-63, lower = better) but the same
  // mapping direction works. Adjust slightly for VP9.
  if (vcodec === "libvpx-vp9") {
    crf = Math.min(crf + 8, 63);
  }

  return crf;
}

// ── scale / crop filter ────────────────────────────────────────────────────

function buildFilterChain(params, probeInfo, padColor) {
  const filters = [];

  const videoStream = (probeInfo.streams || []).find(
    (s) => s.codec_type === "video",
  );
  const srcW = videoStream ? videoStream.width : 1920;
  const srcH = videoStream ? videoStream.height : 1080;

  const w = params.w || -2;
  const h = params.h || -2;
  const crop = params.c; // fill / crop / pad / fit / scale

  if (crop === "fill" || crop === "cover" || crop === "crop") {
    // Scale to cover then center-crop to exact dimensions
    if (params.w && params.h) {
      filters.push(
        `scale=${params.w}:${params.h}:force_original_aspect_ratio=increase`,
        `crop=${params.w}:${params.h}`,
      );
    } else {
      filters.push(`scale=${w}:${h}`);
    }
  } else if (crop === "contain" || crop === "pad") {
    // Scale to fit inside, then pad to exact dimensions
    const bg = padColor || "black";
    if (params.w && params.h) {
      filters.push(
        `scale=${params.w}:${params.h}:force_original_aspect_ratio=decrease`,
        `pad=${params.w}:${params.h}:(ow-iw)/2:(oh-ih)/2:color=${bg}`,
      );
    } else {
      filters.push(`scale=${w}:${h}`);
    }
  } else if (crop === "fit") {
    // Fit inside without padding (Cloudinary c_fit-like behaviour)
    if (params.w && params.h) {
      filters.push(
        `scale=${params.w}:${params.h}:force_original_aspect_ratio=decrease`,
      );
    } else {
      filters.push(`scale=${w}:${h}`);
    }
  } else if (crop === "scale") {
    // Scale (can stretch when both dimensions are set)
    const sw = params.w || -1;
    const sh = params.h || -1;
    filters.push(`scale=${sw}:${sh}`);
  } else if (params.w || params.h) {
    // Simple scale (default behaviour — proportional)
    filters.push(`scale=${w}:${h}`);
  }

  return filters;
}

// ── main transcode ─────────────────────────────────────────────────────────

async function processVideo(inputBuffer, params) {
  const inPath = tmpPath("src");
  await fs.writeFile(inPath, inputBuffer);

  let probeInfo;
  try {
    probeInfo = await probe(inPath);
  } catch (err) {
    await cleanup(inPath);
    throw new Error(`Unable to probe video file: ${err.message}`);
  }

  const { container, ext, vcodec, acodec } = resolveCodecAndFormat(
    params,
    probeInfo,
  );
  const outPath = tmpPath(ext);
  const crf = resolveCrf(params, vcodec);

  // Pad background colour
  let padColor = null;
  if ((params.c === "contain" || params.c === "pad") && params.b === "auto") {
    try {
      padColor = await extractDominantColor(inPath);
    } catch {
      padColor = "black";
    }
  } else if (params.b && params.b !== "auto") {
    padColor = params.b.startsWith("#") ? `0x${params.b.slice(1)}` : params.b;
  }

  const filters = buildFilterChain(params, probeInfo, padColor);

  // H.264 / H.265 with yuv420p require even pixel dimensions due to 4:2:0
  // chroma subsampling. force_original_aspect_ratio=decrease (used by c_fit)
  // can produce odd numbers (e.g. 354×629). Append a normalisation step that
  // is a no-op for even dimensions and rounds odd ones down by 1 pixel.
  if (vcodec === "libx264" || vcodec === "libx265") {
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  }

  // ── Build ffmpeg args ────────────────────────────────────────────────

  const args = ["-y", "-hide_banner", "-loglevel", "error"];

  // Trim: start offset
  if (params.so != null) {
    args.push("-ss", String(params.so));
  }

  args.push("-i", inPath);

  // Trim: end offset
  if (params.eo != null) {
    if (params.so != null) {
      // duration = eo - so
      args.push("-t", String(params.eo - params.so));
    } else {
      args.push("-t", String(params.eo));
    }
  }

  // Video codec
  args.push("-c:v", vcodec);

  // Codec-specific tuning for fast decode / smooth playback
  if (vcodec === "libx264") {
    args.push(
      "-preset",
      FFMPEG_X264_PRESET,
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p", // maximum compatibility
      "-maxrate",
      "2500k",
      "-bufsize",
      "5000k",
    );
  } else if (vcodec === "libx265") {
    args.push(
      "-preset",
      FFMPEG_X265_PRESET,
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-tag:v",
      "hvc1", // Apple compatibility
    );
  } else if (vcodec === "libvpx-vp9") {
    args.push(
      "-crf",
      String(crf),
      "-b:v",
      "0", // constant-quality mode
      "-deadline",
      FFMPEG_VP9_DEADLINE,
      "-cpu-used",
      FFMPEG_VP9_CPU_USED,
      "-row-mt",
      "1", // multi-threaded row encoding
      "-tile-columns",
      "2",
    );
  }

  if (FFMPEG_THREADS > 0) {
    args.push("-threads", String(FFMPEG_THREADS));
  }

  // Audio codec
  const hasAudio = (probeInfo.streams || []).some(
    (s) => s.codec_type === "audio",
  );
  if (hasAudio) {
    args.push("-c:a", acodec);
    if (acodec === "aac") {
      args.push("-b:a", "96k");
    } else if (acodec === "libopus") {
      args.push("-b:a", "64k");
    }
  } else {
    args.push("-an");
  }

  // Video filters
  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  // fl_lossy → push CRF higher (lower quality, smaller file)
  // Already handled via params.q mapping; no extra action needed.

  // Fast start: move moov atom to the beginning for instant playback
  if (container === "mp4") {
    args.push("-movflags", "+faststart");
  }

  args.push(outPath);

  // ── Run ffmpeg ───────────────────────────────────────────────────────

  await new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    proc.stderr.on("data", (d) => stderr.push(d));
    proc.on("close", (code, signal) => {
      if (code !== 0 || code === null) {
        const msg = Buffer.concat(stderr).toString().slice(0, 500);
        if (signal) {
          // Killed by OS — most likely SIGKILL from Docker OOM.
          return reject(
            new Error(
              `ffmpeg killed by signal ${signal} (likely out-of-memory). ` +
                `Consider increasing container memory or reducing concurrency. stderr: ${msg}`,
            ),
          );
        }
        return reject(new Error(`ffmpeg exited ${code}: ${msg}`));
      }
      resolve();
    });
    proc.on("error", reject);
  });

  // Read output
  const outputBuffer = await fs.readFile(outPath);
  await cleanup(inPath, outPath);

  const contentType = container === "webm" ? "video/webm" : "video/mp4";

  return { buffer: outputBuffer, contentType };
}

async function extractSnapshot(inputBuffer, timeSec = 1) {
  const inPath = tmpPath("src");
  await fs.writeFile(inPath, inputBuffer);

  try {
    const probeInfo = await probe(inPath);
    const duration = parseFloat(probeInfo?.format?.duration || "0");
    const seekTo = Math.min(timeSec, Math.max(duration - 0.1, 0));

    const frameBuf = await extractFrame(inPath, seekTo);
    // Convert to webp for small size
    const output = await sharp(frameBuf).webp({ quality: 80 }).toBuffer();
    await cleanup(inPath);
    return { buffer: output, contentType: "image/webp" };
  } catch (err) {
    await cleanup(inPath);
    throw new Error(`Snapshot extraction failed: ${err.message}`);
  }
}

/**
 * Extract a raw PNG frame from a video at the given timestamp.
 * The caller can then pipe the result through processImage for format
 * conversion, resizing, etc.
 */
async function extractRawFrame(inputBuffer, timeSec = 0) {
  const inPath = tmpPath("src");
  await fs.writeFile(inPath, inputBuffer);

  try {
    const probeInfo = await probe(inPath);
    const duration = parseFloat(probeInfo?.format?.duration || "0");
    const seekTo = Math.min(timeSec, Math.max(duration - 0.1, 0));
    const frameBuf = await extractFrame(inPath, seekTo);
    await cleanup(inPath);
    return frameBuf;
  } catch (err) {
    await cleanup(inPath);
    throw new Error(`Frame extraction failed: ${err.message}`);
  }
}

async function transcodeStoryVariant(inPath, outDir, rendition) {
  const playlistName = `${rendition.name}.m3u8`;
  const segmentPattern = path.join(outDir, `${rendition.name}_%03d.ts`);
  const outPlaylistPath = path.join(outDir, playlistName);

  const scaleFilter =
    `scale=${rendition.w}:${rendition.h}:force_original_aspect_ratio=decrease,` +
    `pad=${rendition.w}:${rendition.h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    "scale=trunc(iw/2)*2:trunc(ih/2)*2";

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inPath,
    "-vf",
    scaleFilter,
    "-c:v",
    "libx264",
    "-preset",
    STORY_HLS_X264_PRESET,
    "-profile:v",
    "main",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-b:v",
    rendition.videoBitrate,
    "-maxrate",
    rendition.maxRate,
    "-bufsize",
    rendition.bufSize,
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    rendition.audioBitrate,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-hls_time",
    String(STORY_HLS_SEGMENT_SECONDS),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    segmentPattern,
    outPlaylistPath,
  ];

  if (FFMPEG_THREADS > 0) {
    args.push("-threads", String(FFMPEG_THREADS));
  }

  await new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    proc.stderr.on("data", (d) => stderr.push(d));
    proc.on("close", (code) => {
      if (code !== 0) {
        const msg = Buffer.concat(stderr).toString().slice(0, 700);
        return reject(
          new Error(`Story rendition ${rendition.name} failed: ${msg}`),
        );
      }
      resolve();
    });
    proc.on("error", reject);
  });
}

/**
 * Generate story-focused HLS assets with multiple renditions and rewrite
 * playlists to point back to this API route for delivery.
 */
async function processStoryHls(inputBuffer, baseQueryPath) {
  const inPath = tmpPath("src");
  const outDir = path.join(
    os.tmpdir(),
    `ms_story_${crypto.randomBytes(8).toString("hex")}`,
  );
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(inPath, inputBuffer);

  const renditions = [
    {
      name: "r360",
      w: 360,
      h: 640,
      videoBitrate: "500k",
      maxRate: "650k",
      bufSize: "1000k",
      audioBitrate: "64k",
      bandwidth: 650000,
    },
    {
      name: "r540",
      w: 540,
      h: 960,
      videoBitrate: "900k",
      maxRate: "1100k",
      bufSize: "1800k",
      audioBitrate: "96k",
      bandwidth: 1200000,
    },
    {
      name: "r720",
      w: 720,
      h: 1280,
      videoBitrate: "1800k",
      maxRate: "2100k",
      bufSize: "3200k",
      audioBitrate: "128k",
      bandwidth: 2300000,
    },
  ];

  try {
    await runWithConcurrency(
      renditions,
      (rendition) => transcodeStoryVariant(inPath, outDir, rendition),
      STORY_HLS_TRANSCODE_CONCURRENCY,
    );

    const files = await fs.readdir(outDir);
    const assets = [];

    for (const fileName of files) {
      if (!isLikelyPlaylist(fileName) && !isLikelySegment(fileName)) {
        continue;
      }
      const fullPath = path.join(outDir, fileName);
      let buffer = await fs.readFile(fullPath);
      if (isLikelyPlaylist(fileName)) {
        const originalText = buffer.toString("utf8");
        const rewritten = rewritePlaylistUris(originalText, baseQueryPath);
        buffer = Buffer.from(rewritten, "utf8");
      }
      assets.push({
        name: fileName,
        buffer,
        contentType: storyAssetContentType(fileName),
      });
    }

    const masterText = buildStoryMasterPlaylist(baseQueryPath, renditions);
    assets.push({
      name: "master.m3u8",
      buffer: Buffer.from(masterText, "utf8"),
      contentType: storyAssetContentType("master.m3u8"),
    });

    return { assets };
  } finally {
    await cleanup(inPath);
    try {
      await fs.rm(outDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

async function probeDuration(inputBuffer) {
  const inPath = tmpPath("src");
  await fs.writeFile(inPath, inputBuffer);
  try {
    const info = await probe(inPath);
    return parseFloat(info?.format?.duration || "0") || 0;
  } finally {
    await cleanup(inPath);
  }
}

module.exports = {
  processVideo,
  processStoryHls,
  probeDuration,
  extractSnapshot,
  extractRawFrame,
  probe,
  sanitizeAssetName,
  storyAssetContentType,
};
