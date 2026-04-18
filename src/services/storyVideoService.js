const crypto = require("crypto");
const { parseParams, resolveQAuto } = require("../utils/paramParser");

const STORY_TRANSFORM_PRESET = {
  // Default progressive MP4 story variant tuned for broad compatibility.
  video:
    process.env.STORY_VARIANT_TRANSFORM ||
    "w_540,h_960,f_mp4,vc_h264,q_54,c_fit",
  // Lower-bandwidth fallback for weaker mobile networks.
  fallback:
    process.env.STORY_FALLBACK_VARIANT_TRANSFORM ||
    "w_360,h_640,f_mp4,vc_h264,q_48,c_fit",
};

function storyHash(originalKey, profile = "story") {
  return crypto
    .createHash("sha256")
    .update(`${originalKey}|${profile}-mp4@v1`)
    .digest("hex");
}

function storyAssetKey(originalKey, assetName, profile = "story") {
  return `derived/${storyHash(originalKey, profile)}/${profile}/${assetName}`;
}

function storyVideoCacheKey(originalKey) {
  return storyAssetKey(originalKey, "story.mp4");
}

function storyFallbackVideoCacheKey(originalKey) {
  return storyAssetKey(originalKey, "story-fallback.mp4", "story-fallback");
}

function storyVideoParams() {
  const params = parseParams(STORY_TRANSFORM_PRESET.video);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  params.deliveryProfile = "story";
  return params;
}

function storyFallbackVideoParams() {
  const params = parseParams(STORY_TRANSFORM_PRESET.fallback);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  params.deliveryProfile = "story-fallback";
  return params;
}

function getStoryUrls(relativePath) {
  const base = `/video/upload/${relativePath}`;
  return {
    video: `${base}?target=story`,
    fallback: `${base}?target=story-fallback`,
    snapshot: `${base}?target=snapshot`,
  };
}

module.exports = {
  STORY_TRANSFORM_PRESET,
  storyAssetKey,
  storyVideoCacheKey,
  storyFallbackVideoCacheKey,
  storyVideoParams,
  storyFallbackVideoParams,
  getStoryUrls,
};
