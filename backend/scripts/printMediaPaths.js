/**
 * Prints the two media folders this backend uses, exactly as the API and worker resolve them:
 *   line 1: social media (SOCIAL_MEDIA_STORAGE_DIR)   line 2: mail template assets (MAIL_ASSET_STORAGE_DIR)
 * Used by the staging backup/restore scripts. Nothing else is written to stdout (module banners
 * are suppressed), so the output can be captured safely. Read-only.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const log = console.log;
console.log = () => {};
const social = require('../modules/social/mediaStore').storageRoot();
const mail = require('../modules/mail/templates/assetStore').storageRoot();
console.log = log;
process.stdout.write(`${social}\n${mail}\n`);
process.exit(0);
