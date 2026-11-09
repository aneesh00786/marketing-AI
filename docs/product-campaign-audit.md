# Product-Based AI Social Media Campaigns — Phase 1 Audit and Architecture Plan

Status: **reviewed** (decisions below). Decisions taken:
1. **No changes to the Digital Products page.** The product is chosen when a campaign is created (Social → Campaigns); the product's images for the campaign are chosen in the wizard and saved on the campaign (`campaigns.image_asset_ids_json`). The product record is not changed.
2. Strategy ideas stay in the campaign until *Accept* creates the draft posts.
3. AI background replacement is included (shown with its credit cost); colour adjustments are free in the browser.
4. **Leads are not part of social campaigns** (they belong to email campaigns): no lead columns, no leads metric.
5. LinkedIn stays pages-only.
6. No Sharp for now.

Target workflow: **Select Product → Campaign Details → AI Strategy → Generate Content → Review & Approve →
Schedule & Publish → Analytics**, inside the existing Social module, reusing what already works.

---

## 1. Existing architecture (what is there today)

### 1.1 Digital Products — `digital_products`, API `/api/v1/products`
| Column | Meaning |
|---|---|
| `id`, `workspace_id` | Owned by one workspace; every query filters by the session's workspace |
| `name`, `url` | Product name and website / landing page |
| `tagline`, `description` | Short line and long description |
| `features_json` | Features (list of strings, up to 50) |
| `target_audience` | Who it is for |
| `pricing_tiers_json` | Pricing tiers (free-form list) |
| `status` | `Active` / `Inactive` |

