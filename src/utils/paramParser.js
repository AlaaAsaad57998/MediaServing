class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

const VALID_FORMATS = new Set(["webp", "jpeg", "jpg", "png", "avif"]);
const VALID_FITS = new Set(["cover", "contain", "fill", "inside", "outside"]);
const VALID_FLAGS = new Set(["lossy"]);

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
        const q = parseInt(value, 10);
        if (isNaN(q) || q < 1 || q > 100) {
          throw new ValidationError(
            `Invalid quality: "${value}". Must be an integer between 1 and 100`,
          );
        }
        params.q = q;
        break;
      }
      case "f": {
        const f = value.toLowerCase();
        if (!VALID_FORMATS.has(f)) {
          throw new ValidationError(
            `Invalid format: "${value}". Supported: ${[...VALID_FORMATS].join(", ")}`,
          );
        }
        params.f = f;
        break;
      }
      case "c": {
        const c = value.toLowerCase();
        if (!VALID_FITS.has(c)) {
          throw new ValidationError(
            `Invalid crop/fit: "${value}". Supported: ${[...VALID_FITS].join(", ")}`,
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
      default:
        throw new ValidationError(`Unknown parameter: "${key}"`);
    }
  }

  return params;
}

module.exports = { parseParams, ValidationError };
