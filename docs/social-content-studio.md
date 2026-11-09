# AI Social Media Content Studio

The Social module (Social → *Social Media Content Studio*) now creates content with AI: posters, videos,
platform posts, carousels and complete multi-day campaign plans, using each workspace's Brand Kit.
It extends the existing module — same campaigns, content items, approvals, calendar, publishing queue,
media library and analytics. Nothing new publishes on its own: generated content is a draft or a
library file until a person approves and schedules it.

## 1. Audit (Phase 1) — what existed and was reused

| Area | Existing implementation | Reused as |
|---|---|---|
| Campaigns | `campaigns` table, AI post generation from a brief (`generate_campaign` job) | Campaign Planner creates a normal campaign (`source = content_studio`) |
| Content | `content_items` with versions, approvals, platform options | Planned items, carousels and saved posts are content items (`format`, `plan_day`, `media_prompt`, `carousel_json`, `brand_kit_id` added) |
| Approval & publishing | approval requests; `publishing_jobs` with idempotency keys, retries, stored platform post IDs, "unknown outcome" handling | Unchanged; the Studio never publishes |
| Calendar | month / week / day / list views, filters, drag-and-drop rescheduling | Unchanged; planned items show there when scheduled |
| Media | `assets` on local disk (`SOCIAL_MEDIA_STORAGE_DIR`), content-type probing, quota, unguessable public ids | Generated and edited files are stored the same way (`source = ai` / `edited`, `generation_id`, `parent_asset_id`, `campaign_id`) |
| AI text | `services/aiEngine` (Groq, OpenAI, OpenRouter, Gemini, Ollama) via `lib/aiStructured` with quota and metering | All Studio text (posts, fields, plans, carousel copy) |
| Usage | `usage_ledger` | Media generations are also written there (`ai_image`, `ai_video`, …) |
| Background jobs | `background_jobs` + `workers/socialWorker.js` | New job type `studio_generation` |
| Analytics | real platform metrics; unavailable ≠ 0 | Unchanged (no demo data) |

Not present before: Brand Kit, image / video / voice providers, an image editor, video editing, AI credit
limits and confirmations. No object storage (S3) is configured in this project; files stay on the
server's disk as before.

## 2. Architecture

```
Angular (Social hub)                          Node / Express                                   Providers
─────────────────────                         ──────────────────────────────────────           ─────────
AI Content Generator ─┐                       /api/v1/social/studio  (studio/routes.js)
Campaign Planner     ─┼─ StudioApiService ──▶ generationService  ── text ──▶ lib/aiStructured ──▶ aiEngine (Groq/OpenAI/…)
Brand Kit            ─┤                       │   begin(): request key, estimate, confirm, credit limit
Image editor (canvas)─┘                       │   images/videos ─▶ background_jobs (studio_generation)
                                              │                      └▶ worker or API ─▶ lib/aiMedia ─▶ OpenAI Images / FLUX (fal.ai)
                                              │                                                     ─▶ Runway (image → video, polled)
                                              │                                                     ─▶ ElevenLabs (voice-over)
                                              │                      └▶ lib/videoTools (FFmpeg: trim, subtitles, voice-over)
                                              └ mediaStore.storeBuffer/storeFile ─▶ assets (local disk)
```

- **Provider-independent:** `lib/aiMedia.js` gives every provider the same shape (`generate`, or `start` + `poll`
  for asynchronous video), with `capabilities` (sizes, durations, variations, text-to-video or not). The
  provider is chosen by configuration (`AI_IMAGE_PROVIDER`, …) or the first one configured. Business logic never
  names a provider. Adding Kling or another video provider = one object in `PROVIDERS.video`.
- **Capability checks:** unsupported sizes, durations or variation counts are refused with a clear message;
  options without a provider show "Not set up" with what to configure. Runway animates an image, so
  "text-to-video" first generates a start frame (counted in the estimate).
- **Generations** (`social_content_generations`): one row per generation = the job, the provider request record
  and the usage log. `request_key` (one per click) makes repeats and double-submits the same generation.
  Credits are charged once, on completion; failures cost nothing; Retry reuses the row.
