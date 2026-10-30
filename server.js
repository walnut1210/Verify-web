const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("./config");

const SQLiteStore = SQLiteStoreFactory(session);
const app = express();

if (!config.BASE_URL.startsWith("https://") || !config.REDIRECT_URI.startsWith("https://")) {
  throw new Error("本番環境ではBASE_URLとREDIRECT_URIにHTTPS URLを設定してください。");
}
if (config.SESSION_SECRET.length < 32 || config.BOT_API_SECRET.length < 32) {
  throw new Error("SESSION_SECRETとBOT_API_SECRETは32文字以上のランダム値にしてください。");
}

app.set("trust proxy", config.TRUST_PROXY_HOPS);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

const dataDir = path.dirname(path.resolve(config.DATABASE_PATH));
fs.mkdirSync(dataDir, { recursive: true });

app.use(session({
  store: new SQLiteStore({
    db: "sessions.sqlite",
    dir: dataDir,
    concurrentDB: true
  }),
  name: "discord_verify_session",
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  dotfiles: "deny"
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const DISCORD_API = "https://discord.com/api/v10";
const SCOPES = "identify guilds.join";

function getClientIp(req) {
  // req.ip follows Express trust-proxy configuration. Do not parse X-Forwarded-For manually.
  return req.ip || req.socket.remoteAddress || "unknown";
}

async function sendWebhook(payload) {
  if (!config.WEBHOOK_URL || config.WEBHOOK_URL.includes("WEBHOOK_ID")) return;
  const response = await fetch(config.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
}

app.get("/auth/discord", authLimiter, (req, res, next) => {
  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;

  req.session.save((err) => {
    if (err) return next(err);
    const params = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      response_type: "code",
      redirect_uri: config.REDIRECT_URI,
      scope: SCOPES,
      state,
      prompt: "consent"
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });
});

app.get("/auth/callback", authLimiter, async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;

  if (error) return res.status(400).send("Discord認証がキャンセルされました。");
  if (typeof code !== "string" || typeof state !== "string" ||
      typeof expectedState !== "string" ||
      Buffer.byteLength(state) !== Buffer.byteLength(expectedState) ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
    return res.status(400).send("認証状態を確認できませんでした。最初からやり直してください。");
  }

  try {
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.DISCORD_CLIENT_ID,
        client_secret: config.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.REDIRECT_URI
      }),
      signal: AbortSignal.timeout(10000)
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(401).send("Discordトークンの取得に失敗しました。");
    }

    const userResponse = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(10000)
    });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) {
      return res.status(401).send("Discordユーザー情報を取得できませんでした。");
    }

    // The OAuth access token is sent only to the private Bot API for guild joining.
    const botResponse = await fetch(`${config.BOT_API_URL}/api/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.BOT_API_SECRET}`
      },
      body: JSON.stringify({
        userId: user.id,
        accessToken: tokenData.access_token
      }),
      signal: AbortSignal.timeout(15000)
    });

    const botResult = await botResponse.json().catch(() => ({}));
    if (!botResponse.ok || !botResult.success) {
      console.error("Bot verification failed:", botResponse.status);
      return res.status(502).send("サーバー参加・ロール付与に失敗しました。管理者にお問い合わせください。");
    }

    const timestamp = new Date().toISOString();
    const ip = getClientIp(req);

    try {
      await sendWebhook({
        embeds: [{
          title: "Discord認証成功",
          color: 0x57F287,
          fields: [
            { name: "Discord User ID", value: String(user.id), inline: false },
            { name: "Username", value: String(user.username || "unknown").slice(0, 100), inline: true },
            { name: "認証日時 (UTC)", value: timestamp, inline: false },
            { name: "IPアドレス", value: String(ip).slice(0, 100), inline: false },
            { name: "サーバー参加・ロール付与", value: "成功", inline: true }
          ],
          footer: { text: "Verification System" }
        }]
      });
    } catch (webhookError) {
      console.error("Webhook notification failed:", webhookError.message);
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).send("セッションを更新できませんでした。");
      req.session.verifiedUserId = user.id;
      req.session.save(() => res.redirect("/success.html"));
    });
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("認証処理中にエラーが発生しました。");
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(500).send("サーバーエラーが発生しました。");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Web server listening on ${port}`));
