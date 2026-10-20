/**
 * Sets (or resets) a user's password.
 *
 *   npm run set-password -- admin@tradesage.ai
 *
 * The password is read from a hidden prompt (or NEW_PASSWORD for automation)
 * and stored as a scrypt hash. Nothing is printed back.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const readline = require('readline');
const { get, run, closeDatabase } = require('../db/database');
const { hashPassword } = require('../services/authService');

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (str) => {
      if (str.includes(question)) rl.output.write(str);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const email = String(process.argv[2] || '').toLowerCase().trim();
  if (!email) throw new Error('Usage: npm run set-password -- <email>');
  const user = await get('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) throw new Error(`No user with email ${email}.`);

  let password = process.env.NEW_PASSWORD;
  if (!password) {
    password = await promptHidden('New password (min 10 characters): ');
    const confirm = await promptHidden('Repeat password: ');
    if (password !== confirm) throw new Error('Passwords do not match.');
  }
  if (!password || password.length < 10) throw new Error('Password must be at least 10 characters.');

  await run("UPDATE users SET password_hash = ?, status = 'Active', updated_at = UTC_TIMESTAMP() WHERE id = ?", [hashPassword(password), user.id]);
  console.log(`Password updated for ${email}.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
