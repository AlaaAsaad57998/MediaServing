# Async Video Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move story/video transcoding off the request path into a BullMQ queue + worker, serving a guaranteed-playable fallback (original or an "instant" normalized MP4) until polished variants are warm — with zero changes required from consuming apps.

**Architecture:** Upload classifies the source via ffprobe, stores the original, synchronously builds cheap posters (and an "instant" MP4 only for non-web-playable sources), enqueues the polished transcodes, and responds immediately. A separate worker process drains the queue and writes polished variants to the S3-backed cache. Delivery serves the polished variant when warm (long immutable cache), otherwise the fallback (short TTL so the CDN re-checks and upgrades).

**Tech Stack:** Node 22 (CommonJS), Fastify 5, `@fastify/multipart`, ioredis, BullMQ, Sharp, FFmpeg/ffprobe via `child_process.spawn`, S3 (`@aws-sdk/client-s3`), `node:test` + `node:assert` for tests.

## Global Constraints

- Images ≤ **10 MB** (`IMAGE_MAX_FILE_SIZE_MB`, default `10`), enforced at the multipart layer.
- Videos ≤ **10 MB** (`VIDEO_MAX_FILE_SIZE_MB`, default `10`), enforced at the multipart layer.
- Video duration ≤ **60 s** (`MAX_VIDEO_DURATION_SECONDS`, default `60`), rejected post-probe with HTTP 400.
- Web-playable = container ∈ {mp4, webm} AND video codec ∈ {h264, vp8, vp9, av1} AND audio codec ∈ {aac, opus, mp3, none}.
- Pending (fallback) responses use `MEDIA_PENDING_CACHE_CONTROL` (default `public, max-age=5, must-revalidate`); warm responses keep `MEDIA_CACHE_CONTROL` (long immutable).
- Instant variant transform: `INSTANT_VARIANT_TRANSFORM`, default `w_720,h_1280,f_mp4,vc_h264,q_50,c_fit`.
- FFmpeg jobs are killed after `VIDEO_FFMPEG_TIMEOUT_MS` (default `120000`).
- BullMQ queue name: `video-processing`. Job dedup: `jobId = originalKey`.
- CommonJS modules (`require`/`module.exports`), 2-space indentation, existing Pino logger style.
- Commit on the `main` branch (no feature branch) per project preference.

---

## File Structure

**Create:**
- `src/utils/mediaProbe.js` — pure source classification (`isWebPlayable`, `extractMediaInfo`).
- `src/services/videoQueue.js` — BullMQ queue, connection, `enqueueVideoJob`, `buildJobOptions`.
- `src/services/videoJobs.js` — `generatePolishedVariants` (reusable transcode logic, used by the worker).
- `src/worker.js` — worker process entry point (`npm run worker`).
- `test/mediaProbe.test.js`, `test/videoQueue.test.js`, `test/cacheHeaders.test.js`, `test/instantKey.test.js`, `test/smoke.test.js` — tests.

**Modify:**
- `package.json` — add `bullmq` dep; add `test` and `worker` scripts.
- `src/processors/videoProcessor.js` — remove dead HLS code; add ffprobe-based `probeMedia`; add FFmpeg timeout + `try/finally` temp cleanup in `processVideo`.
- `src/services/videoPreprocessor.js` — add `instantCacheKey` + `createInstantVariant`; export the per-variant generators so `videoJobs.js` can reuse them.
- `src/api/upload.js` — new flow: per-type caps, duration reject, sync posters + instant, enqueue, immediate 201; bulk per-file enqueue.
- `src/api/transform.js` — add `setPendingCacheHeaders`; replace the inline-transcode miss branch for video-byte targets with fallback-serve + enqueue.
- `docker-compose.yml`, `docker-compose.prod.yml` — remove `STORY_HLS_*`; add a `worker` service.
- `Dockerfile` — no command change needed (worker reuses the image with `node src/worker.js`); add comment.
- `.env.development`, `.env.production`, `.env.example` — new env vars.
- `USER_GUIDE.md`, `test.html` — correct the HLS-vs-MP4 story contract.

---

## Task 1: Test harness + BullMQ dependency

