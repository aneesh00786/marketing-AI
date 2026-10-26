/**
 * Builds a release archive of the committed code and verifies it contains no secrets or
 * runtime data.
 *
 *   npm run package                 (from the repository root)
 *   node backend/scripts/packageRelease.js [--out <file.zip>] [--ref <git ref>]
 *
 * The archive is made with `git archive`, so only tracked files are included: .env, uploaded
 * media (backend/storage), logs, databases and archives are ignored by git and can never be
 * packaged. Uncommitted changes are not packaged either: commit what you intend to ship.
 * The finished archive is then listed and checked against FORBIDDEN; any match deletes the
 * archive and exits with status 1. Only file names are inspected, never contents.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FORBIDDEN = [
  { re: /(^|\/)\.env$/i, why: 'environment file with secrets' },
  { re: /(^|\/)\.env\.(?!example$)[^/]+$/i, why: 'environment file with secrets' },
  { re: /(^|\/)storage\//i, why: 'runtime storage (uploaded media)' },
  { re: /(^|\/)logs?\//i, why: 'log directory' },
  { re: /\.log$/i, why: 'log file' },
  { re: /\.(db|db-journal|sqlite|sqlite3)$/i, why: 'database file' },
  { re: /\.(sql|dump|bak)$/i, why: 'database dump or backup' },
  { re: /\.(zip|tar|tgz|gz|7z|rar)$/i, why: 'nested archive' },
  { re: /\.(pem|key|p12|pfx|crt)$/i, why: 'key or certificate' },
  { re: /(^|\/)(id_rsa|id_ed25519)/i, why: 'SSH key' },
  { re: /(^|\/)\.git\//, why: 'git metadata (full history)' },
  { re: /(^|\/)node_modules\//, why: 'dependencies (install on the server)' },
  { re: /(^|\/)(\.DS_Store|__MACOSX\/)/, why: 'OS metadata' },
  { re: /(^|\/)(credentials?|secrets?|tokens?)\.(json|txt|ya?ml)$/i, why: 'credentials file' }
];

/** Entries that must not be in a release archive, with the reason. */
function forbiddenEntries(names) {
  const out = [];
  for (const name of names) {
    const rule = FORBIDDEN.find(r => r.re.test(name));
    if (rule) out.push({ name, why: rule.why });
  }
  return out;
}

function listZip(file) {
  const yauzl = require(path.join(__dirname, '../node_modules/yauzl'));
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names = [];
      zip.on('entry', e => { names.push(e.fileName); zip.readEntry(); });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function main(argv) {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: __dirname, encoding: 'utf8' }).trim();
  const arg = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
  const ref = arg('--ref', 'HEAD');
  const sha = execFileSync('git', ['rev-parse', '--short', ref], { cwd: repo, encoding: 'utf8' }).trim();
  const out = path.resolve(arg('--out', path.join(repo, 'release', `marketing-AI-${sha}.zip`)));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim();
  if (dirty && ref === 'HEAD') console.warn('Note: uncommitted changes exist and are NOT included; the package is the committed state of HEAD.');

  execFileSync('git', ['archive', '--format=zip', '--prefix=marketing-AI/', '-o', out, ref], { cwd: repo });
  const names = await listZip(out);
  const bad = forbiddenEntries(names);
  if (bad.length) {
    fs.unlinkSync(out);
    console.error('Package REJECTED; it would contain:');
    for (const b of bad) console.error(`  ${b.name}  (${b.why})`);
    process.exit(1);
  }
  const size = fs.statSync(out).size;
  console.log(`Package OK: ${out} (${names.length} entries, ${(size / 1048576).toFixed(2)} MB, commit ${sha}). No secrets, media, logs, databases or archives.`);
  return { out, names };
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { FORBIDDEN, forbiddenEntries, listZip, main };
