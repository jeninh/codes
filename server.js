require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { readCodes, writeCodes } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const HERMES_API_KEY = process.env.HERMES_API_KEY;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_EMAIL = 'jenin@hackclub.com';

// ==================== RATE LIMITING ====================
const rateLimitBuckets = new Map();

function rateLimit(keyPrefix, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);

    if (!bucket || now - bucket.windowStart > windowMs) {
      bucket = { windowStart: now, count: 0 };
      rateLimitBuckets.set(key, bucket);
    }

    bucket.count++;

    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    next();
  };
}

// Clean up stale buckets every 5 minutes (only when running as server)
if (!process.env.VERCEL) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets) {
      if (now - bucket.windowStart > 600000) rateLimitBuckets.delete(key);
    }
  }, 300000);
}

// ==================== SECURITY HEADERS ====================
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; worker-src 'none'"
  });
  next();
});

// Trust proxy for accurate IP behind reverse proxy
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple cookie parsing
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    cookies[name] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

// Sign/verify session tokens
function signToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

// Get admin session from cookie
function getAdminSession(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies.admin_session);
}

// ==================== PUBLIC ROUTES ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// 10 validate attempts per IP per minute (anti brute-force)
app.post('/api/validate-code', rateLimit('validate', 10, 60000), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string' || code.length > 100) {
    return res.json({ valid: false, contents: null });
  }

  const codes = await readCodes();
  const entry = codes[code.toUpperCase()];

  if (!entry) return res.json({ valid: false, contents: null });
  if (entry.redeemed) return res.json({ valid: false, contents: null, error: 'This code has already been redeemed' });

  res.json({
    valid: true,
    contents: {
      rubber_stamps: entry.rubber_stamps,
      mail_type: entry.mail_type
    }
  });
});

// 5 redeem attempts per IP per 10 minutes
app.post('/api/redeem', rateLimit('redeem', 5, 600000), async (req, res) => {
  const {
    code, first_name, last_name,
    address_line_1, address_line_2,
    city, state, postal_code, country, email
  } = req.body;

  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Code is required' });

  // Validate required fields
  const required = { first_name, last_name, address_line_1, city, state, postal_code, country };
  for (const [field, value] of Object.entries(required)) {
    if (!value || typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: `${field} is required` });
    }
  }

  const codes = await readCodes();
  const upperCode = code.toUpperCase();
  const entry = codes[upperCode];

  if (!entry) return res.status(404).json({ error: 'Invalid code' });
  if (entry.redeemed) return res.status(400).json({ error: 'Code has already been redeemed' });

  if (!HERMES_API_KEY) return res.status(500).json({ error: 'Server misconfigured: missing API key' });

  const body = {
    first_name,
    last_name,
    address_line_1,
    address_line_2,
    city,
    state,
    postal_code,
    country,
    recipient_email: email,
    mail_type: entry.mail_type,
    rubber_stamps: entry.rubber_stamps,
    notes: `Redeemed via CODES - code: ${upperCode}`
  };

  if (entry.weight_grams) {
    body.weight_grams = entry.weight_grams;
  }

  try {
    const hermesRes = await fetch('https://fulfillment.hackclub.com/api/v1/letters', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HERMES_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const hermesData = await hermesRes.json();

    if (hermesRes.ok) {
      codes[upperCode].redeemed = true;
      codes[upperCode].redeemed_at = new Date().toISOString();
      codes[upperCode].redeemed_by = { first_name, last_name, email };
      codes[upperCode].letter_id = hermesData.letter_id;
      await writeCodes(codes);
    }

    if (hermesRes.ok) {
      res.json({
        success: true,
        letter_id: hermesData.letter_id,
        status: hermesData.status
      });
    } else {
      res.status(hermesRes.status).json({ error: 'Fulfillment request failed' });
    }
  } catch (err) {
    console.error('Hermes error:', err.message);
    res.status(500).json({ error: 'Failed to contact fulfillment service' });
  }
});

// ==================== ADMIN OAUTH ROUTES ====================

// 5 OAuth attempts per IP per 5 minutes
app.get('/admin/login', rateLimit('oauth', 5, 300000), (req, res) => {
  if (!OAUTH_CLIENT_ID) {
    return res.status(500).send('OAuth not configured. Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET.');
  }
  const state = crypto.randomBytes(32).toString('hex');
  const secureCookie = BASE_URL.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `oauth_state=${state}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie}`);
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: `${BASE_URL}/admin/callback`,
    response_type: 'code',
    scope: 'email',
    state
  });
  res.redirect(`https://auth.hackclub.com/oauth/authorize?${params}`);
});

