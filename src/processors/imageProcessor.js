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

  // Cloudinary-like crop semantics:
  // c_fill/c_crop -> sharp cover, c_fit -> inside, c_scale -> fill (stretch), c_pad -> contain + background.
  const fitMap = {
    fill: "cover",
    crop: "cover",
    fit: "inside",
    scale: "fill",
    pad: "contain",
  };
  if (params.c) resizeOptions.fit = fitMap[params.c] || params.c;

  if (params.c === "pad" && params.b) {
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
  const quality = params.q || undefined;

  // fl_lossy on PNG: re-encode as PNG with quality hint
  if (params.fl_lossy && (!format || format === "png")) {
    pipeline = pipeline.png({ quality: quality || 80, effort: 10 });
  } else if (format === "jpeg") {
    // mozjpeg produces ~10% smaller files at the same quality, free of charge
    pipeline = pipeline.jpeg({ mozjpeg: true, quality });
  } else if (format === "webp") {
    // effort 4 (default) balances encode speed vs compression ratio
    pipeline = pipeline.webp({ effort: 4, quality });
  } else if (format === "avif") {
    // effort 4 is a reasonable middle-ground; push to 6 for better compression
    // at the cost of ~2x encode time
    pipeline = pipeline.avif({ effort: 4, quality });
  } else if (format) {
    pipeline = pipeline.toFormat(format, quality ? { quality } : {});
  }

  const buffer = await pipeline.toBuffer();
  const outputFormat = format || (params.fl_lossy ? "png" : null);
  const contentType = outputFormat
    ? mime.lookup(outputFormat) || "application/octet-stream"
    : "application/octet-stream";

  return { buffer, contentType };
}

module.exports = { processImage };
