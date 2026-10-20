# Social Media Marketing Hub

Operator and developer guide for the Social Media Marketing module (`/api/v1/social`, Angular `features/social`).

## 1. Run it

```bash
cd backend
npm install
npm run migrate          # applies backend/migrations/* to DB_NAME (idempotent, additive)
npm run set-password -- admin@tradesage.ai   # the seeded admin has no usable password until you set one
npm start                # API + built frontend on http://localhost:8000
npm run worker           # REQUIRED for publishing, AI campaign generation, analytics and comment sync
npm test                 # backend tests against the tradesage_test database (never DB_NAME)
```

Frontend development: `cd frontend && npm install && npm start` (http://localhost:4200, API on :8000). Production build: `npm run build:frontend` from the repository root.

`start.bat` / `run.ps1` now run migrations and open the worker in a second window.

The worker is a separate process. It polls MySQL (`publishing_jobs`, `background_jobs`); there is no Redis or BullMQ dependency. Run exactly one worker under a process manager (pm2, systemd, a Windows service) in production. Several workers are safe because jobs are claimed atomically, but they are not needed at this scale.

## 2. Required configuration

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs session tokens (≥ 32 chars). Mandatory when `NODE_ENV=production`. |
| `SOCIAL_TOKEN_ENCRYPTION_KEY` | 32 random bytes (base64). AES-256-GCM key for OAuth tokens and mailbox passwords. **Back it up; changing it makes stored tokens unreadable.** |
| `APP_BASE_URL` | Public API origin. OAuth redirect URLs are `APP_BASE_URL/api/v1/social/oauth/<provider>/callback`. Must be HTTPS for real providers. |
| `FRONTEND_URL` | Browser origin (CORS + where OAuth returns the user). |
| One AI key (`GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) or a local Ollama | Campaign generation, regeneration, inbox triage, Roger strategist. Without one these features fail with a clear message; no template content is substituted. |

All variables are listed with comments in `backend/.env.example`.

## 3. Provider app setup

No customer ever gives TradeSage a social media password. Each business connects through the provider's OAuth consent screen.

**Where app credentials come from.** Each provider needs a developer app (an App ID and App Secret).
- **Per workspace (default).** In *Social Media Marketing → Connected Accounts*, a workspace owner or admin clicks **Set up** on a provider card. They follow the in-app steps and paste their own app credentials. The secret is encrypted in `provider_apps` and never returned to the browser. Meta credentials are verified with Meta when saved.
- **Platform default (optional).** If `META_APP_ID`/`META_APP_SECRET` (or the LinkedIn/Google equivalents) are set in the server environment, workspaces without their own app use that shared app. For a SaaS product this is the lowest-friction option, because customers just click Connect. It does require your app to pass each provider's review.

Until a workspace has an app (its own or the platform's), the provider shows **Setup required** and never simulates a connection. The steps below match the in-app setup guide.

### Meta: Facebook Pages + Instagram Professional accounts

1. Create a **Business** app at developers.facebook.com and add **Facebook Login for Business**.
2. Valid OAuth redirect URI: `https://<your-domain>/api/v1/social/oauth/meta/callback`.
3. Permissions requested: `pages_show_list, pages_read_engagement, pages_manage_posts, pages_read_user_content, pages_manage_engagement, read_insights, business_management, instagram_basic, instagram_content_publish, instagram_manage_comments, instagram_manage_insights`.
4. Until **App Review** approves these permissions, only users with a role on the app (admins, developers, testers) can connect. Business Verification is required for Advanced Access.
5. Instagram must be a **Professional** (Business or Creator) account linked to a Facebook Page the connecting user manages.
6. Paste the App ID and App Secret into **Set up** (or set `META_APP_ID`/`META_APP_SECRET` as the platform default). `META_GRAPH_VERSION` (default `v23.0`) is a server setting.
7. Optional webhooks (faster comment sync): subscribe the Page to `feed` at `https://<your-domain>/api/v1/social/webhooks/meta` with `META_WEBHOOK_VERIFY_TOKEN`. Payloads are verified with `X-Hub-Signature-256` and de-duplicated.

Media must be on a public **HTTPS** URL that Meta can fetch. Instagram rejects text-only posts.

### LinkedIn Pages

1. Create an app at linkedin.com/developers, associate it with your LinkedIn Page, and request the **Community Management API** product. This needs LinkedIn's approval.
2. Redirect URL: `https://<your-domain>/api/v1/social/oauth/linkedin/callback`.
3. Scopes: `r_organization_social, w_organization_social, rw_organization_admin`. The connecting member must be a Page admin.
4. Paste the Client ID and Client Secret into **Set up** (or set `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET` as the platform default). `LINKEDIN_API_VERSION` (format `YYYYMM`; LinkedIn retires versions after about a year, so keep it current).
5. Access tokens last about 60 days. Refresh tokens are issued only to apps LinkedIn enables for them. Otherwise the hub warns before expiry and the account must be reconnected.

### YouTube

1. In Google Cloud, enable **YouTube Data API v3** and create an OAuth 2.0 **Web application** client.
2. Authorized redirect URI: `https://<your-domain>/api/v1/social/oauth/youtube/callback`.
3. Scopes: `youtube.readonly`, `youtube.force-ssl`. Sensitive scopes need Google OAuth verification before public use.
4. Paste the Client ID and Client Secret into **Set up** (or set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` as the platform default). Data API quota is 10,000 units/day by default.

### X (Twitter)

Not integrated: API access requires a paid X plan. Drafts can be copied for manual posting and are never marked as published.

## 4. How it works

- **Tenancy.** Every route resolves the user, workspace membership and capabilities from the session token on each request. All social tables carry `workspace_id`, and publishing jobs, metrics and threads use composite `(workspace_id, id)` foreign keys, so cross-tenant references fail in the database itself.
- **Legacy modules.** Leads, mail, drafts, products, voice and appointments still use workspace 1 internally. They are now closed to members of any other workspace (`MODULE_NOT_TENANT_AWARE`) until migrated.
- **Permissions.** Capabilities (`content.approve`, `content.publish`, `integrations.manage`, …) are mapped from roles in `backend/lib/permissions.js` and checked on the server.
- **Content workflow.** `draft → review → approved → scheduled → publishing → published`, with `rejected`, `failed` and `cancelled` as alternatives.
  - Edits create a new version and invalidate approval. Approval is tied to a version.
  - Only the worker sets `published`, and only after the provider returns a post ID.
- **Duplicate prevention.**
  - Each publication has a unique idempotency key (content version + account).
  - Jobs are claimed atomically, and a job with a recorded provider ID is never re-sent.
  - Network failures after a request was sent, and worker crashes mid-publish, put the job in `needs_review` ("Check platform"). It is retried only after a person confirms the post is not on the platform.
- **Retries.** Provider 5xx errors and rate limits are retried with backoff (honouring `Retry-After`), up to 3 attempts. Auth and permission errors fail immediately and flag the account as `expired` or `permission_error`.
- **Time zones.** Users pick a local time and an IANA zone. UTC is stored alongside the original zone. Wall times skipped by a daylight-saving change are rejected.
- **Analytics.** Snapshots record the metric, value, availability, reason, source and collection time. Metrics a provider does not return are `unavailable`; posts not yet synced are `not_collected`. Neither is ever shown as zero.
- **AI.**
  - All generation uses the shared `aiEngine` through `lib/aiStructured.js`, with output validated by zod schemas.
  - A monthly per-workspace request cap applies, and every call is recorded in `usage_ledger`.
  - Website and comment text is passed as untrusted data, and the model can't trigger any tools.
  - Prices and statistics that are not in the supplied facts are flagged on the draft for human verification.
- **Inbox.** AI classifies comments and drafts replies. Replies are sent only by a user with `inbox.reply`. Automatic replies are not available.
- **Security.**
  - OAuth state is single-use, expires after 10 minutes, is stored as a hash and is bound to the user and workspace. YouTube also uses PKCE.
  - Tokens are encrypted at rest and never returned to the browser or written to logs; audit metadata is redacted.
  - Website and media fetching blocks private, loopback, link-local and metadata addresses at connect time.

## 5. Costs and limits to plan for

| Item | Notes |
|---|---|
| Provider APIs | Meta, LinkedIn and YouTube APIs have no direct fee, but need app review/verification and enforce rate limits and quotas. The X API is paid. |
| AI | Each campaign generation is one large model call. Each regeneration, comment classification, reply draft or strategist question is one call. Capped by `SOCIAL_AI_MONTHLY_REQUEST_LIMIT`. |
| Hosting | One API process + one worker process + MySQL. HTTPS and a public domain are required for OAuth redirect URLs and for platforms to fetch media. |
| Image/video generation | Not configured, so no paid provider was added. Users attach their own public media URLs. |

## 6. Feature checklist

**Implemented and tested** (automated tests with mocked provider and AI responses; these are not live provider tests):
- Authentication on all API routes, workspace isolation, capability checks, removed shell endpoints, SSRF guard, CORS allow-list, auth rate limiting.
- OAuth start/callback: state validation, replay, expiry and cross-provider rejection; encrypted token storage; Meta Page + Instagram discovery; disconnect with revocation; LinkedIn token refresh; expired-token handling.
- Content CRUD, versions, submit/approve/reject, approval invalidation on edit, platform validation, scheduling with time-zone conversion, publish now, unschedule, cancel.
- Publishing worker: Facebook text/link/photo, Instagram image (container → publish), success only on provider confirmation, unknown-outcome handling, retry/backoff, rate limits, crash recovery, atomic claiming.
- Campaign builder: saved brief → queued generation with real product facts, schema validation, honest failure without AI, unverified-claim flags, suggested schedule.
- Analytics snapshots and summary (available / unavailable / not collected), Roger strategist grounded in retrieved data, inbox sync / classify / suggest / send / create lead.
- Migrations: idempotent re-application; tenant foreign keys enforced.

**Implemented but not live-tested against providers.** No provider app credentials were available. Each needs a real connection before it's relied on:
- Meta: connect, publish (Facebook + Instagram), insights, comments, replies, webhooks.
- LinkedIn: connect, text/link posts, share statistics, follower count, comments.
- YouTube: connect, channel statistics, comment threads, replies.

**Blocked by credentials or approval:** every live provider connection (Meta App Review, the LinkedIn Community Management API product, Google OAuth verification).

**Not implemented:**
- Image and video generation; LinkedIn image posts; Instagram Reels; YouTube upload; carousels.
- Messenger and Instagram DMs; X API.
- Drag-and-drop calendar rescheduling (reschedule from the post editor instead).
- Automatic AI replies (deliberately excluded).
- Billing integration.
- Tenant-aware versions of the legacy modules.

## 7. Known limitations / next milestone

1. Make the legacy modules (leads, mail, drafts, products, voice, appointments) tenant-aware and remove the workspace 1 restriction.
2. Media uploads to object storage with signed URLs. Today media must already be hosted on a public HTTPS URL.
3. Video Studio rendering (FFmpeg), then Reels and YouTube publishing.
4. Move sessions to HttpOnly cookies with CSRF protection; add password reset and email verification.
5. Rate limiting and quota reservations are in-process; move them to Redis when running more than one API instance.
6. Telnyx voice webhooks are public and not yet signature-verified.
