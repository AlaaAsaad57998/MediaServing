# MediaServing — Production Readiness Assessment

> Scope: readiness for production use behind a storefront (web + mobile) and 2+ dashboards,
> with emphasis on **story-video upload & processing**. Grounded in a code audit of the
> current `main` branch.

---

## Verdict

**Not production-ready today — but close.** The architecture is fundamentally sound
(S3-as-cache, Redis locking, structured logging, Prometheus metrics, non-root container,
distributed-state-aware design). What's missing is **operational hardening**, plus **one
CRITICAL security blocker** that must be handled before anything ships.

The biggest *functional* risk for this use case is that **story-video processing is fully
synchronous and unbounded** — this will be the first production incident if not addressed.

---

## 🔴 CRITICAL — Fix before any production deploy

**1. Live secrets are committed to git.** `.env.production` and `.env.development` contain
real, working credentials:

- AWS S3 access key/secret
- Redis user/password, the API key, Cloudinary API secret, Grafana service token

**These are compromised the moment they're in the repo.** Action:

1. **Rotate every one of them now** (S3, Redis, API key, Cloudinary, Grafana) — assume public.
2. Remove from git history (`git filter-repo` or BFG), add `.env*` to `.gitignore`, keep only
   `.env.example` with placeholders.
3. Inject secrets at runtime via the orchestrator (K8s Secrets / Docker secrets / SSM), never
   files baked into the image.

This takes priority over every other item below.

---

## 🧹 Remove dead code: HLS story pipeline is not wired up

**The HLS story machinery is dead code in the live runtime** and should be removed before
production to cut confusion, maintenance surface, and a misleading client contract.

Evidence from the audit:

- `processStoryHls` (`src/processors/videoProcessor.js:713`) is **defined and exported
  (`:828`) but never imported or called anywhere.** The three modules that require
  `videoProcessor` pull other functions only (`probeDuration`, the preview/full helpers, etc.).
- The live `?target=story` delivery path (`src/api/transform.js:532`) uses
  `storyVideoParams()` / `storyVideoCacheKey()` → it serves a **single MP4**, not an HLS
  manifest. Same for `story-fallback`.
- Despite this, `USER_GUIDE.md` (lines 331, 377–384, 500–521) and `test.html` tell clients to
  prefer `story.variants.hls` and load it via `hls.js`. That URL returns MP4 — any client that
  treats it as an `.m3u8` manifest will fail and fall through to the fallback.

**Recommendation — drop HLS, ship MP4-only stories:**

1. Delete `processStoryHls` and its HLS-only helpers (`.m3u8` rewriting, rendition presets) from
   `src/processors/videoProcessor.js`.
2. Remove `STORY_HLS_*` env vars from `docker-compose.yml` and `docker-compose.prod.yml`
   (`STORY_HLS_TRANSCODE_CONCURRENCY`, `STORY_HLS_X264_PRESET`, `STORY_HLS_SEGMENT_SECONDS`).
3. Fix `USER_GUIDE.md` and `test.html` so `?target=story` is documented as **MP4**, and remove
   the `hls.js` integration / "HLS adaptive" language. The client contract becomes:
   `story` (vertical MP4) + `story-fallback` (MP4) + `snapshot`/`webp` posters.
4. Revisit adaptive bitrate (ABR/HLS) later **only if** delivery metrics show buffering on long
   stories or highly variable-bandwidth audiences. For a storefront + dashboards, MP4 vertical
   variants cover the vast majority of story playback.

> Net effect on capacity planning: the ~4×-heavier HLS transcode path is **not** part of the
> live cost model. All estimates below assume **MP4-only** story processing.

---

## 🎯 Story-video upload & processing — the core concern

This is where the app is most fragile under real load. Current pipeline:

`POST /upload?story=true` → buffer **entire file into memory** → upload original to S3 →
re-fetch from S3 → run **concurrent FFmpeg jobs** (story MP4 + fallback MP4 + snapshot + webp
poster) → **only then** return `201`.

