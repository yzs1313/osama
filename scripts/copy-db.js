"use strict";
// نسخ بياناتك من ملف data.db (القاعدة القديمة) إلى قاعدة Turso السحابية.
// الاستخدام:
//   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/copy-db.js ./data.db
// (الجلسات لا تُنسخ، فالكل يسجّل دخوله من جديد مرة وحدة)
const path = require("path");
const { createClient } = require("@libsql/client");
const { createDb } = require("../lib/db");

(async () => {
  const srcFile = process.argv[2] || "data.db";
  const destUrl = process.env.TURSO_DATABASE_URL;
  if (!destUrl) { console.error("حدّد TURSO_DATABASE_URL و TURSO_AUTH_TOKEN أول"); process.exit(1); }
  const dest = createDb(destUrl, process.env.TURSO_AUTH_TOKEN);
  await dest.ready;
  const src = createClient({ url: "file:" + path.resolve(srcFile) });

  const used = (await dest.get("SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM streams) AS s, (SELECT COUNT(*) FROM news) AS n"));
  if ((used.u || used.s || used.n) && !process.argv.includes("--force")) {
    console.error("القاعدة الوجهة فيها بيانات أصلاً. أضف --force لو متأكد (بيضيف فوقها وقد يتعارض)."); process.exit(1);
  }
  // الترتيب يحافظ على العلاقات (المستخدمون قبل التعليقات... إلخ)
  const tables = ["users", "news", "streams", "social_links", "discord", "kick_channels", "comments", "comment_likes", "tickets"];
  for (const t of tables) {
    let sc;
    try { sc = (await src.execute(`PRAGMA table_info(${t})`)).rows.map(r => r.name); } catch (_) { continue; }
    if (!sc.length) continue;
    const dc = await dest.columns(t);
    const cols = sc.filter(c => dc.includes(c));
    const data = (await src.execute(`SELECT ${cols.join(",")} FROM ${t}`)).rows;
    for (let i = 0; i < data.length; i += 100) {
      await dest.tx(data.slice(i, i + 100).map(r => [
        `INSERT OR REPLACE INTO ${t}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`, cols.map(c => r[c])]));
    }
    console.log(`${t}: ${data.length}`);
  }
  console.log("تم النسخ ✔");
  process.exit(0);
})().catch(e => { console.error("فشل:", e.message); process.exit(1); });
