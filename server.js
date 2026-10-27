"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { defaultDb } = require("./lib/db");

// ---------- الإعدادات (من متغيرات البيئة أو ملف .env محلياً) ----------
try { // تحميل .env بدون مكتبات إضافية (على Vercel الإعدادات من لوحة المشروع)
  for (const l of require("fs").readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) {}
const PORT = process.env.PORT || 3000;
const list = v => (v || "").split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_EMAILS = list(process.env.ADMIN_EMAILS).map(s => s.toLowerCase());
const SECURE = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

// ---------- قاعدة البيانات ----------
const DB = defaultDb();
const { rows, get, run, tx } = DB;
const kick = require("./kick")(DB);
const ready = DB.ready.then(() => kick.seed());
ready.catch(e => console.error("فشل تجهيز قاعدة البيانات:", e.message));

// ---------- أدوات مساعدة ----------
const now = () => Date.now();
const DAY = 86400000;
const hash = t => crypto.createHash("sha256").update(t).digest("hex");
const clean = (s, max) => String(s ?? "").trim().slice(0, max);
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const safeUrl = u => (/^https?:\/\//i.test(u) ? u : "");
const publicUser = u => u && { id: u.id, name: u.name, email: u.email, role: u.role };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); // يمسك أخطاء async
const randomHash = () => bcrypt.hash(crypto.randomBytes(24).toString("hex"), 4); // باسورد عشوائي ما يُعرف

function cookies(req) {
  const o = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (_) {} }
  });
  return o;
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  await run("INSERT INTO sessions VALUES(?,?,?)", [hash(token), userId, now() + 14 * DAY]);
  if (Math.random() < 0.05) await run("DELETE FROM sessions WHERE expires_at<?", [now()]); // تنظيف دوري
  res.append("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${SECURE ? "; Secure" : ""}`);
}
async function endSession(req, res) {
  const t = cookies(req).sid;
  if (t) await run("DELETE FROM sessions WHERE token_hash=?", [hash(t)]);
  res.append("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

// تحديد المستخدم الحالي من الكوكي
const auth = wrap(async (req, _res, next) => {
  req.user = null;
  const t = cookies(req).sid;
  if (t) req.user = await get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`, [hash(t), now()]) || null;
  next();
});
const needLogin = (req, res, next) => req.user ? next() : res.status(401).json({ error: "سجّل دخولك أول" });
const needAdmin = (req, res, next) =>
  req.user?.role === "admin" ? next() : res.status(403).json({ error: "هذي الصلاحية للمشرفين فقط" });

// حد المحاولات محفوظ في القاعدة (يشتغل صح على Vercel حيث كل طلب ممكن يروح لنسخة مختلفة)
async function rateOk(key, max, windowMs) {
  const t = now();
  const r = await get("SELECT COUNT(*) AS n FROM hits WHERE k=? AND ts>?", [key, t - windowMs]);
  if (r.n >= max) return false;
  await run("INSERT INTO hits(k,ts) VALUES(?,?)", [key, t]);
  if (Math.random() < 0.02) await run("DELETE FROM hits WHERE ts<?", [t - 86400000]);
  return true;
}
// تسجيل الدخول/التسجيل: 8 محاولات كل 10 دقايق لكل IP
const limiter = wrap(async (req, res, next) =>
  (await rateOk("auth:" + req.ip, 8, 600000)) ? next() : res.status(429).json({ error: "محاولات كثيرة، جرّب بعد شوي" }));

// حد للدعم الفني: رسالة وحدة كل 6 ساعات لكل جهاز (حسب الـ IP، وحسب الحساب لو مسجّل دخول)
// المحاولات اللي ترجع خطأ ما تُحسب.
const SUPPORT_COOLDOWN = 6 * 3600000;
const supportLimiter = wrap(async (req, res, next) => {
  const since = now() - SUPPORT_COOLDOWN, uid = req.user?.id ?? null;
  const last = await get(
    "SELECT created_at FROM tickets WHERE created_at>? AND (ip_hash=? OR (? IS NOT NULL AND user_id=?)) ORDER BY created_at DESC LIMIT 1",
    [since, hash(req.ip), uid, uid]);
  if (last) {
    const mins = Math.ceil((last.created_at + SUPPORT_COOLDOWN - now()) / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    if (req.lang === "en")
      return res.status(429).json({ error: `You can send one message every 6 hours. Try again in ${h ? h + "h " : ""}${m ? m + "m" : ""}`.trim() });
    const t = mins >= 60 ? `${h} ساعة${m ? ` و${m} دقيقة` : ""}` : `${mins} دقيقة`;
    return res.status(429).json({ error: `تقدر ترسل رسالة وحدة كل 6 ساعات. جرّب بعد ${t}` });
  }
  next();
});

// ---------- السيرفر ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
// اللغة: الواجهة ترسل X-Lang، ورسائل الأخطاء تنترجم للإنجليزي عند الطلب
const EN = {
  "سجّل دخولك أول": "Please log in first",
  "هذي الصلاحية للمشرفين فقط": "Admins only",
  "محاولات كثيرة، جرّب بعد شوي": "Too many attempts, try again shortly",
  "نوع الطلب غير مدعوم": "Unsupported request",
  "الإيميل غير صحيح": "Invalid email",
  "الاسم قصير": "Name is too short",
  "كلمة المرور لازم 8 خانات على الأقل": "Password must be at least 8 characters",
  "هذا الإيميل مسجّل من قبل": "This email is already registered",
  "الإيميل أو كلمة المرور غلط": "Wrong email or password",
  "حالة غير صحيحة": "Invalid status",
  "العنوان مطلوب": "Title is required",
  "اكتب تعليق": "Write a comment",
  "انتظر شوي قبل التعليق التالي": "Please wait a moment before your next comment",
  "غير موجود": "Not found",
  "غير مسموح": "Not allowed",
  "ما تقدر تشيل صلاحية نفسك": "You can't remove your own admin role",
  "خطأ في السيرفر": "Server error",
  "يوزر Kick غير صحيح": "Invalid Kick username",
  "اكتب اسمك": "Enter your name",
  "اكتب عنوان للمشكلة": "Enter a subject",
  "اشرح المشكلة بتفصيل أكثر (10 أحرف على الأقل)": "Please describe the issue in more detail (at least 10 characters)",
  "اكتب اسم الحساب": "Enter the account name",
  "ما تقدر تحذف نفسك": "You can't delete your own account",
  "البيانات غير مكتملة": "Incomplete data",
  "الرابط لازم يبدأ بـ https://": "The link must start with https://"
};
app.use((req, res, next) => {
  req.lang = req.get("x-lang") === "en" ? "en" : "ar";
  if (req.lang === "en") {
    const j = res.json.bind(res);
    res.json = b => j(b && b.error && EN[b.error] ? { ...b, error: EN[b.error] } : b);
  }
  next();
});
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => { // حماية CSRF: الطلبات المعدِّلة لازم تحمل هيدر مخصص (المتصفح ما يرسله من موقع ثاني)
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:");
  if (req.method !== "GET" && req.method !== "HEAD" && req.get("x-requested-with") !== "osamah")
    return res.status(415).json({ error: "نوع الطلب غير مدعوم" });
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (_req, _res, next) => ready.then(() => next(), next), auth);

// --- الحساب ---
app.post("/api/register", limiter, wrap(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const name = clean(req.body.name, 40);
  const password = String(req.body.password ?? "");
  if (!validEmail(email)) return res.status(400).json({ error: "الإيميل غير صحيح" });
  if (name.length < 2) return res.status(400).json({ error: "الاسم قصير" });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: "كلمة المرور لازم 8 خانات على الأقل" });
  if (await get("SELECT 1 FROM users WHERE email=?", [email])) return res.status(409).json({ error: "هذا الإيميل مسجّل من قبل" });
  const role = ADMIN_EMAILS.includes(email) ? "admin" : "user";
  const info = await run("INSERT INTO users(email,name,password_hash,role,created_at) VALUES(?,?,?,?,?)",
    [email, name, await bcrypt.hash(password, 11), role, now()]);
  await startSession(res, info.id);
  res.json({ user: publicUser(await get("SELECT * FROM users WHERE id=?", [info.id])) });
}));

app.post("/api/login", limiter, wrap(async (req, res) => {
  const email = clean(req.body.email, 254).toLowerCase();
  const u = await get("SELECT * FROM users WHERE email=?", [email]);
  const ok = u && await bcrypt.compare(String(req.body.password ?? ""), u.password_hash);
  if (!ok) return res.status(401).json({ error: "الإيميل أو كلمة المرور غلط" });
  if (ADMIN_EMAILS.includes(email) && u.role !== "admin") { // ترقية تلقائية للإيميلات المحددة كمشرفين
    await run("UPDATE users SET role='admin' WHERE id=?", [u.id]); u.role = "admin";
  }
  await startSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post("/api/logout", wrap(async (req, res) => { await endSession(req, res); res.json({ ok: true }); }));
app.get("/api/me", (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- تسجيل الدخول عبر Discord و Google (OAuth2) ----------
// نفس الآلية للاثنين. الفرق: Google إيميله مؤكد دايماً فنربط الحساب بحساب موجود بنفس الإيميل (مع تعطيل الباسورد القديم)،
// أما Discord فما نربط تلقائياً.
const PROVIDERS = {
  discord: {
    idCol: "discord_id", idOk: /^\d{5,25}$/, linkByEmail: false, scope: "identify email",
    clientId: process.env.DISCORD_CLIENT_ID, secret: process.env.DISCORD_CLIENT_SECRET,
    redirect: process.env.DISCORD_REDIRECT_URI, adminIds: list(process.env.ADMIN_DISCORD_IDS),
    authUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: process.env.DISCORD_TOKEN_URL || "https://discord.com/api/oauth2/token",
    userUrl: process.env.DISCORD_USER_URL || "https://discord.com/api/users/@me",
    profile: d => ({ id: String(d.id || ""), name: d.global_name || d.username, email: d.email, verified: d.verified === true })
  },
  google: {
    idCol: "google_id", idOk: /^\d{5,40}$/, linkByEmail: true, scope: "openid email profile",
    clientId: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect: process.env.GOOGLE_REDIRECT_URI, adminIds: [],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    userUrl: process.env.GOOGLE_USER_URL || "https://openidconnect.googleapis.com/v1/userinfo",
    profile: d => ({ id: String(d.sub || ""), name: d.name || d.given_name, email: d.email, verified: d.email_verified === true })
  }
};
const enabled = p => !!(p.clientId && p.secret);
const oauthFail = (res, name, code) => {
  res.append("Set-Cookie", `oauth_${name}=; HttpOnly; SameSite=Lax; Path=/api/auth/${name}; Max-Age=0`);
  res.redirect("/?auth_error=" + code);
};

for (const [name, P] of Object.entries(PROVIDERS)) {
  const redirectUri = req => P.redirect || `${req.protocol}://${req.get("host")}/api/auth/${name}/callback`;

  app.get(`/api/auth/${name}`, (req, res) => {
    if (!enabled(P)) return oauthFail(res, name, "oauth_off");
    const state = crypto.randomBytes(16).toString("hex"); // حماية CSRF: نفس القيمة لازم ترجع من المزوّد
    res.append("Set-Cookie", `oauth_${name}=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/${name}; Max-Age=600${SECURE ? "; Secure" : ""}`);
    res.redirect(`${P.authUrl}?${new URLSearchParams({ client_id: P.clientId, redirect_uri: redirectUri(req), response_type: "code", scope: P.scope, state })}`);
  });

  // حد منفصل وأوسع من حد تسجيل الدخول العادي (ناس كثير ممكن يشاركون نفس الـ IP)
  const oauthLimiter = wrap(async (req, res, next) =>
    (await rateOk("oauth:" + req.ip, 30, 600000)) ? next() : res.redirect("/?auth_error=oauth_busy"));

  app.get(`/api/auth/${name}/callback`, oauthLimiter, async (req, res) => {
    try {
      if (!enabled(P)) return oauthFail(res, name, "oauth_off");
      if (req.query.error) return oauthFail(res, name, "oauth_denied");
      const saved = cookies(req)[`oauth_${name}`] || "", got = String(req.query.state || "");
      if (!saved || saved.length !== got.length || !crypto.timingSafeEqual(Buffer.from(saved), Buffer.from(got)))
        return oauthFail(res, name, "oauth_failed");
      const tr = await fetch(P.tokenUrl, {
        method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: P.clientId, client_secret: P.secret, grant_type: "authorization_code",
          code: String(req.query.code || ""), redirect_uri: redirectUri(req) })
      });
      const tk = await tr.json().catch(() => ({}));
      if (!tr.ok || !tk.access_token) return oauthFail(res, name, "oauth_failed");
      const ur = await fetch(P.userUrl, { signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${tk.access_token}` } });
      const pf = P.profile(await ur.json().catch(() => ({})));
      if (!ur.ok || !P.idOk.test(pf.id)) return oauthFail(res, name, "oauth_failed");

      await ready;
      const mail = pf.verified ? String(pf.email || "").toLowerCase() : "";
      const verifiedMail = validEmail(mail) ? mail : "";
      let u = await get(`SELECT * FROM users WHERE ${P.idCol}=?`, [pf.id]);
      if (!u && P.linkByEmail && verifiedMail) {
        // الإيميل مؤكد من Google: نربط الحساب الموجود ونعطّل باسوورده القديم ونطلّعه من الأجهزة (يمنع أي أحد سجّل بإيميل غيره)
        const ex = await get(`SELECT * FROM users WHERE email=? AND ${P.idCol} IS NULL`, [verifiedMail]);
        if (ex) {
          await tx([[`UPDATE users SET ${P.idCol}=?, password_hash=? WHERE id=?`, [pf.id, await randomHash(), ex.id]],
                    ["DELETE FROM sessions WHERE user_id=?", [ex.id]]]);
          u = await get("SELECT * FROM users WHERE id=?", [ex.id]);
        }
      }
      if (!u) {
        const taken = verifiedMail && await get("SELECT 1 FROM users WHERE email=?", [verifiedMail]);
        const email = verifiedMail && !taken ? verifiedMail : `${name}-${pf.id}@${name}.local`;
        let uname = clean(pf.name, 40);
        if (uname.length < 2) uname = name[0].toUpperCase() + name.slice(1) + " " + pf.id.slice(-4);
        const info = await run(`INSERT INTO users(email,name,password_hash,role,created_at,${P.idCol}) VALUES(?,?,?,?,?,?)`,
          [email, uname, await randomHash(), "user", now(), pf.id]);
        u = await get("SELECT * FROM users WHERE id=?", [info.id]);
      }
      if (u.role !== "admin" && (P.adminIds.includes(pf.id) || (verifiedMail && ADMIN_EMAILS.includes(verifiedMail)))) {
        await run("UPDATE users SET role='admin' WHERE id=?", [u.id]);
      }
      await startSession(res, u.id);
      res.append("Set-Cookie", `oauth_${name}=; HttpOnly; SameSite=Lax; Path=/api/auth/${name}; Max-Age=0`);
      res.redirect("/");
    } catch (e) { console.error(`${name} login:`, e.message); oauthFail(res, name, "oauth_failed"); }
  });
}

// --- المحتوى (القراءة متاحة للجميع) ---
app.get("/api/streams", wrap(async (_req, res) => {
  try { await kick.tick(); } catch (e) { console.error("kick:", e.message); } // فحص Kick عند الطلب إذا مرّ وقته
  res.json(await rows("SELECT * FROM streams ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, created_at DESC"));
}));
app.get("/api/news", wrap(async (_req, res) => res.json(await rows("SELECT * FROM news ORDER BY created_at DESC"))));
app.get("/api/comments", wrap(async (req, res) =>
  res.json(await rows(`SELECT c.id,c.text,c.created_at,c.user_id,u.name,u.role,
      (SELECT COUNT(*) FROM comment_likes l WHERE l.comment_id=c.id) AS likes,
      EXISTS(SELECT 1 FROM comment_likes l WHERE l.comment_id=c.id AND l.user_id=?) AS liked
    FROM comments c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 200`, [req.user?.id ?? 0]))));

// --- الإضافة والتعديل للمشرفين فقط ---
app.post("/api/streams", needAdmin, wrap(async (req, res) => {
  const title = clean(req.body.title, 120);
  const status = ["live", "soon", "ended"].includes(req.body.status) ? req.body.status : "soon";
  if (!title) return res.status(400).json({ error: "العنوان مطلوب" });
  await run("INSERT INTO streams(title,url,status,created_at,streamer) VALUES(?,?,?,?,?)",
    [title, safeUrl(clean(req.body.url, 500)), status, now(), clean(req.body.streamer, 40) || null]);
  res.json({ ok: true });
}));
app.patch("/api/streams/:id", needAdmin, wrap(async (req, res) => {
  if (!["live", "soon", "ended"].includes(req.body.status)) return res.status(400).json({ error: "حالة غير صحيحة" });
  await run("UPDATE streams SET status=? WHERE id=?", [req.body.status, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/streams/:id", needAdmin, wrap(async (req, res) => {
  await run("DELETE FROM streams WHERE id=?", [req.params.id]); res.json({ ok: true });
}));

app.post("/api/news", needAdmin, wrap(async (req, res) => {
  const title = clean(req.body.title, 150);
  if (!title) return res.status(400).json({ error: "العنوان مطلوب" });
  await run("INSERT INTO news(title,body,created_at) VALUES(?,?,?)", [title, clean(req.body.body, 5000), now()]);
  res.json({ ok: true });
}));
app.delete("/api/news/:id", needAdmin, wrap(async (req, res) => {
  await run("DELETE FROM news WHERE id=?", [req.params.id]); res.json({ ok: true });
}));

// --- التعليقات: أي مستخدم مسجّل يكتب، والمشرف أو صاحب التعليق يحذف ---
app.post("/api/comments", needLogin, wrap(async (req, res) => {
  const text = clean(req.body.text, 500);
  if (!text) return res.status(400).json({ error: "اكتب تعليق" });
  const last = await get("SELECT created_at FROM comments WHERE user_id=? ORDER BY id DESC LIMIT 1", [req.user.id]);
  if (last && now() - last.created_at < 10000) return res.status(429).json({ error: "انتظر شوي قبل التعليق التالي" });
  await run("INSERT INTO comments(user_id,text,created_at) VALUES(?,?,?)", [req.user.id, text, now()]);
  res.json({ ok: true });
}));
app.post("/api/comments/:id/like", needLogin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!await get("SELECT 1 FROM comments WHERE id=?", [id])) return res.status(404).json({ error: "غير موجود" });
  const has = await get("SELECT 1 FROM comment_likes WHERE comment_id=? AND user_id=?", [id, req.user.id]);
  if (has) await run("DELETE FROM comment_likes WHERE comment_id=? AND user_id=?", [id, req.user.id]);
  else await run("INSERT OR IGNORE INTO comment_likes(comment_id,user_id) VALUES(?,?)", [id, req.user.id]);
  res.json({ liked: !has, likes: (await get("SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id=?", [id])).n });
}));
app.delete("/api/comments/:id", needLogin, wrap(async (req, res) => {
  const c = await get("SELECT user_id FROM comments WHERE id=?", [req.params.id]);
  if (!c) return res.status(404).json({ error: "غير موجود" });
  if (req.user.role !== "admin" && c.user_id !== req.user.id) return res.status(403).json({ error: "غير مسموح" });
  await tx([["DELETE FROM comment_likes WHERE comment_id=?", [req.params.id]], ["DELETE FROM comments WHERE id=?", [req.params.id]]]);
  res.json({ ok: true });
}));

// --- إدارة المشرفين ---
app.get("/api/admin/users", needAdmin, wrap(async (req, res) => {
  const q = clean(req.query.q, 100).toLowerCase().replace(/[\\%_]/g, "\\$&");
  const like = `%${q}%`;
  res.json(await rows(`SELECT id,name,email,role,created_at,
      CASE WHEN discord_id IS NOT NULL THEN 'discord' WHEN google_id IS NOT NULL THEN 'google' END AS provider FROM users
    WHERE ?='' OR lower(name) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC LIMIT 100`, [q, like, like]));
}));
app.patch("/api/admin/users/:id", needAdmin, wrap(async (req, res) => {
  const role = req.body.role === "admin" ? "admin" : "user";
  if (Number(req.params.id) === req.user.id && role !== "admin")
    return res.status(400).json({ error: "ما تقدر تشيل صلاحية نفسك" });
  await run("UPDATE users SET role=? WHERE id=?", [role, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/users/:id", needAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "ما تقدر تحذف نفسك" });
  if (!await get("SELECT 1 FROM users WHERE id=?", [id])) return res.status(404).json({ error: "غير موجود" });
  // نحذف حسابه وكل تعليقاته وقلوبه وجلساته (يدوياً لأن القاعدة السحابية ما نعتمد فيها على الحذف التلقائي)
  await tx([
    ["DELETE FROM comment_likes WHERE user_id=? OR comment_id IN (SELECT id FROM comments WHERE user_id=?)", [id, id]],
    ["DELETE FROM comments WHERE user_id=?", [id]],
    ["DELETE FROM sessions WHERE user_id=?", [id]],
    ["UPDATE tickets SET user_id=NULL WHERE user_id=?", [id]],
    ["DELETE FROM users WHERE id=?", [id]]
  ]);
  res.json({ ok: true });
}));
// إعادة تعيين كلمة المرور: يتولّد باسورد مؤقت يظهر للمشرف مرة وحدة، ويطلع المستخدم من كل أجهزته
const PW_CHARS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
app.post("/api/admin/users/:id/reset-password", needAdmin, wrap(async (req, res) => {
  const u = await get("SELECT id FROM users WHERE id=?", [req.params.id]);
  if (!u) return res.status(404).json({ error: "غير موجود" });
  let pw = ""; for (const b of crypto.randomBytes(12)) pw += PW_CHARS[b % PW_CHARS.length];
  const cur = cookies(req).sid ? hash(cookies(req).sid) : "";
  await tx([["UPDATE users SET password_hash=? WHERE id=?", [await bcrypt.hash(pw, 11), u.id]],
            ["DELETE FROM sessions WHERE user_id=? AND token_hash!=?", [u.id, cur]]]);
  res.json({ password: pw });
}));

// --- حسابات السوشل (القراءة للجميع، الإضافة والحذف للمشرفين) ---
const PLATFORMS = ["kick", "twitch", "youtube", "x", "instagram", "tiktok", "snapchat", "discord", "telegram", "whatsapp", "facebook", "other"];
app.get("/api/social", wrap(async (_req, res) => res.json(await rows("SELECT * FROM social_links ORDER BY created_at"))));
app.post("/api/social", needAdmin, wrap(async (req, res) => {
  const platform = PLATFORMS.includes(req.body.platform) ? req.body.platform : "other";
  const title = clean(req.body.title, 60), url = safeUrl(clean(req.body.url, 500));
  if (!title) return res.status(400).json({ error: "اكتب اسم الحساب" });
  if (!url) return res.status(400).json({ error: "الرابط لازم يبدأ بـ https://" });
  await run("INSERT INTO social_links(platform,title,url,created_at) VALUES(?,?,?,?)", [platform, title, url, now()]);
  res.json({ ok: true });
}));
app.delete("/api/social/:id", needAdmin, wrap(async (req, res) => {
  await run("DELETE FROM social_links WHERE id=?", [req.params.id]); res.json({ ok: true });
}));

// --- قسم دسكورد (الأعضاء والفئات) ---
app.get("/api/discord", wrap(async (_req, res) => res.json(await rows("SELECT * FROM discord ORDER BY id DESC"))));
app.post("/api/discord", needAdmin, wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  const url = safeUrl(clean(req.body.url, 500));
  const category = clean(req.body.category, 30);
  if (!name || !category) return res.status(400).json({ error: "البيانات غير مكتملة" });
  const info = await run("INSERT INTO discord (name, url, category) VALUES (?, ?, ?)", [name, url, category]);
  res.json({ id: info.id, name, url, category });
}));
app.delete("/api/discord/:id", needAdmin, wrap(async (req, res) => {
  await run("DELETE FROM discord WHERE id = ?", [req.params.id]);
  res.json({ success: true });
}));

// --- الدعم الفني ---
app.get("/api/config", (_req, res) => res.json({
  supportEmail: process.env.SUPPORT_EMAIL || "",
  supportDiscord: safeUrl(process.env.SUPPORT_DISCORD || ""),
  discordLogin: enabled(PROVIDERS.discord),
  googleLogin: enabled(PROVIDERS.google)
}));
app.post("/api/support", supportLimiter, wrap(async (req, res) => {
  const name = clean(req.body.name || req.user?.name, 40);
  const email = clean(req.body.email || req.user?.email, 254).toLowerCase();
  const subject = clean(req.body.subject, 100), message = clean(req.body.message, 2000);
  if (name.length < 2) return res.status(400).json({ error: "اكتب اسمك" });
  if (!validEmail(email)) return res.status(400).json({ error: "الإيميل غير صحيح" });
  if (subject.length < 3) return res.status(400).json({ error: "اكتب عنوان للمشكلة" });
  if (message.length < 10) return res.status(400).json({ error: "اشرح المشكلة بتفصيل أكثر (10 أحرف على الأقل)" });
  await run("INSERT INTO tickets(user_id,name,email,subject,message,created_at,ip_hash) VALUES(?,?,?,?,?,?,?)",
    [req.user?.id ?? null, name, email, subject, message, now(), hash(req.ip)]);
  res.json({ ok: true });
}));
app.get("/api/support/mine", needLogin, wrap(async (req, res) =>
  res.json(await rows("SELECT id,subject,message,status,reply,created_at FROM tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 50", [req.user.id]))));
app.get("/api/admin/support", needAdmin, wrap(async (_req, res) =>
  res.json(await rows("SELECT * FROM tickets ORDER BY (status='open') DESC, created_at DESC LIMIT 300"))));
app.patch("/api/admin/support/:id", needAdmin, wrap(async (req, res) => {
  const status = req.body.status === "closed" ? "closed" : "open";
  if (typeof req.body.reply === "string")
    await run("UPDATE tickets SET reply=?, status=? WHERE id=?", [clean(req.body.reply, 2000), status, req.params.id]);
  else await run("UPDATE tickets SET status=? WHERE id=?", [status, req.params.id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/support/:id", needAdmin, wrap(async (req, res) => {
  await run("DELETE FROM tickets WHERE id=?", [req.params.id]); res.json({ ok: true });
}));

// --- ربط Kick: اليوزرات المراقبة ---
app.get("/api/admin/kick", needAdmin, wrap(async (_req, res) => res.json(await kick.status())));
app.post("/api/admin/kick", needAdmin, wrap(async (req, res) => {
  const slug = kick.normalize(req.body.slug);
  if (!slug) return res.status(400).json({ error: "يوزر Kick غير صحيح" });
  await run("INSERT OR IGNORE INTO kick_channels(slug,created_at) VALUES(?,?)", [slug, now()]);
  try { await kick.tick(true); } catch (e) { console.error("kick:", e.message); }
  res.json({ ok: true });
}));
app.delete("/api/admin/kick/:slug", needAdmin, wrap(async (req, res) => {
  await run("DELETE FROM kick_channels WHERE slug=?", [req.params.slug]); res.json({ ok: true });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "غير موجود" }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "خطأ في السيرفر" }); });

module.exports = app; // Vercel يستخدمه مباشرة (api/index.js)

if (require.main === module) { // تشغيل محلي أو على VPS: node server.js
  app.listen(PORT, () => {
    console.log(`الموقع شغّال: http://localhost:${PORT}`);
    if (!ADMIN_EMAILS.length) console.log("تنبيه: حدّد إيميل المشرف في ملف .env (ADMIN_EMAILS) عشان تصير مشرف.");
    if (!kick.enabled) console.log("Kick: غير مفعّل (حط KICK_CLIENT_ID و KICK_CLIENT_SECRET)");
  });
}
