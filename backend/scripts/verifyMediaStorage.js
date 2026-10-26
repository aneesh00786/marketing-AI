/**
 * Read-only consistency check between the database and the media folders (SOCIAL_MEDIA_STORAGE_DIR
 * for social uploads, MAIL_ASSET_STORAGE_DIR for email template images), for use after a restore,
 * a server move or before a deployment:
 *
 *   node scripts/verifyMediaStorage.js            (from backend/)
 *
 * Reports uploaded media recorded as live whose file is missing or has the wrong size (posts using
 * them cannot publish until re-uploaded), and files on disk that no record refers to (safe to keep).
 * Nothing is changed. Exit status 1 when any recorded file is missing or damaged.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function verify({ all, storageRoot, sql = "SELECT id, workspace_id, public_id, size_bytes FROM assets WHERE source = 'upload' AND status = 'ready' AND public_id IS NOT NULL" }) {
  const rows = await all(sql);
  const missing = [];
  const damaged = [];
  const known = new Set();
  for (const r of rows) {
    const p = path.join(storageRoot, String(Number(r.workspace_id)), r.public_id);
    known.add(p);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (!st) missing.push({ assetId: r.id, workspaceId: r.workspace_id });
    else if (r.size_bytes !== null && st.size !== Number(r.size_bytes)) damaged.push({ assetId: r.id, workspaceId: r.workspace_id });
  }
  const orphans = [];
  let dirs = [];
  try { dirs = fs.readdirSync(storageRoot).filter(d => /^\d+$/.test(d)); } catch (e) { dirs = []; }
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(storageRoot, d))) {
      if (/^[A-Za-z0-9_-]{43}$/.test(f) && !known.has(path.join(storageRoot, d, f))) orphans.push(`${d}/${f}`);
    }
  }
  return { checked: rows.length, missing, damaged, orphans };
}

const MAIL_SQL = 'SELECT id, workspace_id, public_id, size_bytes FROM mail_template_assets';

if (require.main === module) {
  const { all, closeDatabase } = require('../db/database');
  const social = require('../modules/social/mediaStore').storageRoot();
  const mail = require('../modules/mail/templates/assetStore').storageRoot();
  (async () => {
    let bad = 0;
    for (const [label, root, sql] of [['Social media', social, undefined], ['Mail template assets', mail, MAIL_SQL]]) {
      let r;
      try {
        r = await verify({ all, storageRoot: root, ...(sql ? { sql } : {}) });
      } catch (err) {
        // Before migration 023 the assets table has no uploads (no public_id column): nothing to check.
        if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
        console.log(`${label}: database has no uploaded files yet (migration 023 not applied); nothing to check.`);
        continue;
      }
      console.log(`${label} folder: ${root}`);
      console.log(`  Checked ${r.checked} recorded files: ${r.missing.length} missing, ${r.damaged.length} damaged; ${r.orphans.length} unreferenced file(s).`);
      for (const m of r.missing) console.log(`  missing: #${m.assetId} (workspace ${m.workspaceId})`);
      for (const m of r.damaged) console.log(`  wrong size: #${m.assetId} (workspace ${m.workspaceId})`);
      bad += r.missing.length + r.damaged.length;
    }
    await closeDatabase();
    process.exit(bad ? 1 : 0);
  })().catch(async err => { console.error(err.message); await closeDatabase().catch(() => {}); process.exit(1); });
}

module.exports = { verify, MAIL_SQL };
