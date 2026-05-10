const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'teddy.db');
const db = new sqlite3.Database(dbPath);

async function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS tg_users (
        tg_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        phone_number TEXT
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS message_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        sender TEXT,
        message TEXT,
        timestamp INTEGER
      )`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function getSetting(key, def = null) {
  return new Promise((resolve) => {
    db.get('SELECT value FROM settings WHERE key =?', [key], (err, row) => {
      if (err ||!row) return resolve(def);
      try {
        resolve(JSON.parse(row.value));
      } catch {
        resolve(row.value);
      }
    });
  });
}

function setSetting(key, value) {
  return new Promise((resolve, reject) => {
    const val = typeof value === 'object'? JSON.stringify(value) : String(value);
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [key, val], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function upsertTgUser({ tg_id, username, first_name, phone_number }) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO tg_users (tg_id, username, first_name, phone_number) VALUES (?,?,?)',
      [tg_id, username, first_name, phone_number],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function getTgUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM tg_users', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getTgUserCount() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM tg_users', [], (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function logMessage(m, trashcore) {
  return new Promise((resolve) => {
    const chat_id = m.key.remoteJid;
    const sender = m.key.participant || m.key.remoteJid;
    const message = m.message?.conversation || m.message?.extendedTextMessage?.text || '[media]';
    const timestamp = Date.now();

    db.run(
      'INSERT INTO message_logs (chat_id, sender, message, timestamp) VALUES (?,?,?)',
      [chat_id, sender, message, timestamp],
      () => resolve()
    );
  });
}

module.exports = {
  initDatabase,
  getSetting,
  setSetting,
  upsertTgUser,
  getTgUsers,
  getTgUserCount,
  logMessage,
  db
};
