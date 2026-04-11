# Media Server — Developer User Guide

**Base URL:** `https://media_server.ramaaz.dev`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Upload a Single File](#1-upload-a-single-file)
3. [Bulk Upload Multiple Files](#2-bulk-upload-multiple-files)
4. [Specifying a Folder](#specifying-a-folder)
5. [Serving & Transforming Images](#3-serving--transforming-images)
6. [Serving Videos](#4-serving-videos)
7. [Quick Reference Table](#quick-reference-table)
8. [Full Examples](#full-examples)

---

## Authentication

Upload endpoints are **protected**. You must include your API key in every upload request:

```
x-api-key: YOUR_API_KEY
```

Serving/transform URLs (GET requests) are **public** — no key needed.

---

## 1. Upload a Single File

**Endpoint:** `POST /upload`  
**Content-Type:** `multipart/form-data`

### Fields

| Field    | Type   | Required | Description                                                                      |
| -------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `file`   | file   | ✅ Yes   | The image or video file to upload                                                |
| `folder` | string | ❌ No    | Subfolder to organize the file (see [Specifying a Folder](#specifying-a-folder)) |

### Response `201 Created`

```json
{
  "key": "originals/products/1712345678123.jpg",
  "size": 204800,
  "type": "image",
  "url": "/image/upload/products/1712345678123.jpg"
}
```

For **video** files, a `variants` field is also returned:

```json
{
  "key": "originals/clips/1712345678456.mp4",
  "size": 5242880,
  "type": "video",
  "url": "/video/upload/clips/1712345678456.mp4",
  "variants": {
    "full": "/video/upload/clips/1712345678456.mp4",
    "preview": "/video/upload/clips/1712345678456.mp4?target=preview",
    "snapshot": "/video/upload/clips/1712345678456.mp4?target=snapshot"
  }
}
```

If you upload with `?story=true`, the response also includes a `story` section:

```json
{
  "key": "originals/stories/1712345678456.mp4",
  "size": 5242880,
  "type": "video",
  "url": "/video/upload/stories/1712345678456.mp4",
  "story": {
    "enabled": true,
    "variants": {
      "hls": "/video/upload/stories/1712345678456.mp4?target=story",
      "fallback": "/video/upload/stories/1712345678456.mp4?target=story-fallback"
    }
  }
}
```

> **Note:** Video variants (full quality, preview, snapshot) are generated **in the background** after upload. They may not be immediately available. Retry after a few seconds if you get a 503.

### Code Examples

**JavaScript (fetch)**

```js
const form = new FormData();
form.append("file", fileBlob, "photo.jpg");
form.append("folder", "products"); // optional

const res = await fetch("https://media_server.ramaaz.dev/upload", {
  method: "POST",
  headers: { "x-api-key": "YOUR_API_KEY" },
  body: form,
});
const data = await res.json();
console.log(data.url); // "/image/upload/products/1712345678123.jpg"
```

**Story video upload (opt-in):**

```js
const form = new FormData();
form.append("file", fileBlob, "story.mp4");

const res = await fetch("https://media_server.ramaaz.dev/upload?story=true", {
  method: "POST",
  headers: { "x-api-key": "YOUR_API_KEY" },
  body: form,
});

const data = await res.json();
console.log(data.story?.variants?.hls);
```

**cURL**

```bash
curl -X POST https://media_server.ramaaz.dev/upload \
  -H "x-api-key: YOUR_API_KEY" \
  -F "file=@/path/to/photo.jpg" \
  -F "folder=products"
```

---

## 2. Bulk Upload Multiple Files

**Endpoint:** `POST /upload/bulk`  
**Content-Type:** `multipart/form-data`

Upload up to **50 files** in a single request.

### Fields

| Field    | Type   | Required | Description                                         |
| -------- | ------ | -------- | --------------------------------------------------- |
| `file`   | file   | ✅ Yes   | One or more files (repeat this field for each file) |
| `folder` | string | ❌ No    | A single folder applied to **all** uploaded files   |

### Response `201 Created`

```json
{
  "urls": [
    "/image/upload/products/1712345678001.jpg",
    "/image/upload/products/1712345678002.jpg",
    "/image/upload/products/1712345678003.png"
  ],
  "items": [
    {
      "key": "originals/products/1712345678001.jpg",
      "size": 102400,
      "type": "image",
      "url": "/image/upload/products/1712345678001.jpg"
    },
    {
      "key": "originals/products/1712345678002.jpg",
      "size": 98304,
      "type": "image",
      "url": "/image/upload/products/1712345678002.jpg"
    },
    {
      "key": "originals/products/1712345678003.png",
      "size": 204800,
      "type": "image",
      "url": "/image/upload/products/1712345678003.png"
    }
  ]
}
```

### Code Examples

**JavaScript (fetch)**

```js
const form = new FormData();
form.append("folder", "products"); // optional, applies to all files
form.append("file", file1, "photo1.jpg");
form.append("file", file2, "photo2.jpg");
form.append("file", file3, "banner.png");

const res = await fetch("https://media_server.ramaaz.dev/upload/bulk", {
  method: "POST",
  headers: { "x-api-key": "YOUR_API_KEY" },
  body: form,
});
const data = await res.json();
console.log(data.urls); // array of ready-to-use URLs
```

**cURL**

```bash
curl -X POST https://media_server.ramaaz.dev/upload/bulk \
  -H "x-api-key: YOUR_API_KEY" \
  -F "folder=products" \
  -F "file=@photo1.jpg" \
  -F "file=@photo2.jpg" \
  -F "file=@banner.png"
```

---

## Specifying a Folder

The `folder` field organizes your files into subfolders on the server. This is useful for separating content by context (products, avatars, banners, etc.).

- The folder name is included in the returned URL path.
- You can use nested folders with `/` (e.g., `products/summer-2025`).
- If you omit `folder`, the file goes into the root `originals/` directory.

**Example:**

| Folder value      | Resulting URL path                                |
| ----------------- | ------------------------------------------------- |
| _(omitted)_       | `/image/upload/1712345678123.jpg`                 |
| `products`        | `/image/upload/products/1712345678123.jpg`        |
| `products/summer` | `/image/upload/products/summer/1712345678123.jpg` |
| `avatars`         | `/image/upload/avatars/1712345678123.jpg`         |

---

## 3. Serving & Transforming Images

Once uploaded, use the URL returned by the upload endpoint to serve the image. You can add **on-the-fly transformations** directly in the URL path.

**URL Pattern:**

```
GET /image/upload/<transformations>/<file-path>
```

Transformations are placed **before** the file name, separated by `/`. Multiple transformation parameters are joined with `,`.

> All images are **always served as WebP** regardless of the original format or any `f_` parameter you provide. This is intentional for maximum compression efficiency.

### Transformation Parameters

| Param       | Example    | Description                                                                                                                 |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `w_<n>`     | `w_800`    | Resize width to `n` pixels (1–10000)                                                                                        |
| `h_<n>`     | `h_600`    | Resize height to `n` pixels (1–10000)                                                                                       |
| `q_<n>`     | `q_80`     | Quality (1–100). Higher = better quality, larger file.                                                                      |
| `q_auto`    | `q_auto`   | Auto quality (default: `good` = 75). Variants: `q_auto:eco` (45), `q_auto:low` (55), `q_auto:good` (75), `q_auto:best` (85) |
| `c_<mode>`  | `c_fill`   | Crop/fit mode (see table below)                                                                                             |
| `b_<color>` | `b_ff0000` | Background color for padding — hex (e.g. `b_ff0000`) or `b_auto`                                                            |
| `fl_lossy`  | `fl_lossy` | Apply lossy compression hint                                                                                                |

#### Crop / Fit Modes

| Mode    | Aliases             | Behavior                                                            |
| ------- | ------------------- | ------------------------------------------------------------------- |
| `fill`  | `cover`, `outside`  | Crop to exact dimensions, filling the frame (may crop edges)        |
| `fit`   | `contain`, `inside` | Scale down to fit within the box, no cropping                       |
| `pad`   |                     | Fit within the box and add background color to fill remaining space |
| `scale` |                     | Stretch/squish to exact dimensions (ignores aspect ratio)           |
| `crop`  |                     | Crop without resizing                                               |

### Transformation URL Examples

**Resize to 800×600, auto quality:**

```
https://media_server.ramaaz.dev/image/upload/w_800,h_600,q_auto/products/photo.jpg
```

**Resize width only, high quality:**

```
https://media_server.ramaaz.dev/image/upload/w_400,q_90/avatars/user123.jpg
```

**Fill mode (like CSS `object-fit: cover`) with quality 75:**

```
https://media_server.ramaaz.dev/image/upload/w_600,h_400,c_fill,q_75/banners/hero.jpg
```

**Pad to exact size with white background:**

```
https://media_server.ramaaz.dev/image/upload/w_500,h_500,c_pad,b_ffffff/products/item.png
```

**No transformation — serve as-is (still converts to WebP):**

```
https://media_server.ramaaz.dev/image/upload/products/photo.jpg
```

### Chained Transformations

You can chain multiple transformation groups by separating them with `/`. Later groups override earlier ones for the same parameter:

```
https://media_server.ramaaz.dev/image/upload/w_800,c_fill/q_85/products/photo.jpg
```

---

## 4. Serving Videos

Videos are served using **prebuilt variants** that are generated automatically right after upload. You **cannot** apply custom transformations to videos via the URL — use the `?target=` query parameter instead.

**URL Pattern:**

```
GET /video/upload/<file-path>?target=<variant>
```

### Video Variants

| `?target=`       | Description                                               | Format | Dimensions     |
| ---------------- | --------------------------------------------------------- | ------ | -------------- |
| _(omitted)_      | **Full quality** video — best for main playback           | WebM   | 1280×630       |
| `preview`        | **Short preview** — first 10 seconds in smaller size      | WebM   | 400×600        |
| `snapshot`       | **Thumbnail image** — a single frame captured at 1 second | WebP   | —              |
| `story`          | **Story HLS manifest** (ABR-style playlists/segments)     | HLS    | 360p/540p/720p |
| `story-fallback` | **Story MP4 fallback** for clients without HLS support    | MP4    | 720×1280       |

### Video URL Examples

**Full video (default playback):**

```
https://media_server.ramaaz.dev/video/upload/clips/video.mp4
```

**Short preview clip:**

```
https://media_server.ramaaz.dev/video/upload/clips/video.mp4?target=preview
```

**Thumbnail image:**

```
https://media_server.ramaaz.dev/video/upload/clips/video.mp4?target=snapshot
```

### Using in an `<img>` tag (thumbnail)

```html
<img
  src="https://media_server.ramaaz.dev/video/upload/clips/video.mp4?target=snapshot"
  alt="Video thumbnail"
/>
```

### Using in a `<video>` tag

```html
<video
  src="https://media_server.ramaaz.dev/video/upload/clips/video.mp4"
  poster="https://media_server.ramaaz.dev/video/upload/clips/video.mp4?target=snapshot"
  controls
/>
```

> **Note:** After upload, variants are generated in the background so the first request is instant from cache. If you request a variant for a video that was **migrated to S3** without pre-processing, the server will generate it on-the-fly on the first request — this may take a few seconds for large videos. Subsequent requests will be served instantly from cache.

---

## Quick Reference Table

| Action                     | Method | Endpoint                            | Auth Required |
| -------------------------- | ------ | ----------------------------------- | ------------- |
| Upload single file         | POST   | `/upload`                           | ✅ Yes        |
| Bulk upload files          | POST   | `/upload/bulk`                      | ✅ Yes        |
| Serve / transform image    | GET    | `/image/upload/...`                 | ❌ No         |
| Serve full video           | GET    | `/video/upload/...`                 | ❌ No         |
| Serve video preview clip   | GET    | `/video/upload/...?target=preview`  | ❌ No         |
| Serve video snapshot/thumb | GET    | `/video/upload/...?target=snapshot` | ❌ No         |

---

## Rate Limits

| Endpoint            | Limit                   |
| ------------------- | ----------------------- |
| `/upload`           | 20 requests per minute  |
| `/upload/bulk`      | 20 requests per minute  |
| `/image/upload/...` | 120 requests per minute |
| `/video/upload/...` | 120 requests per minute |

---

## Full Examples

### Dashboard — Display a product image, resized to card size

```js
// After upload, store the `url` from the response
const imageUrl =
  "https://media_server.ramaaz.dev" +
  "/image/upload/w_400,h_300,c_fill,q_auto:good" +
  "/products/1712345678123.jpg";
```

### Application — Upload a user avatar and display it

```js
// 1. Upload
const form = new FormData();
form.append("file", avatarFile);
form.append("folder", "avatars");

const { url } = await fetch("https://media_server.ramaaz.dev/upload", {
  method: "POST",
  headers: { "x-api-key": process.env.MEDIA_API_KEY },
  body: form,
}).then((r) => r.json());

// url => "/image/upload/avatars/1712345678456.jpg"

// 2. Build a display URL (50×50 circle-ready crop)
const displayUrl = `https://media_server.ramaaz.dev${url.replace(
  "/image/upload/",
  "/image/upload/w_50,h_50,c_fill,q_auto/",
)}`;
```

### Application — Upload a video and display its thumbnail + player

```js
// 1. Upload
const form = new FormData();
form.append("file", videoFile);
form.append("folder", "clips");

const result = await fetch("https://media_server.ramaaz.dev/upload", {
  method: "POST",
  headers: { "x-api-key": process.env.MEDIA_API_KEY },
  body: form,
}).then((r) => r.json());

// result.variants.snapshot  => "/video/upload/clips/....mp4?target=snapshot"
// result.variants.preview   => "/video/upload/clips/....mp4?target=preview"
// result.variants.full      => "/video/upload/clips/....mp4"

const base = "https://media_server.ramaaz.dev";

// 2. Use in JSX / HTML
// <video poster={base + result.variants.snapshot} src={base + result.variants.full} controls />
```
