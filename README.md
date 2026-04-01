# MediaServing

A self-hosted, Cloudinary-like image processing and serving API. Upload images once, then request them at any size, format, or quality through a simple URL — the service processes and caches everything automatically.

---

## What Does This Do?

Think of it as your own private image CDN:

1. **You upload a photo** → it gets stored in your object storage (MinIO locally, or AWS S3 in production).
2. **You request the photo via a URL** with size/format instructions baked in (e.g., "give me this image at 300×300, WebP format, 80% quality").
3. **The service processes it on the first request**, saves the result, and serves it instantly on every request after that — no reprocessing needed.

No third-party image services, no per-image fees, no data leaving your infrastructure.

---

## Features

| Feature                   | Details                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Image upload**          | Upload JPEG, PNG, WebP, or AVIF images via a simple HTTP POST                |
| **On-the-fly transforms** | Resize, crop, convert format, adjust quality — all via URL parameters        |
| **Smart caching**         | Transformed results are stored and served without re-processing              |
| **Distributed locking**   | Prevents duplicate work when multiple requests arrive simultaneously         |
| **API key auth**          | Only `POST /upload` requires an `X-API-Key` header — image serving is public |
| **Rate limiting**         | Per-key and per-IP limits protect the service from abuse                     |
| **CORS support**          | Configurable allowed origins for browser-based clients                       |
| **Health check**          | `/health` endpoint — no auth required, useful for uptime monitoring          |

---

## Tech Stack

