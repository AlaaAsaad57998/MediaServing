# Async Video Processing — Design Spec

**Date:** 2026-06-27
**Status:** Approved (pending spec review)
**Topic:** Decouple story/video transcoding from the request path via a queue + worker,
serving a guaranteed-playable fallback until polished variants are warm.

---

## 1. Problem & Goals

### Problem

Today, `POST /upload` (and `/upload/bulk`) for videos runs **all** FFmpeg transcodes
**synchronously before responding** (`upload.js` → `preprocessVideo`). For a story upload this
is the snapshot + webp poster + `story.mp4` + `story-fallback.mp4`, taking 15–120s+ and holding
the HTTP request open the whole time. On the delivery side, a cache miss for a video target
transcodes **inline under a lock** (`transform.js handleVideo`), so the first viewer blocks or
gets a 503.

This does not scale to a storefront (web + mobile) plus 2+ dashboards: uploads time out, the
event loop is starved by FFmpeg, and requests are dropped under burst.

### Goals

1. **Never drop a request** under traffic — no request waits on FFmpeg in the request path.
2. **Never serve unplayable bytes** — every variant URL resolves to a playable artifact the
   moment it is handed to a client.
3. **Zero changes required from consuming apps** — same endpoints, same response shapes, same
   variant URLs. The optimized variant transparently replaces the fallback once warm.
4. Enforce hard input constraints (server-side, apps already respect them): **images ≤ 10 MB,
   videos ≤ 10 MB, video duration ≤ 60 s** — all configurable via env.

### Non-Goals

- HLS / adaptive bitrate. The existing `processStoryHls` machinery is dead code (never imported
  or called) and is **removed** as a prerequisite (see §8).
- Changing the image path. Images stay on the current inline Sharp cache-aside flow; they only
  gain the new size cap.
- A client-facing job-status API. Consumers never poll — graceful fallback makes status
  invisible to them.

---

## 2. Core Principle

> By the time any variant URL is returned to a client, a **playable artifact** for it already
> exists in S3. Delivery therefore never blocks on FFmpeg and never serves something that won't
> play.

The source is classified at upload via `ffprobe` (already run for duration):

- **Web-playable source** — container ∈ {mp4, webm}, video codec ∈ {h264, vp8, vp9, av1}, audio
  codec ∈ {aac, opus, mp3, none}. → The **original is the fallback**. No transcode at upload.
  Common case (clean phone/web MP4); upload stays ~1 s; correct aspect ratio.
- **Non-web-playable source** — e.g. HEVC in `.mov` (typical raw iPhone). → Produce **one
  "instant" normalized MP4** synchronously at upload (`-preset ultrafast`, H.264/AAC, `c_fit`
  so aspect is preserved within a ~720×1280 box), stored at `derived/<hash>/instant.mp4`. This
  is the fallback. Adds
  ~3–6 s to upload, only for these sources.

Posters (`snapshot`, `webp`) are images and cannot fall back to an MP4, so they are generated
**synchronously at upload** (cheap — single frame seek + encode).

The slow, high-quality ("polished") transcodes — `story.mp4`, `story-fallback.mp4` (and
`full`/`preview` for non-story video) — move to a background queue.

---

## 3. Architecture Overview

```
            ┌──────────────────────────── API process ────────────────────────────┐
 Upload ──► │ POST /upload                                                          │
            │   • multipart size cap (reject >cap mid-stream → 413)                 │
            │   • ffprobe: duration (>60s → 400) + codec/container                  │
            │   • putObject(original)                                               │
            │   • SYNC fast:   snapshot.webp + poster.webp                          │
            │   • SYNC if !webPlayable: instant.mp4 (ultrafast)                     │
            │   • enqueue polished job (jobId = originalKey)  ───────────┐          │
            │   • 201 (same response shape)                              │          │
            │                                                            │          │
 Delivery ─►│ GET /video/upload/*?target=...                            │          │
            │   polished cached? → serve, long immutable TTL  (HIT)      │          │
            │   else instant cached? → serve, short TTL       (PENDING)  │          │
            │   else → serve original, short TTL              (PENDING)  │          │
            │   + enqueue polished job (deduped, safety net)  ───────────┤          │
            └────────────────────────────────────────────────────────────┼─────────┘
                                                                          │
                                  Redis (BullMQ videoQueue) ◄─────────────┘
                                                                          │
            ┌──────────────────────── Worker process ─────────────────────▼─────────┐
            │ src/worker.js  (npm run worker)                                        │
            │   • consume videoQueue                                                 │
            │   • per-variant: checkCache → processVideo → saveToCache               │
            │   • FFmpeg timeout, try/finally temp cleanup, bounded concurrency      │
            │   • retries (3× backoff) → failed set + metric on exhaustion           │
            └────────────────────────────────────────────────────────────────────────┘
```

