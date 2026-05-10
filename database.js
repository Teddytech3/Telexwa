const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

let db;

function initDatabase() {
  const dbFolder = path.join(__dirname, "database");
  if (!fs.existsSync(dbFolder)) fs.mkdirSync(dbFolder);

  const dbPath = path.join(dbFolder, "trashbot.db");
  db = new Database(dbPath);

  db.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chatId TEXT,
      senderId TEXT,
      body TEXT,
      timestamp INTEGER
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS tg_users (
      tg_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      phone_number TEXT,
      first_seen INTEGER,
      last_seen INTEGER
    )
  `).run();

  return db;
}

function setSetting(key, value) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);
  stmt.run(key, JSON.stringify(value));
}

function getSetting(key, defaultValue = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : defaultValue;
}

function upsertTgUser({ tg_id, username, first_name, phone_number }) {
  const now = Date.now();
  const existing = db.prepare("SELECT tg_id FROM tg_users WHERE tg_id=?").get(String(tg_id));
  if (existing) {
    db.prepare("UPDATE tg_users SET username=?, first_name=?, phone_number=?, last_seen=? WHERE tg_id=?")
      .run(username || '', first_name || '', phone_number || '', now, String(tg_id));
  } else {
    db.prepare("INSERT INTO tg_users (tg_id, username, first_name, phone_number, first_seen, last_seen) VALUES (?,?,?,?,?,?)")
      .run(String(tg_id), username || '', first_name || '', phone_number || '', now, now);
  }
}

function getTgUsers() {
  return db.prepare("SELECT * FROM tg_users ORDER BY last_seen DESC").all();
}

function getTgUserCount() {
  const row = db.prepare("SELECT COUNT(*) as count FROM tg_users").get();
  return row ? row.count : 0;
}

function cleanupOldMessages(hours = 24) {
  if (!db) return 0;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const stmt = db.prepare("DELETE FROM messages WHERE timestamp < ?");
  const info = stmt.run(cutoff);
  return info.changes || 0;
}

module.exports = {
  initDatabase,
  setSetting,
  getSetting,
  upsertTgUser,
  getTgUsers,
  getTgUserCount,
  cleanupOldMessages,
  db
};
