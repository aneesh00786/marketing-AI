/**
 * Creates (or removes) an isolated demo workspace ("DEMO · Sample Workspace") with sample data,
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
 * - Removal covers every workspace-owned table, in one transaction. It refuses (deleting nothing)
 *   when the demo workspace holds rows in a table it does not know, or in tables that may hold
 *   real provider/billing resources (phone numbers, subscriptions).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const crypto = require('crypto');
const { get, all, closeDatabase, withTransaction } = require('../db/database');
const { hashPassword } = require('../services/authService');
const secretBox = require('../lib/secretBox');
const { recordingRun } = require('../lib/demoSeed');

// Every row this script inserts is recorded in demo_seed_records (internal demo marker).
let workspaceForRecords = null;
const run = recordingRun('seedDemoWorkspace', () => workspaceForRecords);

const DEMO_SLUG = 'tradesage-demo-workspace';
const DEMO_EMAIL = 'demo@tradesage.ai';
const DAY = 86400000;
const COMPANIES = ['Malabar Fresh Distributors', 'Gulf Star Trading Co.', 'Deccan FMCG Supply', 'Northern Beverages Ltd', 'Accra Wholesale Hub',
  'Lagos Grocery Supply', 'Lone Star Snacks Distribution', 'Najd Household Goods', 'Coromandel Dairy Logistics', 'Rift Valley Trading'];

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

// Workspace-owned tables, children first. Rows are deleted only for the demo workspace id.
const REMOVE_TABLES = [
  // AI Campaigns sample data (scripts/seedDemoCampaigns.js)
  'budget_alerts', 'budget_revenue_entries', 'budget_spend_entries', 'budget_spend_sources', 'campaign_budgets',
  'automation_run_steps', 'automation_runs', 'automation_events', 'automation_workflows',
  'outreach_step_variants', 'ab_tests', 'outreach_sends', 'outreach_recipients', 'outreach_steps', 'outreach_campaigns',
  'campaign_programs', 'email_suppressions', 'mail_configurations',
  // Social hub
  'engagement_messages', 'engagement_threads', 'social_metric_snapshots', 'publishing_attempts', 'publishing_jobs',
  'content_versions', 'approval_requests', 'video_jobs', 'content_items', 'assets', 'social_accounts', 'provider_credentials',
  'provider_apps', 'provider_webhook_events', 'oauth_states', 'background_jobs', 'campaigns',
  // Mail, CRM, assistant and calls created while using the demo workspace
  'email_drafts', 'client_replies', 'email_campaigns', 'emails', 'b2b_clients', 'connected_businesses',
  'conversation_messages', 'conversations', 'tasks', 'appointments', 'call_records', 'agents',
  'leads', 'digital_products', 'business_profiles', 'social_settings', 'usage_ledger', 'audit_logs', 'demo_seed_records'
];
// May hold real provider or billing resources: never deleted by a script.
const PROTECTED_TABLES = ['phone_numbers', 'subscriptions'];

async function removeDemo() {
  const ws = await findDemo();
  if (!ws) {
    console.log('No demo workspace found.');
    return false;
  }
  const id = ws.id;
  if (id === 1) throw new Error('Refusing to remove workspace 1.');
  const owned = (await all("SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'workspace_id'")).map(r => r.t);
  const blocking = [];
  for (const t of owned.filter(x => !REMOVE_TABLES.includes(x) && x !== 'workspace_members')) {
    const n = await get(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE workspace_id = ?`, [id]);
    if (Number(n.n)) blocking.push(`${t} (${n.n})`);
  }
  if (blocking.length) {
    const why = blocking.some(b => PROTECTED_TABLES.some(p => b.startsWith(`${p} `))) ? 'they may be real provider or billing resources' : 'this script does not know how to remove them safely';
    throw new Error(`Not removed: the demo workspace has rows in ${blocking.join(', ')} and ${why}. Nothing was deleted.`);
  }
  const removed = await withTransaction(async tx => {
    // task_steps has no workspace column; its rows belong to the workspace's tasks.
    if (owned.includes('tasks')) await tx.run('DELETE s FROM task_steps s JOIN tasks t ON t.id = s.task_id WHERE t.workspace_id = ?', [id]);
    for (const t of REMOVE_TABLES.filter(x => owned.includes(x))) await tx.run(`DELETE FROM \`${t}\` WHERE workspace_id = ?`, [id]);
    const members = await tx.all('SELECT user_id FROM workspace_members WHERE workspace_id = ?', [id]);
    await tx.run('DELETE FROM workspace_members WHERE workspace_id = ?', [id]);
    for (const m of members) {
      const other = await tx.get('SELECT id FROM workspace_members WHERE user_id = ? LIMIT 1', [m.user_id]);
      if (!other) {
        await tx.run('DELETE FROM users WHERE id = ? AND email = ?', [m.user_id, DEMO_EMAIL]);
        if (owned.includes('demo_seed_records')) await tx.run("DELETE FROM demo_seed_records WHERE table_name = 'users' AND record_id = ?", [m.user_id]);
      }
    }
    if (owned.includes('demo_seed_records')) await tx.run("DELETE FROM demo_seed_records WHERE table_name = 'workspaces' AND record_id = ?", [id]);
    return tx.run('DELETE FROM workspaces WHERE id = ? AND slug = ?', [id, DEMO_SLUG]);
  });
  if (!removed.changes) throw new Error('The demo workspace row was not removed.');
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
  workspaceForRecords = W;
  await run("INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, 'Workspace Owner', 'Active', UTC_TIMESTAMP())", [W, user.lastID]);
  await run(
    "INSERT INTO business_profiles (workspace_id, business_name, industry, website_url, description, products_json, brand_voice, created_at) VALUES (?, 'Coastal Distribution Tech', 'B2B Software', 'https://thrivewoo.com', 'B2B software for FMCG distributors and their field sales teams.', '[]', 'Professional and practical', UTC_TIMESTAMP())",
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
    { key: 'fb', provider: 'meta', type: 'facebook_page', name: 'ThriveWoo Facebook Page', platform: 'facebook', followers: [2310, 2480],
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_engagement', 'read_insights'] },
    { key: 'ig', provider: 'meta', type: 'instagram_business', name: 'thrivewoo.app (Instagram)', platform: 'instagram', followers: [1180, 1342], username: 'thrivewoo.app',
      scopes: ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'] },
    { key: 'li', provider: 'linkedin', type: 'linkedin_organization', name: 'ThriveWoo LinkedIn Page', platform: 'linkedin', followers: [860, 925],
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
    { name: 'Van Sales Q4 Launch', objective: 'Lead generation', status: 'Active', platforms: ['facebook', 'instagram', 'linkedin'], start: -28, end: 20, product: 0 },
    { name: 'Offline Ordering Awareness', objective: 'Awareness', status: 'Completed', platforms: ['facebook', 'linkedin'], start: -60, end: -31, product: 0 },
    { name: 'Distributor Webinar Invite', objective: 'Demo bookings', status: 'Draft', platforms: ['linkedin'], start: 7, end: 30, product: 1 }
  ];
  const campaigns = [];
  for (const c of campDefs) {
    const ins = await run(
      `INSERT INTO campaigns (workspace_id, name, objective, status, source, platforms_json, channels, product_id, start_date, end_date,
         key_message, generation_status, brief_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'social_hub', ?, ?, ?, ?, ?, 'Book orders on the route, even offline.', 'completed', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [W, c.name, c.objective, c.status, JSON.stringify(c.platforms), c.platforms.join(', '), products[c.product]?.id || null,
        db(now + c.start * DAY).slice(0, 10), db(now + c.end * DAY).slice(0, 10),
        JSON.stringify({ summary: 'Lead generation with distributors who still take van sales orders on paper.', key_messages: ['Offline order booking', 'Live stock on every route'], missing_information: [], provider: 'demo_seed' })]
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
        scheduledAt ? 'UTC' : null, ext, status === 'failed' ? 'The platform did not respond in time; retry publishing.' : null,
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
        p.ext, jobStatus === 'failed' ? 'TIMEOUT' : null, jobStatus === 'failed' ? 'The platform did not respond in time; retry publishing.' : null,
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
       VALUES (?, ?, ?, ?, ?, 'Enquired at the distributor trade fair.', 'New', ?, ?, ?)`,
      [W, name, `${name.split(' ')[0].toLowerCase()}@example.com`, COMPANIES[i % COMPANIES.length],
        social ? 'Social (meta)' : (products[0]?.name || 'Demo product'), between(35, 92), ['Hot', 'Warm', 'Cold'][i % 3], db(now - daysAgo * DAY)]
    );
  }

  // Comments in the engagement inbox.
  const comments = [
    { platform: 'facebook', author: 'Priya', text: 'Does this work for 12 vans in Kochi? Who do I talk to?', cat: 'lead', summary: 'Distributor with 12 vans asking who to contact — buying intent.' },
    { platform: 'instagram', author: 'routeops.co', text: 'Can drivers use it without mobile data?', cat: 'enquiry', summary: 'Asks whether the app works offline.' },
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

  console.log('Demo workspace created (sample data; the workspace is named "DEMO · Sample Workspace").');
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
