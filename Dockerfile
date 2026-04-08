# syntax=docker/dockerfile:1.7

# ── Stage 0: base ────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache dumb-init ffmpeg

# ── Stage 1: install production dependencies ────────────────────────────────
FROM base AS deps

# pnpm lockfile version 9 requires pnpm v9+
RUN npm install -g pnpm@9 --quiet

COPY package.json pnpm-lock.yaml ./

# Install only production dependencies.
# Running on Alpine (musl) so pnpm will pull @img/sharp-linux-x64-musl automatically.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ── Stage 2: lean production image ──────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production

# Copy installed node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source and static HTML pages
COPY src ./src
COPY test.html compare.html ./

EXPOSE 3000

# Run as the built-in non-root node user
USER node

CMD ["dumb-init", "node", "src/index.js"]
