const crypto = require('crypto');
const { run, get, all } = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'tradesage-enterprise-jwt-secret-key-2026';

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
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7); // 7 days
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  if (expectedSig !== signature) return null;

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

async function registerUser(email, password, displayName, workspaceName = 'My Workspace', industry = 'Software') {
  const cleanEmail = (email || '').toLowerCase().trim();
  if (!cleanEmail || !password) {
    throw new Error('Email and password are required.');
  }

  const existing = await get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
  if (existing) {
    throw new Error('A user with this email already exists.');
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const passHash = hashPassword(password);

  // 1. Create User
  const userRes = await run(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Active', ?, ?)`,
    [cleanEmail, passHash, displayName || cleanEmail.split('@')[0], now, now, now]
  );
  const userId = userRes.lastID;

  // 2. Create Workspace
  const slug = (workspaceName || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.floor(1000 + Math.random() * 9000);
  const wsRes = await run(
    `INSERT INTO workspaces (name, slug, owner_email, plan, status, created_at)
     VALUES (?, ?, ?, 'Starter', 'Active', ?)`,
    [workspaceName || 'My Business Workspace', slug, cleanEmail, now]
  );
  const workspaceId = wsRes.lastID;

  // 3. Add workspace member
  await run(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
     VALUES (?, ?, 'Workspace Owner', 'Active', ?)`,
    [workspaceId, userId, now]
  );

  // 4. Create Business Profile
  await run(
    `INSERT INTO business_profiles (
      workspace_id, business_name, industry, website_url, description,
      products_json, brand_voice, brand_colors_json, created_at
    ) VALUES (?, ?, ?, '', '', '[]', 'Professional & Authoritative', '{"primary":"#00f0ff"}', ?)`,
    [workspaceId, workspaceName, industry, now]
  );

  // 5. Create default Subscription
  const starterPlan = await get('SELECT id FROM plans WHERE plan_key = ?', ['starter']);
  await run(
    `INSERT INTO subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES (?, ?, 'Active', ?, date(?, '+30 days'), ?)`,
    [workspaceId, starterPlan?.id || 1, now, now, now]
  );

  const token = createToken({ userId, email: cleanEmail, workspaceId, role: 'Workspace Owner' });

  return {
    token,
    user: { id: userId, email: cleanEmail, displayName: displayName || cleanEmail.split('@')[0] },
    workspace: { id: workspaceId, name: workspaceName, slug, plan: 'Starter' }
  };
}

async function loginUser(email, password) {
  const cleanEmail = (email || '').toLowerCase().trim();
  const user = await get('SELECT * FROM users WHERE email = ?', [cleanEmail]);
  if (!user) {
    throw new Error('Invalid email or password.');
  }

  const isValid = verifyPassword(password, user.password_hash);
  if (!isValid) {
    throw new Error('Invalid email or password.');
  }

  // Get workspace
  const member = await get('SELECT * FROM workspace_members WHERE user_id = ? LIMIT 1', [user.id]);
  const workspace = await get('SELECT * FROM workspaces WHERE id = ?', [member?.workspace_id || 1]);

  const token = createToken({
    userId: user.id,
    email: user.email,
    workspaceId: workspace?.id || 1,
    role: member?.role || 'Workspace Owner'
  });

  return {
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name },
    workspace: workspace || { id: 1, name: 'TradeSage Enterprise', plan: 'Starter' }
  };
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
    subscription: subscription || { plan_name: 'Professional', credits_allowance: 10000, video_minutes: 30, phone_minutes: 100 }
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  registerUser,
  loginUser,
  getUserMe
};