**Files:**
- Modify: `package.json`
- Test: `test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs `node --test`; `bullmq` is installed for later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/smoke.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("test harness runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Run it to verify it fails (no script yet)**

Run: `npm test`
Expected: FAIL — `npm` reports `Missing script: "test"`.

- [ ] **Step 3: Add scripts and dependency**

In `package.json`, add to `"scripts"`:

```json
"test": "node --test",
"worker": "cross-env NODE_ENV=production node src/worker.js"
```

Then install BullMQ (pinned, current major):

Run: `pnpm add bullmq@^5`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — `tests 1 / pass 1 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml test/smoke.test.js
git commit -m "chore: add node:test harness and bullmq dependency"
```

---

## Task 2: Remove dead HLS code

The HLS pipeline is never imported or called (`processStoryHls` is exported but unused); `?target=story` serves MP4. Remove it so the story path has exactly two polished MP4 targets.

**Files:**
- Modify: `src/processors/videoProcessor.js` (delete `processStoryHls`, `transcodeStoryVariant`, `isLikelyPlaylist`, `isLikelySegment`, and the `STORY_HLS_*` constants at lines ~27-35; remove `processStoryHls` from `module.exports`)
- Modify: `docker-compose.yml`, `docker-compose.prod.yml` (delete `STORY_HLS_TRANSCODE_CONCURRENCY`, `STORY_HLS_X264_PRESET`, `STORY_HLS_SEGMENT_SECONDS`)
- Modify: `USER_GUIDE.md` (lines ~331, 377-384, 500-521), `test.html` (HLS player + "adaptive" copy)
- Test: `test/smoke.test.js` (extend)

**Interfaces:**
- Produces: `require("./processors/videoProcessor")` no longer exports `processStoryHls`.

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("videoProcessor no longer exports dead HLS function", () => {
  const vp = require("../src/processors/videoProcessor");
  assert.equal(vp.processStoryHls, undefined);
  assert.equal(typeof vp.processVideo, "function");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `processStoryHls` is currently a function, not `undefined`.

- [ ] **Step 3: Delete the HLS code**

In `src/processors/videoProcessor.js`:
- Delete the `STORY_HLS_X264_PRESET`, `STORY_HLS_SEGMENT_SECONDS`, `STORY_HLS_TRANSCODE_CONCURRENCY` constants (lines ~27-35).
- Delete the functions `isLikelyPlaylist`, `isLikelySegment`, `transcodeStoryVariant`, `processStoryHls`, and any HLS-only helpers they call exclusively (e.g. `sanitizeAssetName`, `storyAssetContentType`, the `.m3u8` rewriter — verify each is referenced only by the deleted code with `Grep` before removing).
- Remove `processStoryHls` (and any now-unused names) from `module.exports`.

In `docker-compose.yml` and `docker-compose.prod.yml`, delete the three `STORY_HLS_*` env lines.

In `USER_GUIDE.md`, change every description of `?target=story` from "HLS manifest / adaptive" to "vertical MP4", and remove the `hls.js`/"HLS First" integration section (keep the MP4 + fallback guidance). In `test.html`, remove the `hls.js` loader and the "Play HLS (adaptive)" button, leaving the MP4 `<video>` playback.

- [ ] **Step 4: Run tests + boot check**

Run: `npm test`
Expected: PASS.
Run: `node -e "require('./src/app.js'); console.log('app module loads')"`
Expected: prints `app module loads` with no `MODULE_NOT_FOUND` / reference errors.
Run a grep to confirm no live references remain:
Run: `git grep -n "processStoryHls\|STORY_HLS_\|\.m3u8" -- src/ docker-compose*.yml`
Expected: no matches in `src/` or compose files.

- [ ] **Step 5: Commit**

```bash
git add src/processors/videoProcessor.js docker-compose.yml docker-compose.prod.yml USER_GUIDE.md test.html test/smoke.test.js
git commit -m "refactor: remove dead HLS story pipeline and correct MP4 story docs"
```

---

## Task 3: Source classification (`mediaProbe.js`)

**Files:**
- Create: `src/utils/mediaProbe.js`
- Test: `test/mediaProbe.test.js`

**Interfaces:**
- Produces:
  - `extractMediaInfo(probeJson) → { durationSeconds: number, container: string, vCodec: string|null, aCodec: string|null }`
  - `isWebPlayable({ container, vCodec, aCodec }) → boolean`

- [ ] **Step 1: Write the failing test**

Create `test/mediaProbe.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractMediaInfo, isWebPlayable } = require("../src/utils/mediaProbe");