- **Workspace isolation:** the workspace comes from the session (never the request body) and from the job row
  in background work; every asset, brand kit, campaign and content id is checked against the workspace;
  generated files reuse the media store's unguessable ids.

## 3. Database (migration `047_social_content_studio`, reversible `down()`)

- `social_brand_kits` — workspace_id, name, is_default, company_name, logo_asset_id, website, contact_info,
  primary/secondary colour, fonts, description, guidelines, tone, product/reference image ids, soft delete.
- `social_content_generations` — workspace_id, user_id, kind (text, plan, image, carousel, video, video_edit),
  purpose, provider, model, request_key (unique per workspace), status, input/output JSON, error, provider_job_id,
  estimated/charged credits, estimated/actual USD, attempts, campaign / content item / brand kit, timestamps.
- `assets` + `generation_id`, `parent_asset_id`, `campaign_id`; `content_items` + `format`, `plan_day`,
  `media_prompt`, `carousel_json`, `brand_kit_id`.

The suggested `social_video_jobs`, `social_ai_usage_logs`, `social_content_assets`, `social_content_versions`
and `social_content_approvals` tables were **not** created: generations cover jobs and usage, and the existing
`assets`, `content_versions` and `approval_requests` tables already do the rest.

## 4. API (`/api/v1/social/studio`, signed in)

| Method & path | Capability | What it does |
|---|---|---|
| `GET /capabilities` | any member | What can be generated here, sizes, durations; never keys |
| `GET /brand-kits` · `POST` · `PUT /:id` · `DELETE /:id` | campaigns.manage (write) | Brand kits |
| `POST /estimate` `{kind, input}` | content.create | Credits (+ USD when priced) before starting |
| `POST /ai/post` | content.create | Platform posts: title, caption, description, hashtags, CTA, best time, format |
| `POST /ai/post-field` | content.create | One field again |
| `POST /ai/poster` | content.create | 1–4 poster variations (background job) |
| `POST /ai/carousel` | content.create | Slide copy (+ optional slide images) → draft carousel post |
| `POST /ai/video` | content.create | Video job: start frame → provider job → polling → library; optional voice-over/subtitles |
| `POST /ai/video-edit` | content.create | Trim, replace a scene with another clip, intro/outro image cards, subtitles, voice-over (mix or replace), background music (FFmpeg) → edited copy |
| `POST /music` (raw MP3 body) | content.create | Background music for videos (cannot be attached to posts) |
| `POST /planner` | campaigns.manage | Brief → campaign + one draft item per planned post |
| `GET /generations`, `GET /generations/:id`, `POST /generations/:id/retry` | content.create (retry) | Status, results, retry of failed media |
| `POST /media/:id/edited` (raw PNG body) | content.create | Image editor export as a new asset linked to the original |
| `GET /usage` | content.create | Credits this month by kind/provider, limit, recent generations |

Every AI call takes `requestKey` (8–80 chars). Expensive calls answer `409 CONFIRMATION_REQUIRED` with the
estimate until `confirm: true` is sent; over the monthly limit `402 CREDIT_LIMIT`; no provider `501`.
Content items also accept `format`, `planDay`, `mediaPrompt` and `slides` on the existing `/content` API.

## 5. Screens

Navigation: **Overview · AI Content Generator · Campaign Planner · Content Calendar · Content Library ·
Published Posts · Analytics · Brand Kit · Connected Accounts**, then All Posts, Engagement Inbox, Mark AI
Strategist and Social Settings.

- **Overview:** "Create with AI" cards (poster, video, posts, carousel, campaign plan).
- **AI Content Generator:** four option cards; short forms with quick-start presets and folded
  **Advanced options** (poster: offer badge, button text, layout, colour mood, background, brand colours,
  logo space, avoid, own prompt; video: camera, mood, pace, starting image, voice-over, subtitles; posts:
  length, emojis, hashtag count, CTA, link, keywords, avoid; carousel: words per slide, tone, final CTA).
  Estimate → confirmation for expensive jobs → live status (queued / processing % / completed / failed + Retry).
  Results: image gallery (Edit, Download, New design), video preview with editing, per-platform post cards
  with ↻ per field and "Save as draft post", carousel slides (edit, reorder, save).
