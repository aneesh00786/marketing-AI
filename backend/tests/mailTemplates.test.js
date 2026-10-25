const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const h = require('./helpers');
const { buildZip, PNG, JPG } = require('./zipBuilder');

// Email Template Library: HTML/ZIP import, sanitization, assets, permissions, isolation, and use
// in Compose, Drafts and Email Campaigns. ZeptoMail is mocked; nothing is sent.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-assets-'));
process.env.MAIL_ASSET_STORAGE_DIR = STORAGE;

const db = () => h.db();
let A;
let B;

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Templates A' });
  B = await h.createWorkspace({ name: 'Templates B' });
});
test.after(async () => { await h.shutdown(); fs.rmSync(STORAGE, { recursive: true, force: true }); });

const t = (ws, method, p, body) => h.api(method, `/api/v1/mail/templates${p}`, { token: ws.token, body });

async function upload(ws, filename, buffer, entry) {
  const { port } = (await h.startApp()).address();
  const q = new URLSearchParams({ filename, ...(entry ? { entry } : {}) });
  const res = await globalThis.__realFetch(`http://127.0.0.1:${port}/api/v1/mail/templates/import?${q}`, {
    method: 'POST', headers: { Authorization: `Bearer ${ws.token}`, 'Content-Type': 'application/octet-stream' }, body: buffer
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

const assetCount = async wsId => Number((await db().get('SELECT COUNT(*) AS n FROM mail_template_assets WHERE workspace_id = ?', [wsId])).n);
const filesOnDisk = wsId => { try { return fs.readdirSync(path.join(STORAGE, String(wsId))).length; } catch (e) { return 0; } };
const assetIds = html => [...String(html).matchAll(/\/api\/v1\/mail\/assets\/([A-Za-z0-9_-]{43})/g)].map(m => m[1]);

const PACKAGE = () => buildZip([
  { name: 'newsletter/index.html', deflate: true, data: `<!doctype html><html><head><link rel="stylesheet" href="css/style.css"></head>
    <body><table width="600" cellpadding="0" style="border-collapse:collapse"><tr><td class="hero" bgcolor="#ffffff">
    <img src="images/logo.png" alt="Logo"><img src="./images/banner.jpg" alt="Banner"><img src="images/missing.png">
    <p style="color:#333">Hi {{first_name}}, news from {{company}}.</p><a href="https://acme-co.io">Visit</a>
    <script>alert(1)</script></td></tr></table></body></html>` },
  { name: 'newsletter/css/style.css', deflate: true, data: '@import "base.css";\n.hero { background: url(../images/banner.jpg) no-repeat; }' },
  { name: 'newsletter/css/base.css', data: 'p { font-family: Arial; } @import url(https://fonts.example.org/x.css);' },
  { name: 'newsletter/images/logo.png', data: PNG },
  { name: 'newsletter/images/banner.jpg', data: JPG },
  { name: 'newsletter/images/unused.png', data: PNG },
  { name: '__MACOSX/._index.html', data: 'junk' }
]);

// ------------------------------------------------------------------ CRUD, permissions, isolation

test('templates: create, list with search/paging, rename, duplicate, delete; permissions and isolation', async () => {
  const member = await h.addMember(A.workspaceId, 'Member');
  const approver = await h.addMember(A.workspaceId, 'Approver');
  const c = await t(member, 'POST', '', { name: 'Welcome series', category: 'Welcome', description: 'First email', html: '<table><tr><td style="padding:8px">Welcome, {{first_name}}!</td></tr></table>' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.template.id;
  assert.match(c.data.template.html, /<td style="padding:8px">Welcome, \{\{first_name\}\}!<\/td>/, 'email markup and inline styles kept');
  assert.deepEqual(c.data.template.placeholders, ['{{first_name}}']);

  assert.equal((await t(approver, 'POST', '', { name: 'x' })).status, 403, 'approvers cannot create');
  assert.equal((await t(approver, 'GET', `/${id}`)).status, 200, 'but can view and use');
  assert.equal((await t(member, 'POST', '', { name: 'x', workspaceId: B.workspaceId })).status, 400, 'no client workspace id');

  for (let i = 0; i < 13; i++) await t(A, 'POST', '', { name: `Promo ${i}`, category: i % 2 ? 'Promotion' : 'Seasonal deals' });
  const page1 = await t(A, 'GET', '?pageSize=5&page=1');
  assert.equal(page1.data.templates.length, 5);
  assert.ok(page1.data.total >= 14);
  assert.equal((await t(A, 'GET', '?q=Welcome')).data.templates[0].name, 'Welcome series');
  assert.ok((await t(A, 'GET', '?category=Seasonal%20deals')).data.templates.every(x => x.category === 'Seasonal deals'));
  assert.ok((await t(A, 'GET', '/categories')).data.categories.includes('Seasonal deals'), 'custom categories listed');
  const cats = await t(A, 'GET', '/categories');
  assert.equal(cats.data.canManage, true);
  assert.equal(cats.data.limits.zipMb, 10);
  assert.equal((await t(approver, 'GET', '/categories')).data.canManage, false, 'approvers only use templates');

  const renamed = await t(member, 'PATCH', `/${id}`, { name: 'Welcome v2', description: 'Updated', category: 'Welcome', version: 1 });
  assert.equal(renamed.data.template.version, 2);
  assert.equal((await t(member, 'PATCH', `/${id}`, { name: 'stale', version: 1 })).data.code, 'VERSION_CONFLICT');
  const dup = await t(member, 'POST', `/${id}/duplicate`);
  assert.equal(dup.data.template.name, 'Welcome v2 (copy)');
  assert.equal(dup.data.template.source, 'duplicate');
  await t(member, 'PATCH', `/${dup.data.template.id}`, { html: '<p>Changed copy</p>' });
  assert.match((await t(A, 'GET', `/${id}`)).data.template.html, /Welcome, \{\{first_name\}\}/, 'the original is unchanged');

  for (const [m, p, body] of [['GET', `/${id}`], ['PATCH', `/${id}`, { name: 'x' }], ['POST', `/${id}/duplicate`], ['DELETE', `/${id}`]]) {
    assert.equal((await t(B, m, p, body)).status, 404, `${m} ${p} from another workspace`);
  }
  assert.ok(!(await t(B, 'GET', '')).data.templates.some(x => x.id === id));
  assert.equal((await t(approver, 'DELETE', `/${id}`)).status, 403);
  assert.equal((await t(member, 'DELETE', `/${dup.data.template.id}`)).status, 200);
  assert.equal((await t(A, 'GET', `/${dup.data.template.id}`)).status, 404);
  const logs = await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND action LIKE 'mail.template_%'", [A.workspaceId]);
  for (const a of ['mail.template_created', 'mail.template_updated', 'mail.template_duplicated', 'mail.template_deleted']) assert.ok(logs.some(l => l.action === a), a);
});

test('sanitization: scripts, handlers, javascript: URLs, forms and frames are removed and reported; email markup stays', async () => {
  const html = `<html><head><style>.x{color:red;background:url(javascript:alert(1))}</style></head><body>
    <table bgcolor="#eee"><tr><td onclick="steal()" style="width:expression(alert(1));color:#111">Hi</td></tr></table>
    <a href="javascript:alert(1)">bad</a><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a><form action="https://x"><input name="p"></form>
    <iframe src="https://evil.example"></iframe><img src="https://cdn.acme-co.io/a.png" onerror="x()"><script>fetch('/api')</script>
    <img src="mkt-asset://${'Z'.repeat(43)}"></body></html>`;
  const r = await t(A, 'POST', '/analyze', { html });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const out = r.data.html;
  for (const bad of [/<script/i, /onclick/i, /onerror/i, /javascript:/i, /expression\(/i, /<form/i, /<iframe/i, /<input/i]) assert.doesNotMatch(out, bad);
  assert.match(out, /<table bgcolor="#eee">/);
  assert.match(out, /href="\$\[LI:UNSUBSCRIBE\]\$"/);
  assert.match(out, /https:\/\/cdn\.acme-co\.io\/a\.png/);
  assert.doesNotMatch(out, /Z{43}/, 'references to assets of no/other workspace are removed');
  const w = r.data.warnings.join(' | ');
  for (const m of [/script/, /event-handler/, /javascript: links/, /form elements/, /iframes/, /not belonging to this workspace/]) assert.match(w, m);
  // Saving goes through the same server-side sanitizer.
  const saved = await t(A, 'POST', '', { name: 'Hostile', html });
  assert.doesNotMatch(saved.data.template.html, /<script|onclick|javascript:/i);
});

// ------------------------------------------------------------------ HTML upload

test('HTML upload: preview only (not saved), warnings for missing local images; invalid files are rejected', async () => {
  const before = Number((await db().get('SELECT COUNT(*) AS n FROM mail_templates WHERE workspace_id = ?', [A.workspaceId])).n);
  const ok = await upload(A, 'Spring Sale.html', Buffer.from('﻿<html><body><img src="img/hero.png"><p>Sale!</p></body></html>'));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.suggestedName, 'Spring Sale');
  assert.equal(ok.data.source, 'html');
  assert.ok(ok.data.warnings.some(w => /Missing image files.*img\/hero\.png/.test(w)));
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM mail_templates WHERE workspace_id = ?', [A.workspaceId])).n), before, 'preview does not save');

  for (const [name, buf, code] of [
    ['notes.txt', Buffer.from('<p>x</p>'), 'INVALID_FILE'],
    ['empty.html', Buffer.alloc(0), 'INVALID_FILE'],
    ['binary.html', Buffer.from([0x3c, 0x70, 0x00, 0x3e]), 'INVALID_FILE'],
    ['latin1.html', Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0x3c]), 'INVALID_ENCODING'],
    ['plain.html', Buffer.from('just some text'), 'INVALID_FILE']
  ]) {
    const r = await upload(A, name, buf);
    assert.equal(r.status, 400, name);
    assert.equal(r.data.code, code, name);
  }
  const member = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await upload(member, 'x.html', Buffer.from('<p>x</p>'))).status, 403);
});

// ------------------------------------------------------------------ ZIP import

test('ZIP import: CSS embedded (with @import), relative images stored and rewritten, missing/remote/unused reported', async () => {
  const r = await upload(A, 'newsletter.zip', PACKAGE());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.entry, 'newsletter/index.html');
  assert.equal(r.data.source, 'zip');
  const html = r.data.html;
  assert.doesNotMatch(html, /<link/i);
  assert.match(html, /<style type="text\/css">[\s\S]*font-family: Arial[\s\S]*\.hero/, 'stylesheets and their @imports embedded');
  assert.doesNotMatch(html, /<script/i);
  const ids = assetIds(html);
  assert.equal(new Set(ids).size, 2, 'logo + banner stored once each (banner used twice)');
  assert.match(html, /images\/missing\.png/, 'a missing image is left as-is and reported');
  const w = r.data.warnings.join(' | ');
  assert.match(w, /Missing files referenced by the template: images\/missing\.png/);
  assert.match(w, /Remote resources were not imported.*fonts\.example\.org/);
  assert.match(w, /not used by the template and were ignored/);
  assert.match(w, /Embedded 1 stylesheet/);
  assert.match(w, /Removed 1 <script>/);
  assert.deepEqual(r.data.placeholders.sort(), ['{{company}}', '{{first_name}}']);

  // Assets are public by opaque id, with safe headers; preview has not created a template.
  const types = [];
  for (const id of new Set(ids)) {
    const a = await h.api('GET', `/api/v1/mail/assets/${id}`);
    assert.equal(a.status, 200);
    types.push(a.headers.get('content-type'));
  }
  assert.deepEqual(types.sort(), ['image/jpeg', 'image/png']);
  const img = await h.api('GET', `/api/v1/mail/assets/${ids[0]}`);
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await h.api('GET', `/api/v1/mail/assets/${'A'.repeat(43)}`)).status, 404);
  for (const evil of ['/api/v1/mail/assets/../../etc/passwd', '/api/v1/mail/assets/..%2F..%2Fetc%2Fpasswd', `/api/v1/mail/assets/${ids[0]}%00.html`]) {
    const r2 = await h.api('GET', evil);
    assert.notEqual(r2.status, 200, evil);
  }

  // Save: assets are attached to the template; stored HTML keeps internal references.
  const saved = await t(A, 'POST', '', { name: r.data.suggestedName, category: 'Newsletter', html: r.data.html, importId: r.data.importId, source: 'zip', sourceFilename: 'newsletter.zip' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const row = await db().get('SELECT html FROM mail_templates WHERE id = ?', [saved.data.template.id]);
  assert.match(row.html, /mkt-asset:\/\//);
  assert.doesNotMatch(row.html, /\/api\/v1\/mail\/assets\//, 'no host name stored');
  const claimed = await db().all('SELECT template_id, import_id FROM mail_template_assets WHERE public_id IN (?, ?)', [...new Set(ids)]);
  assert.ok(claimed.every(a => a.template_id === saved.data.template.id && a.import_id === null));
  assert.deepEqual(assetIds(saved.data.template.html).sort(), ids.sort(), 'URLs stay the same after saving');
});

test('ZIP import: several HTML files require choosing the entry point', async () => {
  const zip = buildZip([{ name: 'a/welcome.html', data: '<p>A</p>' }, { name: 'b/promo.html', data: '<p>B</p>' }]);
  const first = await upload(A, 'multi.zip', zip);
  assert.equal(first.status, 200);
  assert.equal(first.data.needsEntry, true);
  assert.deepEqual(first.data.entries.sort(), ['a/welcome.html', 'b/promo.html']);
  const chosen = await upload(A, 'multi.zip', zip, 'b/promo.html');
  assert.equal(chosen.data.entry, 'b/promo.html');
  assert.match(chosen.data.html, /<p>B<\/p>/);
  assert.equal((await upload(A, 'multi.zip', zip, 'c/none.html')).data.code, 'INVALID_ENTRY');
});

test('ZIP import: hostile archives are rejected with a reason and nothing is extracted', async () => {
  process.env.MAIL_TEMPLATE_ZIP_MAX_ENTRIES = '20';
  process.env.MAIL_TEMPLATE_ZIP_MAX_FILE_MB = '1';
  const C = await h.createWorkspace({ name: 'Templates hostile' });
  try {
    const cases = [
      ['traversal', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: '../../evil.png', data: PNG }]), 'UNSAFE_PATH'],
      ['absolute', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: '/etc/evil.png', data: PNG }]), 'UNSAFE_PATH'],
      ['backslash', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: 'images\\..\\..\\evil.png', data: PNG }]), 'UNSAFE_PATH'],
      ['symlink', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: 'images/link.png', data: '/etc/passwd', externalAttr: (0o120777 << 16) >>> 0 }]), 'UNSAFE_ENTRY'],
      // Encrypted (ZipCrypto): a 12-byte encryption header precedes the stored data.
      ['encrypted', buildZip([{ name: 'index.html', data: Buffer.concat([crypto.randomBytes(12), Buffer.from('<p>x</p>')]), declaredSize: 8, flags: 0x1 }]), 'UNSAFE_ENTRY'],
      ['executable', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: 'tools/run.exe', data: 'MZ' }]), 'SUSPICIOUS_FILE'],
      ['php', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: 'x.php', data: '<?php ?>' }]), 'SUSPICIOUS_FILE'],
      ['too many entries', buildZip([{ name: 'index.html', data: '<p>x</p>' }, ...Array.from({ length: 25 }, (_, i) => ({ name: `img/${i}.png`, data: PNG }))]), 'TOO_MANY_ENTRIES'],
      ['oversized file', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: 'big.png', data: crypto.randomBytes(1.5 * 1024 * 1024) }]), 'TOO_LARGE'],
      ['zip bomb', buildZip([{ name: 'index.html', data: '<p>x</p>' }, { name: 'bomb.png', data: Buffer.alloc(900 * 1024 + 300 * 1024), deflate: true }]), null],
      ['lying size', buildZip([{ name: 'index.html', data: Buffer.alloc(200 * 1024, 0x61), deflate: true, declaredSize: 10 }]), null],
      ['not a zip', Buffer.from('<html>not a zip</html>'), 'INVALID_ZIP'],
      ['no html', buildZip([{ name: 'images/logo.png', data: PNG }]), 'NO_HTML'],
      ['duplicate names', buildZip([{ name: 'index.html', data: '<p>1</p>' }, { name: 'INDEX.html', data: '<p>2</p>' }]), 'UNSAFE_ENTRY']
    ];
    for (const [label, buf, code] of cases) {
      const r = await upload(C, 'pkg.zip', buf);
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.data)}`);
      if (code) assert.equal(r.data.code, code, label);
      else assert.ok(['ZIP_BOMB', 'TOO_LARGE', 'INVALID_ZIP'].includes(r.data.code), `${label}: ${r.data.code}`);
      assert.doesNotMatch(JSON.stringify(r.data), new RegExp(STORAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no server paths in errors');
    }
    assert.equal(await assetCount(C.workspaceId), 0);
    assert.equal(filesOnDisk(C.workspaceId), 0);

    // A file whose content does not match its extension is not stored.
    const fake = await upload(C, 'fake.zip', buildZip([{ name: 'index.html', data: '<img src="logo.png">' }, { name: 'logo.png', data: '<script>alert(1)</script>' }]));
    assert.equal(fake.status, 200);
    assert.ok(fake.data.warnings.some(w => /logo\.png \(content is not a valid PNG file\)/.test(w)));
    assert.equal(await assetCount(C.workspaceId), 0);
    // An .svg is not stored (scripts possible); it is reported.
    const svg = await upload(C, 'svg.zip', buildZip([{ name: 'index.html', data: '<img src="i.svg">' }, { name: 'i.svg', data: '<svg onload="x()"/>' }]));
    assert.ok(svg.data.warnings.some(w => /Unsupported or invalid files.*i\.svg/.test(w)));
  } finally {
    delete process.env.MAIL_TEMPLATE_ZIP_MAX_ENTRIES;
    delete process.env.MAIL_TEMPLATE_ZIP_MAX_FILE_MB;
  }
});

test('assets: another workspace cannot claim or reference them; URLs stay valid after template edits and deletion', async () => {
  const r = await upload(A, 'brand.zip', buildZip([{ name: 'index.html', data: '<img src="logo.png">' }, { name: 'logo.png', data: PNG }]));
  const [id] = assetIds(r.data.html);
  // B tries to claim A's import and reference A's asset by internal reference.
  const b = await t(B, 'POST', '', { name: 'Steal', html: `<img src="mkt-asset://${id}">`, importId: r.data.importId });
  assert.doesNotMatch(b.data.template.html, new RegExp(id));
  assert.equal((await db().get('SELECT template_id, import_id FROM mail_template_assets WHERE public_id = ?', [id])).import_id, r.data.importId, 'not claimed by B');

  const saved = await t(A, 'POST', '', { name: 'Brand', html: r.data.html, importId: r.data.importId });
  const url = `/api/v1/mail/assets/${id}`;
  await t(A, 'PATCH', `/${saved.data.template.id}`, { name: 'Brand v2' });
  await t(A, 'POST', `/${saved.data.template.id}/duplicate`);
  assert.equal((await h.api('GET', url)).status, 200);
  await t(A, 'DELETE', `/${saved.data.template.id}`);
  assert.equal((await h.api('GET', url)).status, 200, 'still served after the template is deleted');
});

test('cleanup removes only unreferenced, old assets; images used by campaigns and emails are kept', async () => {
  const D = await h.createWorkspace({ name: 'Templates cleanup' });
  const mk = async name => {
    const r = await upload(D, `${name}.zip`, buildZip([{ name: 'index.html', data: '<img src="a.png">' }, { name: 'a.png', data: Buffer.concat([PNG, Buffer.from(name)]) }]));
    return { r, id: assetIds(r.data.html)[0] };
  };
  const orphan = await mk('orphan');
  const forCampaign = await mk('campaign');
  const tpl = await t(D, 'POST', '', { name: 'C', html: forCampaign.r.data.html, importId: forCampaign.r.data.importId });
  const campaign = await h.api('POST', '/api/v1/mail/campaigns', { token: D.token, body: { name: 'From template', templateId: tpl.data.template.id } });
  assert.equal(campaign.status, 200, JSON.stringify(campaign.data));
  await t(D, 'DELETE', `/${tpl.data.template.id}`);
  await db().run('UPDATE mail_template_assets SET created_at = UTC_TIMESTAMP() - INTERVAL 3 DAY WHERE workspace_id = ?', [D.workspaceId]);

  const member = await h.addMember(D.workspaceId, 'Member');
  assert.equal((await t(member, 'POST', '/assets/cleanup', {})).status, 403);
  const c = await t(D, 'POST', '/assets/cleanup', {});
  assert.equal(c.status, 200);
  assert.equal(c.data.removed, 1);
  assert.equal((await h.api('GET', `/api/v1/mail/assets/${orphan.id}`)).status, 404);
  assert.equal((await h.api('GET', `/api/v1/mail/assets/${forCampaign.id}`)).status, 200, 'kept for the campaign');
  assert.equal(filesOnDisk(D.workspaceId), 1);
});

// ------------------------------------------------------------------ use in Mail Center workflows

test('Email Campaigns: a template is copied into a new campaign; edits stay independent; approval resets on change', async () => {
  const tpl = await t(A, 'POST', '', { name: 'Campaign base', html: '<p>Big news</p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>' });
  const c = await h.api('POST', '/api/v1/mail/campaigns', { token: A.token, body: { name: 'Oct', templateId: tpl.data.template.id, subject: 'News', fromEmail: 'news@acme-co.io' } });
  assert.match(c.data.campaign.html, /Big news/);
  const id = c.data.campaign.id;
  await t(A, 'PATCH', `/${tpl.data.template.id}`, { html: '<p>Template changed</p>' });
  assert.match((await h.api('GET', `/api/v1/mail/campaigns/${id}`, { token: A.token })).data.campaign.html, /Big news/, 'campaign copy unaffected');

  // Approve (bypassing Zoho checks by marking approved directly), then an edit resets approval.
  await db().run("UPDATE mail_campaigns SET status = 'approved', approved_version = version, approved_by = ? WHERE id = ?", [A.userId, id]);
  const edited = await h.api('PATCH', `/api/v1/mail/campaigns/${id}`, { token: A.token, body: { html: '<p>Edited</p><script>x()</script>' } });
  assert.equal(edited.data.campaign.status, 'draft');
  assert.equal(edited.data.campaign.approved, false);
  assert.doesNotMatch(edited.data.campaign.html, /<script/, 'campaign HTML sanitized on save');
  assert.equal((await h.api('POST', '/api/v1/mail/campaigns', { token: B.token, body: { name: 'x', templateId: tpl.data.template.id } })).status, 404, 'another workspace\'s template');

  // Personalization tokens are flagged for Zoho delivery.
  const tok = await h.api('POST', '/api/v1/mail/campaigns', { token: A.token, body: { name: 'Tok', html: '<p>Hi {{first_name}}</p>' } });
  const v = await h.api('POST', `/api/v1/mail/campaigns/${tok.data.campaign.id}/validate`, { token: A.token });
  assert.ok(v.data.validation.problems.some(p => /Personalization tokens.*\{\{first_name\}\}/.test(p)));
});

test('Mail Drafts: a draft starts from a template copy; its {{tokens}} must be filled before approval', async () => {
  const tpl = await t(A, 'POST', '', { name: 'Follow-up', html: '<table><tr><td>Hi {{first_name}}, thanks for meeting {{company}}.</td></tr></table>' });
  const g = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { templateId: tpl.data.template.id, recipientEmail: 'dana@acme.io', recipientName: 'Dana', subject: 'Thanks' } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const d = g.data.draft;
  assert.equal(d.subject, 'Thanks');
  assert.match(d.body_html, /Hi \{\{first_name\}\}/);
  assert.match(d.body_text, /Hi \{\{first_name\}\}, thanks/);
  assert.deepEqual(d.placeholders.sort(), ['{{company}}', '{{first_name}}']);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token })).data.code, 'UNRESOLVED_PLACEHOLDERS');
  const filled = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { replacements: { '{{first_name}}': 'Dana', '{{company}}': 'Acme <Fleet>' } } });
  assert.equal(filled.status, 200, JSON.stringify(filled.data));
  assert.match(filled.data.draft.body_html, /Hi Dana, thanks for meeting Acme &lt;Fleet&gt;/);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token })).status, 200);
  assert.match((await t(A, 'GET', `/${tpl.data.template.id}`)).data.template.html, /\{\{first_name\}\}/, 'template unchanged');
  assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: B.token, body: { templateId: tpl.data.template.id } })).status, 404);
});

test('Compose & Send: template HTML with unfilled {{tokens}} is not sent; filled, it is sent once with a plain-text part', async () => {
  await h.api('POST', '/api/v1/mail/config', { token: A.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-a', sender_email: 'news@acme-co.io' } });
  const tpl = (await t(A, 'GET', `/${(await t(A, 'POST', '', { name: 'Compose', html: '<p>Hello {{first_name}}</p>' })).data.template.id}`)).data.template;
  const calls = [];
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { calls.push(JSON.parse(init.body)); return h.json(200, { request_id: 'r1' }); } }]);
  const key = { 'Idempotency-Key': crypto.randomBytes(16).toString('hex') };
  try {
    const blocked = await h.api('POST', '/api/v1/emails/send-html', { token: A.token, headers: key, body: { recipient_email: 'kim@client.io', subject: 'Hi', html_body: tpl.html, confirm: true } });
    assert.equal(blocked.data.code, 'UNRESOLVED_PLACEHOLDERS');
    const sent = await h.api('POST', '/api/v1/emails/send-html', { token: A.token, headers: key, body: { recipient_email: 'kim@client.io', subject: 'Hi', html_body: tpl.html.replace('{{first_name}}', 'Kim'), confirm: true } });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
  } finally { mock.restore(); }
  assert.equal(calls.length, 1);
  assert.match(calls[0].textbody, /Hello Kim/);
});