State is S3 (artifacts) + Redis (queue + dedup). No new in-process state, so the design is
horizontally scalable: run N API replicas and M workers independently.

---

## 4. Components

### 4.1 Upload route (`src/api/upload.js`)

- **Size caps at the multipart layer.** Set `limits.fileSize` per resource type so oversize
  uploads are rejected mid-stream (413) rather than buffered then rejected. Images use
  `IMAGE_MAX_FILE_SIZE_MB`, videos use `VIDEO_MAX_FILE_SIZE_MB` (both default 10). For the
  single `/upload` route the resource type isn't known until the file part arrives; enforce the
  stricter applicable cap and re-check after the part header / on the streamed byte count.
- **Probe before processing.** Run `ffprobe` once to get duration + codec/container. Reject
  `duration > MAX_VIDEO_DURATION_SECONDS` (default 60) with 400.
- **Store original**, then synchronously:
  - generate `snapshot.webp` + `poster.webp` (existing `extractSnapshot` /
    `createWebpPosterVariant`, cached under existing `snapshotCacheKey` / `webpCacheKey`);
  - if `!webPlayable`, generate `instant.mp4` under a new `instantCacheKey(originalKey)`.
- **Enqueue** the polished job `{ originalKey, relativePath, story }` with `jobId = originalKey`.
- **Respond 201** with the unchanged shape (`url`, `variants`, `story.variants`,
  `durationSeconds`). `getVariantUrls` / `getStoryUrls` are unchanged.
- **Bulk:** enqueue one job per video; stop awaiting transcodes. A single bad file no longer
  fails the whole batch (current all-or-nothing 500 is removed).

### 4.2 Queue (`src/services/videoQueue.js`)

- **BullMQ** on the existing Redis connection (reuse `lockService` connection settings; honor
  `REDIS_*` env incl. TLS).
- One queue, `videoQueue`. Job payload `{ originalKey, relativePath, story }`.
  `jobId = originalKey` → adding a duplicate is a no-op, giving free dedup across upload-time and
  delivery-time enqueues.
- Default job options: `attempts: 3`, exponential backoff, `removeOnComplete: true`,
  `removeOnFail: false` (keep for inspection/backfill).

### 4.3 Worker (`src/worker.js`, `npm run worker`)

- Separate process, same codebase, so FFmpeg CPU never starves the API event loop.
- Extract the per-variant generation from today's `preprocessVideo` into a reusable
  `generatePolishedVariants(originalKey, relativePath, { story }, logger)`; it already
  `checkCache`s before each variant, so it is idempotent and safe to retry.
- Concurrency bound = vCPU count (env `VIDEO_PREPROCESS_CONCURRENCY`, reused).
- Hardening (also benefits any remaining inline poster generation):
  - **FFmpeg timeout** — kill child on `VIDEO_FFMPEG_TIMEOUT_MS` (default 120000) → job fails →
    retry.
  - **`try/finally` temp cleanup** in `processVideo` so failures don't orphan `/tmp` files.
- On final failure (attempts exhausted): job stays in the failed set, a metric increments, and
  the existing `preprocess-videos` script serves as the reconcile/backfill tool.

### 4.4 Delivery (`src/api/transform.js` → `handleVideo`)

Replace the miss branch for **video-byte targets** (`story`, `story-fallback`, `full`,
`preview`) — no inline transcode:

```
polished variant cached?  → serve it,      setMediaCacheHeaders (long immutable)   X-Cache: HIT
else instant cached?      → serve instant,  setPendingCacheHeaders (short)          X-Cache: PENDING
else                      → serve original, setPendingCacheHeaders (short)          X-Cache: PENDING
   + enqueue polished job (deduped) as safety net
```

- New helper `setPendingCacheHeaders(reply)` → `Cache-Control` from
  `MEDIA_PENDING_CACHE_CONTROL` (default `public, max-age=5, must-revalidate`). **This short TTL
  is essential**: it prevents the CDN from pinning the unoptimized fallback and forces a
  re-check that transparently upgrades to the polished variant once warm.
- The current `acquireLock` → inline `processVideo` → `saveToCache` path is **deleted** for these
  targets (the `serveFromCacheOrWait` 503 path with it).
- **Posters** (`snapshot`, `webp`): keep current inline generation purely as a safety net; after
  the upload change they are essentially always a HIT.
- Range/206 handling is unchanged and applies to fallback responses too (the original and instant
  are both seekable MP4s).

### 4.5 Source classification (`src/utils/mediaProbe.js` or extend `videoProcessor`)

`classifySource(probeResult) → { webPlayable: boolean, durationSeconds, container, vCodec, aCodec }`.
`webPlayable` per §2. Add `instantCacheKey(originalKey)` alongside the existing cache-key helpers.

