/**
 * Adds sample data to every AI Campaigns tab of the demo workspace (slug DEMO_SLUG):
 * Command Center campaigns (brief, audience, build), email sequences with results, A/B tests,
 * automation workflows with run history, analytics inputs (conversions) and Budget & ROI.
 *
 *   npm run seed:demo-campaigns              add (or refresh) the sample data
 *   npm run seed:demo-campaigns -- --remove  remove it again
 *
 * Safety:
 * - Only touches the workspace with slug DEMO_SLUG (create it first with `npm run seed:demo`).
 * - Never modifies workspace 1 or any other workspace.
 * - Nothing can be sent or published: the demo mailbox has no transport (approving a sequence is
 *   blocked), no sequence is left running with emails due, demo social accounts are never synced.
 * - Records use plain business names (no "demo" labels in the UI); the workspace itself stays
 *   named "DEMO · Sample Workspace", contacts use @example.com addresses, social accounts keep
 *   their demo_ ids and metric snapshots keep source "demo_seed" (shown as non-live data).
 * - Internally every inserted row is recorded in demo_seed_records (migration 012), so seeded rows
 *   are identifiable and removed precisely. The demo mailbox is never reported as a live inbox.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const crypto = require('crypto');
const { get, all, closeDatabase } = require('../db/database');
const secretBox = require('../lib/secretBox');
const { recordingRun, registryAvailable } = require('../lib/demoSeed');

// Every row this script inserts is recorded in demo_seed_records (internal demo marker).
let workspaceForRecords = null;
const run = recordingRun('seedDemoCampaigns', () => workspaceForRecords);

const DEMO_SLUG = 'tradesage-demo-workspace';
const DAY = 86400000;
const at = daysAgo => new Date(Date.now() - daysAgo * DAY).toISOString().replace('T', ' ').substring(0, 19);
const dateAt = daysAgo => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
const token = () => crypto.randomBytes(20).toString('hex');

let seed = 20261021;
function rand() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
const pick = list => list[Math.floor(rand() * list.length)];

const FIRST = ['Aarav', 'Meera', 'Daniel', 'Hana', 'Kofi', 'Lucia', 'Mateo', 'Nadia', 'Oliver', 'Pooja', 'Rahul', 'Sara', 'Tariq', 'Yuki', 'Zara', 'Ben', 'Chloe', 'Dev', 'Elena', 'Farhan'];
const LAST = ['Shah', 'Iyer', 'Brooks', 'Sato', 'Mensah', 'Garcia', 'Silva', 'Aziz', 'Grant', 'Reddy', 'Verma', 'Lopez', 'Malik', 'Tanaka', 'Hussain', 'Cole', 'Martin', 'Joshi', 'Novak', 'Rahman'];
const CITIES = ['Kochi', 'Dubai', 'Pune', 'Leeds', 'Accra', 'Lagos', 'Austin', 'Riyadh', 'Chennai', 'Nairobi'];
const TRADES = ['Fresh Foods', 'Beverages', 'FMCG', 'Snacks', 'Dairy', 'Household Goods', 'Wholesale', 'Grocery Supply'];
const SUFFIX = ['Distributors', 'Trading Co.', 'Supply Ltd', 'Logistics', 'Wholesale'];

async function demoWorkspace() {
  const ws = await get('SELECT id FROM workspaces WHERE slug = ?', [DEMO_SLUG]);
  if (!ws) throw new Error('No demo workspace. Run `npm run seed:demo` first.');
  if (ws.id === 1) throw new Error('Refusing to seed workspace 1.');
  return ws.id;
}

async function removeSample(W) {
  // Child tables first; only rows of the demo workspace.
  const tables = ['budget_alerts', 'budget_revenue_entries', 'budget_spend_entries', 'budget_spend_sources', 'campaign_budgets',
    'automation_run_steps', 'automation_runs', 'automation_events', 'automation_workflows',
    'outreach_step_variants', 'ab_tests', 'outreach_sends', 'outreach_recipients', 'outreach_steps', 'outreach_campaigns',
    'campaign_programs', 'email_suppressions'];
  for (const t of tables) await run(`DELETE FROM \`${t}\` WHERE workspace_id = ?`, [W]);
  if (await registryAvailable()) {
    await run("DELETE l FROM leads l JOIN demo_seed_records d ON d.table_name = 'leads' AND d.record_id = l.id WHERE l.workspace_id = ? AND d.seeded_by = 'seedDemoCampaigns'", [W]);
    await run("DELETE FROM demo_seed_records WHERE workspace_id = ? AND seeded_by = 'seedDemoCampaigns'", [W]);
  }
  // Contacts added by this script have numbered example.com addresses (e.g. aarav.shah.07@example.com).
  await run("DELETE FROM leads WHERE workspace_id = ? AND email LIKE 'demo-contact-%@example.com'", [W]); // earlier version of this script
  await run("DELETE FROM leads WHERE workspace_id = ? AND email REGEXP '\\\\.[0-9]{2}@example\\\\.com$'", [W]);
  await run("UPDATE leads SET status = 'New' WHERE workspace_id = ? AND email LIKE '%@example.com'", [W]);
  await run("DELETE FROM mail_configurations WHERE workspace_id = ? AND status = 'Demo'", [W]);
}

const COMPANIES = ['Malabar Fresh Distributors', 'Gulf Star Trading Co.', 'Deccan FMCG Supply', 'Northern Beverages Ltd', 'Accra Wholesale Hub',
  'Lagos Grocery Supply', 'Lone Star Snacks Distribution', 'Najd Household Goods', 'Coromandel Dairy Logistics', 'Rift Valley Trading'];

/** Removes "DEMO" / "(demo)" labels from records created by seedDemoWorkspace.js (demo workspace only). */
async function relabelBase(W) {
  const leads = await all("SELECT id, company_name FROM leads WHERE workspace_id = ? AND (name LIKE '% (demo)' OR company_name LIKE 'DEMO Distributor %') ORDER BY id", [W]);
  for (const [i, l] of leads.entries()) {
    await run("UPDATE leads SET name = REPLACE(name, ' (demo)', ''), company_name = ?, notes = REPLACE(REPLACE(notes, 'DEMO ', ''), '(demo)', '') WHERE id = ? AND workspace_id = ?", [COMPANIES[i % COMPANIES.length], l.id, W]);
  }
  await run("UPDATE campaigns SET name = REPLACE(name, 'DEMO · ', ''), objective = REPLACE(objective, 'DEMO · ', '') WHERE workspace_id = ?", [W]);
  await run("UPDATE social_accounts SET display_name = REPLACE(display_name, 'DEMO · ', ''), username = REPLACE(username, '.demo', '.app') WHERE workspace_id = ?", [W]);
  for (const t of ['engagement_threads', 'engagement_messages']) await run(`UPDATE ${t} SET author_name = REPLACE(REPLACE(author_name, ' (demo)', ''), 'routeops.demo', 'routeops.co') WHERE workspace_id = ?`, [W]);
  await run("UPDATE campaigns SET brief_json = REPLACE(brief_json, 'Sample campaign brief (demo data).', 'Lead generation with distributors who still take van sales orders on paper.') WHERE workspace_id = ?", [W]);
  await run("UPDATE publishing_jobs SET last_error_code = 'TIMEOUT', last_error = 'The platform did not respond in time; retry publishing.' WHERE workspace_id = ? AND last_error_code = 'DEMO'", [W]);
  await run("UPDATE content_items SET last_error = 'The platform did not respond in time; retry publishing.' WHERE workspace_id = ? AND (last_error LIKE 'Sample failure%' OR last_error LIKE 'Demo: sample%')", [W]);
  await run("UPDATE leads SET notes = 'Enquired at the distributor trade fair.' WHERE workspace_id = ? AND notes = 'Demo lead (sample data).'", [W]);
  await run("UPDATE business_profiles SET business_name = 'Coastal Distribution Tech', description = 'B2B software for FMCG distributors and their field sales teams.' WHERE workspace_id = ? AND business_name LIKE 'DEMO%'", [W]);
}