- **Video editing** (after a video is generated): trim, intro and outro cards (any library image, e.g. a poster
  made in the image editor), background music (upload an MP3, set the volume), replace a scene with another
  clip, subtitles (burned into the picture when the server's FFmpeg has libass, otherwise a subtitle track plus
  a downloadable .srt), voice-over mixed with or replacing the original sound. The same branding options are
  in the video generator's advanced options.
- **Content Calendar:** thumbnails of each post's image or video in month, day and list views.
- **Analytics:** a new "AI usage" card (credits used against the monthly limit, by type and provider, failed
  generations not charged); the existing per-campaign and per-platform comparison tables are unchanged.
- **Image editor:** platform sizes (1080², 1080×1350, 1080×1920, 1200×628, 1280×720, 1200²), zoom/move,
  background, text layers (drag, size, colour, weight, alignment, shadow), brand logo, layouts (bottom
  banner, big headline, offer badge), download or save a copy (original kept).
- **Campaign Planner:** brief + presets (Black Friday, launch, festival, monthly) → plan table by day with
  format, platform, suggested time, media status; per item: Edit / schedule, ↻ Rewrite, ✨ Make image /
  video / carousel (attached to the post as a new version), Send for approval, Delete.
- **Brand Kit:** several brands, one default; logo, colours, fonts, voice, guidelines, product and reference images.
- **Content Library:** filters for AI-generated / Edited / Uploaded, badges, Edit image, Download.

## 6. Configuration

See `backend/.env.example` (section "AI Social Media Content Studio"): `OPENAI_API_KEY` and/or `FAL_KEY`
(images), `RUNWAY_API_KEY` (video), `ELEVENLABS_API_KEY` (voice-over), `FFMPEG_PATH` (video editing),
`AI_CREDITS_*`, `SOCIAL_AI_MONTHLY_CREDIT_LIMIT`, `AI_CONFIRM_CREDITS`, optional `AI_COST_<KIND>_<PROVIDER>_USD`.
Run `npm run migrate` (adds 047). Keep `npm run worker` running for videos (the API also runs due steps
while someone watches a generation).

## 7. Known limitations

- The real provider integrations (OpenAI Images including reference images, fal.ai FLUX, Runway, ElevenLabs)
  are written to their published APIs but were **not called** during development (no paid generations); test
  them with a real key on staging first. Runway's API version header is `2024-11-06`.
- Video editing needs FFmpeg on the server (it was tested here with Homebrew's FFmpeg 7). Burned-in subtitles
  need an FFmpeg built with libass (Homebrew: `brew install ffmpeg-full`; Ubuntu's `ffmpeg` package has it);
  without it they are a subtitle track. A damaged input file stops after a time limit instead of hanging.
- Reference images go to the image model only with OpenAI's gpt-image models; FLUX (fal.ai) refuses them with a
  clear message. Fonts from the Brand Kit apply in the image editor.
- Scene replacement uses a clip you choose (for example one generated with "Video"); it is not regenerated
  inside the same provider request.
- Carousels are saved as multi-image posts; whether a platform accepts that carousel is checked by the
  existing publishing rules.

## 8. Tests

- Backend `tests/socialStudio.test.js` (mocked text, image and video providers; no real AI):
  capabilities, brand kit isolation, posts and request-key de-duplication, posters and credits, failure +
  retry charged once, credit limit, confirmations, asynchronous video with polling, FFmpeg capability,
  carousels, planner (drafts only, nothing scheduled), edited images keep originals, usage per workspace.
- Backend also: music uploads (MP3 only via the Studio, never on posts) and a real-FFmpeg edit (trim, replaced
  scene, intro/outro, subtitles, music: checks length 7.5 s, size and sound), skipped when FFmpeg is missing.
- Frontend `studio.spec.ts`: generator options and usage, posts and field regeneration, video confirmation
  and progress, presets and advanced options, retry, video editing options, brand kit save, planner, image
  editor export.