---

## 5. Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `IMAGE_MAX_FILE_SIZE_MB` | `10` | Image upload cap (multipart layer) |
| `VIDEO_MAX_FILE_SIZE_MB` | `10` | Video upload cap (multipart layer) |
| `MAX_VIDEO_DURATION_SECONDS` | `60` | Reject longer videos post-probe (400) |
| `INSTANT_VARIANT_TRANSFORM` | `w_720,h_1280,f_mp4,vc_h264,q_50,c_fit` | Normalize non-playable sources (ultrafast); `c_fit` preserves aspect within the box |
| `MEDIA_PENDING_CACHE_CONTROL` | `public, max-age=5, must-revalidate` | Short TTL for fallback responses |
| `VIDEO_FFMPEG_TIMEOUT_MS` | `120000` | Kill hung FFmpeg |
| `VIDEO_PREPROCESS_CONCURRENCY` | `4` (existing) | Worker FFmpeg concurrency (set = vCPU) |
| `MEDIA_CACHE_CONTROL` | existing | Long immutable TTL for warm variants (unchanged) |

`UPLOAD_MAX_FILE_SIZE_MB` (120) is superseded for media by the per-type caps above; keep it only
if other upload types (e.g. Excel) still rely on it.

---

## 6. Failure Modes

| Failure | Behavior | Severity |
|---------|----------|----------|
| Worker job fails after retries | Variant stays un-warm; delivery keeps serving the fallback indefinitely (degraded, never broken); metric/alert; backfill script re-runs it. | Low |
| Instant-gen fails at upload on a non-playable source | Still 201 + enqueue; during warming that one video falls back to the unplayable original until the polished variant lands. Logged + metered. **Single weak spot of this approach — accepted as rare.** | Low (rare) |
| FFmpeg hangs | Timeout kills it → job fails → retry. | Handled |
| Redis down | Enqueue fails. Upload should still 201 (original + posters stored); delivery falls back to original/instant; backfill warms variants once Redis returns. Run Redis HA in prod. | Medium |
| Original missing at delivery | 404 (unchanged). | Handled |

---

## 7. Observability

- **Metrics:** queue depth, job duration histogram, job-failure counter, fallback-served counter
  (instant vs original), warm-vs-fallback ratio per target.
- **Logs:** extend the existing `transformed: warm|cold|bypass` Loki mapping with a `pending`
  state for fallback-served requests (`X-Cache: PENDING`).

---

## 8. Prerequisite Cleanup: Remove Dead HLS Code

The HLS story pipeline is dead code (never imported/called) and the `?target=story` route serves
MP4, not HLS. Before this refactor:

1. Delete `processStoryHls` and its HLS-only helpers (`.m3u8` rewriting, rendition presets) from
   `src/processors/videoProcessor.js`.
2. Remove `STORY_HLS_*` env vars from `docker-compose.yml` and `docker-compose.prod.yml`.
3. Correct `USER_GUIDE.md` and `test.html` to document `?target=story` as **MP4** and drop the
   `hls.js` / "HLS adaptive" language. Client story contract: `story` (vertical MP4) +
   `story-fallback` (MP4) + `snapshot`/`webp` posters.

This leaves the story path with exactly two polished MP4 targets, matching §4.

---

## 9. Resource Estimates (MP4-only, queue-based)

Transcoding is CPU-bound; the 10 MB / 60 s caps bound per-job cost and memory.

- **Per story upload (polished):** ~2 transcodes (`story` + `story-fallback`), `x264 superfast`
  ≈ 1.5–2.5 vCPU·s per second of source. A 30 s clip ≈ 45–75 vCPU·s of background work.
- **Per upload (sync):** posters (sub-second to ~2 s) + instant transcode only for non-playable
  sources (~3–6 s worst case, ultrafast).

| Tier | Sizing (starting point) |
|------|-------------------------|
| API / delivery | 2× **2 vCPU / 4 GB**, behind LB + CDN; never runs FFmpeg for video-byte targets |
| Video workers | 2× **4 vCPU / 8 GB**; concurrency = vCPU; autoscale on queue depth / CPU |
| Redis | Managed HA, 1–2 GB |
| S3 | Derived cache ≈ 2–3× originals |

**CDN in front is assumed** — the warm delivery path is `immutable`, so a CDN absorbs ~95%+ of
delivery and keeps the API tier near idle. Right-size workers from real queue-depth and
`http_request_duration_seconds` data within the first week.

---

## 10. Out-of-Scope Follow-ups (tracked, not in this spec)

- Secrets rotation / removal from git (handled separately by the team on the server).
- Graceful shutdown, `/ready` + `/live`, Dockerfile `HEALTHCHECK` — from the readiness doc;
  worth doing alongside but not required for this refactor to function.
- Magic-byte validation on media uploads.