// OAuth callback
app.get('/admin/callback', rateLimit('oauth-cb', 5, 300000), async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/admin/login');

  // CSRF: verify state matches the one we set in the cookie
  const cookies = parseCookies(req);
  if (!state || !cookies.oauth_state || state !== cookies.oauth_state) {
    return res.redirect('/admin/login');
  }
  try {
    // Exchange code for token
    const tokenRes = await fetch('https://auth.hackclub.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/admin/callback`,
        code,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.redirect('/admin/login');
    }

    // Get user info
    const userRes = await fetch('https://auth.hackclub.com/api/v1/me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    const userData = await userRes.json();
    const email = (userData.identity?.primary_email || userData.email)?.toLowerCase();

    if (email !== ADMIN_EMAIL) {
      return res.send(`
        <!DOCTYPE html>
        <html><head><title>Access Denied</title>
        <style>
          body { background: #0a0a0f; color: #fff; font-family: 'Inter', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: rgba(255,30,30,0.1); border: 1px solid rgba(255,30,30,0.3); border-radius: 16px; padding: 48px; text-align: center; max-width: 400px; }
          h1 { color: #ff4444; font-size: 2rem; margin-bottom: 8px; }
          p { color: #888; line-height: 1.6; }
          a { color: #00d4ff; }
        </style></head>
        <body><div class="card">
          <h1>🚫 Scram!</h1>
          <p>You're not authorized to access the admin panel.</p>
          <p style="margin-top: 24px"><a href="/">← Back to CODES</a></p>
        </div></body></html>
      `);
    }

    // Set signed session cookie and clear state cookie
    const sessionToken = signToken({ email, logged_in_at: Date.now() });
    const secureCookie = BASE_URL.startsWith('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureCookie}`,
      'oauth_state=; Path=/admin; HttpOnly; Max-Age=0'
    ]);
    res.redirect('/admin');

  } catch (err) {
    console.error('OAuth error:', err);
    res.redirect('/admin/login');
  }
});

// Admin logout
app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/');
});

// Admin page - serve the admin HTML
app.get('/admin', (req, res) => {
  const session = getAdminSession(req);
  if (!session || session.email !== ADMIN_EMAIL) {
    return res.redirect('/admin/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== ADMIN API ROUTES ====================

// Middleware to check admin auth for API routes
function requireAdmin(req, res, next) {
  const session = getAdminSession(req);
  if (!session || session.email !== ADMIN_EMAIL) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List all codes
app.get('/api/admin/codes', requireAdmin, async (req, res) => {
  const codes = await readCodes();
  res.json(codes);
});

// Add a code
app.post('/api/admin/codes', requireAdmin, async (req, res) => {
  const { code, rubber_stamps, mail_type, weight_grams } = req.body;
  if (!code || !rubber_stamps) {
    return res.status(400).json({ error: 'Code and rubber_stamps are required' });
  }

  const codes = await readCodes();
  const upperCode = code.toUpperCase();

  if (codes[upperCode]) {
    return res.status(409).json({ error: 'Code already exists' });
  }

  codes[upperCode] = {
    rubber_stamps,
    mail_type: mail_type || 'lettermail',
    weight_grams: weight_grams ? Number(weight_grams) : null,
    redeemed: false,
    created_at: new Date().toISOString()
  };

  await writeCodes(codes);
  res.json({ success: true, code: upperCode });
});

// Update a code
app.put('/api/admin/codes/:code', requireAdmin, async (req, res) => {
  const codes = await readCodes();
  const upperCode = req.params.code.toUpperCase();

  if (!codes[upperCode]) {
    return res.status(404).json({ error: 'Code not found' });
  }

  const { rubber_stamps, mail_type, weight_grams } = req.body;
  if (rubber_stamps) codes[upperCode].rubber_stamps = rubber_stamps;
  if (mail_type) codes[upperCode].mail_type = mail_type;
  if (weight_grams !== undefined) codes[upperCode].weight_grams = weight_grams ? Number(weight_grams) : null;

  await writeCodes(codes);
  res.json({ success: true, code: upperCode });
});

// Delete a code
app.delete('/api/admin/codes/:code', requireAdmin, async (req, res) => {
  const codes = await readCodes();
  const upperCode = req.params.code.toUpperCase();

  if (!codes[upperCode]) {
    return res.status(404).json({ error: 'Code not found' });
  }

  delete codes[upperCode];
  await writeCodes(codes);
  res.json({ success: true });
});

// Reset a code (mark as unredeemed)
app.post('/api/admin/codes/:code/reset', requireAdmin, async (req, res) => {
  const codes = await readCodes();
  const upperCode = req.params.code.toUpperCase();

  if (!codes[upperCode]) {
    return res.status(404).json({ error: 'Code not found' });
  }

  codes[upperCode].redeemed = false;
  delete codes[upperCode].redeemed_at;
  delete codes[upperCode].redeemed_by;
  delete codes[upperCode].letter_id;

  await writeCodes(codes);
  res.json({ success: true });
});

// Start server locally (Vercel handles this automatically)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`CODES server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