async function seedSample(W) {
  await relabelBase(W);
  const products = await all('SELECT id, name, tagline, features_json, target_audience FROM digital_products WHERE workspace_id = ? ORDER BY id', [W]);
  if (!products.length) throw new Error('The demo workspace has no products; run `npm run seed:demo -- --reset`.');
  const product = products[0];
  const social = await get("SELECT id FROM campaigns WHERE workspace_id = ? ORDER BY id LIMIT 1", [W]);
  const owner = await get("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'Workspace Owner' LIMIT 1", [W]);
  const uid = owner ? owner.user_id : null;

  // Demo mailbox: no SMTP/ZeptoMail transport (nothing can be sent) and never synced. Hosts use the
  // reserved .invalid domain and are never contacted; analytics reports replies as not live.
  await run(
    `INSERT INTO mail_configurations (workspace_id, provider, smtp_host, smtp_port, smtp_user, smtp_pass, imap_host, imap_port, imap_tls, imap_user, imap_pass, sender_name, sender_email, status, last_synced_at, created_at, updated_at)
     VALUES (?, 'custom_smtp', NULL, 587, NULL, NULL, 'imap.demo.invalid', 993, 1, 'inbox@example.com', ?, 'Sales Team', 'sales@example.com', 'Demo', NULL, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [W, secretBox.isConfigured() ? secretBox.encrypt('demo-not-a-real-password') : 'demo-not-a-real-password']
  );

  // ---------------- Leads: the 10 demo leads + 82 sample contacts ----------------
  const existing = await all("SELECT id, name, email, company_name FROM leads WHERE workspace_id = ? AND email LIKE '%@example.com' ORDER BY id", [W]);
  const leads = [...existing];
  for (let i = 0; i < 82; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const name = `${first} ${last}`;
    const company = `${pick(CITIES)} ${pick(TRADES)} ${pick(SUFFIX)}`;
    const email = `${first}.${last}.${String(i + 1).padStart(2, '0')}@example.com`.toLowerCase();
    const score = 45 + Math.floor(rand() * 45);
    const r = await run(
      `INSERT INTO leads (workspace_id, name, email, company_name, product_id, product_interest, notes, status, ai_score, ai_category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Met at the distributor trade fair', 'New', ?, ?, ?, ?)`,
      [W, name, email, company, product.id, product.name, score, score >= 75 ? 'Hot' : score >= 45 ? 'Warm' : 'Cold', at(26 + Math.floor(rand() * 20)), at(26)]
    );
    leads.push({ id: r.lastID, name, email, company_name: company });
  }

  // ---------------- Email sequences ----------------
  async function sequence(name, status, days, steps, extra = {}) {
    const c = await run(
      `INSERT INTO outreach_campaigns (workspace_id, name, product_id, goal, audience_note, tone, status, timezone, send_days, send_start_hour, send_end_hour, daily_limit, ai_provider, generated_at, approved_by, approved_at, completed_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Professional', ?, 'Asia/Kolkata', '1,2,3,4,5', 9, 17, 60, NULL, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [W, name, product.id, extra.goal || 'Book a 20-minute demo with distributors who still take orders on paper', 'Owners and sales managers of FMCG distributors', status,
        at(days + 1), status === 'draft' ? null : uid, status === 'draft' ? null : at(days), status === 'completed' ? at(2) : null, uid, at(days + 2)]
    );
    const ids = [];
    for (const [i, s] of steps.entries()) {
      const r = await run('INSERT INTO outreach_steps (workspace_id, campaign_id, step_order, delay_days, subject, body_text, needs_verification_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'[]\', ?, ?)',
        [W, c.lastID, i + 1, s.delay, s.subject, s.body, at(days + 1), at(days + 1)]);
      ids.push({ id: r.lastID, order: i + 1, delay: s.delay });
    }
    return { id: c.lastID, steps: ids };
  }

  const featureList = JSON.parse(product.features_json || '[]');
  const f1 = featureList[0] || 'mobile order booking';
  const s1 = await sequence('Van sales intro (3 emails)', 'completed', 25, [
    { delay: 0, subject: 'Orders from the road, without paper slips', body: `Hi {{first_name}},\n\n${product.name} gives your field team ${String(f1).split(':')[0].toLowerCase()} on their phones, so orders reach the office the moment they are taken.\n\nWould a 20-minute walkthrough for {{company}} be useful this week?` },
    { delay: 3, subject: 'Quick follow-up on order booking', body: 'Hi {{first_name}},\n\nFollowing up on my note about taking orders on mobile. Happy to show it on a short call.' },
    { delay: 5, subject: 'Should I close the loop?', body: 'Hi {{first_name}},\n\nIf digital ordering is not a priority right now, no problem. Reply "later" and I will check back next quarter.' }
  ]);
  const s2 = await sequence('Offline ordering follow-up', 'paused', 8, [
    { delay: 0, subject: 'Taking orders where there is no signal', body: `Hi {{first_name}},\n\nMany of your reps work in areas with weak coverage. ${product.name} keeps working offline and syncs later.\n\nWorth a quick look?` },
    { delay: 4, subject: 'Re: offline ordering', body: 'Hi {{first_name}},\n\nJust checking whether offline order booking is on your list this quarter.' }
  ]);
  const s3 = await sequence('Distributor webinar invite', 'draft', 0, [
    { delay: 0, subject: 'Webinar: digitising van sales in 30 minutes', body: 'Hi {{first_name}},\n\nWe are running a short live session on moving van sales from paper to mobile. Would you like an invite?' },
    { delay: 2, subject: 'Reminder: van sales webinar', body: 'Hi {{first_name}},\n\nA quick reminder about the session. Reply "yes" and I will send the link.' }
  ]);

  // Sequence 1 results: 90 recipients, split A/B on email 1 for the A/B test.
  const cohort1 = leads.slice(0, 90);
  const replyB = new Set([1, 3, 5, 9, 13, 17, 21, 27, 33, 41, 49, 61].map(i => i * 2 + 1));
  const replyA = new Set([4, 22, 46, 70].map(i => i * 2));
  const bounced = new Set([12, 38, 74]);
  const unsub = new Set([16, 56]);
  const replied1 = [];
  for (const [i, lead] of cohort1.entries()) {
    const variant = i % 2 === 0 ? 'A' : 'B';
    let status = 'completed';
    if (replyA.has(i) || replyB.has(i)) status = 'replied';
    else if (bounced.has(i)) status = 'bounced';
    else if (unsub.has(i)) status = 'unsubscribed';
    const firstAt = 25 - (i % 3) * 0.2;
    const sentAt = bounced.has(i) ? null : at(firstAt); // a bounce means the first email was never delivered
    const r = await run(
      `INSERT INTO outreach_recipients (workspace_id, campaign_id, lead_id, email, name, company, status, next_step_order, next_send_at, first_sent_at, last_sent_at, variant_label, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [W, s1.id, lead.id, lead.email, lead.name, lead.company_name, status, status === 'completed' ? 4 : 2, sentAt, sentAt, variant, token(), at(26), at(status === 'replied' ? 22 : 10)]
    );
    // Email 1 for everyone except bounces (which fail at send).
    await run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, email_id, provider_message_id, error, variant_label, created_at, sent_at) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?)",
      [W, s1.id, r.lastID, s1.steps[0].id, bounced.has(i) ? 'failed' : 'sent', bounced.has(i) ? null : `demo-msg-${r.lastID}-1`, bounced.has(i) ? '550 5.1.1 mailbox unavailable' : null, variant, at(firstAt), bounced.has(i) ? null : at(firstAt)]);
    if (status === 'completed') {
      await run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, provider_message_id, created_at, sent_at) VALUES (?, ?, ?, ?, 2, 'sent', ?, ?, ?)", [W, s1.id, r.lastID, s1.steps[1].id, `demo-msg-${r.lastID}-2`, at(firstAt - 3), at(firstAt - 3)]);
      await run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, provider_message_id, created_at, sent_at) VALUES (?, ?, ?, ?, 3, 'sent', ?, ?, ?)", [W, s1.id, r.lastID, s1.steps[2].id, `demo-msg-${r.lastID}-3`, at(firstAt - 8), at(firstAt - 8)]);
    }
    if (status === 'replied') replied1.push(lead);
    if (bounced.has(i) || unsub.has(i)) await run('INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, ?)', [W, lead.email.toLowerCase(), bounced.has(i) ? 'bounced' : 'unsubscribed', 'demo_seed', at(20)]);
  }

  // Sequence 2 (paused by a person): 40 recipients, email 1 sent 8 days ago.
  for (const [i, lead] of leads.slice(50, 90).entries()) {
    const status = [2, 9, 23].includes(i) ? 'replied' : 'active';
    const r = await run(
      `INSERT INTO outreach_recipients (workspace_id, campaign_id, lead_id, email, name, company, status, next_step_order, next_send_at, first_sent_at, last_sent_at, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 2, NULL, ?, ?, ?, ?, ?)`,
      [W, s2.id, lead.id, lead.email, lead.name, lead.company_name, status, at(8), at(8), token(), at(9), at(status === 'replied' ? 6 : 8)]
    );
    await run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, provider_message_id, created_at, sent_at) VALUES (?, ?, ?, ?, 1, 'sent', ?, ?, ?)", [W, s2.id, r.lastID, s2.steps[0].id, `demo-msg2-${r.lastID}`, at(8), at(8)]);
  }
  // Sequence 3 (draft): 20 recipients waiting for approval.
  for (const lead of leads.slice(10, 30)) {
    await run(`INSERT INTO outreach_recipients (workspace_id, campaign_id, lead_id, email, name, company, status, next_step_order, unsubscribe_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, s3.id, lead.id, lead.email, lead.name, lead.company_name, token()]);
  }

  // ---------------- CRM outcomes (status history used by analytics) ----------------
  const won = replied1.slice(0, 3);
  const qualified = replied1.slice(3, 9);
  let n = 0;
  for (const [i, lead] of won.entries()) {
    await run("UPDATE leads SET status = 'Won', updated_at = ? WHERE id = ? AND workspace_id = ?", [at(6 - i), lead.id, W]);
    await run(`INSERT INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, status, created_at, processed_at) VALUES (?, 'lead.status_changed', 'lead', ?, ?, ?, 'processed', ?, ?)`,
      [W, lead.id, JSON.stringify({ from: 'Qualified', to: 'Won' }), `demo:won:${lead.id}`, at(6 - i), at(6 - i)]);
    n++;
  }
  for (const [i, lead] of qualified.entries()) {
    await run("UPDATE leads SET status = 'Qualified', updated_at = ? WHERE id = ? AND workspace_id = ?", [at(14 - i), lead.id, W]);
    await run(`INSERT INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, status, created_at, processed_at) VALUES (?, 'lead.status_changed', 'lead', ?, ?, ?, 'processed', ?, ?)`,
      [W, lead.id, JSON.stringify({ from: 'Contacted', to: 'Qualified' }), `demo:qualified:${lead.id}`, at(14 - i), at(14 - i)]);
  }
  for (const lead of leads.slice(30, 50)) await run("UPDATE leads SET status = 'Contacted' WHERE id = ? AND workspace_id = ? AND status = 'New'", [lead.id, W]);
  // A won deal with no campaign email in the lookback window (shows as unattributed).
  const direct = leads[91]; // never emailed by any sample sequence
  await run("UPDATE leads SET status = 'Won' WHERE id = ? AND workspace_id = ?", [direct.id, W]);
  await run(`INSERT INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, status, created_at, processed_at) VALUES (?, 'lead.status_changed', 'lead', ?, ?, ?, 'processed', ?, ?)`,
    [W, direct.id, JSON.stringify({ from: 'Proposal', to: 'Won' }), `demo:won:${direct.id}`, at(3), at(3)]);

  // ---------------- A/B tests ----------------
  await run(`INSERT INTO ab_tests (workspace_id, kind, name, hypothesis, outreach_campaign_id, step_order, metric, direction, min_sample_per_variant, wait_days, alpha, status, locked_at, created_by, created_at, updated_at)
    VALUES (?, 'email', 'Benefit vs. question subject', 'A subject naming the benefit gets more replies than a generic one', ?, 1, 'reply_rate', 'higher', 40, 3, 0.05, 'running', ?, ?, ?, UTC_TIMESTAMP())`,
    [W, s1.id, at(25), uid, at(26)]);
  await run("INSERT INTO outreach_step_variants (workspace_id, campaign_id, step_order, label, subject, body_text, needs_verification_json, created_at, updated_at) VALUES (?, ?, 1, 'B', ?, ?, '[]', ?, ?)",
    [W, s1.id, 'Are paper order slips slowing your van team?', `Hi {{first_name}},\n\nIf your reps still write orders on paper, ${product.name} lets them book on their phones and send orders to the office instantly.\n\nOpen to a 20-minute walkthrough for {{company}}?`, at(26), at(26)]);
  await run(`INSERT INTO ab_tests (workspace_id, kind, name, hypothesis, outreach_campaign_id, step_order, metric, direction, min_sample_per_variant, wait_days, alpha, status, created_by, created_at, updated_at)
    VALUES (?, 'email', 'Webinar subject test', 'Mentioning the 30-minute length increases replies', ?, 1, 'reply_rate', 'higher', 100, 3, 0.05, 'draft', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, s3.id, uid]);
  await run("INSERT INTO outreach_step_variants (workspace_id, campaign_id, step_order, label, subject, body_text, needs_verification_json, created_at, updated_at) VALUES (?, ?, 1, 'B', 'Join us: a short session on mobile van sales', 'Hi {{first_name}},\n\nWe are hosting a short live session on taking van sales orders on mobile. Want an invite?', '[]', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [W, s3.id]);

  // ---------------- Command Center campaigns ----------------
  const features = featureList.slice(0, 4).map(x => String(x).split(':')[0]);
  const brief = {
    objectives: ['Book demos with FMCG distributors that still take van sales orders on paper', 'Build awareness of offline ordering among sales managers'],
    audience: { summary: product.target_audience || 'FMCG distributors and their field sales managers', segments: ['Distributor owners', 'Sales managers with van teams'] },
    messaging: {
      value_proposition: `${product.name}: ${product.tagline || 'mobile order booking for field sales teams'}`,
      key_messages: ['Orders reach the office as soon as they are taken', 'Works for reps on the road', ...features.slice(0, 2)],
      proof_points: features.slice(0, 3),
      call_to_action: 'Book a 20-minute walkthrough'
    },
    content_plan: [
      { channel: 'email', format: '3-step email sequence', count: 3, purpose: 'Introduce the product and book demos' },
      { channel: 'linkedin', format: 'company page posts', count: 3, purpose: 'Reach sales managers' },
      { channel: 'facebook', format: 'page posts', count: 2, purpose: 'Reach distributor owners' }
    ],
    timeline: [
      { phase: 'Launch', start_day: 0, end_day: 7, activities: ['Send email 1', 'Publish launch posts'] },
      { phase: 'Follow-up', start_day: 8, end_day: 20, activities: ['Follow-up emails', 'Answer comments'] },
      { phase: 'Review', start_day: 21, end_day: 30, activities: ['Compare A/B results', 'Review pipeline'] }
    ],
    kpis: [
      { metric: 'reply_rate', name: 'Reply rate', target: null, why: 'Shows interest from the audience' },
      { metric: 'emails_sent', name: 'Emails sent', target: null, why: 'Reach of the sequence' },
      { metric: 'posts_published', name: 'Posts published', target: null, why: 'Social activity' },
      { metric: 'leads_won', name: 'Leads won', target: '3', why: 'Target stated in the goal' }
    ],
    gaps: ['No customer case study saved yet', 'Pricing is not in the product facts, so it is not mentioned']
  };
  const p1 = await run(
    `INSERT INTO campaign_programs (workspace_id, name, product_id, goal, target_audience, tone, channels_json, budget_amount, budget_currency, budget_note, start_date, end_date, status, brief_json, brief_flags_json, brief_provider, brief_generated_at, brief_approved_by, brief_approved_at, lead_ids_json, outreach_campaign_id, social_campaign_id, created_by, created_at, updated_at)
     VALUES (?, 'Q4 Van Sales Push', ?, 'Book demos and win at least 3 distributors this quarter', 'FMCG distributors with van sales teams', 'Professional', ?, 2500, 'USD', 'Boosted posts + design help', ?, ?, 'built', ?, '[]', NULL, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [W, product.id, JSON.stringify(['email', 'linkedin', 'facebook']), dateAt(25), dateAt(-5), JSON.stringify(brief), at(27), uid, at(26), JSON.stringify(cohort1.map(l => l.id)), s1.id, social ? social.id : null, uid, at(28)]
  );
  await run(
    `INSERT INTO campaign_programs (workspace_id, name, product_id, goal, target_audience, tone, channels_json, start_date, end_date, status, brief_json, brief_flags_json, brief_provider, brief_generated_at, outreach_campaign_id, created_by, created_at, updated_at)
     VALUES (?, 'Distributor Webinar', ?, 'Fill a 30-minute webinar with distributor owners', 'Distributor owners', 'Friendly', ?, ?, ?, 'brief_ready', ?, ?, NULL, UTC_TIMESTAMP(), NULL, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [W, product.id, JSON.stringify(['email', 'linkedin']), dateAt(-3), dateAt(-20), JSON.stringify({ ...brief, objectives: ['Get 40 registrations for the webinar'], content_plan: brief.content_plan.slice(0, 2),
      messaging: { ...brief.messaging, key_messages: ['A 30-minute live session', 'See mobile order booking in action', 'Save 40% time on order entry'] } }), JSON.stringify(['40%']), uid]
  );
  await run(`INSERT INTO campaign_programs (workspace_id, name, product_id, goal, target_audience, tone, channels_json, status, created_by, created_at, updated_at)
    VALUES (?, 'New Feature Teaser', ?, 'Announce the next release to existing contacts', 'Existing leads', 'Direct', ?, 'draft', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, products[1] ? products[1].id : product.id, JSON.stringify(['linkedin', 'instagram']), uid]);

  // ---------------- Budget & ROI (sample actual spend and recorded revenue) ----------------
  const b = await run(`INSERT INTO campaign_budgets (workspace_id, program_id, amount, currency, period_start, period_end, alert_thresholds_json, status, created_by, created_at, updated_at)
    VALUES (?, ?, 2500, 'USD', ?, ?, '[40,80,100]', 'active', ?, ?, UTC_TIMESTAMP())`, [W, p1.lastID, dateAt(25), dateAt(-5), uid, at(25)]);
  const spend = [[24, 300, 'Design freelancer: launch visuals', 'INV-1001'], [20, 420, 'LinkedIn sponsored post boost', 'INV-1002'], [14, 380, 'Facebook post boost', 'INV-1003'], [6, 150, 'Webinar tool (monthly)', 'INV-1004']];
  for (const [d, amt, desc, ref] of spend) {
    await run(`INSERT INTO budget_spend_entries (workspace_id, budget_id, source_type, spend_date, amount, currency, external_ref, description, evidence_ref, entered_by, created_at)
      VALUES (?, ?, 'manual', ?, ?, 'USD', ?, ?, ?, ?, ?)`, [W, b.lastID, dateAt(d), amt, `manual:${crypto.randomUUID()}`, desc, ref, uid, at(d)]);
  }
  await run(`INSERT INTO budget_spend_entries (workspace_id, budget_id, source_type, spend_date, amount, currency, external_ref, description, evidence_ref, entered_by, created_at, voided_at, voided_by, void_reason)
    VALUES (?, ?, 'manual', ?, 99, 'USD', ?, 'Duplicate of INV-1002', 'INV-1002', ?, ?, ?, ?, 'Entered twice by mistake')`, [W, b.lastID, dateAt(20), `manual:${crypto.randomUUID()}`, uid, at(19), at(18), uid]);
  for (const [i, lead] of won.slice(0, 2).entries()) {
    await run(`INSERT INTO budget_revenue_entries (workspace_id, budget_id, lead_id, amount, currency, received_date, description, evidence_ref, entered_by, created_at)
      VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)`, [W, b.lastID, lead.id, [2400, 1800][i], dateAt(5 - i), `Annual plan signed: ${lead.company_name}`, `CRM-${200 + i}`, uid, at(5 - i)]);
  }

  // ---------------- Automations (with sample run history) ----------------
  const lastEvent = await get('SELECT MAX(id) AS id FROM automation_events');
  const wf = async (name, status, trigger, cfg, conditions, steps, extra = {}) => (await run(
    `INSERT INTO automation_workflows (workspace_id, name, description, trigger_type, trigger_config_json, conditions_json, steps_json, exit_on_reply, max_runs_per_day, status, version, activated_by, activated_at, activated_version, activated_after_event_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 200, ?, 1, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [W, name, extra.description || null, trigger, JSON.stringify(cfg), JSON.stringify(conditions), JSON.stringify(steps), status,
      status === 'draft' ? null : uid, status === 'draft' ? null : at(24), status === 'draft' ? null : 1, status === 'draft' ? null : (lastEvent?.id || 0), uid, at(25)]
  )).lastID;
  const w1 = await wf('Welcome new product leads', 'active', 'lead.created', { productId: product.id }, [{ field: 'has_valid_email', op: 'is', value: true }],
    [{ type: 'action', action: 'add_lead_note', params: { text: 'New lead for {{company}}: send the intro sequence after review.' } }, { type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }],
    { description: 'Notes and status only; nothing is sent.' });
  const w2 = await wf('Reply → qualify and stop emails', 'paused', 'email.replied', { emailCampaignId: s1.id }, [],
    [{ type: 'action', action: 'update_lead_status', params: { status: 'Qualified' } }, { type: 'action', action: 'stop_sequences', params: {} }]);
  await wf('No reply → draft a personal follow-up', 'draft', 'email.sequence_completed', { emailCampaignId: s1.id }, [{ field: 'suppressed', op: 'is', value: false }],
    [{ type: 'wait', hours: 72 }, { type: 'check', conditions: [{ field: 'status', op: 'in', value: ['New', 'Contacted'] }] }, { type: 'action', action: 'create_email_draft', params: { subject: 'One more idea for {{company}}', body: 'Hi {{first_name}},\n\nA quick personal note…' } }]);
  // Sample history for the reply workflow (it ran while active, then was paused).
  for (const [i, lead] of replied1.entries()) {
    const ev = await run(`INSERT INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, status, created_at, processed_at) VALUES (?, 'email.replied', 'lead', ?, ?, ?, 'processed', ?, ?)`,
      [W, lead.id, JSON.stringify({ emailCampaignId: s1.id }), `demo:replied:${lead.id}`, at(22 - i * 0.5), at(22 - i * 0.5)]);
    const status = i === 10 ? 'failed' : 'completed';
    const r = await run(`INSERT INTO automation_runs (workspace_id, workflow_id, workflow_version, event_id, subject_type, subject_id, status, current_step, next_run_at, last_error, created_at, finished_at)
      VALUES (?, ?, 1, ?, 'lead', ?, ?, 2, ?, ?, ?, ?)`, [W, w2, ev.lastID, lead.id, status, at(22 - i * 0.5), status === 'failed' ? 'Step 2: temporary database error' : null, at(22 - i * 0.5), at(22 - i * 0.5)]);
    await run("INSERT INTO automation_run_steps (workspace_id, run_id, step_index, step_type, status, attempts, result_json, finished_at) VALUES (?, ?, 0, 'update_lead_status', 'done', 1, ?, ?)", [W, r.lastID, JSON.stringify({ status: 'Qualified' }), at(22 - i * 0.5)]);
    await run("INSERT INTO automation_run_steps (workspace_id, run_id, step_index, step_type, status, attempts, result_json, error, finished_at) VALUES (?, ?, 1, 'stop_sequences', ?, ?, ?, ?, ?)",
      [W, r.lastID, status === 'failed' ? 'failed' : 'done', status === 'failed' ? 3 : 1, status === 'failed' ? null : JSON.stringify({ stopped: 1 }), status === 'failed' ? 'temporary database error' : null, at(22 - i * 0.5)]);
  }
  void w1; void n;
  return { leads: leads.length, sequences: 3, programs: 3, tests: 2, workflows: 3, replies: replied1.length };
}

async function main() {
  const W = await demoWorkspace();
  workspaceForRecords = W;
  await removeSample(W);
  if (process.argv.includes('--remove')) {
    console.log(`Removed AI Campaigns sample data from demo workspace #${W}.`);
    return;
  }
  const r = await seedSample(W);
  console.log(`AI Campaigns sample data added to demo workspace #${W}:`);
  console.log(`  ${r.sequences} email sequences, ${r.programs} Command Center campaigns, ${r.tests} A/B tests, ${r.workflows} automations, ${r.leads} demo leads (${r.replies} replies).`);
  console.log('  Nothing can be sent or published from this data (no mail transport; demo social accounts).');
}

main()
  .catch(err => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => closeDatabase());
