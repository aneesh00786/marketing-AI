const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { forbiddenEntries, listZip } = require('../scripts/packageRelease');

// Release packaging must never include secrets or runtime data. Only file names are inspected.
const REPO = path.resolve(__dirname, '../..');

test('the package rules reject secrets, media, logs, databases, archives and git metadata', () => {
  const bad = forbiddenEntries([
    'marketing-AI/backend/.env',
    'marketing-AI/backend/.env.production',
    'marketing-AI/backend/storage/social-media/2/abc',
    'marketing-AI/backend/storage/mail-assets/1/x',
    'marketing-AI/backend/logs/api.log',
    'marketing-AI/tradesage.db',
    'marketing-AI/backup.sql',
    'marketing-AI/marketing-AI.zip',
    'marketing-AI/.git/config',
    'marketing-AI/certs/server.key',
    'marketing-AI/.DS_Store'
  ]).map(b => b.name);
  assert.equal(bad.length, 11);
  assert.deepEqual(forbiddenEntries([
    'marketing-AI/backend/.env.example',
    'marketing-AI/backend/lib/secretBox.js',
    'marketing-AI/backend/server.js',
    'marketing-AI/frontend/dist/frontend/browser/index.html'
  ]), []);
});

test('a real archive containing .env and uploaded media is detected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-pkg-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'app/backend/storage/social-media'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/backend/.env'), 'PLACEHOLDER=1\n');
    fs.writeFileSync(path.join(dir, 'app/backend/storage/social-media/file'), 'x');
    fs.writeFileSync(path.join(dir, 'app/backend/server.js'), '//');
    execFileSync('zip', ['-qr', 'out.zip', 'app'], { cwd: dir });
    const names = await listZip(path.join(dir, 'out.zip'));
    assert.deepEqual(forbiddenEntries(names).map(b => b.name).sort(), ['app/backend/.env', 'app/backend/storage/', 'app/backend/storage/social-media/', 'app/backend/storage/social-media/file'].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git keeps ignoring secrets and runtime data, so `git archive` packages can never contain them', () => {
  for (const p of ['backend/.env', 'backend/storage/social-media/1/x', 'backend/logs/api.log', 'tradesage.db', 'release/marketing-AI-abc.zip']) {
    const ignored = (() => { try { execFileSync('git', ['check-ignore', '-q', p], { cwd: REPO }); return true; } catch (e) { return false; } })();
    assert.ok(ignored, `${p} must be git-ignored`);
  }
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(forbiddenEntries(tracked.map(f => `marketing-AI/${f}`)), [], 'no forbidden file is tracked by git');
});