| # | Issue | Impact |
|---|-------|--------|
| 1 | **Processing is synchronous** — the HTTP request blocks until all FFmpeg jobs finish (15–120s+). | Client/CDN timeouts; retries re-trigger work; poor mobile UX. |
| 2 | **No FFmpeg timeout.** A hung/stalled ffmpeg blocks the request forever and ties up a worker. | One malformed video wedges a slot indefinitely. |
| 3 | **Size cap enforced after full buffering.** The 10 MB story cap is checked *after* the whole file is in memory; Fastify's multipart limit is 120 MB. | A 100 MB upload is fully buffered before rejection → OOM vector. |
| 4 | **No streaming — everything is in-memory buffers.** ~4 concurrent 100 MB uploads ≈ 0.8–1.2 GB peak RAM before FFmpeg temp files. | OOM-kill under modest concurrency. |
| 5 | **No atomic rollback.** Original is written to S3 *before* processing; if FFmpeg fails, the orphaned original stays and the request 500s. | Orphaned S3 objects, inconsistent state. |
| 6 | **Temp-file leak in `processVideo()`** — cleanup runs only on success, not on FFmpeg failure/kill. | `/tmp` fills over time → disk-full outage. |
| 7 | **Bulk upload is all-or-nothing.** One file's failure 500s the whole batch (up to 50 files); no per-file status. | One bad video fails 49 good ones. |

**Target design:**

- **Decouple processing from the request.** Accept the upload, validate, store the original,
  enqueue a job (BullMQ on the existing Redis is the lowest-friction choice), return
  `202 Accepted` with a status URL. A dedicated worker pool runs FFmpeg. Dashboards/storefront
  poll or receive a webhook when variants are ready.
- **Enforce the 10 MB cap at the multipart layer** (`limits.fileSize`) so oversized files are
  rejected mid-stream, never buffered.
- **Stream to a temp file** instead of `toBuffer()`; hand the path to FFmpeg.
- **Add a hard FFmpeg timeout** (`STORY_FFMPEG_TIMEOUT_MS`, kill on expiry) and wrap
  `processVideo` temp cleanup in `try/finally`.
- **Make it idempotent** — dedup by content hash so client retries don't reprocess.

**Minimal short-term mitigation** (if keeping it synchronous for now): multipart-level size cap
+ FFmpeg timeout + `try/finally` temp cleanup. Three small changes that prevent the worst
outages.

---

## 🟠 HIGH — operational gaps

- **No request timeout in Fastify.** Slow ffmpeg/Sharp can hang connections indefinitely. Set
  `connectionTimeout` / `requestTimeout`.
- **No graceful shutdown.** No `SIGTERM` handler / connection draining → in-flight transforms
  killed mid-write on every deploy. Add `SIGTERM → app.close()` with a drain timeout.
- **No `HEALTHCHECK` in Dockerfile**, and **`/ready` / `/live` are referenced but not
  implemented** (only `/health` exists, doing no dependency checks). K8s readiness probes
  hitting `/ready` will 404 and crash-loop pods. Implement `/ready` (check Redis + S3
  reachability) and `/live`.
- **API key leaked into `test.html` / `stats.html`** via HTML substitution, and those pages are
  *unauthenticated*. Anyone hitting `/stats` gets the API key in page source. Put behind auth or
  remove key embedding.
- **Rate-limit bypass via User-Agent spoofing** — crawler allowlist trusts the UA string;
  `User-Agent: facebookexternalhit` bypasses limits on public media paths.

---

## 🟡 MEDIUM — hardening

- **Redis is effectively required, not optional.** The in-memory lock fallback has no TTL and
  isn't shared across instances — with 2+ replicas and Redis down, cache-stampede protection
  silently breaks and locks can stick forever. Run Redis as **HA/managed** (ElastiCache, Redis
  Cloud, or Sentinel), and treat "Redis down" as degraded, not normal.
- **No magic-byte validation on media uploads** (Excel uploads already validate — apply the same
  to media). Currently trusts client MIME/extension; a disguised file can be stored and served
  from the origin.
- **No explicit S3 timeouts/retries** — relies on SDK defaults; a degraded network can hang
  operations for minutes. Set `requestTimeout` / `AbortSignal.timeout()`.
