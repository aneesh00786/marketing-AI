const crypto = require('crypto');
const { run, get, all, withTransaction } = require('../db/database');

const MIN_SECRET_LENGTH = 32;

// The signing secret must come from the environment. A missing secret is fatal in
// production; in development a random per-process secret is used (tokens reset on restart).
let JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < MIN_SECRET_LENGTH) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`JWT_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters in production.`);
  }
  console.warn('[auth] JWT_SECRET missing or too short; using an ephemeral development secret.');
  JWT_SECRET = crypto.randomBytes(48).toString('base64url');
}
const TOKEN_TTL_SECONDS = parseInt(process.env.JWT_TTL_SECONDS || String(60 * 60 * 12), 10);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  if (keyBuffer.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ ...payload, iat, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(expectedSig);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Expired
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function authError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const nowSql = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const MAX_OWNED_WORKSPACES = () => parseInt(process.env.MAX_OWNED_WORKSPACES || '10', 10);

/** Runs fn({ run, get }) in one transaction (MySQL); other clients run the statements in order. */
async function atomically(fn) {
  if ((process.env.DB_CLIENT || 'mysql') === 'mysql') return withTransaction(fn);
  return fn({ run, get, all });
}

function cleanWorkspaceName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 100) throw authError('Workspace name must be 2 to 100 characters.', 400, 'VALIDATION_ERROR');
  return n;
}

/**
 * Creates a workspace with its owner membership, business profile and (when the starter plan
 * exists) a subscription, using the caller's transaction.
 */
async function createWorkspaceRecords(tx, { name, industry, ownerEmail, userId }) {
  const now = nowSql();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-${crypto.randomBytes(3).toString('hex')}`;
  const ws = await tx.run(
    `INSERT INTO workspaces (name, slug, owner_email, plan, status, created_at)
     VALUES (?, ?, ?, 'Starter', 'Active', ?)`,
    [name, slug, ownerEmail, now]
  );
  const workspaceId = ws.lastID;
  await tx.run(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
     VALUES (?, ?, 'Workspace Owner', 'Active', ?)`,
    [workspaceId, userId, now]
  );
  await tx.run(
    `INSERT INTO business_profiles (
      workspace_id, business_name, industry, website_url, description,
      products_json, brand_voice, brand_colors_json, created_at
    ) VALUES (?, ?, ?, '', '', '[]', 'Professional & Authoritative', '{"primary":"#00f0ff"}', ?)`,
    [workspaceId, name, industry || 'Software', now]
  );
  const starterPlan = await tx.get('SELECT id FROM plans WHERE plan_key = ?', ['starter']);
  if (starterPlan) {
    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    await tx.run(
      `INSERT INTO subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES (?, ?, 'Active', ?, ?, ?)`,
      [workspaceId, starterPlan.id, now, periodEnd, now]
    );
  }
  return { id: workspaceId, name, slug, plan: 'Starter' };
}

/** Active memberships of the user in active workspaces, oldest first. */
async function listMemberships(userId) {
  const rows = await all(
    `SELECT w.id, w.name, w.slug, w.plan, m.role
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? AND m.status = 'Active' AND (w.status IS NULL OR w.status = 'Active')
     ORDER BY m.id ASC`,
    [userId]
  );
  return rows.map(r => ({ id: r.id, name: r.name, slug: r.slug, plan: r.plan, role: r.role }));
}

/** Issues a token for one workspace after checking the user is an active member of it. */
async function sessionFor(user, workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw authError('Invalid workspace.', 400, 'VALIDATION_ERROR');
  const workspaces = await listMemberships(user.id);
  const membership = workspaces.find(w => w.id === id);
  if (!membership) throw authError('You are not an active member of that workspace.', 403, 'NOT_A_MEMBER');
  const token = createToken({ userId: user.id, email: user.email, workspaceId: id, role: membership.role });
  return {
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name },
    workspace: { id: membership.id, name: membership.name, slug: membership.slug, plan: membership.plan },
    role: membership.role,
    workspaces
  };
}

