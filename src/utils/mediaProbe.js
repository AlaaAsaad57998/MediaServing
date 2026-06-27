// Pure helpers for classifying a probed media file. No I/O here so it is
// trivially unit-testable; the ffprobe spawn lives in videoProcessor.probeMedia.

const PLAYABLE_CONTAINERS = ["mp4", "webm"];
const PLAYABLE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const PLAYABLE_AUDIO_CODECS = new Set(["aac", "opus", "mp3"]);

function extractMediaInfo(probeJson) {
  const format = probeJson?.format || {};
  const streams = Array.isArray(probeJson?.streams) ? probeJson.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    durationSeconds: Number.parseFloat(format.duration || "0") || 0,
    container: String(format.format_name || ""),
    vCodec: video ? String(video.codec_name || "").toLowerCase() : null,
    aCodec: audio ? String(audio.codec_name || "").toLowerCase() : null,
  };
}

function isWebPlayable({ container, vCodec, aCodec }) {
  const containerOk = PLAYABLE_CONTAINERS.some((c) =>
    String(container || "")
      .toLowerCase()
      .includes(c),
  );
  const videoOk = vCodec != null && PLAYABLE_VIDEO_CODECS.has(vCodec);
  const audioOk = aCodec == null || PLAYABLE_AUDIO_CODECS.has(aCodec);
  return containerOk && videoOk && audioOk;
}

module.exports = { extractMediaInfo, isWebPlayable };
