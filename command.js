// ============================================================
//  TELEXWA — by Trashcore
//  command.js  |  the command router file 
// you can edit this file carefully depending on your needs 
// ============================================================

const { getSetting, setSetting } = require('./database');
const handleCase                  = require('./case');
const { jidNormalizedUser } = require('@trashcore/baileys');
const fontConverter         = require('./utils/fontConverter');
const { connect }           = require('./utils/connect');

const CREATOR_NUMBER = '254104245659';

let _initialized = false;

const GROUP_KEY_PREFIXES = ['welcome_', 'goodbye_', 'antilink_', 'antilinkgc_', 'warn_', 'antipromote_', 'antidemote_'];

function makeSessionSettings(botNumber) {
  const isGroupKey = (key) => GROUP_KEY_PREFIXES.some(p => key.startsWith(p));
  const scopedKey  = (key) => isGroupKey(key) ? key : `${botNumber}:${key}`;
  return {
    sessionGetSetting: (key, def = null) => getSetting(scopedKey(key), def),
    sessionSetSetting: (key, val)        => setSetting(scopedKey(key), val),
  };
}

function normalizeNumber(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : '';
}

function isSudoOrCreator(bareNumber) {
  if (bareNumber === CREATOR_NUMBER) return true;
  const list = getSetting('sudoUsers', []);
  const now  = Date.now();
  return list.some(e => e.number === bareNumber && (!e.expiresAt || e.expiresAt > now));
}


async function handleMessage(trashcore, m) {
  if (!m || !m.message) return;

  if (!_initialized) {
    _initialized = true;
    try { await connect(trashcore); } catch (err) { console.error('connect error:', err.message); }
  }

  const chatId   = m.key.remoteJid;
  const isGroup  = chatId.endsWith('@g.us');
  const isFromMe = m.key.fromMe === true;

  if (isFromMe && isGroup) return;

  const senderJid    = m.key.participant || chatId;
  const senderNumber = normalizeNumber(senderJid);
  const botNumber    = normalizeNumber(trashcore.user.id);
  const isOwner      = senderNumber === botNumber || isSudoOrCreator(senderNumber);

  const { sessionGetSetting, sessionSetSetting } = makeSessionSettings(botNumber);

 
  const text =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    m.message?.documentMessage?.caption ||
    m.message?.buttonsResponseMessage?.selectedButtonId ||
    m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.message?.templateButtonReplyMessage?.selectedId ||
    '';

  if (!text) return;

  const prefix = sessionGetSetting('prefix', '.');
  if (!text.startsWith(prefix)) return;

  const rawArgs = text.slice(prefix.length).trim().split(/\s+/);
  const command = rawArgs.shift().toLowerCase();
  const args    = rawArgs;

  const privateMode = sessionGetSetting('privateMode', false);
  if (privateMode && !isOwner) return;

  let metadata   = {};
  let isAdmin    = false;
  let isBotAdmin = false;

  if (isGroup) {
    try {
      metadata = global.getGroupMeta
        ? await global.getGroupMeta(trashcore, chatId)
        : await trashcore.groupMetadata(chatId).catch(() => ({}));

      if (metadata?.participants) {
        const toBare    = jid => jidNormalizedUser(jid).split('@')[0];
        const senderBare = toBare(senderJid);
        const botBare    = toBare(trashcore.user.id);

        const adminCheck = metadata.participants.find(p => toBare(p.id) === senderBare);
        isAdmin = adminCheck?.admin === 'admin' || adminCheck?.admin === 'superadmin' || false;

        const botCheck = metadata.participants.find(p => toBare(p.id) === botBare);
        isBotAdmin = botCheck?.admin === 'admin' || botCheck?.admin === 'superadmin' || false;
      }
    } catch {}
  }

  m.quoted = null;
  const contextInfo = m.message?.extendedTextMessage?.contextInfo;
  if (contextInfo?.quotedMessage) {
    m.quoted = {
      message: contextInfo.quotedMessage,
      key: {
        remoteJid:   chatId,
        fromMe:      jidNormalizedUser(contextInfo.participant) === jidNormalizedUser(trashcore.user.id),
        id:          contextInfo.stanzaId,
        participant: contextInfo.participant
      },
      fromMe: jidNormalizedUser(contextInfo.participant) === jidNormalizedUser(trashcore.user.id)
    };
  }

  const _applyFont = (t) => fontConverter.applyFont(String(t), sessionGetSetting);

  const xreply = async (replyText) => {
    await trashcore.sendMessage(chatId, { text: _applyFont(replyText) }, { quoted: m });
  };

  try {
    await handleCase(trashcore, m, {
      command,
      args,
      text:         args.join(' '),
      from:         chatId,
      isGroup,
      isSelf:       isOwner,
      isOwner,
      isAdmin,
      isBotAdmin,
      metadata,
      participants: metadata?.participants || [],
      sender:       senderNumber,
      senderJid,
      prefix,
      pushName:     m.pushName || '',
      xreply,
      applyFont:    _applyFont,
      getSetting:   sessionGetSetting,
      setSetting:   sessionSetSetting,
      botStartTime: global.botStartTime,
    });
  } catch (err) {
    console.error(`❌ Case error [${command}]:`, err.message);
  }
}

module.exports = handleMessage;
