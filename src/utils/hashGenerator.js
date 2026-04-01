const crypto = require("crypto");
const path = require("path");

function normalizeParams(params) {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join(",");
  return sorted;
}

function generateDerivedKey(originalKey, params) {
  const normalized = normalizeParams(params);
  const hashInput = `${originalKey}|${normalized}`;
  const hash = crypto.createHash("sha256").update(hashInput).digest("hex");

  const basename = path.basename(originalKey, path.extname(originalKey));
  const outputFormat = params.f || path.extname(originalKey).slice(1) || "jpeg";

  return `derived/${hash}/${basename}.${outputFormat}`;
}

module.exports = { normalizeParams, generateDerivedKey };
