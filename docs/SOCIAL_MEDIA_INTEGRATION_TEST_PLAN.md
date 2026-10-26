# Social Media — Live Integration Test Plan

Automated tests (`backend/tests/socialMedia.test.js`, `socialReadiness.test.js`, `publishing.test.js`) use mocked
platform APIs only. Before real customers publish, run this plan once per platform with **dedicated test accounts**,
on a **staging** server with its own database and storage folder. Never use customer accounts or the production
database for it.

## 0. Preparation (once)

1. Staging server with a public HTTPS domain. Set `APP_BASE_URL=https://<staging-domain>` and `FRONTEND_URL`.
2. Set `SOCIAL_MEDIA_STORAGE_DIR` to an absolute path outside the code folder; confirm the API and worker run as
   users that can both read and write it.
3. `cd backend && npm run migrate:status` → check only expected migrations are pending, then `npm run migrate`.
4. Start the API (`npm start`) and exactly one worker (`npm run worker`) under a process manager.
5. Create a test workspace with three members: Owner (publishes), Approver, Member (drafts only).
   Settings → Social: time zone `Asia/Kolkata` (no DST, easy to check), approval required.
6. Test accounts:
   - **Facebook**: a test Page you admin; Meta app in development mode with you as an app role; permissions
     `pages_manage_posts`, `pages_read_engagement`, `read_insights`, `pages_read_user_content`, `pages_manage_engagement`.
   - **Instagram**: a Professional (Business/Creator) test account linked to that Page; `instagram_basic`,
     `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`.
   - **LinkedIn**: a test Company Page you admin; an app with the Community Management API product approved.
   - **YouTube**: a test channel; Google Cloud project with YouTube Data API v3 and your account as a test user.
     Expect uploads to be **private** until Google audits the project.
7. Test media (keep copies): `square.jpg` 1080×1080 JPEG < 4 MB; `portrait.jpg` 1080×1350; `photo.png` 1200×1200;
   `reel.mp4` 1080×1920 H.264/AAC 30 fps, 10–20 s; `landscape.mp4` 1920×1080 H.264, 20–60 s.

For every step record: time, Marketech job id and status, the platform URL, and a screenshot of the platform.
**Pass** requires the platform to show the post — a Marketech status alone is not enough.

## 1. Every platform

| # | Step | Expected |
|---|---|---|
| 1.1 | Connect the account (Connected Accounts). | Account `connected`; capabilities show Available for the features you granted. |
| 1.2 | Upload the test media in Media Library. | Dimensions/duration/codec shown; oversized or renamed non-media files are refused. |
| 1.3 | As Member, create a post for the account in the composer. | Draft created; Member has no Publish/Schedule. Platform checks list any problems. |
| 1.4 | Submit; as Approver approve; as Owner schedule 10 min ahead in `Asia/Kolkata`. | Queue shows the time in IST; job `queued`. Nothing is posted early. |
| 1.5 | Restart the API and the worker before the scheduled time. | After restart the job is still `queued`, media previews still load, the post goes out at the scheduled time. |
| 1.6 | At publish time. | Job `succeeded` (or `processing` for videos, then `succeeded`); content `published`; "View post" opens the real post. |
| 1.7 | Press "Publish now" again on the same version. | Refused ("already published"). Only one post exists on the platform. |
| 1.8 | Edit the published post's draft copy (Duplicate) and change the media alt text of an approved post. | Changed posts return to draft and need approval again. |
| 1.9 | Demote the Approver to Member after approving a scheduled post; wait for its time. | Job `failed` with APPROVAL_REQUIRED; nothing posted. |
| 1.10 | Revoke the app's access on the platform; schedule a post. | Job `failed` with AUTH_EXPIRED / PERMISSION_DENIED; account shows reconnect guidance; nothing posted. Reconnect afterwards. |
| 1.11 | Sync analytics (after 24–48 h). | Metrics shown with collection time; metrics the platform does not report say Unavailable, not 0. |

## 2. Platform-specific

### Facebook Page
- 2.F1 Text post; 2.F2 link post (link preview shown); 2.F3 one photo; 2.F4 three photos (one post with three images).
- 2.F5 `landscape.mp4`: job shows **processing on platform** until Facebook finishes, then `succeeded`. Confirm the
  video plays on the Page. If it stays processing for 24 h it becomes `needs_review` — check the Page manually.
- 2.F6 Photo + link in one post: refused before publishing (Facebook cannot show both).

### Instagram
- 2.I1 `square.jpg` single image; 2.I2 `photo.png`: refused (JPEG only).
- 2.I3 Carousel of `square.jpg` + `portrait.jpg`; confirm order on Instagram matches the attachment order.
- 2.I4 `reel.mp4` as a Reel; confirm it appears under Reels and in the feed.
- 2.I5 Temporarily set `APP_BASE_URL` to `http://...`: composer shows the HTTPS problem; scheduling is refused.

### LinkedIn Page
- 2.L1 Text; 2.L2 link (article preview); 2.L3 one image with alt text (check alt text in the post's accessibility view);
  2.L4 three images; 2.L5 `landscape.mp4` with a title.

### YouTube
- 2.Y1 `landscape.mp4` with title, description, hashtags, privacy **Unlisted**.
- Expected: job `processing on platform`, then `succeeded`. Until the project is audited, the queue shows the note
  "YouTube set this video to private" — that is correct reporting, not a failure.
- 2.Y2 Upload the same file again: YouTube may reject duplicates → job `failed` with PROCESSING_FAILED; delete it in Studio.
- Quota: each upload costs about 1,600 of the default 10,000 daily units. Do not run more than ~5 uploads per day.

## 3. Failure and recovery drills (staging only)

| # | How | Expected |
|---|---|---|
| 3.1 Timeout before sending | Block outbound HTTPS to the platform (firewall) for the worker host; schedule a post. | Job retried with backoff (`queued`, attempts increase); nothing posted; unblock → published once. |
| 3.2 Ambiguous outcome | Kill the worker process during a video upload (watch the log for the job id). | Within ~10 min the job becomes `needs_review`; it is **not** retried. Check the platform: if the post is there, leave it; if not, Retry and confirm. Exactly one post must exist. |
| 3.3 Two workers | Run two workers; schedule five posts for the same minute. | Each post published exactly once; no job taken over while uploading. |
| 3.4 Rate limit | Hard to force safely — verify from logs if it occurs: job `queued` with RATE_LIMITED and a later next attempt. YouTube quota errors wait until after midnight Pacific. |
| 3.5 Missing media | On staging, move one scheduled post's file out of `SOCIAL_MEDIA_STORAGE_DIR`. | Job `failed` with MEDIA_MISSING before any platform call; message names the file, not a server path. |
| 3.6 Token expiry | LinkedIn: wait for (or shorten via app settings) token expiry. | Refresh used if the app has refresh tokens; otherwise AUTH_EXPIRED and reconnect guidance. |

## 4. Sign-off

A platform is ready when sections 1 and 2 pass for it and drills 3.1, 3.2 and 3.5 pass at least once on staging.
Record any platform response that differs from this plan (status names, delays, error codes) — the adapters
were written from the platforms' documentation and have not yet been run against the live APIs.