- **CORS defaults to `*`** in dev config — lock to storefront + dashboard origins in prod.
- **No error tracking** (Sentry/equiv). Loki logs exist but there's no alerting/aggregation on
  exceptions.

---

## 📊 Resource estimates (MP4-only stories — HLS removed)

Video transcoding is **CPU-bound** — that's the primary sizing constraint, not RAM or network.
Story videos (vertical, ≤10 MB, typically 5–30s) with `x264 -preset superfast`:

- **Per story upload** ≈ 2 full transcodes (story MP4 + fallback) + 2 frame extractions
  (snapshot + webp). Budget **~1.5–2.5 vCPU-seconds per second of source video** across the
  variants. A 20s clip ≈ **30–50 vCPU-seconds** of work.
- **No HLS path** — the 4-rendition ABR cost is not in the live model (dead code, removed per the
  cleanup section). This roughly **halves** the per-upload CPU vs. an HLS-enabled pipeline.

**Suggested baseline (start here, then measure):**

| Tier | Workload | Sizing |
|------|----------|--------|
| **API / delivery nodes** | Serving cached media, image transforms, routing | 2× instances, **2 vCPU / 4 GB** each, behind LB + CDN |
| **Video worker pool** (after decoupling) | FFmpeg story processing (MP4 only) | 2× instances, **4 vCPU / 8 GB** each; concurrency = vCPU count, not the default 4-on-everything |
| **Redis** | Locks + rate limit | Managed HA, small (1–2 GB) is plenty |
| **S3** | Originals + derived cache | Pay-per-use; derived cache ≈ **2–3× originals** (lower without HLS segment fan-out) |
| **Observability** | Loki + Grafana + Prometheus | 1× small instance or managed (Grafana Cloud) |

**Rules of thumb:**

- Size the **video tier by peak concurrent uploads × per-job CPU**, then divide. ~10 concurrent
  story uploads at peak → ~10 MP4-transcode pairs in flight → **~8–12 vCPU** of worker headroom
  (vs. ~16–20 if HLS were enabled).
- **Put a CDN in front** (CloudFront/Cloudflare). The delivery route is cache-friendly
  (`max-age=31536000, immutable`) — a CDN turns 95%+ of delivery into zero origin load and makes
  the API tier nearly idle.
- **RAM**: with streaming-to-disk fixed, 8 GB per video worker is comfortable; without that fix,
  expect to over-provision and still risk OOM.
- **Disk**: video workers need fast scratch space for temp files; ensure `/tmp` has headroom and
  a cleanup safety net.
- **Autoscale the video tier on CPU** (target ~60–70%); scale the delivery tier on request rate.

These are **starting points** — instrument first (Prometheus histograms already exist), load-test
the story upload path, and right-size from real `http_request_duration_seconds` and CPU data
within the first week.

---

## ✅ What's already solid

S3-as-cache with content-hash keys · Redis distributed locking with finally-block release ·
cache-aside with stampede protection · Prometheus metrics + structured Pino/Loki logs with key
redaction · path-traversal guards · transform dimension caps (10k px) · per-endpoint rate limits ·
non-root container with `dumb-init` · multi-stage Docker build · up-to-date deps (Node 22,
Fastify 5.8, Sharp 0.34).

---

## Recommended sequence

1. **Rotate + purge secrets** (CRITICAL — do this first).
2. **Remove dead HLS code** + fix `USER_GUIDE.md`/`test.html` to the MP4-only story contract.
3. **Story pipeline hardening**: multipart-level size cap, FFmpeg timeout, `try/finally` temp
   cleanup. *(small, high-value)*
4. **Decouple video processing into a queue/worker** (BullMQ on existing Redis) → return `202`.
   *(the big one)*
5. **Ops baseline**: graceful shutdown, request timeouts, `/ready` + `/live`, Dockerfile
   `HEALTHCHECK`.
6. **Security pass**: auth the test/stats pages, magic-byte validation on media, lock CORS, S3
   timeouts.
7. **CDN in front + load-test the story path**, then right-size from real metrics.
