// ============================================================
// TEDDY-XMD — by Trashcore
// database/antiViewOnce.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@trashcore/baileys');

module.exports = function initAntiViewOnce(trashcore, opts = {}) {

  const botNumber = opts.botNumber?.endsWith('@s.whatsapp.net')
   ? opts.botNumber
    : `${opts.botNumber}@s.whatsapp.net`;

  const STATE_PATH = path.join(__dirname, 'antiviewonce_state.json');

  let enabled = typeof opts.enabled === 'boolean'? opts.enabled : true;
  try {
    if (fs.existsSync(STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      enabled =!!s.enabled;
    }
  } catch {}

  global.antiViewOnceEnabled = enabled;

  function saveState(val) {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify({ enabled: val }, null, 2));
    } catch (e) {
      console.error('[antiViewOnce] saveState error:', e.message);
    }
  }

  // ── deep unwrap: handles ephemeral + all viewonce wrappers ──
  function deepUnwrap(msg) {
    if (!msg) return null;
    let m = msg;
    for (let i = 0; i < 10; i++) {
      if (m?.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
      if (m?.viewOnceMessage?.message) { return { inner: m.viewOnceMessage.message, wrapper: 'viewOnceMessage' }; }
      if (m?.viewOnceMessageV2?.message) { return { inner: m.viewOnceMessageV2.message, wrapper: 'viewOnceMessageV2' }; }
      if (m?.viewOnceMessageV2Extension?.message) { return { inner: m.viewOnceMessageV2Extension.message, wrapper: 'viewOnceMessageV2Extension' }; }
      break;
    }
    return null;
  }

  async function handleMessage(m) {
    try {
      if (!global.antiViewOnceEnabled) return;
      if (!m?.message) return;
      if (m.key.fromMe) return;

      const chat = m.key.remoteJid;
      if (!chat || chat === 'status@broadcast') return;

      const senderJid = m.key.participant || chat;
      const senderNum = senderJid.split('@')[0];
      const isGroup = chat.endsWith('@g.us');

      const result = deepUnwrap(m.message);
      if (!result) return;

      const { inner } = result;

      const imageMsg = inner?.imageMessage || null;
      const videoMsg = inner?.videoMessage || null;

      if (!imageMsg &&!videoMsg) return;

      const mediaMsg = imageMsg || videoMsg;
      const mediaType = imageMsg? 'image' : 'video';

      // ── chat name ──────────────────────────────────────────
      let chatName = isGroup? chat : `DM with +${senderNum}`;
      if (isGroup) {
        try {
          const meta = await trashcore.groupMetadata(chat);
          chatName = meta?.subject || chat;
        } catch {}
      }

      console.log(`[antiViewOnce] Intercepted ${mediaType} from ${senderNum} in ${chatName}`);

      // ── download ───────────────────────────────────────────
      let buffer;
      try {
        const stream = await downloadContentFromMessage(mediaMsg, mediaType);
        buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        if (!buffer || buffer.length === 0) throw new Error('Empty buffer');
      } catch (err) {
        console.error('[antiViewOnce] download failed:', err.message);
        await trashcore.sendMessage(botNumber, {
          text:
            `👁️ *Anti-ViewOnce*\n\n` +
            `• *From* : @${senderNum}\n` +
            `• *Chat* : ${chatName}\n` +
            `• *Type* : ${mediaType}\n\n` +
            `❌ Could not download media: ${err.message}`,
          mentions: [senderJid]
        });
        return;
      }

      // ── caption ────────────────────────────────────────────
      const caption =
        `👁️ *Anti-ViewOnce Captured*\n\n` +
        `• *From* : @${senderNum}\n` +
        `• *Chat* : ${chatName}\n` +
        `• *Type* : ${mediaType === 'image'? '🖼️ Image' : '🎥 Video'}\n` +
        (mediaMsg.caption? `• *Caption* : ${mediaMsg.caption}\n` : '') +
        `\n_Captured by TEDDY-XMD_ 🐻`;

      // ── send to bot DM ─────────────────────────────────────
      const msgPayload = mediaType === 'image'
       ? { image: buffer, caption, mimetype: 'image/jpeg' }
        : { video: buffer, caption, mimetype: 'video/mp4' };

      await trashcore.sendMessage(botNumber, {
       ...msgPayload,
        mentions: [senderJid],
        contextInfo: {
          mentionedJid: [senderJid],
          externalAdReply: {
            title: `👁️ View-Once — ${mediaType === 'image'? 'Image' : 'Video'}`,
            body: chatName,
            sourceUrl: 'https://github.com/TEDDY-XMD',
            mediaType: 1,
            renderLargerThumbnail: mediaType === 'image'
          }
        }
      });

      console.log(`[antiViewOnce] ✅ Forwarded ${mediaType} from ${senderNum}`);

    } catch (err) {
      console.error('[antiViewOnce] error:', err.message);
    }
  }

  // ── listen on messages.upsert ────────────────────────────────
  trashcore.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type!== 'notify') return;
    for (const m of messages) {
      try { await handleMessage(m); } catch (e) {
        console.error('[antiViewOnce] loop error:', e.message);
      }
    }
  });

  console.log(`✅ AntiViewOnce active [${enabled? 'ON' : 'OFF'}]`);

  return {
    enable: () => { global.antiViewOnceEnabled = true; saveState(true); },
    disable: () => { global.antiViewOnceEnabled = false; saveState(false); },
    toggle: () => { global.antiViewOnceEnabled =!global.antiViewOnceEnabled; saveState(global.antiViewOnceEnabled); return global.antiViewOnceEnabled; },
    isEnabled: () => global.antiViewOnceEnabled,
    saveState
  };
};