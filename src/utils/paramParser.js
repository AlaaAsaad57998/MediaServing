class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

const VALID_IMAGE_FORMATS = new Set(["webp", "jpeg", "jpg", "png", "avif"]);
const VALID_VIDEO_FORMATS = new Set(["mp4", "webm"]);
const VALID_FORMATS = new Set([...VALID_IMAGE_FORMATS, ...VALID_VIDEO_FORMATS]);
// Canonical Cloudinary-style crop modes we expose in URLs.
const VALID_FITS = new Set(["fill", "pad", "fit", "scale", "crop"]);
// Backward-compatible aliases that are normalized to canonical values.
const FIT_ALIASES = {
  cover: "fill",
  contain: "fit",
  inside: "fit",
  outside: "fill",
};
const VALID_FLAGS = new Set(["lossy"]);
const VALID_VIDEO_CODECS = new Set(["auto", "h264", "h265", "hevc", "vp9"]);

// Quality presets for q_auto — mirrors Cloudinary's naming
const Q_AUTO_PRESETS = { eco: 45, low: 55, good: 75, best: 85 };

/**
 * Resolve a q_auto string ("auto", "auto:good", etc.) to a numeric quality.
 * Pass-through for numbers.
 */
function resolveQAuto(qValue) {
  if (typeof qValue !== "string" || !qValue.startsWith("auto")) return qValue;
  const preset = qValue.includes(":") ? qValue.split(":")[1] : "good";
  return Q_AUTO_PRESETS[preset] ?? Q_AUTO_PRESETS.good;
}

function isHexColor(value) {
  return /^[0-9a-fA-F]{6}$/.test(value) || /^[0-9a-fA-F]{3}$/.test(value);
}

function parseParams(transformationString) {
  if (!transformationString || transformationString.trim() === "") {
    return {};
  }

  const parts = transformationString.split(",");
  const params = {};

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Handle flag params like fl_lossy
    if (trimmed.startsWith("fl_")) {
      const flag = trimmed.slice(3);
      if (!VALID_FLAGS.has(flag)) {
        throw new ValidationError(`Unknown flag: fl_${flag}`);
      }
      params[`fl_${flag}`] = true;
      continue;
    }

    const sepIndex = trimmed.indexOf("_");
    if (sepIndex === -1) {
      throw new ValidationError(
        `Invalid parameter format: "${trimmed}". Expected key_value`,
      );
    }

    const key = trimmed.slice(0, sepIndex);
    const value = trimmed.slice(sepIndex + 1);

    switch (key) {
      case "w": {
        const w = parseInt(value, 10);
        if (isNaN(w) || w <= 0 || w > 10000) {
          throw new ValidationError(
            `Invalid width: "${value}". Must be a positive integer (1-10000)`,
          );
        }
        params.w = w;
        break;
      }
      case "h": {
        const h = parseInt(value, 10);
        if (isNaN(h) || h <= 0 || h > 10000) {
          throw new ValidationError(
            `Invalid height: "${value}". Must be a positive integer (1-10000)`,
          );
        }
        params.h = h;
        break;
      }
      case "q": {
        // Accept auto[:eco|low|good|best] in addition to plain integers
        if (value === "auto" || value.startsWith("auto:")) {
          const preset = value.includes(":") ? value.split(":")[1] : "good";
          if (
            preset &&
            !Object.prototype.hasOwnProperty.call(Q_AUTO_PRESETS, preset)
          ) {
            throw new ValidationError(
              `Invalid q_auto level: "${preset}". Supported: eco, low, good, best`,
            );
          }
          params.q = value; // kept as string; resolved to number in transform.js
          break;
        }
        const q = parseInt(value, 10);
        if (isNaN(q) || q < 1 || q > 100) {
          throw new ValidationError(
            `Invalid quality: "${value}". Must be an integer (1-100) or auto[:eco|low|good|best]`,
          );
        }
        params.q = q;
        break;
      }
      case "f": {
        const f = value.toLowerCase();
        // "auto" = pick best format based on the browser's Accept header
        if (f !== "auto" && !VALID_FORMATS.has(f)) {
          throw new ValidationError(
            `Invalid format: "${value}". Supported: auto, ${[...VALID_FORMATS].join(", ")}`,
          );
        }
        params.f = f;
        break;
      }
      case "c": {
        const raw = value.toLowerCase();
        const c = FIT_ALIASES[raw] || raw;
        if (!VALID_FITS.has(c)) {
          throw new ValidationError(
            `Invalid crop/fit: "${value}". Supported: ${[...VALID_FITS, ...Object.keys(FIT_ALIASES)].join(", ")}`,
          );
        }
        params.c = c;
        break;
      }
      case "b": {
        const b = value.toLowerCase();
        if (b === "auto") {
          params.b = "auto";
          break;
        }

        if (!isHexColor(b)) {
          throw new ValidationError(
            `Invalid background: "${value}". Use auto or hex like ff0000`,
          );
        }

        params.b = `#${b}`;
        break;
      }
      case "vc": {
        const vc = value.toLowerCase();
        if (!VALID_VIDEO_CODECS.has(vc)) {
          throw new ValidationError(
            `Invalid video codec: "${value}". Supported: ${[...VALID_VIDEO_CODECS].join(", ")}`,
          );
        }
        params.vc = vc;
        break;
      }
      case "so": {
        const so = parseFloat(value);
        if (isNaN(so) || so < 0) {
          throw new ValidationError(
            `Invalid start offset: "${value}". Must be a non-negative number (seconds)`,
          );
        }
        params.so = so;
        break;
      }
      case "eo": {
        const eo = parseFloat(value);
        if (isNaN(eo) || eo <= 0) {
          throw new ValidationError(
            `Invalid end offset: "${value}". Must be a positive number (seconds)`,
          );
        }
        params.eo = eo;
        break;
      }
      default:
        throw new ValidationError(`Unknown parameter: "${key}"`);
    }
  }

  return params;
}

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
  "flv",
  "wmv",
  "m4v",
  "3gp",
  "ogv",
]);
const VIDEO_MIMETYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/x-flv",
  "video/x-ms-wmv",
  "video/3gpp",
  "video/ogg",
  "video/mpeg",
]);

function isVideoFile(filename, mimetype) {
  if (mimetype && VIDEO_MIMETYPES.has(mimetype.toLowerCase())) return true;
  if (filename) {
    const ext = filename.split(".").pop().toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  }
  return false;
}

function isVideoPath(filePath) {
  if (!filePath) return false;
  const ext = filePath.split(".").pop().toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

/** True when any video-only param is present */
function hasVideoParams(params) {
  return params.vc != null || params.so != null || params.eo != null;
}

module.exports = {
  parseParams,
  resolveQAuto,
  Q_AUTO_PRESETS,
  ValidationError,
  isVideoFile,
  isVideoPath,
  hasVideoParams,
  VALID_IMAGE_FORMATS,
  VALID_VIDEO_FORMATS,
};
