const crypto = require("crypto");
const { parseParams, resolveQAuto } = require("../utils/paramParser");

const STORY_TRANSFORM_PRESET = {
  // Optimized progressive MP4 story variant (no HLS) tuned for fast playback.
  video:
    process.env.STORY_VARIANT_TRANSFORM ||
    "w_540,h_960,f_mp4,vc_h264,q_54,c_fit",
};

function storyHash(originalKey) {
  return crypto
    .createHash("sha256")
    .update(`${originalKey}|story-mp4@v3`)
    .digest("hex");
}

function storyAssetKey(originalKey, assetName) {
  return `derived/${storyHash(originalKey)}/story/${assetName}`;
}

function storyVideoCacheKey(originalKey) {
  return storyAssetKey(originalKey, "story.mp4");
}

function storyVideoParams() {
  const params = parseParams(STORY_TRANSFORM_PRESET.video);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  params.deliveryProfile = "story";
  return params;
}

function getStoryUrls(relativePath) {
  const base = `/video/upload/${relativePath}`;
  return {
    video: `${base}?target=story`,
    snapshot: `${base}?target=snapshot`,
  };
}

module.exports = {
  STORY_TRANSFORM_PRESET,
  storyAssetKey,
  storyVideoCacheKey,
  storyVideoParams,
  getStoryUrls,
};
