/**
 * A stand-in IMAP server for tests: replaces ImapFlow's methods (nothing connects anywhere). Folders hold messages
 * with stable UIDs; fetch honours "start:*" ranges by sequence number or UID, like a real server.
 */
const { ImapFlow } = require('imapflow');

function install() {
  const imap = {
    folders: { INBOX: [] },
    junk: null,
    uidValidity: 1,
    logins: [],
    fail: null,
    flagOps: [],
    nextUid: {},
    /** Adds a message to a folder: { id, source, flags? }. */
    push(folder, m) {
      if (!this.folders[folder]) this.folders[folder] = [];
      this.nextUid[folder] = (this.nextUid[folder] || 0) + 1;
      this.folders[folder].push({ ...m, uid: this.nextUid[folder] });
    },
    reset() { this.folders = { INBOX: [] }; this.junk = null; this.nextUid = {}; this.flagOps = []; this.fail = null; this.logins = []; }
  };
  const proto = ImapFlow.prototype;
  proto.connect = async function () {
    imap.logins.push({ host: this.options.host, user: this.options.auth.user, pass: this.options.auth.pass });
    if (imap.fail) { const e = new Error('Command failed'); e.authenticationFailed = true; throw e; }
  };
  proto.logout = async () => {};
  proto.list = async () => [{ path: 'INBOX', name: 'INBOX' }, ...(imap.junk ? [{ path: imap.junk, name: imap.junk, specialUse: '\\Junk' }] : [])];
  proto.getMailboxLock = async function (path) {
    const f = imap.folders[path];
    if (!f) throw new Error(`No folder ${path}`);
    this._folder = path;
    this.mailbox = { path, uidValidity: BigInt(imap.uidValidity), exists: f.length, uidNext: (imap.nextUid[path] || 0) + 1 };
    return { release() {} };
  };
  proto.status = async function (path) { const f = imap.folders[path] || []; return { messages: f.length, unseen: f.length }; };
  proto.fetch = async function* (range, query, opts = {}) {
    const f = imap.folders[this._folder] || [];
    const start = Number(String(range).split(':')[0]) || 1;
    for (let i = 0; i < f.length; i++) {
      const m = f[i];
      if ((opts.uid ? m.uid : i + 1) >= start) yield { seq: i + 1, uid: m.uid, envelope: { messageId: `<${m.id}>` }, flags: new Set(m.flags || []) };
    }
  };
  proto.fetchOne = async function (uid) {
    const m = (imap.folders[this._folder] || []).find(x => String(x.uid) === String(uid));
    return m ? { uid: m.uid, source: m.source } : false;
  };
  proto.messageFlagsAdd = async function (uid, flags) { imap.flagOps.push({ folder: this._folder, uid: Number(uid), add: flags }); return true; };
  proto.messageFlagsRemove = async function (uid, flags) { imap.flagOps.push({ folder: this._folder, uid: Number(uid), remove: flags }); return true; };
  return imap;
}

/** A raw email (MIME). Optional: inReplyTo, references, attachment { filename, contentType, content }. */
function rawEmail({ from = 'kim@kimco.io', subject = 'Hello', id, inReplyTo = null, references = null, body = 'Thanks, sounds good.', attachment = null }) {
  const head = [`From: Kim <${from}>`, 'To: x@x.io', `Subject: ${subject}`, `Message-ID: <${id}>`, 'Date: Fri, 20 Nov 2026 10:00:00 +0000', 'MIME-Version: 1.0'];
  if (inReplyTo) head.push(`In-Reply-To: ${inReplyTo}`);
  if (references) head.push(`References: ${references}`);
  if (!attachment) return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'));
  const b = 'BOUNDARY42';
  return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', body,
    `--${b}`, `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`, `Content-Disposition: attachment; filename="${attachment.filename}"`, 'Content-Transfer-Encoding: base64', '',
    Buffer.from(attachment.content).toString('base64'), `--${b}--`, ''].join('\r\n'));
}

module.exports = { install, rawEmail };
