# MediaServing — Setup Guide

This guide walks you through getting MediaServing running on your machine — from scratch, step by step — and then into production. No prior server experience is needed for the local setup section.

---

## Table of Contents

1. [What You Need](#1-what-you-need)
2. [Local Development Setup](#2-local-development-setup)
3. [Verify Everything Works](#3-verify-everything-works)
4. [Deploying to Production](#4-deploying-to-production)
5. [Stopping & Restarting](#5-stopping--restarting)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. What You Need

Before starting, install the following two pieces of software. Both are free.

### Node.js (version 18 or higher)

Node.js is the runtime that executes the server code.

- Download: [https://nodejs.org/](https://nodejs.org/) — choose the **LTS** version
- After installing, verify by opening a terminal and running:
  ```bash
  node --version
  # should print v18.x.x or higher
  ```

### Docker Desktop

Docker runs MinIO (your local image storage) and Redis (caching/locking) as containers — isolated processes that are easy to start and stop.

- Download: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
- After installing, verify with:
  ```bash
  docker --version
  # should print Docker version 24.x.x or similar
  ```

> **Non-technical note:** Think of Docker like a mini-computer inside your computer. It runs the storage and caching services MediaServing depends on, without you needing to install or configure them manually.

---

## 2. Local Development Setup

Follow these steps in order. Each one builds on the previous.

### Step 1 — Get the project files

If you haven't already, make sure the project folder is on your machine at a path you know (e.g., `C:\Users\You\Desktop\workspace\MediaServing`).

Open a terminal inside that folder:

**Windows (PowerShell):**

```powershell
cd C:\Users\You\Desktop\workspace\MediaServing
```

**Mac / Linux:**

```bash
cd ~/workspace/MediaServing
```

---

### Step 2 — Install dependencies

This downloads all the libraries the project needs.

```bash
npm install
```

You will see a lot of output. It is done when you get your prompt back. This only needs to be done once (or again after pulling code updates).

---

### Step 3 — Start MinIO and Redis

This starts the storage (MinIO) and caching (Redis) services in Docker:

```bash
docker compose up -d
```

The `-d` flag means "run in the background." You will see Docker download the images on first run (this can take a minute).

**Verify they are running:**

```bash
docker compose ps
```

You should see two services listed — `minio` and `redis` — both with `running` status.

Services started:

- **MinIO storage API** → `http://localhost:9000`
- **MinIO web console** → `http://localhost:9001`
- **Redis** → `localhost:6379`

---

### Step 4 — Create the storage bucket

MinIO is your local S3-compatible object storage. You need to create a "bucket" (a named space) for the service to store images in.

1. Open [http://localhost:9001](http://localhost:9001) in your browser
2. Log in with:
   - **Username:** `minioadmin`
   - **Password:** `minioadmin`
3. Click **"Create Bucket"** in the left sidebar
4. Enter **`media`** as the bucket name
5. Click **"Create Bucket"**

> **Non-technical note:** A bucket is like a folder in the cloud — it's where all your uploaded images will live.

---

### Step 5 — Configure your API key

The `.env.development` file already exists with default values for local development. The most important value to set is `API_KEY` — this is the password that protects your API.

Open `.env.development` in a text editor and set a secret key of your choosing:

```
API_KEY=replace-this-with-any-strong-secret-string
```

To generate a strong key automatically, run:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copy the output and paste it as your `API_KEY` value.

> You will need this key when making any API request. Keep it private.

---

### Step 6 — Start the server

```bash
npm run dev
```

Expected output:

```
Loaded env file: .../.env.development
Server listening at http://0.0.0.0:3000
```

The server is now running at **http://localhost:3000** and will automatically restart if you edit any source files.

---

## 3. Verify Everything Works

Run these checks to confirm the service is healthy and fully operational.

### Health check (no API key required)

```bash
curl http://localhost:3000/health
```

Expected: `{"status":"ok"}`

---

### Upload an image

Replace `C:\path\to\photo.jpg` with an actual image on your machine:

**Windows (PowerShell):**

```powershell
curl -X POST http://localhost:3000/upload `
  -H "X-API-Key: your-api-key-here" `
  -F "file=@C:\path\to\photo.jpg"
```

**Mac / Linux:**

```bash
curl -X POST http://localhost:3000/upload \
  -H "X-API-Key: your-api-key-here" \
  -F "file=@/path/to/photo.jpg"
```

Expected response:

```json
{
  "key": "originals/1712001234567.jpg",
  "size": 204800,
  "url": "/media/upload/f_webp/1712001234567.jpg"
}
```

Copy the filename from the `url` field — you'll use it in the next steps.

---

### Transform an image (first request — processes & caches)

```bash
curl "http://localhost:3000/media/upload/w_300,h_300,f_webp/1712001234567.jpg" \
  -H "X-API-Key: your-api-key-here" \
  --output thumbnail.webp
```

Check the response header for `X-Cache: MISS` — this means the image was freshly processed.

---

### Transform (second request — served from cache)

Run the exact same command again:

```bash
curl "http://localhost:3000/media/upload/w_300,h_300,f_webp/1712001234567.jpg" \
  -H "X-API-Key: your-api-key-here" \
  --output thumbnail2.webp
```

This time you should see `X-Cache: HIT` — served from storage with no reprocessing.

---

### Confirm auth is enforced

```bash
curl http://localhost:3000/media/upload/w_300/1712001234567.jpg
```

Expected: `{"error":"Unauthorized"}` with HTTP 401.

---

### Confirm validation works

```bash
curl "http://localhost:3000/media/upload/w_abc/1712001234567.jpg" \
  -H "X-API-Key: your-api-key-here"
```

Expected: `{"error":"Invalid width: \"abc\"..."}` with HTTP 400.

---

### Inspect stored files in MinIO

Open [http://localhost:9001](http://localhost:9001) → log in → click **Object Browser** → open the `media` bucket. You should see:

- `originals/` folder — contains your uploaded image
- `derived/` folder — contains the cached processed version

---

## 4. Deploying to Production

This section is for running MediaServing on a real server with real cloud services.

### What changes in production

| Component     | Development        | Production                                                  |
| ------------- | ------------------ | ----------------------------------------------------------- |
| Storage       | MinIO (Docker)     | AWS S3 (or any S3-compatible service)                       |
| Redis         | Docker container   | Managed Redis (e.g., AWS ElastiCache, Upstash, Redis Cloud) |
| Env file      | `.env.development` | `.env.production`                                           |
| Start command | `npm run dev`      | `npm start`                                                 |

---

### Configure `.env.production`

Edit `.env.production` with your real credentials:

```env
# Server
PORT=3000

# AWS S3
S3_ACCESS_KEY=YOUR_AWS_ACCESS_KEY_ID
S3_SECRET_KEY=YOUR_AWS_SECRET_ACCESS_KEY
S3_REGION=us-east-1
S3_BUCKET=your-bucket-name
S3_FORCE_PATH_STYLE=false

# Redis
REDIS_URL=redis://your-redis-host:6379
REDIS_PASS=your-redis-password

# Auth — use a strong, random string
API_KEY=replace-with-a-strong-random-secret

# CORS — restrict to your actual frontend domain(s)
CORS_ORIGIN=https://yourapp.com

# Rate limiting
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000
UPLOAD_RATE_LIMIT_MAX=20
TRANSFORM_RATE_LIMIT_MAX=120

# Trust proxy if behind a load balancer / reverse proxy
TRUST_PROXY=true
```

> **Security:** Never commit `.env.production` to version control. Add it to `.gitignore` and manage secrets through your deployment platform's secrets manager.

---

### Create your S3 bucket

In your AWS (or compatible) console, create a bucket with the name you set in `S3_BUCKET`. The bucket does not need to be public — the service fetches and serves all objects directly.

---

### Start in production mode

On your server, install dependencies and start:

```bash
npm install --omit=dev
npm start
```

This loads `.env.production` automatically, thanks to the `cross-env NODE_ENV=production` prefix in the start script.

---

### Run as a system service (recommended)

For long-running production deployments, use a process manager like [PM2](https://pm2.keymetrics.io/) so the server restarts on crash and survives reboots:

```bash
# Install PM2 globally
npm install -g pm2

# Start the service
pm2 start npm --name "media-serving" -- start

# Auto-start on system reboot
pm2 startup
pm2 save
```

---

### Reverse proxy (recommended)

For HTTPS and proper header forwarding, place a reverse proxy (nginx, Caddy, or a cloud load balancer) in front of Node.js. The service sets `trustProxy: true` by default to correctly read client IPs passed via `X-Forwarded-For`.

---

## 5. Stopping & Restarting

### Stop the development server

Press `Ctrl + C` in the terminal where `npm run dev` is running.

### Stop Docker services (MinIO + Redis)

```bash
# Stop containers (data is preserved in Docker volumes)
docker compose down

# Stop and delete all stored data (full reset)
docker compose down -v
```

### Restart everything

```bash
docker compose up -d
npm run dev
```

---

## 6. Troubleshooting

### "No env file found" warning at startup

This is shown if neither `.env.development` nor `.env.production` exist. Make sure the file exists in the project root and is named exactly `.env.development` or `.env.production`.

---

### Upload returns 401 Unauthorized

Your `X-API-Key` header value does not match the `API_KEY` in your `.env` file. Double-check both values for typos or extra whitespace.

---

### Upload returns 500 / "NoSuchBucket"

The `media` bucket does not exist in MinIO (or S3). Go back to [Step 4](#step-4--create-the-storage-bucket) and create it.

---

### MinIO console is unreachable (http://localhost:9001)

Docker containers may not be running. Run:

```bash
docker compose ps
```

If containers are stopped or absent:

```bash
docker compose up -d
```

If Docker Desktop itself is not running, launch it from your system tray or applications menu.

---

### Port 3000 is already in use

Another application is using port 3000. Either stop that application, or change the `PORT` value in your `.env.development` file to something else (e.g., `PORT=3001`) and restart the server.

---

### Image processing is slow on the first request

The first request for a given set of transformations always processes the image (cache miss). Subsequent identical requests are near-instant. If you need faster first-request times, consider pre-warming the cache by requesting your most common transforms immediately after upload.

---

### Redis connection errors in the logs

```
Rate limit Redis unavailable; limits may degrade
```

This is a warning, not a fatal error. The service runs fine without Redis — it falls back to in-memory locking. To suppress the warning, start Redis with `docker compose up -d` or point `REDIS_URL` to a working Redis instance.