| Component            | Technology                                              |
| -------------------- | ------------------------------------------------------- |
| **Web framework**    | [Fastify](https://fastify.dev/)                         |
| **Image processing** | [Sharp](https://sharp.pixelplumbing.com/)               |
| **Object storage**   | MinIO (local) / AWS S3 (production)                     |
| **Cache / Locking**  | Redis (falls back to in-memory if Redis is unavailable) |
| **Runtime**          | Node.js 18+                                             |

---

## Project Structure

```
MediaServing/
├── src/
│   ├── index.js                  # Entry point — starts the server
│   ├── app.js                    # App factory — plugins, routes, error handler
│   ├── api/
│   │   ├── upload.js             # POST /upload
│   │   └── transform.js          # GET /media/upload/:transformations/*
│   ├── config/
│   │   └── env.js                # Environment variable loading
│   ├── middleware/
│   │   └── auth.js               # X-API-Key authentication hook
│   ├── processors/
│   │   └── imageProcessor.js     # Sharp image processing pipeline
│   ├── services/
│   │   ├── cacheService.js       # S3-based derived image cache
│   │   └── lockService.js        # Redis SET NX EX lock + in-memory fallback
│   ├── storage/
│   │   └── s3Client.js           # S3 client helpers (get, put, exists)
│   └── utils/
│       ├── paramParser.js        # Parses transformation strings like w_300,h_300,f_webp
│       └── hashGenerator.js      # SHA256-based derived cache key generator
├── .env.development              # Local dev configuration
├── .env.production               # Production configuration (DO NOT commit secrets)
├── docker-compose.yml            # MinIO + Redis for local development
├── package.json
├── SETUP.md                      # Step-by-step setup guide
└── README.md                     # This file
```

---

## API Reference

### Authentication

Only **`POST /upload`** requires authentication. Image serving and the health check are fully public.

Protected endpoints require an `X-API-Key` header:

```
X-API-Key: your-secret-api-key
```

Missing or incorrect key on a protected endpoint → `401 Unauthorized`.

**Public routes (no key needed):**

- `GET /health`
- `GET /media/upload/...` — all image serving and transform URLs
- `GET /test`, `GET /test.html`

**Protected routes (API key required):**

- `POST /upload`

---

### `GET /health`

Health check. No authentication required.

**Response:**

```json
{ "status": "ok" }
```

---

### `POST /upload`

Upload an image to storage.

**Request:** `multipart/form-data`

| Field    | Type   | Required | Description                                                |
| -------- | ------ | -------- | ---------------------------------------------------------- |
| `file`   | file   | Yes      | The image file to upload                                   |
| `folder` | string | No       | Optional subfolder path (e.g., `avatars`, `products/2024`) |

**Example:**

```bash
curl -X POST http://localhost:3000/upload \
  -H "X-API-Key: your-api-key" \
  -F "file=@/path/to/photo.jpg" \
  -F "folder=products"
```

**Success Response (201):**

```json
{
  "key": "originals/products/1712001234567.jpg",
  "size": 204800,
  "url": "/media/upload/f_webp/products/1712001234567.jpg"
}
```

**Error Responses:**

- `400` — No file provided, or file is empty
- `401` — Missing or invalid API key
- `429` — Rate limit exceeded (default: 20 uploads/minute)

---

### `GET /media/upload/:transformations/*`

> **No authentication required.** This endpoint is fully public — browsers, `<img>` tags, and CDNs can fetch images directly without an API key.

Fetch an image with on-the-fly transformations applied. On the first request, the image is processed and cached. All subsequent identical requests are served from the cache.

**URL format:**

```
/media/upload/{transformation,transformation,...}/{path/to/image.ext}
```

**Example:**

```
GET /media/upload/w_800,h_600,f_webp,q_85/products/1712001234567.jpg
```

**Response headers:**

- `X-Cache: HIT` — served from cache (fast)
- `X-Cache: MISS` — freshly processed
- `X-Cache: BYPASS` — no transformations; original served directly
- `Cache-Control: public, max-age=31536000, immutable` — browser/CDN caching

**No transformations (serve original):**

```
GET /media/upload/products/1712001234567.jpg
```

---

## Transformation Parameters

Parameters are comma-separated in the URL. Order does not matter.

| Parameter      | Format      | Range / Options                                 | Description                      | Example    |
| -------------- | ----------- | ----------------------------------------------- | -------------------------------- | ---------- |
| **Width**      | `w_{value}` | 1 – 10000                                       | Output width in pixels           | `w_300`    |
| **Height**     | `h_{value}` | 1 – 10000                                       | Output height in pixels          | `h_200`    |
| **Quality**    | `q_{value}` | 1 – 100                                         | Compression quality              | `q_80`     |
| **Format**     | `f_{value}` | `webp`, `jpeg`, `jpg`, `png`, `avif`            | Output image format              | `f_webp`   |
| **Fit / Crop** | `c_{value}` | `cover`, `contain`, `fill`, `inside`, `outside` | How to fit image into dimensions | `c_cover`  |
| **Background** | `b_{value}` | 3 or 6-digit hex, or `auto`                     | Fill color for `contain` mode    | `b_ffffff` |
| **Lossy flag** | `fl_lossy`  | —                                               | Enable lossy compression on PNG  | `fl_lossy` |

### Fit Modes Explained

| Mode      | Behavior                                                            |
| --------- | ------------------------------------------------------------------- |
| `cover`   | Fills the exact dimensions, cropping the excess (default behavior)  |
| `contain` | Fits within the dimensions, padding with background color if needed |
| `fill`    | Stretches or squishes to fill exactly — may distort the image       |
| `inside`  | Resizes so the image fits inside the box, never upscaling           |
| `outside` | Resizes so the image covers the box, never downscaling              |

### Common Transform Examples

```
# Square thumbnail, WebP
/media/upload/w_300,h_300,f_webp,c_cover/photo.jpg

# Max 1200px wide, keep aspect ratio, 85% quality
/media/upload/w_1200,q_85,f_jpeg/photo.jpg

# Avatar circle-ready: 100×100 WebP
/media/upload/w_100,h_100,f_webp,c_cover,q_90/avatar.jpg

# Full quality PNG with white background for transparent images
/media/upload/w_800,h_600,f_png,c_contain,b_ffffff/diagram.png

# Modern AVIF for maximum compression
/media/upload/w_1200,f_avif,q_70/banner.jpg
```

---

## Environment Variables

All configuration lives in `.env.development` (local) or `.env.production` (production). Copy and adapt as needed.

### Server

| Variable   | Default       | Description                                               |
| ---------- | ------------- | --------------------------------------------------------- |
| `PORT`     | `3000`        | Port the server listens on                                |
| `NODE_ENV` | `development` | Set automatically by npm scripts — do not change manually |

### S3 / Object Storage

| Variable              | Default                 | Description                              |
| --------------------- | ----------------------- | ---------------------------------------- |
| `S3_ENDPOINT`         | `http://localhost:9000` | S3 endpoint URL (omit for AWS S3)        |
| `S3_ACCESS_KEY`       | —                       | Access key ID                            |
| `S3_SECRET_KEY`       | —                       | Secret access key                        |
| `S3_REGION`           | `us-east-1`             | Storage region                           |
| `S3_BUCKET`           | `media`                 | Bucket name                              |
| `S3_FORCE_PATH_STYLE` | `true`                  | Set `true` for MinIO, `false` for AWS S3 |

### Redis

| Variable         | Default                  | Description                        |
| ---------------- | ------------------------ | ---------------------------------- |
| `REDIS_URL`      | `redis://localhost:6379` | Redis connection URL               |
| `REDIS_USERNAME` | —                        | Redis username (for Redis 6+ ACLs) |
| `REDIS_PASS`     | —                        | Redis password                     |

> If Redis is unavailable, the service falls back to in-memory locking automatically. Rate limiting may degrade gracefully.

### Authentication

| Variable  | Description                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `API_KEY` | Required. A strong secret string. Must be sent via the `X-API-Key` header when calling `POST /upload`. |

### Rate Limiting

| Variable                   | Default | Description                           |
| -------------------------- | ------- | ------------------------------------- |
| `RATE_LIMIT_MAX`           | `120`   | Max requests per time window (global) |
| `RATE_LIMIT_WINDOW_MS`     | `60000` | Time window in milliseconds (60s)     |
| `UPLOAD_RATE_LIMIT_MAX`    | `20`    | Max upload requests per window        |
| `TRANSFORM_RATE_LIMIT_MAX` | `120`   | Max transform requests per window     |

### Networking

| Variable              | Default                               | Description                                                                       |
| --------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `CORS_ORIGIN`         | `true`                                | Allowed CORS origins. `true` = all, `*` = all, or comma-separated list of origins |
| `TRUST_PROXY`         | `true`                                | Set `false` only if the app is directly internet-facing without a reverse proxy   |
| `MEDIA_CACHE_CONTROL` | `public, max-age=31536000, immutable` | `Cache-Control` header sent with all media responses                              |

---

## How Caching Works

```
Client Request
     │
     ▼
Is derived image already in S3?
     │
  Yes (HIT) ──────────────────────► Serve from S3 instantly
     │
  No (MISS)
     │
     ▼
Acquire lock (Redis or in-memory)
     │
     ▼
Re-check cache (another worker may have finished)
     │
     ▼
Fetch original from S3
     │
     ▼
Process with Sharp (resize, convert, crop)
     │
     ▼
Save result to S3 under derived/{hash}/{filename}
     │
     ▼
Release lock → Send result to client
```

The derived key is a SHA256 hash of the original file path + all transformation parameters (alphabetically sorted), so `w_300,h_300` and `h_300,w_300` resolve to the same cache entry.

---

## Development vs. Production

| Aspect          | Development             | Production                                 |
| --------------- | ----------------------- | ------------------------------------------ |
| Storage         | MinIO (Docker, local)   | AWS S3 (or any S3-compatible)              |
| Redis           | Docker container        | Managed Redis (ElastiCache, Upstash, etc.) |
| Start command   | `npm run dev`           | `npm start`                                |
| Env file loaded | `.env.development`      | `.env.production`                          |
| Auto-restart    | Yes (Node.js `--watch`) | No                                         |

---

## Security Notes

- **Never commit `.env.production`** to version control. Add it to `.gitignore`.
- **Generate a strong `API_KEY`** — at least 32 random characters. You can generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```
- **Change MinIO default credentials** (`minioadmin`/`minioadmin`) before any public-facing deployment.
- **Set `CORS_ORIGIN`** to your actual frontend domain(s) in production instead of `true`.
- **Set `TRUST_PROXY=false`** if the Node.js process is directly internet-facing without a load balancer or reverse proxy.

---

## Scope

This is an **images-only MVP**. The following are out of scope for the current version:

- Video processing
- Signed / expiring URLs
- Multi-bucket support
- CDN integration
- User management / per-user API keys
- Rate limiting dashboard
