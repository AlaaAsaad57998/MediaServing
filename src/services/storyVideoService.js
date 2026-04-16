const crypto = require("crypto");
const { parseParams, resolveQAuto } = require("../utils/paramParser");

const STORY_TRANSFORM_PRESET = {
  // MP4 fallback used when HLS is not available on the client.
  fallback: "w_720,h_1280,f_mp4,vc_h264,q_75,c_fill",
};

function storyHash(originalKey) {
  return crypto
    .createHash("sha256")
    .update(`${originalKey}|story-hls@v2`)
    .digest("hex");
}

function storyAssetKey(originalKey, assetName) {
  return `derived/${storyHash(originalKey)}/story/${assetName}`;
}

function storyFallbackParams() {
  const params = parseParams(STORY_TRANSFORM_PRESET.fallback);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  return params;
}

function getStoryUrls(relativePath) {
  const base = `/video/upload/${relativePath}`;
  return {
    hls: `${base}?target=story`,
    fallback: `${base}?target=webp`,
  };
}

module.exports = {
  STORY_TRANSFORM_PRESET,
  storyAssetKey,
  storyFallbackParams,
  getStoryUrls,
};
