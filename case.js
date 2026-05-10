// ============================================================
// TEDDY-XMD — Command Handler
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { downloadContentFromMessage, generateWAMessageFromContent, generateWAMessageContent } = require('@trashcore/baileys');
const { writeExifImg, writeExifVid } = require('./library/exif');
const config = require('./config');
const { getSetting, setSetting } = require('./database');

const NEXRAY_API = 'https://api.nexray.web.id';

function formatUptime(seconds) {
  seconds = Number(seconds);
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function detectPlatform() {
  if (process.env.DYNO) return 'Heroku';
  if (process.env.RENDER) return 'Render';
  if (process.env.P_SERVER_UUID) return 'Panel';
  switch (os.platform()) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return 'Unknown';
  }
}

async function handleCase(trashcore, m, { command, args, text, from, isOwner, isAdmin, isBotAdmin, metadata, prefix, getSetting: sessionGet, setSetting: sessionSet, xreply, applyFont }) {

  const reply = (txt) => trashcore.sendMessage(from, { text: txt }, { quoted: m });

  switch (command) {

    // ================= MENU =================
    case 'menu':
    case 'help': {
      try {
        const startTime = global.botStartTime || Date.now();
        const uptimeSeconds = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
        const uptime = formatUptime(uptimeSeconds);
        const pfx = sessionGet('prefix', '.');
        const privateMode = sessionGet('privateMode', false);
        const mode = privateMode? 'PRIVATE' : 'PUBLIC';
        const ramMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        const platform = detectPlatform();
        const ownerName = sessionGet('ownerName', 'Owner');
        const menuSettings = sessionGet('menuSettings', { mode: 'text' });

        const cmds = [
          'menu', 'ping', 'uptime', 'mode', 'play', 'tiktok', 'promote', 'demote',
          'kick', 'vv', 'kill', 'setprefix', 'autotyping', 'autorecord', 'swgc',
          'antilink', 'claude', 'sticker'
        ];

        const header = `
╭─「 *TEDDY-XMD* 」
│ 🧸 Owner : ${ownerName}
│ ⚙️ Prefix : ${pfx}
│ 🌍 Mode : ${mode}
│ 📊 Commands : ${cmds.length}
│ ⏱️ Uptime : ${uptime}
│ 💾 RAM : ${ramMB} MB
│ 💻 Host : ${platform}
╰───────────────

`;

        const commandsText = `╭─「 *COMMAND LIST* 」
${cmds.map(c => `│ ${pfx}${c}`).join('\n')}
╰───────────────
> Powered by TEDDY-XMD`;

        const fullText = applyFont? applyFont(header + commandsText) : header + commandsText;

        const MENU_IMAGE_URL = 'https://files.catbox.moe/13nyhx.jpg';

        const loaderKey = (await trashcore.sendMessage(from, { text: '_Loading menu..._' })).key;
        await trashcore.sendMessage(from, { delete: loaderKey }).catch(() => {});

        if (menuSettings.mode === 'video' && menuSettings.videoUrl) {
          await trashcore.sendMessage(from, { video: { url: menuSettings.videoUrl }, gifPlayback: true, caption: fullText }, { quoted: m });
        } else {
          const imageSource = (menuSettings.mode === 'image' && menuSettings.imageUrl)
           ? { url: menuSettings.imageUrl }
            : { url: MENU_IMAGE_URL };
          await trashcore.sendMessage(from, { image: imageSource, caption: fullText }, { quoted: m });
        }
      } catch (err) {
        console.error('Menu Error:', err);
        reply('❌ Failed to load menu.');
      }
      break;
    }

    // ================= PING =================
    case 'ping':
    case 'p': {
      const start = Date.now();
      await xreply('Pinging...');
      await xreply(`📍 Pong: ${Date.now() - start} ms`);
      break;
    }

    // ================= UPTIME =================
    case 'uptime':
    case 'runtime':
    case 'host': {
      const host = detectPlatform();
      const uptime = formatUptime(process.uptime());
      await xreply(`*🐻 TEDDY-XMD*\n\n📡 Platform: ${host}\n⏱️ Runtime: ${uptime}\n🔄 Status: Online`);
      break;
    }

    // ================= PLAY =================
    case 'play': {
      try {
        if (!args.length) return xreply('🎵 Provide a song name\nExample:.play Faded');
        const query = args.join(' ');
        const { data } = await axios.get(
          `https://api.fvckers.my.id/api/downloader/ytplay?q=${encodeURIComponent(query)}`,
          { timeout: 20000 }
        );
        if (!data?.success ||!data?.data) return xreply('❌ Song not found.');
        const info = data.info;
        const result = data.data;
        const totalSec = Math.floor(info.duration);
        const minutes = Math.floor(totalSec / 60);
        const seconds = totalSec % 60;

        await trashcore.sendMessage(from, {
          text: `🎶 *Now Playing*\n\nTitle: ${info.title}\nDuration: ${minutes}:${seconds.toString().padStart(2, '0')}`
        }, { quoted: m });

        await trashcore.sendMessage(from, {
          audio: { url: result.download },
          mimetype: 'audio/mpeg',
          fileName: `${info.title.slice(0, 50)}.mp3`
        }, { quoted: m });
      } catch (err) {
        console.error('Play Error:', err.message);
        xreply('⚠️ Failed to fetch the song.');
      }
      break;
    }

    // ================= TIKTOK =================
    case 'tiktok':
    case 'tt': {
      try {
        if (!args[0]) return xreply('⚠️ Provide a TikTok link.');
        await xreply('⏳ Fetching TikTok data...');
        const fg = require('api-dylux');
        const data = await fg.tiktok(args[0]);
        const json = data.result;
        let caption = `🎵 *TikTok Download*\n\nUsername: ${json.author.nickname}\nTitle: ${json.title}\nLikes: ${json.digg_count}`;

        if (json.images?.length > 0) {
          for (const imgUrl of json.images)
            await trashcore.sendMessage(from, { image: { url: imgUrl } }, { quoted: m });
        } else {
          await trashcore.sendMessage(from, { video: { url: json.play }, mimetype: 'video/mp4', caption }, { quoted: m });
        }
      } catch (err) {
        console.error('TikTok Error:', err);
        await xreply('❌ Failed to fetch TikTok data.');
      }
      break;
    }

    // ================= PROMOTE =================
    case 'promote': {
      try {
        if (!from.endsWith('@g.us')) return xreply('⚠️ Group only.');
        if (!isOwner) return xreply('⚠️ Owner only.');
        let target = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
          m.message?.extendedTextMessage?.contextInfo?.participant;
        if (!target) return xreply('⚠️ Mention or reply to a user.');
        await trashcore.groupParticipantsUpdate(from, [target], 'promote');
        await xreply(`✅ Promoted @${target.split('@')[0]}`);
      } catch (err) {
        console.error('Promote Error:', err);
        return xreply('❌ Failed to promote member.');
      }
      break;
    }

    // ================= DEMOTE =================
    case 'demote': {
      try {
        if (!from.endsWith('@g.us')) return xreply('⚠️ Group only.');
        if (!isOwner) return xreply('⚠️ Owner only.');
        let target = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
          m.message?.extendedTextMessage?.contextInfo?.participant;
        if (!target) return xreply('⚠️ Mention or reply to a user.');
        await trashcore.groupParticipantsUpdate(from, [target], 'demote');
        await xreply(`✅ Demoted @${target.split('@')[0]}`);
      } catch (err) {
        console.error('Demote Error:', err);
        return xreply('❌ Failed to demote member.');
      }
      break;
    }

    // ================= KICK =================
    case 'kick': {
      try {
        if (!from.endsWith('@g.us')) return xreply('⚠️ Group only.');
        if (!isOwner) return xreply('⚠️ Owner only.');
        let target = m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
          m.message?.extendedTextMessage?.contextInfo?.participant;
        if (!target) return xreply('⚠️ Mention or reply to a user.');
        await trashcore.groupParticipantsUpdate(from, [target], 'remove');
        return xreply(`👢 Removed @${target.split('@')[0]}`);
      } catch (err) {
        console.error('Kick Error:', err);
        return xreply('❌ Failed to kick member.');
      }
      break;
    }

    // ================= VV =================
    case 'vv':
    case 'viewonce': {
      try {
        if (!m.quoted) return xreply('⚠️ Reply to a view once message!');
        const viewOnceMsg = m.quoted.message?.viewOnceMessage?.message || m.quoted.message;
        const imageMsg = viewOnceMsg?.imageMessage;
        const videoMsg = viewOnceMsg?.videoMessage;
        if (!imageMsg &&!videoMsg) return xreply('⚠️ Not a view once message!');
        const type = imageMsg? 'image' : 'video';
        const stream = await downloadContentFromMessage(imageMsg || videoMsg, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await trashcore.sendMessage(from,
          type === 'image'
           ? { image: buffer, caption: '*Retrieved by TEDDY-XMD*' }
            : { video: buffer, caption: '*Retrieved by TEDDY-XMD*' },
          { quoted: m }
        );
      } catch (err) {
        console.error('VV Error:', err);
        xreply('❌ Failed to retrieve view-once media.');
      }
      break;
    }

    // ================= KILL =================
    case 'kill': {
      try {
        if (!from.endsWith('@g.us')) return xreply('⚠️ Group only.');
        if (!isOwner) return xreply('❌ Owner only.');
        const members = metadata.participants
         .filter(p => p.id!== trashcore.user.id)
         .map(p => p.id);
        xreply('💀 Initializing Kill command... All members will be removed.');
        await trashcore.groupUpdateSubject(from, 'TEDDY-XMD');
        await trashcore.groupUpdateDescription(from, 'This group is managed by TEDDY-XMD');
        setTimeout(async () => {
          await trashcore.sendMessage(from, {
            text: `⚠️ Removing ${members.length} member(s) now. Goodbye everyone 👋`
          }, { quoted: m });
          await trashcore.groupParticipantsUpdate(from, members, 'remove');
          setTimeout(() => trashcore.groupLeave(from), 1500);
        }, 1500);
      } catch (err) {
        console.error('Kill Error:', err);
        reply('❌ Failed to execute kill command.');
      }
      break;
    }

    // ================= MODE =================
    case 'mode': {
      if (!isOwner) return xreply('❌ Owner only.');
      if (!args[0] ||!['private', 'public'].includes(args[0]))
        return xreply('Usage:.mode private/public');
      const newMode = args[0] === 'private';
      await sessionSet('privateMode', newMode);
      xreply(`✅ Mode: ${newMode? 'PRIVATE' : 'PUBLIC'}`);
      break;
    }

    // ================= SETPREFIX =================
    case 'setprefix': {
      if (!isOwner) return xreply('❌ Owner only.');
      if (!args[0]) return xreply('Usage:.setprefix <prefix>');
      sessionSet('prefix', args[0]);
      await xreply(`✅ Prefix set to: ${args[0]}`);
      break;
    }

    // ================= AUTOTYPING =================
    case 'autotyping': {
      if (!isOwner) return xreply('❌ Owner only.');
      if (!args[0] ||!['on', 'off'].includes(args[0])) return xreply('Usage:.autotyping on/off');
      const val = args[0] === 'on';
      await sessionSet('autoTyping', val);
      xreply(`✅ Auto Typing is now: ${val? 'ON' : 'OFF'}`);
      break;
    }

    // ================= AUTORECORD =================
    case 'autorecord': {
      if (!isOwner) return xreply('❌ Owner only.');
      if (!args[0] ||!['on', 'off'].includes(args[0])) return xreply('Usage:.autorecord on/off');
      const val = args[0] === 'on';
      await sessionSet('autoRecord', val);
      xreply(`✅ Auto Record is now: ${val? 'ON' : 'OFF'}`);
      break;
    }

    // ================= ANTILINK =================
    case 'antilink': {
      try {
        if (!from.endsWith('@g.us')) return xreply('⚠️ Group only.');
        if (!isOwner &&!isAdmin) return xreply('❌ Admins only.');
        if (!args[0] ||!['on', 'off'].includes(args[0])) return xreply('Usage:.antilink on/off');
        const val = args[0] === 'on';
        await sessionSet(`antilink_${from}`, val);
        xreply(`✅ Anti-Link is now: ${val? 'ON' : 'OFF'}`);
      } catch (err) {
        console.error('Antilink Error:', err);
        reply('❌ Failed to toggle antilink.');
      }
      break;
    }

    // ================= CLAUDE =================
    case 'claude':
    case 'claudeai': {
      try {
        const query = args.join(' ');
        if (!query) return xreply('Usage:.claude <message>');
        await xreply('🤖 Asking Claude...');
        const { data } = await axios.get(`${NEXRAY_API}/ai/claude?text=${encodeURIComponent(query)}`);
        reply(data.status? `💬 Claude:\n\n${data.result}` : '❌ Failed to get response');
      } catch (err) {
        console.error('Claude Error:', err);
        xreply('❌ Error contacting Claude AI');
      }
      break;
    }

    // ================= STICKER =================
    case 'sticker':
    case 's': {
      try {
        const quotedMsg = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const msg = quotedMsg?.imageMessage || quotedMsg?.videoMessage || m.message?.imageMessage || m.message?.videoMessage;
        if (!msg) return xreply('⚠️ Reply to an image or video.');
        if (msg.videoMessage?.seconds > 30) return xreply('⚠️ Max 30s for video stickers.');

        await xreply('🪄 Creating sticker...');
        const stream = await downloadContentFromMessage(msg, msg.mimetype.split('/')[0]);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        const opts = { packname: config.PACK_NAME || 'TEDDY-XMD', author: config.AUTHOR || 'Bot' };
        let webpPath;
        if (/image/.test(msg.mimetype)) webpPath = await writeExifImg(buffer, opts);
        else webpPath = await writeExifVid(buffer, opts);

        await trashcore.sendMessage(from, { sticker: fs.readFileSync(webpPath) }, { quoted: m });
        fs.unlinkSync(webpPath);
      } catch (err) {
        console.error('Sticker Error:', err);
        await xreply(`💥 Failed to create sticker:\n${err.message}`);
      }
      break;
    }

    default:
      break;
  }
}

module.exports = handleCase;