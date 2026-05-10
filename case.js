// ============================================================
// TEDDY-XMD — Command Handler
// ============================================================

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { downloadContentFromMessage } = require('@trashcore/baileys');
const { writeExifImg, writeExifVid } = require('./library/exif');
const config = require('./config');

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

        const cmds = [
          'menu', 'ping', 'uptime', 'runtime', 'mode', 'setprefix',
          'play', 'song', 'video', 'tiktok', 'sticker', 'vv', 'toimg', 'copy',
          'promote', 'demote', 'kick', 'add', 'tagall', 'group', 'groupinfo',
          'mute', 'unmute', 'antilink', 'antidelete',
          'autotyping', 'autorecord', 'autoviewstatus', 'autolikestatus',
          'autoread', 'autoblue', 'autoreact', 'autobio', 'autosavecontact',
          'antiban', 'anticall', 'ai', 'gpt', 'image',
          'addnewsletter', 'listnewsletter',
          'owner', 'addprem', 'delprem', 'public', 'self', 'ban', 'unban',
          'kill'
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
> Powered by TEDDY-XMD | Creator: @xdbot1`;

        const fullText = applyFont? applyFont(header + commandsText) : header + commandsText;
        const MENU_IMAGE_URL = 'https://files.catbox.moe/13nyhx.jpg';

        await trashcore.sendMessage(from, { image: { url: MENU_IMAGE_URL }, caption: fullText }, { quoted: m });
      } catch (err) {
        console.error('Menu Error:', err);
        reply('❌ Failed to load menu.');
      }
      break;
    }

    case 'ping':
    case 'p': {
      const start = Date.now();
      await xreply('Pinging...');
      await xreply(`📍 Pong: ${Date.now() - start} ms`);
      break;
    }

    case 'uptime':
    case 'runtime':
    case 'host': {
      const host = detectPlatform();
      const uptime = formatUptime(process.uptime());
      await xreply(`*🐻 TEDDY-XMD*\n\n📡 Platform: ${host}\n⏱️ Runtime: ${uptime}\n🔄 Status: Online`);
      break;
    }

    case 'antidelete': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}antidelete on/off`);
      await sessionSet('antidelete', opt === 'on');
      xreply(`✅ Anti-Delete: ${opt.toUpperCase()}\nDeleted messages will be forwarded to you.`);
      break;
    }

    case 'play':
    case 'song': {
      try {
        if (!args.length) return xreply(`🎵 Provide a song name\nExample: ${prefix}play Faded`);
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
        xreply('⚠️ Failed to fetch the song.');
      }
      break;
    }

    case 'video': {
      try {
        if (!args[0]) return xreply(`⚠️ Provide a video link.\nExample: ${prefix}video https://youtu.be/xxx`);
        await xreply('⏳ Downloading video...');
        const { data } = await axios.get(
          `https://api.fvckers.my.id/api/downloader/ytmp4?url=${encodeURIComponent(args[0])}`,
          { timeout: 30000 }
        );
        if (!data?.success) return xreply('❌ Failed to download video.');
        await trashcore.sendMessage(from, {
          video: { url: data.data.download },
          mimetype: 'video/mp4',
          caption: data.data.title || 'Video'
        }, { quoted: m });
      } catch (err) {
        xreply('❌ Failed to fetch video.');
      }
      break;
    }

    case 'vv': {
      try {
        if (!m.message?.extendedTextMessage?.contextInfo?.quotedMessage?.viewOnceMessage)
          return xreply('⚠️ Reply to a view once message.');
        const msg = m.message.extendedTextMessage.contextInfo.quotedMessage.viewOnceMessage.message;
        const type = Object.keys(msg)[0];
        const stream = await downloadContentFromMessage(msg[type], type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        if (type === 'imageMessage') {
          await trashcore.sendMessage(from, { image: buffer, caption: msg.imageMessage.caption || '' }, { quoted: m });
        } else if (type === 'videoMessage') {
          await trashcore.sendMessage(from, { video: buffer, caption: msg.videoMessage.caption || '' }, { quoted: m });
        }
      } catch (err) {
        xreply('❌ Failed to retrieve view once media.');
      }
      break;
    }

    case 'autorecord': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}autorecord on/off`);
      await sessionSet('autoRecord', opt === 'on');
      xreply(`✅ Auto Recording: ${opt.toUpperCase()}`);
      break;
    }

    case 'alwaysonline': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}alwaysonline on/off`);
      await sessionSet('alwaysOnline', opt === 'on');
      xreply(`✅ Always Online: ${opt.toUpperCase()}`);
      break;
    }

    case 'autotyping': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}autotyping on/off`);
      await sessionSet('autoTyping', opt === 'on');
      xreply(`✅ Auto Typing: ${opt.toUpperCase()}`);
      break;
    }

    case 'autolikestatus': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}autolikestatus on/off`);
      await sessionSet('autoLikeStatus', opt === 'on');
      xreply(`✅ Auto Like Status: ${opt.toUpperCase()}`);
      break;
    }

    case 'ai': {
      if (!args.length) return xreply(`Usage: ${prefix}ai <question>\nExample: ${prefix}ai who is Elon Musk`);
      try {
        const { data } = await axios.get(`https://api.nexray.web.id/ai/gpt?query=${encodeURIComponent(args.join(' '))}`);
        if (!data?.result) return xreply('❌ AI failed to respond.');
        xreply(data.result);
      } catch (err) {
        xreply('❌ AI error.');
      }
      break;
    }

    case 'gpt': {
      if (!args.length) return xreply(`Usage: ${prefix}gpt <question>`);
      try {
        const { data } = await axios.get(`https://api.nexray.web.id/ai/chatgpt?query=${encodeURIComponent(args.join(' '))}`);
        if (!data?.result) return xreply('❌ GPT failed to respond.');
        xreply(data.result);
      } catch (err) {
        xreply('❌ GPT error.');
      }
      break;
    }

    case 'autoblue':
    case 'autoread': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}autoread on/off`);
      await sessionSet('autoRead', opt === 'on');
      xreply(`✅ Auto Read/Blue Ticks: ${opt.toUpperCase()}`);
      break;
    }

    case 'autoreact': {
      if (!isOwner) return xreply('❌ Owner only.');
      const emoji = args[0];
      if (!emoji) return xreply(`Usage: ${prefix}autoreact ❤️\nUse 'off' to disable.`);
      if (emoji === 'off') {
        await sessionSet('autoReact', false);
        return xreply('✅ Auto React: OFF');
      }
      await sessionSet('autoReact', emoji);
      xreply(`✅ Auto React: ${emoji}`);
      break;
    }

    case 'image': {
      if (!args.length) return xreply(`Usage: ${prefix}image cute cat in space`);
      try {
        const prompt = encodeURIComponent(args.join(' '));
        const url = `https://api.nexray.web.id/ai/imagine?prompt=${prompt}`;
        await trashcore.sendMessage(from, { image: { url }, caption: `🎨 Prompt: ${args.join(' ')}` }, { quoted: m });
      } catch (err) {
        xreply('❌ Failed to generate image.');
      }
      break;
    }

    case 'antiban': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}antiban on/off`);
      await sessionSet('antiBan', opt === 'on');
      xreply(`✅ Anti-Ban Mode: ${opt.toUpperCase()}\nReduces spam actions to avoid bans.`);
      break;
    }

    case 'autosavecontact': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}autosavecontact on/off`);
      await sessionSet('autoSaveContact', opt === 'on');
      xreply(`✅ Auto Save Contacts: ${opt.toUpperCase()}`);
      break;
    }

    case 'anticall': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}anticall on/off`);
      await sessionSet('antiCall', opt === 'on');
      xreply(`✅ Anti-Call: ${opt.toUpperCase()}\nIncoming calls will be auto-rejected.`);
      break;
    }

    case 'autobio': {
      if (!isOwner) return xreply('❌ Owner only.');
      const opt = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(opt)) return xreply(`Usage: ${prefix}autobio on/off`);
      await sessionSet('autoBio', opt === 'on');
      xreply(`✅ Auto Bio: ${opt.toUpperCase()}`);
      break;
    }

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
        return xreply('❌ Failed to promote member.');
      }
      break;
    }

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
        return xreply('❌ Failed to demote member.');
      }
      break;
    }

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
        return xreply('❌ Failed to kick member.');
      }
      break;
    }

    case 'antilink': {
      try {
        if (!from.endsWith('@g.us')) return xreply('⚠️ Group only.');
        if (!isOwner &&!isAdmin) return xreply('❌ Admins only.');
        if (!args[0] ||!['on', 'off'].includes(args[0])) return xreply(`Usage: ${prefix}antilink on/off`);
        const val = args[0] === 'on';
        await sessionSet(`antilink_${from}`, val);
        xreply(`✅ Anti-Link: ${val? 'ON' : 'OFF'}\nLinks will be deleted.`);
      } catch (err) {
        reply('❌ Failed to toggle antilink.');
      }
      break;
    }

    case 'addnewsletter': {
      if (!isOwner) return xreply('❌ Owner only.');
      if (!args[0]) return xreply(`Usage: ${prefix}addnewsletter 120363xxxx@newsletter`);
      const jid = args[0];
      let list = sessionGet('newsletters', []);
      if (!list.includes(jid)) list.push(jid);
      await sessionSet('newsletters', list);
      xreply(`✅ Added ${jid} to auto-follow list.`);
      break;
    }

    case 'listnewsletter': {
      let list = sessionGet('newsletters', []);
      if (!list.length) return xreply('No newsletters added.');
      xreply(`📋 *Auto-Follow Newsletters*\n\n${list.map(j => `• ${j}`).join('\n')}`);
      break;
    }

    case 'kill': {
      if (!isOwner) return xreply('❌ Owner only.');
      xreply('🛑 Shutting down...');
      process.exit(0);
      break;
    }

    default:
      break;
  }
}

module.exports = handleCase;