async function registerUser(email, password, displayName, workspaceName = 'My Workspace', industry = 'Software') {
  const cleanEmail = (email || '').toLowerCase().trim();
  if (!cleanEmail || !password) {
    throw new Error('Email and password are required.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Enter a valid email address.');
  }
  if (String(password).length < 10) {
    throw new Error('Password must be at least 10 characters.');
  }
  const existing = await get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
  if (existing) {
    throw new Error('A user with this email already exists.');
  }
  const name = cleanWorkspaceName(workspaceName || 'My Business Workspace');
  const now = nowSql();
  const passHash = hashPassword(password);
  const display = displayName || cleanEmail.split('@')[0];

  // User, workspace, owner membership, profile and subscription are created together or not at all.
  const { userId, workspace } = await atomically(async tx => {
    const userRes = await tx.run(
      `INSERT INTO users (email, password_hash, display_name, email_verified_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Active', ?, ?)`,
      [cleanEmail, passHash, display, now, now, now]
    );
    const ws = await createWorkspaceRecords(tx, { name, industry, ownerEmail: cleanEmail, userId: userRes.lastID });
    return { userId: userRes.lastID, workspace: ws };
  });

  const token = createToken({ userId, email: cleanEmail, workspaceId: workspace.id, role: 'Workspace Owner' });
  return {
    token,
    user: { id: userId, email: cleanEmail, displayName: display },
    workspace,
    role: 'Workspace Owner',
    workspaces: [{ ...workspace, role: 'Workspace Owner' }]
  };
}

/**
 * Signs in. Without workspaceId the first active membership is used (unchanged behaviour); with
 * it, the user must be an active member of that workspace.
 */
async function loginUser(email, password, workspaceId = null) {
  const cleanEmail = (email || '').toLowerCase().trim();
  const user = await get('SELECT * FROM users WHERE email = ?', [cleanEmail]);
  if (!user) {
    throw new Error('Invalid email or password.');
  }
  const isValid = verifyPassword(password, user.password_hash);
  if (!isValid) {
    throw new Error('Invalid email or password.');
  }
  if (user.status && user.status !== 'Active') {
    throw new Error('This account is not active.');
  }
  const workspaces = await listMemberships(user.id);
  if (!workspaces.length) {
    throw new Error('This account is not a member of any active workspace.');
  }
  const target = workspaceId === null || workspaceId === undefined || workspaceId === '' ? workspaces[0].id : workspaceId;
  return sessionFor(user, target);
}

/** New token for another workspace of the signed-in user (membership is checked). */
async function switchWorkspace(userId, workspaceId) {
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || (user.status && user.status !== 'Active')) throw authError('This account is not active.', 401, 'UNAUTHENTICATED');
  return sessionFor(user, workspaceId);
}

/** Creates another workspace owned by the signed-in user and returns a session for it. */
async function createWorkspaceForUser(userId, { name, industry } = {}) {
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || (user.status && user.status !== 'Active')) throw authError('This account is not active.', 401, 'UNAUTHENTICATED');
  const cleanName = cleanWorkspaceName(name);
  const owned = await get("SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ? AND role = 'Workspace Owner' AND status = 'Active'", [userId]);
  if (Number(owned.n) >= MAX_OWNED_WORKSPACES()) {
    throw authError(`You can own at most ${MAX_OWNED_WORKSPACES()} workspaces.`, 409, 'WORKSPACE_LIMIT');
  }
  const workspace = await atomically(tx => createWorkspaceRecords(tx, {
    name: cleanName, industry: String(industry || '').trim().slice(0, 100) || 'Software', ownerEmail: user.email, userId
  }));
  return sessionFor(user, workspace.id);
}

async function getUserMe(userId, workspaceId) {
  const user = await get('SELECT id, email, display_name, status, created_at FROM users WHERE id = ?', [userId]);
  const workspace = await get('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
  const profile = await get('SELECT * FROM business_profiles WHERE workspace_id = ?', [workspaceId]);
  const subscription = await get(
    `SELECT s.*, p.name as plan_name, p.plan_key, p.credits_allowance, p.video_minutes, p.phone_minutes
     FROM subscriptions s
     JOIN plans p ON s.plan_id = p.id
     WHERE s.workspace_id = ? ORDER BY s.id DESC LIMIT 1`,
    [workspaceId]
  );
  if (profile && profile.products_json) {
    try { profile.products = JSON.parse(profile.products_json); } catch (e) { profile.products = []; }
  }
  return {
    user,
    workspace,
    businessProfile: profile,
    // The real subscription, or null with an explicit status: no plan or credits are assumed.
    subscription: subscription || null,
    subscriptionStatus: subscription ? (subscription.status || 'unknown') : 'none',
    workspaces: await listMemberships(userId)
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  registerUser,
  loginUser,
  switchWorkspace,
  createWorkspaceForUser,
  listMemberships,
  getUserMe
};
