# CloudFront CDN Setup For `/image` and `/video` Only

Owner: Developer + DevOps  
Last updated: 2026-04-12  
Current app domain: `https://media_server.ramaaz.dev`

## 1. Scope (Important)

Goal: speed up media delivery only.

In scope:

- `GET /image/upload/*`
- `GET /video/upload/*`

Out of scope:

- Upload endpoints (`/upload`, `/upload/bulk`)
- Any other API route

## 2. Architecture Decision

Use CloudFront in front of your app origin for media paths.

Why:

- Your app performs dynamic transforms on `/image/upload/*` and serves video variants on `/video/upload/*`.
- S3-only CloudFront origin would bypass app logic and break transform behavior.

Send this exact request to DevOps:

1. Create ACM certificate in `us-east-1` for `cdn.ramaaz.dev`.
2. Create CloudFront distribution with origin set to app origin (ALB or server hostname), not S3.
3. Attach alternate domain `cdn.ramaaz.dev` and the ACM cert.
4. Create behavior for `/image/upload/*`:

- Allowed methods: `GET, HEAD, OPTIONS`
- Cache: enabled
- Compress objects: enabled
- Cookies: none
- Query strings: forward all

5. Create behavior for `/video/upload/*`:

- Allowed methods: `GET, HEAD, OPTIONS`
- Cache: enabled
- Compress objects: enabled
- Cookies: none
- Query strings: forward all (required for `?target=` variants)

6. Default behavior:

- No cache for non-media routes or keep default pointing to origin and not used by app clients.

7. Create DNS record:

- `cdn.ramaaz.dev` -> CloudFront domain (`dxxxxx.cloudfront.net`)

## 5. CloudFront Settings Quick Table

Use these values unless your infra standards require different ones.

Exact origin to use in your case:

- `Origin domain`: `media_server.ramaaz.dev`
- `Origin path`: empty
- `Origin type`: Custom origin (HTTP server), not S3 origin
- If you have an ALB/Nginx public hostname, prefer that hostname as origin and keep `media_server.ramaaz.dev` only for users.

| Setting                       | Value to set                                 |
| ----------------------------- | -------------------------------------------- |
| Origin domain name            | `media_server.ramaaz.dev`                    |
| Origin type                   | `Custom`                                     |
| Origin protocol policy        | `HTTPS only`                                 |
| HTTPS port                    | `443`                                        |
| Origin path                   | empty                                        |
| Viewer protocol policy        | `Redirect HTTP to HTTPS`                     |
| Alternate domain name (CNAME) | `cdn.ramaaz.dev`                             |
| TLS certificate               | ACM cert for `cdn.ramaaz.dev` in `us-east-1` |
| Behavior path #1              | `/image/upload/*`                            |
| Behavior path #2              | `/video/upload/*`                            |
| Allowed HTTP methods          | `GET, HEAD, OPTIONS`                         |
| Cache policy                  | Managed: `CachingOptimized`                  |
| Origin request policy         | Managed: `AllViewerExceptHostHeader`         |
| Query strings                 | `All`                                        |
| Cookies                       | `None`                                       |
| Compression                   | `On`                                         |
| Default behavior              | Leave default uncached/not used by clients   |

## 6. Validation After Setup

Run these checks:

1. Open one image through origin and CDN and compare load times.
2. Call the same CDN media URL twice; second call should be faster.
3. Confirm response has CloudFront indicators (`Age` increases after repeated requests).
4. Confirm video targets are distinct and work through CDN:

- `.../video/upload/<file>?target=preview`
- `.../video/upload/<file>?target=snapshot`

5. Confirm uploads still work directly on origin domain.

## 7. Rollback (If Needed)

1. Switch client media base URL from `cdn.ramaaz.dev` back to `media_server.ramaaz.dev`.
2. Keep origin API traffic unchanged.
3. Investigate CloudFront behavior settings, then retry rollout.

## 8. Common Mistakes

- Using S3 as CloudFront origin for these transform paths.
- Not forwarding query strings for `/video/upload/*`.
- Sending `/upload` traffic to CDN cached behaviors.
- Using ACM certificate outside `us-east-1`.