API: list, detail, create, edit, delete (`campaigns.manage` to change) and *extract from website* (AI fills the
fields from the product's URL). UI: the Digital Products page in `app.component` (product grid and form).
**Missing for this spec:** product **images** and a **category**. There is no "benefits" field (benefits can be
derived from features and description, marked as derived).

### 1.2 Social campaigns — `campaigns` + `content_items`
- `campaigns` already has `product_id` (checked to belong to the workspace), objective, target audience, offer,
  key message, start/end dates, platforms, accounts, tone, language, call to action, landing URL, image/video
  requirements, `brief_json`, `generation_status`, `source`.
- The existing **AI campaign generation** (`campaignService.runGeneration`, background job `generate_campaign`)
  reads the product's facts (`loadFacts`), writes draft posts, and **flags any claim not found in the product
  facts** ("Verify before approval: …") — the "no invented features or prices" rule already exists here.
- `content_items` (posts): platform, account, caption, hashtags, CTA, link, media assets, image prompt, video
  script, suggested time, status, version history (`content_versions`), approval (`approval_requests`),
  platform groups (`post_group_id`: one post written per platform), and — from the Content Studio — format,
  plan day, media prompt, carousel slides, brand kit.
- Statuses: `draft, generating, review, approved, scheduled, publishing, published, rejected, failed, cancelled`
  (the spec's list maps 1:1: *Ready for Review* = `review`).

### 1.3 AI Content Studio (built on this branch, uncommitted)
- Provider-independent AI: text via `services/aiEngine` (Groq, OpenAI, OpenRouter, Gemini, Ollama); images
  (OpenAI Images with reference images, FLUX), video (Runway, asynchronous, polled), voice (ElevenLabs),
  FFmpeg video editing — `lib/aiMedia.js`, `lib/videoTools.js`.
- `social_content_generations`: every AI generation = job + provider record + credit log; one request key per
  click (no double runs or charges), credits charged once on success, monthly limit, confirmation for
  expensive jobs, retry.
- Brand Kits (`social_brand_kits`), posters, videos (intro/outro, music, subtitles, voice-over, scene
  replacement), carousels, platform posts, a multi-day planner, image editor, AI usage report.

### 1.4 Accounts, publishing, scheduling
- `social_accounts`: Facebook Pages, Instagram Business, LinkedIn Organizations, YouTube channels (OAuth,
  encrypted tokens, scope checks per feature in `capabilities.js`, health checks, expired-token detection).
  LinkedIn **personal** profiles are not supported today.
- `publishing_jobs` / `publishing_attempts`: idempotency key per post and account, claimed by the worker,
  retries with backoff, rate-limit handling, "unknown outcome" sent to a person instead of retried, platform
  post ID and URL stored, *published* only after the platform confirms. Preflight validates the account,
  permissions, media format, dimensions, duration and caption length (`platformRules.js`).
- Approval: workspace setting "approval required"; schedule/publish refuse unapproved content.
- Calendar: month / week / day / list, filters (platform, account, campaign, status), drag-to-reschedule,
  thumbnails.

### 1.5 Media
- `assets` on the server's disk (`SOCIAL_MEDIA_STORAGE_DIR`), unguessable 256-bit public ids, content-checked
  uploads (JPEG/PNG/WebP/MP4/MOV, MP3 music only via the Studio), workspace quota; AI and edited files are
  marked and linked to their original. No S3 is configured.

### 1.6 Analytics
- `social_metric_snapshots`: per post impressions, reach, views, likes, comments, shares, saves, clicks, average
  watch time — from the platform APIs, each marked available / unavailable with the reason; demo accounts are
  never shown as live. Summary by platform and by campaign, CSV export.
- **Leads per campaign are not tracked**: leads have `product_id` but no campaign link; the Engagement Inbox can
  create a lead from a comment/DM thread, without recording the campaign.

### 1.7 Security and permissions
- Workspace from the session on every route; capabilities: `campaigns.manage`, `content.create`,
  `content.approve`, `content.publish`, `analytics.view`, `integrations.manage` (roles: Owner, Admin, Marketing
  Manager, Approver, …). Background jobs carry and re-check their workspace.

---

## 2. Reuse map (spec item → existing piece)

| Spec | Reused | New work |
|---|---|---|
| Select Product | `digital_products`, `/api/v1/products` | category + images on products; picker cards, search, filter, details |
| Campaign Details | `campaigns` (all 13 fields exist except a description column) | `campaigns.description`; wizard form; draft save / resume |
| AI Strategy | `generateStructured`, product facts, claim check | strategy schema (theme, message, concepts, schedule, hashtags, CTAs); editable idea list; accept |
| Generate Content (posters, videos, carousels, posts, stories) | Content Studio generators, Brand Kit | product context and product images as references; content tabs per campaign; stories (9:16 posters) |
| Review & Edit | content items, versions, approvals, image editor, video editing | review board (cards with preview, status, actions); image colour adjustments, AI background replacement |
| Schedule & Publish | calendar, publishing queue, preflight, platform groups | campaign filter as default; "approve all ready" helper |
| Analytics | `social_metric_snapshots`, campaign/platform summaries | campaign dashboard (content funnel + metrics), post detail drill-down, lead attribution |
| Credits | `social_content_generations`, usage report | product id + campaign id on every record |

## 3. Data model changes (one reversible migration, no new product or campaign tables)

| Change | Why |
|---|---|
| `digital_products.category VARCHAR(100)`, `digital_products.image_asset_ids_json TEXT` | Product cards and AI reference images; images are media-library assets of the same workspace |
| `campaigns.description TEXT`, `campaigns.strategy_json LONGTEXT`, `campaigns.wizard_step VARCHAR(20)` | Campaign description; the AI strategy and its idea list before acceptance; resume where the user left |
| `social_content_generations.product_id INT` (+ index) | Every AI record linked to workspace, user, campaign **and product** |
| `content_items.product_id INT` (+ index), set from the campaign | Content linked to product directly (filters, analytics) |

The spec's suggested tables are already covered: *campaign content items* = `content_items`; *generations* and
*video jobs* = `social_content_generations`; *versions* = `content_versions`; *approvals* = `approval_requests`.

## 4. API plan (extend existing routes)

- `GET /api/v1/products?search=&category=` (+ `categories`), product images on detail/create/edit.
- `/api/v1/social/campaigns`: create/update accept `description`, `wizardStep`; `GET /campaigns/:id/overview`
  (product, strategy, content counts by status, generations, readiness of each step).
- `POST /api/v1/social/studio/campaigns/:id/strategy` (generate / regenerate), `PUT …/strategy` (edit ideas),
  `POST …/strategy/accept` (creates the draft content items; no media is generated).
- Studio generators accept `campaignId`; product facts and product images come from the campaign's product
  (server side, never from the browser). New `story` purpose (9:16).
- `GET /api/v1/social/studio/campaigns/:id/analytics` (content funnel + platform metrics; no leads), post drill-down reuses the
  content detail.

## 5. UI plan (Social → Campaigns)

A guided wizard with a progress bar (steps clickable once reached; everything saves as Draft):
1. **Select Product** — product cards (image, name, short description, category, features, status), search,
   category filter, details drawer, "Continue".
2. **Campaign Details** — the 13 fields, objective and tone options from the spec, platforms limited to
   connected accounts, "Save draft" / "Continue".
3. **AI Strategy** — "Generate AI Campaign Strategy"; strategy summary, concepts per format, day-by-day idea
   table (edit, remove, add, regenerate), hashtags and CTAs; "Accept strategy".
4. **Generate Content** — tabs Posters · Videos · Carousels · Posts · Stories, each pre-filled from the accepted
   ideas and the product; variations to choose from; estimate and confirmation.
5. **Review & Approve** — visual cards (preview, title, product, campaign, type, platform, generation and
   approval status) with Preview, Edit, Regenerate, Duplicate, Delete, Approve, Schedule.
6. **Schedule & Publish** — the existing calendar filtered to the campaign, publish now / schedule / reschedule.
7. **Analytics** — campaign dashboard and per-post drill-down.

The existing campaign list stays (opening a campaign resumes its wizard); the manual "new campaign" form and
the Content Studio remain available.

## 6. Decisions needed before implementation

1. **Product images and category**: add them to the existing Digital Products page (upload images to the media
   library, pick a category) — recommended. Alternative: pick product images only inside the campaign wizard.
2. **Strategy before acceptance**: keep ideas inside the campaign (`strategy_json`) and create posts only on
   *Accept* — recommended (nothing appears in the calendar until accepted).
3. **Background replacement** in the image editor: needs an AI image edit (OpenAI image edits; uses credits) —
   recommended; colour adjustments (brightness, contrast, saturation) are done in the browser for free.
4. **Leads generated**: record the campaign on leads created from the Engagement Inbox for a campaign post, and
   tag campaign links with `utm_campaign=mkt-<id>` so website leads can be matched when your site passes it on —
   recommended. Without this, "Leads generated" shows as *not tracked*, never as 0.
5. **LinkedIn personal accounts**: not supported by the current LinkedIn connection (organisation pages only);
   adding them needs the `w_member_social` permission on your LinkedIn app. Keep pages only for now?
6. **Sharp** (server image processing): not installed. Image edits run in the browser and AI edits through the
   provider, so Sharp is not needed now. Add it only if you want server-side resizing per platform.

## 7. Phases (after review)

2 Product selection and campaign wizard · 3 AI strategy · 4 Posters, carousels, posts, stories with product
context · 5 Video in the campaign flow · 6 Review board, calendar and publishing · 7 Campaign analytics and AI
usage per campaign/product. Each phase: migrations, backend and frontend tests (mocked AI and social APIs),
full test suites and production build, report.

## 8. Known risks
- Real AI providers and social publishing are tested with mocks only; try one of each on staging.
- The test database grows with every run (two admin tests list all workspaces and slow down); reset it when needed.


---

## 9. Implementation report (Phases 2–7)

### Features
- **Social → Campaigns** is now the product campaign wizard (the old brief form and the separate "Campaign Planner" were
  replaced; existing campaigns open in the wizard). Steps with a progress bar, each saved on the server:
  1. **Select Product** — cards from Digital Products (image when available, name, short description, category, first
     features, status), search, category filter, details drawer.
  2. **Campaign Details** — the 13 fields; objective and tone options; platforms limited to connected accounts; the
     product's images for this campaign (upload or pick from the library); *Save draft* / *Save & continue*.
  3. **AI Strategy** — strategy, theme, message, audiences, content themes, formats and post count, poster/video/reel/
     carousel concepts, schedule, hashtags, CTAs and a day-by-day idea table; edit, add, remove, regenerate (with a
     direction), accept. Claims not in the product's facts are flagged; missing product details are listed. No media.
  4. **Generate Content** — tabs Posters · Videos & Reels · Carousels · Social Posts · Stories; each planned post can be
     created from its idea (media attached to it as a new version) or anything new for the campaign. The server adds the
     product's facts and images (references for posters, start frame for videos).
  5. **Review & Approve** — cards with preview, title, product, campaign, type, platform, generation and approval status;
     Approve, Edit, ↻ Media, ↻ Text, Duplicate, Delete, preview dialog, "Approve all with media".
  6. **Schedule & Publish** — per approved post: account (connected only), date and time, Schedule / Publish now,
     Unschedule, link to the post on the platform, errors; "Open the calendar" filtered to the campaign.
  7. **Analytics** — generated / approved / scheduled / published, reach, impressions, likes, comments, shares and clicks
     from the platforms (unavailable shown as unavailable), by platform, published posts (open a post), AI credits.
     No leads (they belong to email campaigns).
- **Image editor:** brightness, contrast and saturation; AI background replacement (cost shown, new copy).

### Database (migration `048_product_campaigns`, reversible)
`digital_products.category`, `digital_products.image_asset_ids_json` (API only; the Products page is unchanged),
`campaigns.description`, `strategy_json`, `wizard_step`, `image_asset_ids_json`, `content_items.product_id`,
`social_content_generations.product_id`.

### APIs
- `GET /api/v1/products?search=&category=&status=`, `GET /api/v1/products/categories`.
- `/api/v1/social/campaigns`: `description`, `wizardStep`, `imageAssetIds` (checked against the workspace's library).
- `/api/v1/social/studio`: `GET campaigns/:id/overview`, `POST|PUT campaigns/:id/strategy`, `POST campaigns/:id/strategy/accept`,
  `GET campaigns/:id/analytics`, `POST ai/background`; generators take `campaignId` (+ `contentItemId`) and record the
  product. Removed: `POST /planner` (replaced by the strategy step).

### Tests
Backend `tests/productCampaigns.test.js` (mocked AI): products search/filter and isolation, campaign draft with product and
images (foreign product/image refused), strategy grounded in product facts with claim flags, edit/add/remove, accept once,
nothing published, product-aware posters/stories/carousels/posts, AI background, overview, analytics without leads.
Frontend `campaign-wizard.spec.ts`: product picker, details draft, strategy edit and accept, review approve, analytics.

## 10. Product-first fix (no free-text product)

- The AI Content Generator no longer has "Product or service" fields. **Every** AI generation (posts, posters, stories,
  carousels, videos) requires a campaign with a selected Digital Product (`CAMPAIGN_REQUIRED` / `PRODUCT_REQUIRED`);
  the product's database record (name, description, features, pricing, audience, images) is read on the server and is
  the only product context. A product typed into a request is ignored.
- Social → **AI Content Generator** and the Overview's create buttons open product selection first; **Campaigns** too.
- Wizard steps: Select Product → **Review Product** (image, name, description, features and benefits, website;
  *Continue to Create Campaign* / *Change Product*) → Campaign Details (selected product read-only, *Change product*) →
  AI Strategy → Generate Content → Review & Approve → Schedule & Publish → Analytics. The selected product is shown in the
  wizard header throughout.
- Changing a campaign's product: allowed until any post is scheduled or published (`PRODUCT_LOCKED` after); needs
  confirmation when a strategy or posts exist (`CONFIRM_PRODUCT_CHANGE`); a draft strategy is cleared; posts already made
  keep the product they were made for. Product ownership is checked on the server.
- No new tables or product APIs: products come from `GET /api/v1/products` (existing); campaigns keep `product_id`.

## 11. AI Campaign Strategy and Generate All Content

### Audit (what was reused)
Product selection and review, campaign details (draft), the strategy step, every generator (posters, stories,
videos/reels, carousels, platform posts), `social_content_generations` (job + credits + history), background jobs,
`attachToContent` (media as a new post version), the review board, scheduling and publishing guards, analytics.

### What changed
- **Campaign details:** duration 7 / 14 / 30 days / custom (sets the end date); details save themselves as a draft.
  Objectives in the order of the spec.
- **Strategy (structured):** A overview (theme, objective, main message, audience, unique selling points from the
  facts only, approach) · B content mix (posts, posters, videos, reels, carousels, stories) · C platform strategy ·
  D publishing (frequency, best times, sequence, notes) · E messages (headline, supporting, promotional, CTAs,
  hashtags). The product's images are part of the analysis. Unsupported claims are flagged; missing details listed.
- **Content plan items:** title, description, objective, type, **several platforms**, day → date, time, image prompt,
  video prompt, caption, hashtags, CTA, media format. Edit, add, delete, reorder, change type/platforms/date,
  **regenerate one item** (`POST /campaigns/:id/strategy/items/:ideaId/regenerate`), or **Regenerate Strategy**.
  **Approve Strategy** creates one draft post per item and platform (an item's posts share a post group). No paid
  media before approval.
- **Generate All Content** (`bulkService.js`, job `studio_bulk`):
  - estimate by type, per item and in total, against the **available balance** (monthly limit − charged − reserved);
    confirmation; refused when not enough credits;
  - one unit per planned item: posters/stories (image, story 9:16), videos/reels (product image as start frame),
    carousels (copy + slide images), posts (one call writes the post for every platform of the item);
    media of one item is shared with its posts on the other platforms (generated and charged once);
  - progress persisted (`social_content_generations.batch_key` + the run in `strategy_json.bulk`); a second click or a
    refresh returns the active run; items that already have content are never generated again;
  - per item: retry (failed), cancel (queued), view, regenerate; cancel the rest of a run.
- **Credits:** generations still queued or running **reserve** their estimated credits; failed and canceled ones are
  never charged and release the reservation; completed ones are charged once (actual provider cost when configured).
- **Versions:** regenerating one post makes a new version and keeps the previous file; `GET /content/:id/generations`
  lists each version with provider, model, prompt, credits/cost, status and files.
- **Review:** filters (all, posters, videos, reels, carousels, posts, stories, needs review, approved, failed), select and
  approve several, hashtags and planned date on cards, download, versions.
- **Schedule:** "Schedule all approved at the planned times" (connected accounts checked; existing publishing guards).
- **Analytics:** planned, generated, approved, scheduled, published, failed; comparison by content type and platform.
  Leads are not shown for social campaigns (decided earlier: leads belong to email campaigns).

### Database
Migration `049_bulk_generation`: `social_content_generations.batch_key` (+ index); status `canceled` for generations.

### APIs (under `/api/v1/social/studio`)
`GET campaigns/:id/bulk/estimate`, `POST campaigns/:id/bulk` (`{confirm}`), `GET campaigns/:id/bulk`,
`POST campaigns/:id/bulk/cancel` (`{itemId?}`), `POST campaigns/:id/bulk/items/:itemId/retry`,
`POST campaigns/:id/strategy/items/:ideaId/regenerate`, `POST generations/:id/cancel`, `GET content/:id/generations`.

### Known limitations
- Real providers are still exercised only with mocks; try a small campaign on staging first.
- A generation already processing cannot be canceled (the provider is working on it); it finishes and is charged.
- Credits are Marketech.ai units against a monthly workspace limit (no separate prepaid wallet exists).
