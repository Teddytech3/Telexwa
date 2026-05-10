const chalk = require('chalk');

const C = {
  dmBar:     chalk.hex('#f9c74f'),
  dmHeader:  chalk.hex('#f9c74f').bold,
  dmLabel:   chalk.hex('#f3722c').bold,       
  dmValue:   chalk.hex('#ffe8a1'),      
  dmName:    chalk.hex('#f94144').bold,        
  dmMsg:     chalk.hex('#ffffff').bold,        
  gcBar:     chalk.hex('#43aa8b'),
  gcHeader:  chalk.hex('#43aa8b').bold,
  gcLabel:   chalk.hex('#90be6d').bold,       
  gcValue:   chalk.hex('#dde5b6'),             
  gcName:    chalk.hex('#f9c74f').bold,        
  gcGroup:   chalk.hex('#43aa8b').bold,        
  gcMsg:     chalk.hex('#ffffff').bold,        

  arrow:     chalk.hex('#f8961e').bold,        
};

// ── EAT timezone (UTC+3) ──────────────────────────────────────
function nowTs() {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  const day  = now.toLocaleDateString('en-GB', { weekday: 'long' });
  const date = now.toLocaleDateString('en-GB');
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { day, date, time, full: `${day}, ${time} EAT` };
}

function hbar(colorFn, char = '─', len = 48) {
  return colorFn(char.repeat(len));
}

// ── Message helpers ───────────────────────────────────────────
function getMsgBody(m) {
  // unwrap view-once first
  const inner =
    m.message?.viewOnceMessage?.message ||
    m.message?.viewOnceMessageV2?.message ||
    m.message?.viewOnceMessageV2Extension?.message ||
    m.message;

  if (inner?.conversation)              return inner.conversation;
  if (inner?.extendedTextMessage?.text) return inner.extendedTextMessage.text;
  if (inner?.imageMessage?.caption)     return inner.imageMessage.caption;
  if (inner?.videoMessage?.caption)     return inner.videoMessage.caption;
  if (inner?.stickerMessage)            return '[Sticker]';
  if (inner?.audioMessage)              return '[Audio]';
  if (inner?.documentMessage)           return '[Document]';
  if (inner?.imageMessage)              return '[Image 👁️ view-once]';
  if (inner?.videoMessage)              return '[Video 👁️ view-once]';
  if (inner?.reactionMessage)           return `[React: ${inner.reactionMessage.text}]`;
  return '(empty)';
}

function getMsgType(m) {
  const isVO =
    !!m.message?.viewOnceMessage ||
    !!m.message?.viewOnceMessageV2 ||
    !!m.message?.viewOnceMessageV2Extension;

  const inner =
    m.message?.viewOnceMessage?.message ||
    m.message?.viewOnceMessageV2?.message ||
    m.message?.viewOnceMessageV2Extension?.message ||
    m.message;

  const base =
    inner?.conversation        ? 'conversation'        :
    inner?.extendedTextMessage ? 'extendedTextMessage' :
    inner?.imageMessage        ? 'imageMessage'        :
    inner?.videoMessage        ? 'videoMessage'        :
    inner?.stickerMessage      ? 'stickerMessage'      :
    inner?.audioMessage        ? 'audioMessage'        :
    inner?.documentMessage     ? 'documentMessage'     :
    inner?.reactionMessage     ? 'reactionMessage'     : 'unknown';

  return isVO ? `${base} [viewOnce]` : base;
}

// ── DM block ──────────────────────────────────────────────────
function logDM(senderName, senderNum, msgType, body) {
  const { full, date } = nowTs();
  const A = C.arrow('»');
  console.log('');
  console.log(`${hbar(C.dmBar, '─', 18)} ${C.dmHeader('『 TRASHCORE BOT 』')} ${hbar(C.dmBar, '─', 18)}`);
  console.log(`${A}  ${C.dmLabel('Sent Time:  ')} ${C.dmValue(full)}`);
  console.log(`${A}  ${C.dmLabel('Date:       ')} ${C.dmValue(date)}`);
  console.log(`${A}  ${C.dmLabel('Msg Type:   ')} ${C.dmValue(msgType)}`);
  console.log(`${A}  ${C.dmLabel('Sender Name:')} ${C.dmName(senderName || senderNum)}`);
  console.log(`${A}  ${C.dmLabel('Chat ID:    ')} ${C.dmValue(senderNum)}`);
  console.log(`${A}  ${C.dmLabel('Message:    ')} ${C.dmMsg(body)}`);
  console.log(`${hbar(C.dmBar, '─', 56)}`);
  console.log('');
}

// ── GC block ──────────────────────────────────────────────────
function logGC(senderName, senderNum, groupName, groupJid, msgType, body) {
  const { full, date } = nowTs();
  const A = C.arrow('»');
  console.log('');
  console.log(`${hbar(C.gcBar, '─', 18)} ${C.gcHeader('『 TRASHCORE BOT 』')} ${hbar(C.gcBar, '─', 18)}`);
  console.log(`${A}  ${C.gcLabel('Sent Time:  ')} ${C.gcValue(full)}`);
  console.log(`${A}  ${C.gcLabel('Date:       ')} ${C.gcValue(date)}`);
  console.log(`${A}  ${C.gcLabel('Msg Type:   ')} ${C.gcValue(msgType)}`);
  console.log(`${A}  ${C.gcLabel('Sender Name:')} ${C.gcName(senderName || senderNum)}`);
  console.log(`${A}  ${C.gcLabel('Chat ID:    ')} ${C.gcValue(senderNum)}`);
  console.log(`${A}  ${C.gcLabel('Group:      ')} ${C.gcGroup(groupName || groupJid)}`);
  console.log(`${A}  ${C.gcLabel('Group JID:  ')} ${C.gcValue(groupJid)}`);
  console.log(`${A}  ${C.gcLabel('Message:    ')} ${C.gcMsg(body)}`);
  console.log(`${hbar(C.gcBar, '─', 56)}`);
  console.log('');
}

// ── Main exported function ────────────────────────────────────
async function logMessage(m, trashcore) {
  if (!m?.message) return;

  const chatId     = m.key.remoteJid;
  const isGroup    = chatId.endsWith('@g.us');
  const senderJid  = m.key.participant || chatId;
  const sender     = senderJid.split('@')[0].split(':')[0];
  const senderName = m.pushName || sender;
  const body       = getMsgBody(m);
  const msgType    = getMsgType(m);

  if (isGroup) {
    let groupName = chatId;
    try {
      const meta = global.getGroupMeta
        ? await global.getGroupMeta(trashcore, chatId)
        : await trashcore.groupMetadata(chatId);
      groupName = meta?.subject || chatId;
    } catch {
      groupName = chatId;
    }
    logGC(senderName, sender, groupName, chatId, msgType, body);
  } else {
    logDM(senderName, sender, msgType, body);
  }
}

module.exports = { logMessage };
