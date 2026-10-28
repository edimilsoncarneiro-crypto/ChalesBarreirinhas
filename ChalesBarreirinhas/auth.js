const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth_config.json');
const SETUP_TOKEN_FILE = path.join(DATA_DIR, 'auth_setup_token.txt');
const COOKIE_NAME = 'chales_session';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function ensureSetupToken() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (isConfigured()) {
    if (fs.existsSync(SETUP_TOKEN_FILE)) fs.unlinkSync(SETUP_TOKEN_FILE);
    return;
  }

  if (!fs.existsSync(SETUP_TOKEN_FILE)) {
    const token = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(SETUP_TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
  }
  const token = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
  console.log('\n[Autenticacao] Configuracao inicial necessaria.');
  console.log(`[Autenticacao] Codigo de configuracao (insira na tela de login): ${token}\n`);
}

function isConfigured() {
  return fs.existsSync(AUTH_FILE);
}

function readConfig() {
  const config = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  if (!config.username || !config.salt || !config.passwordHash || !config.sessionSecret) {
    throw new Error('Arquivo de autenticacao invalido.');
  }
  return config;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setup(token, username, password) {
  if (isConfigured()) throw new Error('A configuracao inicial ja foi concluida.');
  if (!fs.existsSync(SETUP_TOKEN_FILE)) throw new Error('Codigo de configuracao indisponivel. Reinicie o servidor.');

  const expectedToken = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
  if (!safeEqualText(token, expectedToken)) throw new Error('Codigo de configuracao incorreto.');
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error('O login deve ter de 3 a 32 caracteres: letras, numeros, ponto, hifen ou sublinhado.');
  }
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('A senha precisa ter pelo menos 12 caracteres.');
  }
  if (password.length > 128) throw new Error('A senha pode ter no maximo 128 caracteres.');

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const config = {
    version: 1,
    username: username.toLowerCase(),
    salt,
    passwordHash,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString()
  };
  const tempFile = `${AUTH_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tempFile, AUTH_FILE);
  fs.unlinkSync(SETUP_TOKEN_FILE);
}

function verifyCredentials(username, password) {
  if (!isConfigured() || typeof username !== 'string' || typeof password !== 'string' || password.length > 128) return false;
  const config = readConfig();
  const candidate = crypto.scryptSync(password, config.salt, 64).toString('hex');
  return safeEqualText(username.toLowerCase(), config.username) && safeEqualText(candidate, config.passwordHash);
}

function createSessionCookie() {
  const config = readConfig();
  const payload = Buffer.from(JSON.stringify({
    issuedAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionCookie(value) {
  if (!isConfigured() || typeof value !== 'string') return false;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return false;

  try {
    const config = readConfig();
    const expected = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
    if (!safeEqualText(signature, expected)) return false;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(session.expiresAt) && session.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function getCookieValue(req) {
  const cookieHeader = req.headers.cookie || '';
  const entry = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return '';
  try {
    return decodeURIComponent(entry.slice(COOKIE_NAME.length + 1));
  } catch {
    return '';
  }
}

function isAuthenticated(req) {
  return verifySessionCookie(getCookieValue(req));
}

function setSessionCookie(res, req) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${createSessionCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${secure}`);
}

function clearSessionCookie(res, req) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function requireAuth(req, res, next) {
  if (!isConfigured()) return res.status(503).json({ error: 'Configure o acesso inicial pelo servidor.' });
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Sessao expirada ou nao autenticada.' });
  next();
}

module.exports = {
  COOKIE_NAME,
  ensureSetupToken,
  isConfigured,
  isAuthenticated,
  setup,
  verifyCredentials,
  setSessionCookie,
  clearSessionCookie,
  requireAuth
};
