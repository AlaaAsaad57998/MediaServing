const sharp = require("sharp");
const mime = require("mime-types");

const FORMAT_MAP = {
  jpeg: "jpeg",
  jpg: "jpeg",
  png: "png",
  webp: "webp",
  avif: "avif",
};

async function getAutoBackground(buffer) {
  // Use Sharp dominant color as a practical approximation of "most appealing" color.
  const { dominant } = await sharp(buffer).stats();
  return {
    r: dominant.r,
    g: dominant.g,
    b: dominant.b,
    alpha: 1,
  };
}

async function processImage(inputBuffer, params) {
  let pipeline = sharp(inputBuffer);

  // Resize
  const resizeOptions = {};
  if (params.w) resizeOptions.width = params.w;
  if (params.h) resizeOptions.height = params.h;
  if (params.c) resizeOptions.fit = params.c;

  if (params.c === "contain" && params.b) {
    if (params.b === "auto") {
      resizeOptions.background = await getAutoBackground(inputBuffer);
    } else {
      resizeOptions.background = params.b;
    }
  }

  if (resizeOptions.width || resizeOptions.height) {
    pipeline = pipeline.resize(resizeOptions);
  }

  // Format conversion
  const format = params.f ? FORMAT_MAP[params.f] : null;
  const formatOptions = {};

  if (params.q) {
    formatOptions.quality = params.q;
  }

  // fl_lossy on PNG: convert to webp or use quality hint
  if (params.fl_lossy && (!format || format === "png")) {
    pipeline = pipeline.png({ quality: params.q || 80, effort: 10 });
  } else if (format) {
    pipeline = pipeline.toFormat(format, formatOptions);
  }

  const buffer = await pipeline.toBuffer();
  const outputFormat = format || (params.fl_lossy ? "png" : null);
  const contentType = outputFormat
    ? mime.lookup(outputFormat) || "application/octet-stream"
    : "application/octet-stream";

  return { buffer, contentType };
}

module.exports = { processImage };
