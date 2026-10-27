"use strict";
// الربط مع Kick عبر الـ API الرسمي (api.kick.com/public/v1) باستخدام App Access Token.
// الفحص "عند الطلب": كل ما حد يفتح الموقع (أو يتحدّث تلقائياً كل 20 ثانية) نفحص Kick إذا مرّ وقت الفحص،
// وحالة كل قناة محفوظة في قاعدة البيانات، فيشتغل على Vercel بدون عمليات خلفية.
const API = process.env.KICK_API_URL || "https://api.kick.com/public/v1";
const TOKEN_URL = process.env.KICK_TOKEN_URL || "https://id.kick.com/oauth/token";

module.exports = function createKick({ rows, get, run }) {
  const CLIENT_ID = process.env.KICK_CLIENT_ID || "";
  const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || "";
  const POLL = Math.max(15, Number(process.env.KICK_POLL_SECONDS) || 30) * 1000;
  const enabled = !!(CLIENT_ID && CLIENT_SECRET);
  let token = null, tokenExp = 0; // كاش بسيط داخل نفس النسخة، ولو ضاع نجيب توكن جديد

  async function getToken() {
    if (token && Date.now() < tokenExp - 60000) return token;
    const r = await fetch(TOKEN_URL, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error("فشل جلب توكن Kick (تأكد من CLIENT_ID و CLIENT_SECRET)");
    token = j.access_token;
    tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return token;
  }

  // يرجع { live, title, start } أو { notFound:true }
  async function fetchChannel(slug) {
    const t = await getToken();
    const r = await fetch(`${API}/channels?slug=${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${t}`, Accept: "application/json" }
    });
    if (r.status === 401) { token = null; throw new Error("التوكن منتهي، بيتجدد بالفحص القادم"); }
    if (r.status === 400 || r.status === 404) return { notFound: true };
    if (!r.ok) throw new Error("Kick رجّع خطأ " + r.status);
    const j = await r.json();
    const ch = Array.isArray(j.data) ? j.data[0] : j.data;
    if (!ch) return { notFound: true };
    const s = ch.stream || {};
    return {
      live: s.is_live === true,
      title: String(ch.stream_title || s.title || "").slice(0, 120),
      start: s.start_time || s.started_at || null
    };
  }

  async function apply(ch, c) {
    const slug = ch.slug, t = Date.now();
    if (c.live) {
      const session = String(c.start || ch.session || t);
      const title = c.title || "بث مباشر على Kick";
      const same = await get("SELECT id,status,title FROM streams WHERE kick_slug=? AND kick_session=?", [slug, session]);
      if (!same) {
        const live = await get("SELECT id FROM streams WHERE kick_slug=? AND status='live'", [slug]);
        if (live) await run("UPDATE streams SET kick_session=?, title=?, streamer=COALESCE(streamer,?) WHERE id=?", [session, title, slug, live.id]);
        else await run("INSERT INTO streams(title,url,status,created_at,source,kick_slug,kick_session,streamer) VALUES(?,?,?,?,?,?,?,?)",
          [title, `https://kick.com/${slug}`, "live", t, "kick", slug, session, slug]);
      } else if (same.status === "live" && same.title !== title) {
        await run("UPDATE streams SET title=? WHERE id=?", [title, same.id]);
      }
      // لو المشرف أنهى البث يدوياً (status=ended) ما نرجّعه
      await run("UPDATE kick_channels SET off_count=0, session=?, last_live=1, last_title=?, last_error=NULL, last_checked=? WHERE slug=?", [session, title, t, slug]);
    } else {
      const off = (ch.off_count || 0) + 1;
      // نحتاج فحصين متتاليين "غير مباشر" قبل إنهاء البث (الـ API يتأخر ثواني أحياناً)
      if (off >= 2) {
        await run("UPDATE streams SET status='ended' WHERE kick_slug=? AND status='live'", [slug]);
        await run("UPDATE kick_channels SET off_count=?, session=NULL, last_live=0, last_title=NULL, last_error=NULL, last_checked=? WHERE slug=?", [off, t, slug]);
      } else {
        await run("UPDATE kick_channels SET off_count=?, last_live=0, last_error=NULL, last_checked=? WHERE slug=?", [off, t, slug]);
      }
    }
  }

  // force=true يتجاوز الانتظار (عند إضافة يوزر جديد). نحجز "دور الفحص" بعملية وحدة عشان ما يفحص أكثر من واحد بنفس الوقت.
  async function tick(force = false) {
    if (!enabled) return false;
    const t = Date.now();
    const claim = await run("UPDATE kv SET v=? WHERE k='kick_last' AND CAST(v AS INTEGER) < ?", [String(t), t - (force ? 3000 : POLL)]);
    if (!claim.changes) return false;
    const chans = await rows("SELECT * FROM kick_channels");
    await Promise.all(chans.map(async ch => {
      try {
        const c = await fetchChannel(ch.slug);
        if (c.notFound) return void await run("UPDATE kick_channels SET last_live=0, last_error=?, last_checked=? WHERE slug=?", ["اليوزر غير موجود في Kick", Date.now(), ch.slug]);
        await apply(ch, c);
      } catch (e) {
        await run("UPDATE kick_channels SET last_error=?, last_checked=? WHERE slug=?", [String(e.message).slice(0, 200), Date.now(), ch.slug]);
      }
    }));
    return true;
  }

  // للوحة المشرف
  async function status() {
    const list = await rows("SELECT * FROM kick_channels ORDER BY created_at");
    const last = await get("SELECT v FROM kv WHERE k='kick_last'");
    const channels = list.map(r => ({
      slug: r.slug,
      ...(r.last_error ? { error: r.last_error, checked: r.last_checked }
        : r.last_checked ? { live: !!r.last_live, title: r.last_title || "", checked: r.last_checked } : {})
    }));
    return { enabled, lastCheck: Number(last?.v) || null, error: channels.find(c => c.error)?.error || null, channels };
  }

  function normalize(s) { // يقبل اليوزر أو رابط القناة
    const m = String(s || "").trim().toLowerCase().replace(/^https?:\/\/(www\.)?kick\.com\//, "").split(/[/?#]/)[0];
    return /^[a-z0-9_-]{2,40}$/.test(m) ? m : "";
  }

  async function seed() { // اليوزرات من متغير KICK_CHANNELS
    for (const s of (process.env.KICK_CHANNELS || "").split(",")) {
      const slug = normalize(s);
      if (slug) await run("INSERT OR IGNORE INTO kick_channels(slug,created_at) VALUES(?,?)", [slug, Date.now()]);
    }
  }

  return { tick, status, seed, normalize, enabled };
};
