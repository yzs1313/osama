"use strict";
// طبقة قاعدة البيانات: libSQL (SQLite متوافق).
//  - محلياً أو على VPS: ملف data.db (الافتراضي)
//  - على Vercel: قاعدة Turso السحابية (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
const path = require("path");
const { createClient } = require("@libsql/client");

const SCHEMA_VERSION = "3";

function createDb(url, authToken) {
  const client = createClient({ url, authToken: authToken || undefined });
  const rows = async (sql, args = []) => (await client.execute({ sql, args })).rows.map(r => ({ ...r }));
  const get = async (sql, args = []) => (await rows(sql, args))[0];
  const run = async (sql, args = []) => {
    const r = await client.execute({ sql, args });
    return { changes: r.rowsAffected, id: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid) };
  };
  const tx = stmts => client.batch(stmts.map(([sql, args = []]) => ({ sql, args })), "write"); // كلها أو ولا وحدة
  const columns = async table => (await rows(`PRAGMA table_info(${table})`)).map(c => c.name);
  const addColumn = async (table, name, def) => {
    if (!(await columns(table)).includes(name)) await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };

  async function init() {
    // لو القاعدة جاهزة بنفس الإصدار نتخطى (يوفر وقت على الـ cold start في Vercel)
    try {
      const v = await get("SELECT v FROM kv WHERE k='schema'");
      if (v && v.v === SCHEMA_VERSION) return;
    } catch (_) { /* الجدول غير موجود بعد */ }

    await client.executeMultiple(`
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS streams(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'soon',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comment_likes(
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY(comment_id, user_id)
);
CREATE TABLE IF NOT EXISTS kick_channels(slug TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS social_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discord(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, url TEXT NOT NULL, category TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS hits(k TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hits ON hits(k, ts);
`);
    // ترقية القواعد القديمة (أعمدة أضيفت مع الإصدارات)
    await addColumn("streams", "source", "TEXT NOT NULL DEFAULT 'manual'");
    await addColumn("streams", "kick_slug", "TEXT");
    await addColumn("streams", "kick_session", "TEXT");
    await addColumn("streams", "streamer", "TEXT");
    await addColumn("users", "discord_id", "TEXT");
    await addColumn("users", "google_id", "TEXT");
    await addColumn("tickets", "ip_hash", "TEXT");
    for (const [c, d] of [["off_count", "INTEGER NOT NULL DEFAULT 0"], ["session", "TEXT"], ["last_live", "INTEGER"],
      ["last_title", "TEXT"], ["last_error", "TEXT"], ["last_checked", "INTEGER"]]) await addColumn("kick_channels", c, d);
    await client.executeMultiple(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google ON users(google_id);
UPDATE streams SET streamer=kick_slug WHERE streamer IS NULL AND kick_slug IS NOT NULL;
INSERT OR IGNORE INTO kv(k,v) VALUES('kick_last','0');
`);
    await run("INSERT INTO kv(k,v) VALUES('schema',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [SCHEMA_VERSION]);
  }

  return { client, rows, get, run, tx, columns, ready: init() };
}

// القاعدة الافتراضية للتطبيق
const url = process.env.TURSO_DATABASE_URL
  || "file:" + (process.env.DB_FILE || path.join(__dirname, "..", "data.db"));

module.exports = { createDb, defaultDb: () => createDb(url, process.env.TURSO_AUTH_TOKEN), url };
