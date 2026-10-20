/**
 * Creates (or removes) an isolated DEMO workspace with clearly labelled sample data,
 * so the Command Center and Social Media Marketing hub can be explored without real accounts.
 *
 *   npm run seed:demo              create the demo workspace (prints the demo login once)
 *   npm run seed:demo -- --reset   delete and recreate it
 *   npm run seed:demo -- --remove  delete it
 *
 * Safety:
 * - Only ever creates/deletes rows belonging to the workspace with slug DEMO_SLUG.
 * - Existing workspaces are never modified. Product facts are copied (read-only) from workspace 1.
 * - Accounts use external ids starting with "demo_": the worker never syncs them and
 *   publishing to them is refused, so no request ever reaches a real provider.
 * - Every metric snapshot has source "demo_seed"; the dashboard shows a demo-data banner.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const crypto = require('crypto');
const { run, get, all, closeDatabase } = require('../db/database');
const { hashPassword } = require('../services/authService');
const secretBox = require('../lib/secretBox');

const DEMO_SLUG = 'tradesage-demo-workspace';
const DEMO_EMAIL = 'demo@tradesage.ai';
const DAY = 86400000;

// Deterministic pseudo-random numbers so re-seeding gives the same sample data.
let seed = 20261020;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
const db = d => new Date(d).toISOString().replace('T', ' ').substring(0, 19);

async function findDemo() {
  return get('SELECT id FROM workspaces WHERE slug = ?', [DEMO_SLUG]);
}

async function removeDemo() {
  const ws = await findDemo();
  if (!ws) {
    console.log('No demo workspace found.');
    return false;
  }
  const id = ws.id;
  const tables = [
    'engagement_messages', 'engagement_threads', 'social_metric_snapshots', 'publishing_attempts', 'publishing_jobs',
    'content_versions', 'approval_requests', 'content_items', 'assets', 'social_accounts', 'provider_credentials',
    'provider_apps', 'oauth_states', 'background_jobs', 'campaigns', 'leads', 'digital_products', 'business_profiles',
    'social_settings', 'usage_ledger', 'audit_logs'
  ];
  for (const t of tables) {
    const exists = await get('SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]);
    if (exists) await run(`DELETE FROM \`${t}\` WHERE workspace_id = ?`, [id]);
  }
  const members = await all('SELECT user_id FROM workspace_members WHERE workspace_id = ?', [id]);
  await run('DELETE FROM workspace_members WHERE workspace_id = ?', [id]);
  for (const m of members) {
    const other = await get('SELECT id FROM workspace_members WHERE user_id = ? LIMIT 1', [m.user_id]);
    if (!other) await run('DELETE FROM users WHERE id = ? AND email = ?', [m.user_id, DEMO_EMAIL]);
  }
  await run('DELETE FROM workspaces WHERE id = ? AND slug = ?', [id, DEMO_SLUG]);
  console.log(`Removed demo workspace #${id}.`);
  return true;
}

async function createDemo() {
  if (await findDemo()) {
    console.log('Demo workspace already exists. Use --reset to recreate it.');
    return;
  }
  if (!secretBox.isConfigured()) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must be set.');
  const now = Date.now();

  // Workspace + login
  const existingUser = await get('SELECT id FROM users WHERE email = ?', [DEMO_EMAIL]);
  if (existingUser) throw new Error(`${DEMO_EMAIL} already exists outside the demo workspace; not touching it.`);
  const password = `Demo-${crypto.randomBytes(6).toString('base64url')}`;
  const user = await run(
    "INSERT INTO users (email, password_hash, display_name, status, email_verified_at, created_at, updated_at) VALUES (?, ?, 'Demo Owner', 'Active', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [DEMO_EMAIL, hashPassword(password)]
  );
  const ws = await run(
    "INSERT INTO workspaces (name, slug, owner_email, plan, status, timezone, created_at) VALUES ('DEMO · Sample Workspace', ?, ?, 'Professional', 'Active', 'UTC', UTC_TIMESTAMP())",
    [DEMO_SLUG, DEMO_EMAIL]
  );
  const W = ws.lastID;
  await run("INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, 'Workspace Owner', 'Active', UTC_TIMESTAMP())", [W, user.lastID]);
  await run(
    "INSERT INTO business_profiles (workspace_id, business_name, industry, website_url, description, products_json, brand_voice, created_at) VALUES (?, 'DEMO · Sample Distributor Tech', 'B2B Software', 'https://thrivewoo.com', 'Sample business profile for the demo workspace.', '[]', 'Professional and practical', UTC_TIMESTAMP())",
    [W]
  );
  await run("INSERT INTO social_settings (workspace_id, timezone, require_approval, created_at) VALUES (?, 'UTC', 1, UTC_TIMESTAMP())", [W]);

  // Real product facts copied from the main workspace (read-only on the source).
  const sourceProducts = await all('SELECT name, url, tagline, description, features_json, target_audience FROM digital_products WHERE workspace_id = 1 ORDER BY id LIMIT 3');
  const products = [];
  for (const p of sourceProducts) {
    const ins = await run(
      "INSERT INTO digital_products (workspace_id, name, url, tagline, description, features_json, target_audience, pricing_tiers_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'Active', UTC_TIMESTAMP())",
      [W, p.name, p.url, p.tagline, p.description, p.features_json, p.target_audience]
    );
    products.push({ id: ins.lastID, name: p.name });
  }

  // Social accounts (demo_ ids: never synced, publishing refused).
  const accountDefs = [
    { key: 'fb', provider: 'meta', type: 'facebook_page', name: 'DEMO · ThriveWoo Facebook Page', platform: 'facebook', followers: [2310, 2480],
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_engagement', 'read_insights'] },
    { key: 'ig', provider: 'meta', type: 'instagram_business', name: 'DEMO · thrivewoo.app (Instagram)', platform: 'instagram', followers: [1180, 1342], username: 'thrivewoo.demo',
      scopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'] },
    { key: 'li', provider: 'linkedin', type: 'linkedin_organization', name: 'DEMO · ThriveWoo LinkedIn Page', platform: 'linkedin', followers: [860, 925],
      scopes: ['r_organization_social', 'w_organization_social', 'rw_organization_admin'] }
  ];
  const accounts = {};
  for (const a of accountDefs) {
    const cred = await run(
      'INSERT INTO provider_credentials (workspace_id, provider_key, secret_ciphertext, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())',
      [W, a.provider, secretBox.encryptJson({ access_token: 'demo-not-a-real-token', demo: true })]
    );
    const ins = await run(
      `INSERT INTO social_accounts (workspace_id, provider_key, account_type, external_account_id, display_name, username, credential_id, scopes_json,
         status, status_detail, last_success_at, last_checked_at, metadata_json, app_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', 'Demo account with sample data — not linked to a real provider.', UTC_TIMESTAMP(), UTC_TIMESTAMP(), '{"demo":true}', 'platform', UTC_TIMESTAMP())`,
      [W, a.provider, a.type, `demo_${a.key}_${W}`, a.name, a.username || null, cred.lastID, JSON.stringify(a.scopes)]
    );
    accounts[a.platform] = { id: ins.lastID, ext: `demo_${a.key}_${W}`, ...a };
    // Follower snapshots 35 days ago and today (growth over the period).
    for (const [i, when] of [[0, now - 35 * DAY], [1, now - 2 * 3600 * 1000]]) {
      await run(
        `INSERT INTO social_metric_snapshots (workspace_id, social_account_id, external_object_id, object_type, metric_key, metric_value, availability, period, source, collected_at)
         VALUES (?, ?, ?, 'account', 'followers', ?, 'available', 'lifetime', 'demo_seed', ?)`,
        [W, ins.lastID, `demo_${a.key}_${W}`, a.followers[i], db(when)]
      );
    }
  }

  // Campaigns
  const campDefs = [
    { name: 'DEMO · Van Sales Q4 Launch', objective: 'Lead generation', status: 'Active', platforms: ['facebook', 'instagram', 'linkedin'], start: -28, end: 20, product: 0 },
    { name: 'DEMO · Offline Ordering Awareness', objective: 'Awareness', status: 'Completed', platforms: ['facebook', 'linkedin'], start: -60, end: -31, product: 0 },
    { name: 'DEMO · Distributor Webinar Invite', objective: 'Demo bookings', status: 'Draft', platforms: ['linkedin'], start: 7, end: 30, product: 1 }
  ];
  const campaigns = [];
  for (const c of campDefs) {
    const ins = await run(
      `INSERT INTO campaigns (workspace_id, name, objective, status, source, platforms_json, channels, product_id, start_date, end_date,
         key_message, generation_status, brief_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'social_hub', ?, ?, ?, ?, ?, 'Book orders on the route, even offline.', 'completed', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [W, c.name, c.objective, c.status, JSON.stringify(c.platforms), c.platforms.join(', '), products[c.product]?.id || null,
        db(now + c.start * DAY).slice(0, 10), db(now + c.end * DAY).slice(0, 10),
        JSON.stringify({ summary: 'Sample campaign brief (demo data).', key_messages: ['Offline order booking', 'Live stock on every route'], missing_information: [], provider: 'demo_seed' })]
    );
    campaigns.push({ id: ins.lastID, ...c });
  }

  // Posts: published (current + previous 30-day period), scheduled, in review, approved, draft, failed.
  const captions = [
    'Your reps can book orders with zero signal and sync when back online.',
    'Live warehouse stock on every route stop — no more promising what is not on the truck.',
    'End-of-day cash reconciliation in two taps.',
    'Customer-specific pricing, right on the handheld.',
    'Route planning that drivers actually use.',
    'Barcode scan to invoice in under 15 seconds.',
    'Every van becomes a mobile showroom with a live catalogue.',
    'Bulk-import your customer list from Excel in minutes.'
  ];
  let ci = 0;
  const mkPost = async ({ platform, campaign, status, daysAgo = null, daysAhead = null }) => {
    const acct = accounts[platform];
    const caption = captions[ci++ % captions.length];
    const publishedAt = daysAgo !== null ? db(now - daysAgo * DAY - between(1, 10) * 3600000) : null;
    const scheduledAt = daysAhead !== null ? db(now + daysAhead * DAY) : null;
    const ext = status === 'published' ? `demo_post_${platform}_${W}_${ci}` : null;
    const ins = await run(
      `INSERT INTO content_items (workspace_id, campaign_id, platform, platform_key, social_account_id, title, caption_text, hashtags, call_to_action,
         status, version, published_at, scheduled_at, schedule_timezone, external_post_id, last_error, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '#FMCG #VanSales #Distribution', 'Book a demo', ?, 1, ?, ?, ?, ?, ?, 'demo_seed', ?, UTC_TIMESTAMP())`,
      [W, campaign?.id || null, platform, platform, acct.id, caption.slice(0, 48), caption, status, publishedAt, scheduledAt,
        scheduledAt ? 'UTC' : null, ext, status === 'failed' ? 'Demo: sample failed publication (no real request was made).' : null,
        db(now - (daysAgo ?? 3) * DAY - DAY)]
    );
    return { id: ins.lastID, ext, platform, acct, publishedAt };
  };

  const published = [];
  const active = campaigns[0];
  const completed = campaigns[1];
  for (const [platform, days] of [['facebook', [2, 6, 11, 17, 24]], ['instagram', [3, 9, 15, 22]], ['linkedin', [4, 13, 26]]]) {
    for (const d of days) published.push(await mkPost({ platform, campaign: active, status: 'published', daysAgo: d }));
  }
  for (const [platform, days] of [['facebook', [34, 41, 49]], ['linkedin', [38, 52]]]) {
    for (const d of days) published.push(await mkPost({ platform, campaign: completed, status: 'published', daysAgo: d }));
  }
  const scheduled = [await mkPost({ platform: 'facebook', campaign: active, status: 'scheduled', daysAhead: 2 }),
    await mkPost({ platform: 'linkedin', campaign: active, status: 'scheduled', daysAhead: 5 })];
  await mkPost({ platform: 'instagram', campaign: active, status: 'review' });
  await mkPost({ platform: 'linkedin', campaign: campaigns[2], status: 'review' });
  await mkPost({ platform: 'facebook', campaign: active, status: 'approved' });
  await mkPost({ platform: 'linkedin', campaign: campaigns[2], status: 'draft' });
  await mkPost({ platform: 'instagram', campaign: null, status: 'draft' });
  const failed = await mkPost({ platform: 'instagram', campaign: active, status: 'failed' });

  // Publishing jobs mirror post states.
  for (const p of [...published, ...scheduled, failed]) {
    const row = await get('SELECT status, scheduled_at, published_at FROM content_items WHERE id = ?', [p.id]);
    const jobStatus = row.status === 'published' ? 'succeeded' : (row.status === 'scheduled' ? 'queued' : 'failed');
    const when = row.published_at || row.scheduled_at || db(now - 5 * 3600000);
    await run(
      `INSERT INTO publishing_jobs (workspace_id, content_item_id, social_account_id, content_version, idempotency_key, status, scheduled_for,
         schedule_timezone, attempt_count, next_attempt_at, external_post_id, last_error_code, last_error, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [W, p.id, p.acct.id, `content:${p.id}:v1:account:${p.acct.id}`, jobStatus, when, jobStatus === 'queued' ? 0 : 1, when,
        p.ext, jobStatus === 'failed' ? 'DEMO' : null, jobStatus === 'failed' ? 'Sample failure for the demo workspace.' : null,
        jobStatus === 'succeeded' ? when : null]
    );
    if (jobStatus === 'queued' || jobStatus === 'succeeded') {
      await run(
        "INSERT INTO approval_requests (workspace_id, resource_type, resource_id, resource_version, status, decided_at, created_at) VALUES (?, 'content', ?, 1, 'approved', UTC_TIMESTAMP(), UTC_TIMESTAMP())",
        [W, p.id]
      );
    }
  }

  // Post metrics, shaped like each platform's real API (some metrics are not reported).
  const metricPlan = {
    facebook: { reach: [500, 2600], likes: [12, 110], comments: [1, 18], shares: [0, 14], clicks: [6, 70], impressions: null },
    instagram: { reach: [300, 1900], views: [500, 3200], likes: [20, 180], comments: [2, 25], shares: [0, 12], saves: [2, 40] },
    linkedin: { impressions: [600, 4200], reach: [350, 2400], likes: [8, 75], comments: [0, 12], shares: [0, 9], clicks: [10, 95] }
  };
  for (const p of published) {
    for (const [key, range] of Object.entries(metricPlan[p.platform])) {
      const unavailable = range === null;
      await run(
        `INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key,
           metric_value, availability, unavailable_reason, period, source, collected_at)
         VALUES (?, ?, ?, ?, 'post', ?, ?, ?, ?, 'lifetime', 'demo_seed', UTC_TIMESTAMP())`,
        [W, p.acct.id, p.id, p.ext, key, unavailable ? null : between(range[0], range[1]), unavailable ? 'unavailable' : 'available',
          unavailable ? 'Demo: mirrors Meta no longer reporting post impressions.' : null]
      );
    }
  }

  // Leads across both periods (some from social comments).
  const leadNames = ['Priya Menon', 'Arjun Nair', 'Fatima Khan', 'Liam Chen', 'Sofia Rossi', 'Omar Haddad', 'Grace Lee', 'Ravi Kumar', 'Emma Wilson', 'Noah Patel'];
  for (const [i, name] of leadNames.entries()) {
    const daysAgo = [1, 3, 5, 8, 12, 16, 21, 33, 40, 55][i];
    const social = i % 3 === 0;
    await run(
      `INSERT INTO leads (workspace_id, name, email, company_name, product_interest, notes, status, ai_score, ai_category, created_at)
       VALUES (?, ?, ?, ?, ?, 'Demo lead (sample data).', 'New', ?, ?, ?)`,
      [W, `${name} (demo)`, `${name.split(' ')[0].toLowerCase()}@example.com`, `DEMO Distributor ${i + 1}`,
        social ? 'Social (meta)' : (products[0]?.name || 'Demo product'), between(35, 92), ['Hot', 'Warm', 'Cold'][i % 3], db(now - daysAgo * DAY)]
    );
  }

  // Comments in the engagement inbox.
  const comments = [
    { platform: 'facebook', author: 'Priya (demo)', text: 'Does this work for 12 vans in Kochi? Who do I talk to?', cat: 'lead', summary: 'Distributor with 12 vans asking who to contact — buying intent.' },
    { platform: 'instagram', author: 'routeops.demo', text: 'Can drivers use it without mobile data?', cat: 'enquiry', summary: 'Asks whether the app works offline.' },
    { platform: 'linkedin', author: 'LinkedIn member', text: 'We switched last quarter — reconciliation is so much faster now.', cat: 'feedback', summary: 'Positive feedback about reconciliation speed.' }
  ];
  for (const c of comments) {
    const post = published.find(p => p.platform === c.platform);
    const t = await run(
      `INSERT INTO engagement_threads (workspace_id, social_account_id, provider_key, thread_type, external_thread_id, external_object_id, content_item_id,
         author_name, preview_text, last_message_at, ai_category, ai_summary, status, created_at)
       VALUES (?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?, ?, ?, 'open', UTC_TIMESTAMP())`,
      [W, post.acct.id, post.acct.provider, `demo_comment_${post.id}`, post.ext, post.id, c.author, c.text, db(now - 5 * 3600000), c.cat, c.summary]
    );
    await run(
      "INSERT INTO engagement_messages (workspace_id, thread_id, direction, external_message_id, author_name, body_text, status, provider_created_at, created_at) VALUES (?, ?, 'in', ?, ?, ?, 'received', ?, UTC_TIMESTAMP())",
      [W, t.lastID, `demo_comment_${post.id}`, c.author, c.text, db(now - 5 * 3600000)]
    );
  }

  console.log('Demo workspace created (sample data, clearly labelled DEMO).');
  console.log(`  Sign in with: ${DEMO_EMAIL}`);
  console.log(`  Password:     ${password}`);
  console.log('  (Shown once. Reset it with: npm run set-password -- demo@tradesage.ai)');
  console.log(`  ${published.length} published posts, ${scheduled.length} scheduled, 3 accounts, ${campaigns.length} campaigns, ${leadNames.length} leads.`);
}

(async () => {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--remove')) await removeDemo();
    else {
      if (args.includes('--reset')) await removeDemo();
      await createDemo();
    }
  } catch (err) {
    console.error('Demo seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
})();