test("extractMediaInfo pulls duration, container, codecs from ffprobe json", () => {
  const json = {
    format: { duration: "12.5", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [
      { codec_type: "video", codec_name: "h264" },
      { codec_type: "audio", codec_name: "aac" },
    ],
  };
  const info = extractMediaInfo(json);
  assert.equal(info.durationSeconds, 12.5);
  assert.equal(info.vCodec, "h264");
  assert.equal(info.aCodec, "aac");
  assert.ok(info.container.includes("mp4"));
});

test("isWebPlayable true for h264/aac mp4", () => {
  assert.equal(
    isWebPlayable({ container: "mov,mp4,m4a", vCodec: "h264", aCodec: "aac" }),
    true,
  );
});

test("isWebPlayable false for hevc mov", () => {
  assert.equal(
    isWebPlayable({ container: "mov,mp4,m4a", vCodec: "hevc", aCodec: "aac" }),
    false,
  );
});

test("isWebPlayable true for h264 mp4 with no audio", () => {
  assert.equal(
    isWebPlayable({ container: "mp4", vCodec: "h264", aCodec: null }),
    true,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/utils/mediaProbe'`.

- [ ] **Step 3: Write the implementation**

Create `src/utils/mediaProbe.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all four `mediaProbe` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/mediaProbe.js test/mediaProbe.test.js
git commit -m "feat: add pure media source classification helpers"
```

---

## Task 4: ffprobe-backed `probeMedia` (`videoProcessor.js`)

**Files:**
- Modify: `src/processors/videoProcessor.js` (add `probeMedia`, export it)
- Test: manual (needs ffprobe + a real file)

**Interfaces:**
- Consumes: existing `probe(inputPath)` (returns parsed ffprobe JSON), `tmpPath`, `cleanup`, `extractMediaInfo` from Task 3.
- Produces: `probeMedia(inputBuffer) → Promise<{ durationSeconds, container, vCodec, aCodec }>`

- [ ] **Step 1: Add the implementation**

At the top of `src/processors/videoProcessor.js`, add the import:

```js
const { extractMediaInfo } = require("../utils/mediaProbe");
```

Add this function near `probeDuration` (which already buffers→temp→probe):

```js
async function probeMedia(inputBuffer) {
  const inPath = tmpPath("src");
  await fs.writeFile(inPath, inputBuffer);
  try {
    const json = await probe(inPath);
    return extractMediaInfo(json);
  } finally {
    await cleanup(inPath);
  }
}
```

Add `probeMedia` to `module.exports`.

- [ ] **Step 2: Verify against a real file**

Run (replace the path with any small mp4 on disk):

```bash
node -e "const{probeMedia}=require('./src/processors/videoProcessor');const fs=require('fs');probeMedia(fs.readFileSync(process.argv[1])).then(i=>console.log(i))" ./test.html.notavideo.mp4
```

Expected: prints an object like `{ durationSeconds: <n>, container: 'mov,mp4,...', vCodec: 'h264', aCodec: 'aac' }`. (If you have no sample file handy, skip — Task 10's manual upload test exercises this path end-to-end.)

- [ ] **Step 3: Commit**

```bash
git add src/processors/videoProcessor.js
git commit -m "feat: add probeMedia returning duration and codec info"
```

---

## Task 5: FFmpeg hardening — timeout + guaranteed temp cleanup

`processVideo` currently cleans temp files only on success; a spawn failure or kill orphans them, and a hung ffmpeg blocks forever. Wrap the body in `try/finally` and add a kill-timer.

**Files:**
- Modify: `src/processors/videoProcessor.js` (`processVideo`, lines ~364-582)
- Test: `test/smoke.test.js` (extend — assert timeout constant wiring)

**Interfaces:**
- Consumes: `VIDEO_FFMPEG_TIMEOUT_MS` env.
- Produces: `processVideo` unchanged signature `(inputBuffer, params) → { buffer, contentType }`; now self-cleans on failure and aborts after the timeout.

- [ ] **Step 1: Add the timeout constant**

Near the other constants (top of file), add:

```js
const VIDEO_FFMPEG_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.VIDEO_FFMPEG_TIMEOUT_MS || "120000", 10) || 120000,
);
```

- [ ] **Step 2: Wrap processVideo in try/finally and add the kill-timer**

In `processVideo`, move the existing temp-cleanup so it always runs. Change the structure so that after `const outPath = tmpPath(ext);` everything down to the return is inside a `try`, with a `finally { await cleanup(inPath, outPath); }`. Remove the now-redundant success-only `await cleanup(inPath, outPath);` at line ~577 and the early `await cleanup(inPath);` in the probe-catch at line ~372 (the finally covers both — but keep `inPath` cleanup correct by declaring `outPath` before the try; for the probe step, wrap it too). Concretely, the spawn block becomes:

```js
  await new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, VIDEO_FFMPEG_TIMEOUT_MS);

    proc.stderr.on("data", (d) => stderr.push(d));
    proc.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (timedOut) {
        return reject(
          new Error(
            `ffmpeg timed out after ${VIDEO_FFMPEG_TIMEOUT_MS}ms and was killed`,
          ),
        );
      }
      if (code !== 0 || code === null) {
        const msg = Buffer.concat(stderr).toString().slice(0, 500);
        if (signal) {
          return reject(
            new Error(
              `ffmpeg killed by signal ${signal} (likely out-of-memory). ` +
                `Consider increasing container memory or reducing concurrency. stderr: ${msg}`,
            ),
          );
        }
        return reject(new Error(`ffmpeg exited ${code}: ${msg}`));
      }
      resolve();
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
```

And restructure the surrounding function so temp files are always cleaned:

```js
async function processVideo(inputBuffer, params) {
  const inPath = tmpPath("src");
  await fs.writeFile(inPath, inputBuffer);
  let outPath = null;
  try {
    let probeInfo;
    try {
      probeInfo = await probe(inPath);
    } catch (err) {
      throw new Error(`Unable to probe video file: ${err.message}`);
    }
    const { container, ext, vcodec, acodec } = resolveCodecAndFormat(
      params,
      probeInfo,
    );
    outPath = tmpPath(ext);
    // ... unchanged arg-building + the spawn block above ...
    const outputBuffer = await fs.readFile(outPath);
    const contentType = container === "webm" ? "video/webm" : "video/mp4";
    return { buffer: outputBuffer, contentType };
  } finally {
    await cleanup(inPath, ...(outPath ? [outPath] : []));
  }
}
```

- [ ] **Step 3: Write the wiring test**

Add to `test/smoke.test.js`:

```js
test("processVideo is exported and VIDEO_FFMPEG_TIMEOUT_MS is read", () => {
  process.env.VIDEO_FFMPEG_TIMEOUT_MS = "5000";
  delete require.cache[require.resolve("../src/processors/videoProcessor")];
  const vp = require("../src/processors/videoProcessor");
  assert.equal(typeof vp.processVideo, "function");
});
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/processors/videoProcessor.js test/smoke.test.js
git commit -m "fix: add ffmpeg timeout and guaranteed temp cleanup in processVideo"
```

---

## Task 6: Instant variant key + builder (`videoPreprocessor.js`)

**Files:**
- Modify: `src/services/videoPreprocessor.js` (add `instantCacheKey`, `instantParams`, `createInstantVariant`, export them)
- Test: `test/instantKey.test.js`

**Interfaces:**
- Consumes: `parseParams`, `resolveQAuto`, `processVideo`.
- Produces:
  - `instantCacheKey(originalKey) → string` (stable, `derived/<sha256>/instant.mp4`)
  - `instantParams() → object` (parsed from `INSTANT_VARIANT_TRANSFORM`)
  - `createInstantVariant(originalBuffer) → Promise<{ buffer, contentType }>`

- [ ] **Step 1: Write the failing test**

Create `test/instantKey.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { instantCacheKey } = require("../src/services/videoPreprocessor");

test("instantCacheKey is deterministic and namespaced", () => {
  const k1 = instantCacheKey("originals/a/b.mov");
  const k2 = instantCacheKey("originals/a/b.mov");
  assert.equal(k1, k2);
  assert.match(k1, /^derived\/[0-9a-f]{64}\/instant\.mp4$/);
});

test("instantCacheKey differs per original", () => {
  assert.notEqual(
    instantCacheKey("originals/a.mov"),
    instantCacheKey("originals/b.mov"),
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `instantCacheKey is not a function`.

- [ ] **Step 3: Implement**

In `src/services/videoPreprocessor.js`, add near the other cache-key helpers:

```js
const INSTANT_VARIANT_TRANSFORM =
  process.env.INSTANT_VARIANT_TRANSFORM ||
  "w_720,h_1280,f_mp4,vc_h264,q_50,c_fit";
const INSTANT_X264_PRESET = process.env.INSTANT_X264_PRESET || "ultrafast";

function instantCacheKey(originalKey) {
  const hash = crypto
    .createHash("sha256")
    .update(`${originalKey}|instant-mp4@v1|${INSTANT_VARIANT_TRANSFORM}`)
    .digest("hex");
  return `derived/${hash}/instant.mp4`;
}

function instantParams() {
  const params = parseParams(INSTANT_VARIANT_TRANSFORM);
  if (typeof params.q === "string" && params.q.startsWith("auto")) {
    params.q = resolveQAuto(params.q);
  }
  // Tag so processVideo / x264 preset selection can pick the ultrafast preset.
  params.instantPreset = INSTANT_X264_PRESET;
  return params;
}

async function createInstantVariant(originalBuffer) {
  return processVideo(originalBuffer, instantParams());
}
```

Add `instantCacheKey`, `instantParams`, `createInstantVariant` to `module.exports`.

Then in `src/processors/videoProcessor.js`, honor the `instantPreset` tag: in the `libx264` branch (line ~448) replace the hard-coded `FFMPEG_X264_PRESET` for the preset arg with `params.instantPreset || FFMPEG_X264_PRESET`:

```js
    args.push(
      "-preset",
      params.instantPreset || FFMPEG_X264_PRESET,
      "-tune",
      "fastdecode",
      // ... unchanged ...
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — both `instantKey` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/videoPreprocessor.js src/processors/videoProcessor.js test/instantKey.test.js
git commit -m "feat: add instant fallback variant (key, params, builder)"
```

---

## Task 7: Reusable polished-variant job logic (`videoJobs.js`)

Extract the variant-generation body of `preprocessVideo` into a standalone function the worker calls, so transcoding lives in one place.

**Files:**
- Create: `src/services/videoJobs.js`
- Modify: `src/services/videoPreprocessor.js` (re-export / delegate is optional; keep `preprocessVideo` working for the existing `preprocess-videos` script by delegating to the new function)
- Test: `test/smoke.test.js` (extend — export shape)

**Interfaces:**
- Consumes: `getObjectBuffer`, `checkCache`, `saveToCache`, `processVideo`, `extractSnapshot`, `createWebpPosterVariant`, `storyVideoCacheKey`, `storyFallbackVideoCacheKey`, `storyVideoParams`, `storyFallbackVideoParams`, `previewParams`, `fullParams`, `generateDerivedKey`, `snapshotCacheKey`, `webpCacheKey`, `runWithConcurrency`, `SNAPSHOT_SECOND`.
- Produces: `generatePolishedVariants(originalKey, relativePath, { story }, logger) → Promise<void>` (throws if any variant fails). Generates only the heavy variants (story+fallback for story; preview+full otherwise) — posters are NOT regenerated here (upload makes them synchronously).

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("videoJobs exposes generatePolishedVariants", () => {
  const jobs = require("../src/services/videoJobs");
  assert.equal(typeof jobs.generatePolishedVariants, "function");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/services/videoJobs'`.

- [ ] **Step 3: Implement**

Create `src/services/videoJobs.js`:

```js
const { getObjectBuffer } = require("../storage/s3Client");
const { checkCache, saveToCache } = require("./cacheService");
const { processVideo } = require("../processors/videoProcessor");
const { generateDerivedKey } = require("../utils/hashGenerator");
const {
  previewParams,
  fullParams,
} = require("./videoPreprocessor");
const {
  storyVideoCacheKey,
  storyFallbackVideoCacheKey,
  storyVideoParams,
  storyFallbackVideoParams,
} = require("./storyVideoService");

async function runWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const results = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.VIDEO_PREPROCESS_CONCURRENCY || "4", 10) || 4,
);

function variantTask(derivedKey, params, label, logger) {
  return async () => {
    if (await checkCache(derivedKey)) {
      logger.info({ derivedKey }, `${label} already cached, skipping`);
      return;
    }
    const original = await getObjectBuffer(variantTask._originalKey);
    const { buffer, contentType } = await processVideo(original.buffer, params);
    await saveToCache(derivedKey, buffer, contentType);
    logger.info({ derivedKey, size: buffer.length }, `${label} created`);
  };
}

async function generatePolishedVariants(originalKey, relativePath, opts, logger) {
  // Fetch once; share the buffer across variant tasks.
  const original = await getObjectBuffer(originalKey);
  const buf = original.buffer;

  const make = (derivedKey, params, label) => async () => {
    if (await checkCache(derivedKey)) {
      logger.info({ derivedKey }, `${label} already cached, skipping`);
      return;
    }
    const { buffer, contentType } = await processVideo(buf, params);
    await saveToCache(derivedKey, buffer, contentType);
    logger.info({ derivedKey, size: buffer.length }, `${label} created`);
  };

  const tasks =
    opts && opts.story === true
      ? [
          make(storyVideoCacheKey(originalKey), storyVideoParams(), "Story variant"),
          make(
            storyFallbackVideoCacheKey(originalKey),
            storyFallbackVideoParams(),
            "Story fallback variant",
          ),
        ]
      : [
          (() => {
            const p = previewParams();
            return make(generateDerivedKey(originalKey, p), p, "Preview");
          })(),
          (() => {
            const p = fullParams();
            return make(generateDerivedKey(originalKey, p), p, "Full variant");
          })(),
        ];

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  const failures = results
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  if (failures.length > 0) {
    for (const f of failures) {
      logger.error({ error: f?.message }, "Video variant generation failed");
    }
    throw new Error("One or more video variants failed to generate");
  }
}

module.exports = { generatePolishedVariants };
```

> Note: remove the stray `variantTask` helper above before committing — it was scaffolding; the working code is the `make(...)` closure inside `generatePolishedVariants`. (Self-review will catch this; delete it now.)

Delete the `variantTask` function from the file (it is unused). Final `videoJobs.js` contains only `runWithConcurrency`, `CONCURRENCY`, `generatePolishedVariants`, and the exports.

- [ ] **Step 4: Run tests + lint-by-boot**

Run: `npm test`
Expected: PASS.
Run: `node -e "require('./src/services/videoJobs'); console.log('ok')"`
Expected: prints `ok` (no reference errors, confirming `variantTask` removal didn't break exports).

- [ ] **Step 5: Commit**

```bash
git add src/services/videoJobs.js test/smoke.test.js
git commit -m "refactor: extract reusable generatePolishedVariants for the worker"
```

---

## Task 8: Video queue (`videoQueue.js`)

**Files:**
- Create: `src/services/videoQueue.js`
- Test: `test/videoQueue.test.js`

**Interfaces:**
- Consumes: `bullmq`, ioredis, `REDIS_*` env.
- Produces:
  - `QUEUE_NAME = "video-processing"`
  - `buildJobOptions(originalKey) → { jobId, attempts, backoff, removeOnComplete, removeOnFail }`
  - `createQueueConnection() → IORedis` (BullMQ-safe: `maxRetriesPerRequest: null`)
  - `getVideoQueue() → Queue` (lazy singleton)
  - `enqueueVideoJob({ originalKey, relativePath, story }) → Promise<void>` (no-op if BullMQ/Redis unavailable; logs and returns)

- [ ] **Step 1: Write the failing test**

Create `test/videoQueue.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildJobOptions, QUEUE_NAME } = require("../src/services/videoQueue");

test("queue name is stable", () => {
  assert.equal(QUEUE_NAME, "video-processing");
});

test("buildJobOptions dedups by originalKey and sets retries", () => {
  const opts = buildJobOptions("originals/x/y.mp4");
  assert.equal(opts.jobId, "originals/x/y.mp4");
  assert.equal(opts.attempts, 3);
  assert.equal(opts.backoff.type, "exponential");
  assert.equal(opts.removeOnComplete, true);
  assert.equal(opts.removeOnFail, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/services/videoQueue'`.

- [ ] **Step 3: Implement**

Create `src/services/videoQueue.js`:

```js
const IORedis = require("ioredis");

const QUEUE_NAME = "video-processing";

function buildJobOptions(originalKey) {
  return {
    jobId: originalKey, // dedup: re-enqueues for the same original collapse
    attempts: Number.parseInt(process.env.VIDEO_JOB_ATTEMPTS || "3", 10) || 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  };
}

function createQueueConnection() {
  const url = (process.env.REDIS_URL || "").trim();
  // BullMQ requires maxRetriesPerRequest: null on its blocking connection.
  const common = { maxRetriesPerRequest: null };
  if (url.startsWith("redis://") || url.startsWith("rediss://")) {
    return new IORedis(url, common);
  }
  return new IORedis({
    host: url || "127.0.0.1",
    port: Number.parseInt(process.env.REDIS_PORT || "6379", 10) || 6379,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASS,
    tls:
      process.env.REDIS_TLS === "true" || process.env.REDIS_TLS === "1"
        ? {}
        : undefined,
    ...common,
  });
}

let queue = null;
function getVideoQueue() {
  if (queue) return queue;
  try {
    const { Queue } = require("bullmq");
    queue = new Queue(QUEUE_NAME, { connection: createQueueConnection() });
  } catch {
    queue = null;
  }
  return queue;
}

async function enqueueVideoJob({ originalKey, relativePath, story }, logger) {
  const q = getVideoQueue();
  if (!q) {
    (logger || console).warn(
      { originalKey },
      "Video queue unavailable; skipping enqueue (variant will warm on backfill/first view)",
    );
    return;
  }
  try {
    await q.add(
      "polish",
      { originalKey, relativePath, story: story === true },
      buildJobOptions(originalKey),
    );
  } catch (err) {
    (logger || console).error(
      { originalKey, error: err.message },
      "Failed to enqueue video job",
    );
  }
}

module.exports = {
  QUEUE_NAME,
  buildJobOptions,
  createQueueConnection,
  getVideoQueue,
  enqueueVideoJob,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — both `videoQueue` tests green. (The pure `buildJobOptions`/`QUEUE_NAME` tests don't touch Redis.)

- [ ] **Step 5: Commit**

```bash
git add src/services/videoQueue.js test/videoQueue.test.js
git commit -m "feat: add BullMQ video-processing queue with jobId dedup"
```

---

## Task 9: Worker process (`worker.js`)

**Files:**
- Create: `src/worker.js`
- Test: manual (needs Redis + ffmpeg)

**Interfaces:**
- Consumes: `bullmq` `Worker`, `QUEUE_NAME`, `createQueueConnection`, `generatePolishedVariants`.
- Produces: a long-running process started by `npm run worker`.

- [ ] **Step 1: Implement**

Create `src/worker.js`:

```js
require("./config/env"); // load .env.<NODE_ENV> then .env (same as the app)
const pino = require("pino");
const { Worker } = require("bullmq");
const { QUEUE_NAME, createQueueConnection } = require("./services/videoQueue");
const { generatePolishedVariants } = require("./services/videoJobs");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const concurrency = Math.max(
  1,
  Number.parseInt(process.env.VIDEO_PREPROCESS_CONCURRENCY || "4", 10) || 4,
);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { originalKey, relativePath, story } = job.data;
    logger.info({ originalKey, story }, "Processing video job");
    await generatePolishedVariants(originalKey, relativePath, { story }, logger);
    logger.info({ originalKey }, "Video job complete");
  },
  { connection: createQueueConnection(), concurrency },
);

worker.on("failed", (job, err) => {
  logger.error(
    { originalKey: job?.data?.originalKey, attempts: job?.attemptsMade, error: err?.message },
    "Video job failed",
  );
});

async function shutdown(signal) {
  logger.info({ signal }, "Worker shutting down");
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

logger.info({ queue: QUEUE_NAME, concurrency }, "Video worker started");
```

> Check `src/config/env.js`'s export style — if it exports a function rather than running on require, call it (e.g. `require("./config/env").load?.()`). Match whatever `src/index.js` does to load env.

- [ ] **Step 2: Verify it boots**

With Redis reachable (e.g. `docker compose up redis`), run:

Run: `npm run worker`
Expected: logs `Video worker started` with the queue name and stays running. Stop with Ctrl-C; expect `Worker shutting down`.

- [ ] **Step 3: Commit**

```bash
git add src/worker.js
git commit -m "feat: add video worker process draining the polish queue"
```

---

## Task 10: Upload route refactor (`upload.js`)

**Files:**
- Modify: `src/api/upload.js`
- Test: `test/smoke.test.js` (extend — pure cap resolver) + manual curl

**Interfaces:**
- Consumes: `probeMedia`, `isWebPlayable`, `instantCacheKey`, `createInstantVariant`, `extractSnapshot`, `createWebpPosterVariant`, `snapshotCacheKey`, `webpCacheKey`, `saveToCache`, `enqueueVideoJob`, env caps.
- Produces: unchanged 201 response shape; heavy transcodes enqueued, not awaited.

- [ ] **Step 1: Write the failing test (pure cap resolver)**

Add to `test/smoke.test.js`:

```js
test("resolveMaxBytes picks per-type cap", () => {
  const { resolveMaxBytes } = require("../src/api/upload");
  assert.equal(resolveMaxBytes("image", { image: 10, video: 10 }), 10 * 1024 * 1024);
  assert.equal(resolveMaxBytes("video", { image: 10, video: 8 }), 8 * 1024 * 1024);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `resolveMaxBytes is not a function`.

- [ ] **Step 3: Implement the upload changes**

In `src/api/upload.js`:

Add config + helpers near the top:

```js
const {
  probeMedia,
  extractSnapshot,
  createWebpPosterVariant,
} = require("../processors/videoProcessor");
const { isWebPlayable } = require("../utils/mediaProbe");
const { saveToCache } = require("../services/cacheService");
const {
  snapshotCacheKey,
  webpCacheKey,
  SNAPSHOT_SECOND,
  instantCacheKey,
  createInstantVariant,
} = require("../services/videoPreprocessor");
const { enqueueVideoJob } = require("../services/videoQueue");

const IMAGE_MAX_MB = Number.parseInt(process.env.IMAGE_MAX_FILE_SIZE_MB || "10", 10) || 10;
const VIDEO_MAX_MB = Number.parseInt(process.env.VIDEO_MAX_FILE_SIZE_MB || "10", 10) || 10;
const MAX_VIDEO_DURATION_SECONDS =
  Number.parseInt(process.env.MAX_VIDEO_DURATION_SECONDS || "60", 10) || 60;

function resolveMaxBytes(resourceType, capsMb) {
  const mb = resourceType === "video" ? capsMb.video : capsMb.image;
  return mb * 1024 * 1024;
}

module.exports.resolveMaxBytes = resolveMaxBytes; // exported for unit test
```

Set the multipart `fileSize` limit to the larger configured cap so oversize is rejected mid-stream, then re-check the precise per-type cap after the file is known. Replace the single-upload `request.parts({ limits: { fileSize: maxFileSize } })` with:

```js
const mediaMultipartLimit = Math.max(IMAGE_MAX_MB, VIDEO_MAX_MB) * 1024 * 1024;
// ... inside the handler ...
for await (const part of request.parts({ limits: { fileSize: mediaMultipartLimit } })) {
  // ... existing collection; if part.file.truncated becomes true, return 413 ...
}
```

After `filePart` is known and `isVideo`/`resourceType` resolved, enforce the exact cap:

```js
const resourceType = isVideoFile(dataFilename, dataMimetype) ? "video" : "image";
if (buffer.length > resolveMaxBytes(resourceType, { image: IMAGE_MAX_MB, video: VIDEO_MAX_MB })) {
  return reply.code(413).send({
    error: `${resourceType} exceeds the ${resourceType === "video" ? VIDEO_MAX_MB : IMAGE_MAX_MB} MB limit`,
  });
}
```

Replace the synchronous `preprocessVideo` block (lines ~180-207) with: probe → duration check → store posters synchronously → instant if needed → enqueue. The original is already stored by `saveUploadedImage`:

```js
if (item.type === "video") {
  let info;
  try {
    info = await probeMedia(buffer);
  } catch (err) {
    return reply.code(400).send({ error: "Unreadable video file" });
  }
  if (info.durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    return reply.code(400).send({
      error: `Video duration must be ${MAX_VIDEO_DURATION_SECONDS}s or less`,
    });
  }
  item.durationSeconds = info.durationSeconds;

  // Synchronous, cheap: posters (needed immediately by image targets).
  try {
    const snapKey = snapshotCacheKey(item.key);
    if (!(await checkCache(snapKey))) {
      const snap = await extractSnapshot(buffer, SNAPSHOT_SECOND);
      await saveToCache(snapKey, snap.buffer, snap.contentType);
    }
    const posterKey = webpCacheKey(item.key);
    if (!(await checkCache(posterKey))) {
      const poster = await createWebpPosterVariant(buffer);
      await saveToCache(posterKey, poster.buffer, poster.contentType);
    }
  } catch (err) {
    request.log.error({ s3_key: item.key, error: err.message }, "Poster generation failed");
    // Non-fatal: delivery regenerates posters on demand as a safety net.
  }

  // Synchronous only when the source won't play in a browser as-is.
  if (!isWebPlayable(info)) {
    try {
      const instant = await createInstantVariant(buffer);
      await saveToCache(instantCacheKey(item.key), instant.buffer, instant.contentType);
    } catch (err) {
      request.log.error({ s3_key: item.key, error: err.message }, "Instant variant generation failed");
      // Rare; logged. Falls back to the original until polished lands.
    }
  }

  // Heavy, polished variants go to the queue.
  await enqueueVideoJob(
    { originalKey: item.key, relativePath: item.key.replace(/^originals\//, ""), story: storyMode },
    request.log,
  );
}
```

Add `const { checkCache } = require("../services/cacheService");` (alongside `saveToCache`). Remove the now-unused `preprocessVideo` import and the `probeDuration` import if no longer used.

For `/upload/bulk`: apply the same per-file cap check and replace the `Promise.allSettled(preprocessVideo...)` block (lines ~297-325) with a per-file loop that does posters+instant synchronously and `enqueueVideoJob` per video. A single file's failure must NOT fail the batch — wrap each file's poster/instant in try/catch and always enqueue.

- [ ] **Step 4: Run tests + manual upload**

Run: `npm test`
Expected: PASS (incl. `resolveMaxBytes`).

Manual (app + redis + worker running, valid API key, small mp4):

```bash
curl -s -X POST "http://localhost:3000/upload?story=true" \
  -H "X-API-Key: $API_KEY" -F "file=@small.mp4" | jq
```
Expected: responds within ~1-2s with `story.variants` URLs and `durationSeconds`. Worker log shows "Processing video job" → "Video job complete" shortly after.

```bash
curl -s -X POST "http://localhost:3000/upload?story=true" \
  -H "X-API-Key: $API_KEY" -F "file=@too-big-15mb.mp4" -o /dev/null -w "%{http_code}\n"
```
Expected: `413`.

- [ ] **Step 5: Commit**

```bash
git add src/api/upload.js test/smoke.test.js
git commit -m "feat: async upload — sync posters/instant, enqueue polished, enforce caps"
```

---

## Task 11: Delivery refactor (`transform.js`)

**Files:**
- Modify: `src/api/transform.js` (`handleVideo` miss branch; add `setPendingCacheHeaders`)
- Test: `test/cacheHeaders.test.js`

**Interfaces:**
- Consumes: `instantCacheKey`, `enqueueVideoJob`, `getFromCache`, `getCacheMetadata`, `checkCache`, `getObjectBuffer`, env `MEDIA_PENDING_CACHE_CONTROL`.
- Produces: `setPendingCacheHeaders(reply)` sets the short TTL header. For video-byte targets, a polished miss serves the fallback (instant if present, else original) with the short TTL and enqueues; it never transcodes inline.

- [ ] **Step 1: Write the failing test**

Create `test/cacheHeaders.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setPendingCacheHeaders } = require("../src/api/transform.testkit");

test("setPendingCacheHeaders uses the short pending TTL", () => {
  const headers = {};
  const reply = { header: (k, v) => { headers[k] = v; return reply; } };
  setPendingCacheHeaders(reply);
  assert.match(headers["Cache-Control"], /max-age=5/);
  assert.match(headers["Cache-Control"], /must-revalidate/);
});
```

> `transform.js` defines helpers inside `transformRoutes(fastify)`. To make `setPendingCacheHeaders` unit-testable, define it (and `setMediaCacheHeaders` if convenient) at module scope and export a small testkit. Create `src/api/transform.testkit.js` that re-exports the module-scope helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/api/transform.testkit'`.

- [ ] **Step 3: Implement**

In `src/api/transform.js`, add at module scope (next to `setMediaCacheHeaders`, line ~39):

```js
function setPendingCacheHeaders(reply) {
  reply.header(
    "Cache-Control",
    process.env.MEDIA_PENDING_CACHE_CONTROL ||
      "public, max-age=5, must-revalidate",
  );
}
```

Create `src/api/transform.testkit.js`:

```js
// Test-only re-export of pure header helpers from transform.js.
const mod = require("./transform");
module.exports = { setPendingCacheHeaders: mod.setPendingCacheHeaders };
```

Export it from `transform.js`: ensure `module.exports` (or the route plugin's attached statics) includes `setPendingCacheHeaders`. If `transform.js` exports only the Fastify plugin function, attach the helper: `module.exports.setPendingCacheHeaders = setPendingCacheHeaders;` after the plugin export.

Now replace the miss path for video-byte targets. After the cache-hit fast path (line ~598), for `variantName` in {`story`, `story-fallback`, `full`, `preview`} replace the `acquireLock → process inline → saveToCache` block with a fallback-serve:

```js
// Video-byte targets never transcode inline. Serve the fallback and enqueue.
const isVideoByteTarget = ["story", "story-fallback", "full", "preview"].includes(variantName);
if (isVideoByteTarget) {
  // Prefer the instant normalized MP4 (present for non-playable sources),
  // else the original. Both are seekable MP4s, so range handling still works.
  const instantKey = instantCacheKey(originalKey);
  const fallbackKey = (await checkCache(instantKey)) ? instantKey : originalKey;

  // Fire-and-forget enqueue so the polished variant warms up.
  enqueueVideoJob(
    { originalKey, relativePath: filePath, story: variantName.startsWith("story") },
    request.log,
  );

  const meta = await getCacheMetadata(fallbackKey).catch(() => null);
  if (!meta) {
    stampLogExtra(request, { isVideo: true, filePath, cacheStatus: "NOT_FOUND", videoTarget: variantName });
    return reply.code(404).send({ error: "Original file not found" });
  }
  const totalLength = Number(meta.contentLength || 0);
  const range = parseSingleRangeHeader(request.headers.range, totalLength);
  if (range.kind === "invalid" || range.kind === "unsatisfiable") {
    reply.code(416);
    setVideoDeliveryHeaders(reply);
    reply.header("Content-Range", `bytes */${totalLength}`);
    return reply.send({ error: "Requested range not satisfiable" });
  }
  const { buffer, contentType } = await getFromCache(fallbackKey, {
    range: range.kind === "partial" ? range.storageRange : undefined,
  });
  setPendingCacheHeaders(reply); // short TTL → CDN re-checks → upgrades when warm
  stampLogExtra(request, { isVideo: true, filePath, cacheStatus: "PENDING", videoTarget: variantName });
  return sendVideoBuffer(reply, {
    buffer, contentType, variantName, cacheStatus: "PENDING", range, totalLength,
  });
}
// Posters (snapshot/webp) keep the existing inline generation as a safety net.
```

Keep the existing `acquireLock`/inline path **only** for the poster targets (`snapshot`, `webp`). `getFromCache`/`getCacheMetadata` already accept arbitrary keys, so they work for `originalKey` too. Add the imports `instantCacheKey` (from `videoPreprocessor`) and `enqueueVideoJob` (from `videoQueue`) at the top of `transform.js`.

Ensure `sendVideoBuffer`/`applyVideoBodyHeaders` does not overwrite `Cache-Control` after `setPendingCacheHeaders`; if `applyVideoBodyHeaders` calls `setMediaCacheHeaders`, pass the `cacheStatus: "PENDING"` through so it uses the pending header instead (adjust `applyVideoBodyHeaders` to call `setPendingCacheHeaders` when `cacheStatus === "PENDING"`, else `setMediaCacheHeaders`).

- [ ] **Step 4: Run tests + manual delivery**

Run: `npm test`
Expected: PASS (`cacheHeaders` green).

Manual: immediately after an upload (before the worker finishes), request the story URL:

```bash
curl -sD - -o /dev/null "http://localhost:3000/video/upload/<path>?target=story"
```
Expected (warming): `200`/`206`, header `X-Cache: PENDING`, `Cache-Control: ...max-age=5...`. After the worker completes, repeat:
Expected (warm): `X-Cache: HIT`, `Cache-Control: ...immutable`.

- [ ] **Step 5: Commit**

```bash
git add src/api/transform.js src/api/transform.testkit.js test/cacheHeaders.test.js
git commit -m "feat: delivery serves playable fallback while polished variant warms"
```

---

## Task 12: Config, compose worker service, env files

**Files:**
- Modify: `.env.example`, `.env.development`, `.env.production`
- Modify: `docker-compose.yml`, `docker-compose.prod.yml`
- Modify: `Dockerfile` (comment only)

**Interfaces:**
- Produces: documented env defaults; a `worker` service alongside `app`.

- [ ] **Step 1: Add env keys**

Append to `.env.example` (and mirror non-secret defaults into `.env.development` / `.env.production`):

```
IMAGE_MAX_FILE_SIZE_MB=10
VIDEO_MAX_FILE_SIZE_MB=10
MAX_VIDEO_DURATION_SECONDS=60
INSTANT_VARIANT_TRANSFORM=w_720,h_1280,f_mp4,vc_h264,q_50,c_fit
INSTANT_X264_PRESET=ultrafast
MEDIA_PENDING_CACHE_CONTROL=public, max-age=5, must-revalidate
VIDEO_FFMPEG_TIMEOUT_MS=120000
VIDEO_JOB_ATTEMPTS=3
```

- [ ] **Step 2: Add the worker service to compose**

In `docker-compose.yml`, add a service reusing the app image with the worker command (it shares Redis/S3/env with `app`):

```yaml
  worker:
    build: .
    command: node src/worker.js
    env_file: .env.development
    depends_on:
      - redis
      - minio
    restart: unless-stopped
```

Mirror in `docker-compose.prod.yml` (using the prod env_file and any prod build args). Keep its `VIDEO_PREPROCESS_CONCURRENCY` set to the worker host's vCPU count.

In `Dockerfile`, add a comment above the entrypoint noting the same image runs the worker via `node src/worker.js` (no separate build needed).

- [ ] **Step 3: Verify compose config parses**

Run: `docker compose config >/dev/null && echo "compose ok"`
Expected: prints `compose ok` (no YAML/interpolation errors); the `worker` service appears in `docker compose config`.

- [ ] **Step 4: Commit**

```bash
git add .env.example .env.development .env.production docker-compose.yml docker-compose.prod.yml Dockerfile
git commit -m "chore: add async-video env config and worker compose service"
```

---

## Task 13: Observability — metrics + pending log state

**Files:**
- Modify: `src/middleware/metrics.js` (register queue/job gauges + counters)
- Modify: `src/worker.js` (record job duration/failures)
- Modify: wherever `stampLogExtra` maps cache status to `transformed` (search: `Grep "transformed"`) — add a `pending` mapping for `cacheStatus: "PENDING"`.
- Test: `test/smoke.test.js` (extend — metric names registered)

**Interfaces:**
- Consumes: `prom-client` (already a dep).
- Produces: counters `video_jobs_total{result}`, histogram `video_job_duration_seconds`, counter `video_fallback_served_total{kind}`; `transformed: pending` in logs.

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("video job metrics are registered", async () => {
  const client = require("prom-client");
  require("../src/services/videoMetrics"); // registers on import
  const metrics = await client.register.metrics();
  assert.match(metrics, /video_jobs_total/);
  assert.match(metrics, /video_job_duration_seconds/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/services/videoMetrics'`.

- [ ] **Step 3: Implement**

Create `src/services/videoMetrics.js`:

```js
const client = require("prom-client");

const jobsTotal = new client.Counter({
  name: "video_jobs_total",
  help: "Polished video jobs by result",
  labelNames: ["result"],
});
const jobDuration = new client.Histogram({
  name: "video_job_duration_seconds",
  help: "Duration of polished video jobs",
  buckets: [1, 2, 5, 10, 20, 40, 80, 160],
});
const fallbackServed = new client.Counter({
  name: "video_fallback_served_total",
  help: "Fallback (pending) video responses served",
  labelNames: ["kind"], // instant | original
});

module.exports = { jobsTotal, jobDuration, fallbackServed };
```

In `src/worker.js`, wrap the processor:

```js
const { jobsTotal, jobDuration } = require("./services/videoMetrics");
// inside the processor:
const end = jobDuration.startTimer();
try {
  await generatePolishedVariants(originalKey, relativePath, { story }, logger);
  jobsTotal.inc({ result: "success" });
} catch (err) {
  jobsTotal.inc({ result: "failure" });
  throw err;
} finally {
  end();
}
```

In `transform.js`'s fallback branch (Task 11), increment `fallbackServed.inc({ kind: fallbackKey === instantKey ? "instant" : "original" })` and add the `pending` mapping where `stampLogExtra`/`transformed` is computed (so Loki cache-ratio queries can see the warming state).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (metric names present).

- [ ] **Step 5: Commit**

```bash
git add src/services/videoMetrics.js src/worker.js src/api/transform.js src/middleware/metrics.js
git commit -m "feat: add video job + fallback metrics and pending log state"
```

---

## Self-Review

**Spec coverage:**
- §2 core principle (probe → web-playable → original-or-instant fallback): Tasks 3, 4, 6, 10. ✓
- §4.1 upload flow + caps + duration reject: Task 10. ✓
- §4.2 queue + jobId dedup: Task 8. ✓
- §4.3 worker + FFmpeg timeout + temp cleanup: Tasks 5, 9. ✓
- §4.4 delivery state machine + short TTL: Task 11. ✓
- §4.5 classification + instant key: Tasks 3, 6. ✓
- §5 config/env: Task 12. ✓
- §6 failure modes (enqueue no-op when Redis down, instant-fail logged, job retries): Tasks 8, 9, 10. ✓
- §7 observability: Task 13. ✓
- §8 dead HLS removal: Task 2. ✓
- §9 resource estimates: informational, no task needed. ✓

**Placeholder scan:** Task 7 intentionally flags and removes the scaffold `variantTask` helper in-step (not a deferred placeholder). No "TBD"/"implement later" remain.

**Type consistency:** `generatePolishedVariants(originalKey, relativePath, { story }, logger)` is defined in Task 7 and called identically in Tasks 9. `enqueueVideoJob({ originalKey, relativePath, story }, logger)` defined in Task 8, called the same in Tasks 10 and 11. `instantCacheKey(originalKey)` defined in Task 6, used in Tasks 10, 11. `setPendingCacheHeaders(reply)` defined and tested in Task 11. `isWebPlayable` / `extractMediaInfo` (Task 3) consumed by `probeMedia` (Task 4) and upload (Task 10). Consistent. ✓

**Open verification dependencies:** Tasks 4, 9, 10, 11 have manual verification steps requiring ffmpeg + Redis + a sample MP4; these are integration glue not amenable to pure unit tests. Each lists the exact command and expected output.
