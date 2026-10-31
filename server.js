const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const dataDir = path.dirname(path.resolve(config.DATABASE_PATH));
fs.mkdirSync(dataDir, { recursive: true });

if (!config.BASE_URL.startsWith("https://") || !config.REDIRECT_URI.startsWith("https://")) throw new Error("BASE_URL and REDIRECT_URI must use HTTPS.");
if (!/^[a-fA-F0-9]{64}$/.test(config.JOB_ENCRYPTION_KEY || "")) throw new Error("JOB_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters.");
if (typeof config.SESSION_SECRET !== "string" || config.SESSION_SECRET.length < 32 || typeof config.BOT_API_SECRET !== "string" || config.BOT_API_SECRET.length < 32) throw new Error("SESSION_SECRET and BOT_API_SECRET must be at least 32 characters.");

const encryptionKey = Buffer.from(config.JOB_ENCRYPTION_KEY, "hex");
const db = new Database(path.resolve(config.DATABASE_PATH));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS verification_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', encrypted_token TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL, ip_address TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, completed_at TEXT, last_error TEXT)");
const jobColumns = db.prepare("PRAGMA table_info(verification_jobs)").all().map(column => column.name);
if (!jobColumns.includes("email")) db.exec("ALTER TABLE verification_jobs ADD COLUMN email TEXT NOT NULL DEFAULT ''");
db.exec("CREATE INDEX IF NOT EXISTS idx_verification_jobs_status ON verification_jobs(status, created_at)");
db.exec("CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");

app.set("trust proxy", config.TRUST_PROXY_HOPS);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'"], scriptSrc: ["'self'"], imgSrc: ["'self'", "data:"], baseUri: ["'self'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: "10kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: dataDir, concurrentDB: true }),
  name: "discord_verify_session", secret: config.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: true, sameSite: "lax", maxAge: 10 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", dotfiles: "deny" }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
const internalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
const DISCORD_API = "https://discord.com/api/v10";
const SCOPES = "identify email guilds.join";
const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requireBotAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(supplied, config.BOT_API_SECRET)) return res.status(401).json({ success: false, error: "unauthorized" });
  next();
}
function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { encrypted_token: encrypted.toString("base64"), iv: iv.toString("base64"), auth_tag: cipher.getAuthTag().toString("base64") };
}
function decryptToken(job) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(job.iv, "base64"));
  decipher.setAuthTag(Buffer.from(job.auth_tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(job.encrypted_token, "base64")), decipher.final()]).toString("utf8");
}
async function sendWebhook(payload) {
  if (!config.WEBHOOK_URL || config.WEBHOOK_URL.includes("WEBHOOK_ID")) return;
  const response = await fetch(config.WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Webhook returned HTTP " + response.status);
}
function getClientIp(req) { return req.ip || req.socket.remoteAddress || "unknown"; }

app.get("/auth/discord", authLimiter, (req, res, next) => {
  const state = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO oauth_states (state_hash, expires_at) VALUES (?, ?)").run(crypto.createHash("sha256").update(state).digest("hex"), Date.now() + 10 * 60 * 1000);
  console.log("OAuth start diagnostics:", JSON.stringify({ secure: req.secure, forwardedProto: req.get("x-forwarded-proto") || null, host: req.get("host") || null, stateStored: true }));
  const params = new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, response_type: "code", redirect_uri: config.REDIRECT_URI, scope: SCOPES, state, prompt: "consent" });
  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

app.get("/auth/callback", authLimiter, async (req, res) => {
  const { code, state, error } = req.query;
  console.log("OAuth callback diagnostics:", JSON.stringify({ secure: req.secure, forwardedProto: req.get("x-forwarded-proto") || null, host: req.get("host") || null, codePresent: typeof code === "string", statePresent: typeof state === "string" }));
  if (error) return res.status(400).send("Discord認証がキャンセルされました。");
  if (typeof code !== "string" || typeof state !== "string" || state.length > 256) {
    return res.status(400).send("認証状態を確認できませんでした。最初からやり直してください。");
  }
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  const consumeState = db.transaction(() => {
    const saved = db.prepare("SELECT expires_at FROM oauth_states WHERE state_hash=?").get(stateHash);
    if (!saved || saved.expires_at < Date.now()) {
      db.prepare("DELETE FROM oauth_states WHERE state_hash=?").run(stateHash);
      return false;
    }
    db.prepare("DELETE FROM oauth_states WHERE state_hash=?").run(stateHash);
    return true;
  });
  if (!consumeState()) return res.status(400).send("認証状態を確認できませんでした。最初からやり直してください。");
  try {
    const tokenResponse = await fetch(DISCORD_API + "/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, client_secret: config.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: config.REDIRECT_URI }),
      signal: AbortSignal.timeout(10000)
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return res.status(401).send("Discordトークンの取得に失敗しました。");
    const userResponse = await fetch(DISCORD_API + "/users/@me", { headers: { Authorization: "Bearer " + tokenData.access_token }, signal: AbortSignal.timeout(10000) });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) return res.status(401).send("Discordユーザー情報を取得できませんでした。");

    const encrypted = encryptToken(tokenData.access_token);
    const jobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO verification_jobs (id,user_id,username,email,encrypted_token,iv,auth_tag,ip_address,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(jobId, String(user.id), String(user.username || "unknown").slice(0, 100), String(user.email || "").slice(0, 254), encrypted.encrypted_token, encrypted.iv, encrypted.auth_tag, String(getClientIp(req)).slice(0, 100), createdAt);

    res.redirect("/success.html");
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("認証処理中にエラーが発生しました。");
  }
});

app.get("/internal/jobs/next", internalLimiter, requireBotAuth, (req, res) => {
  const now = Date.now();
  // A worker that crashed on its final attempt must not leave a token-bearing job forever.
  db.prepare("UPDATE verification_jobs SET status='failed', encrypted_token='', iv='', auth_tag='', lease_until=NULL, last_error='worker_lease_expired' WHERE status='processing' AND attempts >= ? AND lease_until < ?").run(MAX_ATTEMPTS, now);
  const claim = db.transaction(() => {
    const job = db.prepare("SELECT * FROM verification_jobs WHERE attempts < ? AND (status = 'pending' OR (status = 'processing' AND lease_until < ?)) ORDER BY created_at ASC LIMIT 1").get(MAX_ATTEMPTS, now);
    if (!job) return null;
    db.prepare("UPDATE verification_jobs SET status='processing', attempts=attempts+1, lease_until=? WHERE id=?").run(now + LEASE_MS, job.id);
    return { ...job, attempts: job.attempts + 1 };
  });
  const job = claim();
  if (!job) return res.status(204).end();
  try {
    res.json({ jobId: job.id, userId: job.user_id, accessToken: decryptToken(job), attempt: job.attempts });
  } catch (err) {
    db.prepare("UPDATE verification_jobs SET status='failed', encrypted_token='', iv='', auth_tag='', last_error='token_decryption_failed' WHERE id=?").run(job.id);
    console.error("Job token decryption failed:", err.message);
    res.status(500).json({ success: false, error: "job_decryption_failed" });
  }
});

app.post("/internal/jobs/:jobId/complete", internalLimiter, requireBotAuth, async (req, res) => {
  const job = db.prepare("SELECT * FROM verification_jobs WHERE id=?").get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "job_not_found" });
  if (job.status === "completed") return res.json({ success: true, alreadyCompleted: true });
  const completedAt = new Date().toISOString();
  db.prepare("UPDATE verification_jobs SET status='completed', completed_at=?, encrypted_token='', iv='', auth_tag='', lease_until=NULL, last_error=NULL WHERE id=?").run(completedAt, job.id);
  try {
    await sendWebhook({ embeds: [{ title: "Discord認証成功", color: 0x57F287, fields: [
      { name: "Discord User ID", value: job.user_id, inline: false },
      { name: "Username", value: job.username, inline: true },
      { name: "メールアドレス", value: job.email || "Discordから取得できませんでした", inline: false },
      { name: "認証日時 (UTC)", value: job.created_at, inline: false },
      { name: "IPアドレス", value: job.ip_address, inline: false },
      { name: "サーバー参加・ロール付与", value: "成功", inline: true }
    ], footer: { text: "Verification System" } }] });
  } catch (err) { console.error("Webhook notification failed:", err.message); }
  res.json({ success: true });
});

app.post("/internal/jobs/:jobId/fail", internalLimiter, requireBotAuth, (req, res) => {
  const job = db.prepare("SELECT * FROM verification_jobs WHERE id=?").get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "job_not_found" });
  if (job.status === "completed") return res.json({ success: true, alreadyCompleted: true });
  const reason = typeof req.body?.error === "string" ? req.body.error.slice(0, 120) : "verification_failed";
  if (job.attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE verification_jobs SET status='failed', encrypted_token='', iv='', auth_tag='', lease_until=NULL, last_error=? WHERE id=?").run(reason, job.id);
  } else {
    db.prepare("UPDATE verification_jobs SET status='pending', lease_until=NULL, last_error=? WHERE id=?").run(reason, job.id);
  }
  res.json({ success: true, retrying: job.attempts < MAX_ATTEMPTS });
});

app.get("/health", (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => { console.error("Server error:", err.message); res.status(500).send("サーバーエラーが発生しました。"); });
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Web server listening on " + port));
