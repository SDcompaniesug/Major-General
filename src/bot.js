const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');
const { containsLink, inspectText } = require('./moderation');
const { askAI } = require('./ai');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const authDir = process.env.AUTH_DIR || path.join(process.cwd(), 'data', 'auth');
let sock = null, qrDataUrl = null, connected = false, connecting = false;
let lastConnection = null, pairingCode = null, pairingNumber = null;
let authResetAttempted = false, authResetInProgress = false, reconnectAttempts = 0, reconnectTimer = null;
const isGroup = jid => jid && jid.endsWith('@g.us');
function getText(msg) {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
}
async function startBot() {
  if (connecting) return;
  connecting = true;
  fs.mkdirSync(authDir, { recursive: true });
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}
    sock = makeWASocket({ version, auth: state, logger: logger.child({ level: 'warn' }), browser: ['Major General','Chrome','1.0.0'], markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrDataUrl = await QRCode.toDataURL(qr); lastConnection = 'Scan QR from dashboard'; }
      if (connection === 'open') { authResetAttempted = false; authResetInProgress = false; reconnectAttempts = 0; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; connected = true; qrDataUrl = null; pairingCode = null; pairingNumber = null; lastConnection = 'Connected'; connecting = false; logger.info('WhatsApp connected'); }
      if (connection === 'close') {
        connected = false; connecting = false; qrDataUrl = null;
        const disconnectError = lastDisconnect?.error;
        const code = disconnectError?.output?.statusCode || disconnectError?.data?.statusCode || disconnectError?.statusCode || null;
        const reason = disconnectError?.message || disconnectError?.cause?.message || String(disconnectError || 'unknown error');
        lastConnection = 'Connection closed (' + (code || 'unknown') + '): ' + String(reason).slice(0,160);
        logger.warn('WA_DISCONNECT status=' + (code || 'unknown') + ' reason=' + String(reason).replace(/[\\r\\n]/g,' ').slice(0,240));
        pairingCode = null;
        pairingNumber = null;
        logger.warn({ statusCode:code || null, reason:String(reason).slice(0,160) }, 'WhatsApp connection closed');
        if (code === DisconnectReason.loggedOut && !authResetAttempted) {
          authResetAttempted = true;
          authResetInProgress = true;
          lastConnection = 'WhatsApp rejected the saved session. Backing it up and creating one fresh session.';
          setTimeout(async () => {
            try {
              const backupDir = authDir + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
              try { await fs.promises.rename(authDir, backupDir); }
              catch (e) { if (e.code !== 'ENOENT') throw e; }
              await fs.promises.mkdir(authDir, { recursive:true });
              qrDataUrl = null; pairingCode = null; pairingNumber = null; connected = false; sock = null;
              lastConnection = 'Old session backed up. Fresh WhatsApp registration starting.';
              authResetInProgress = false;
              await startBot();
            } catch (e) { authResetInProgress = false; connecting = false; lastConnection = 'Could not reset saved session: ' + String(e.message || e).slice(0,140); logger.error({err:e}, 'WhatsApp session reset failed'); }
          }, 1500);
        } else if (code === DisconnectReason.loggedOut) {
          lastConnection = 'WhatsApp rejected the fresh session (401). Automatic retries stopped; this may be a WhatsApp cloud-host restriction.';
          logger.error('WhatsApp rejected a fresh session; stopping reconnect loop.');
        } else {
          reconnectAttempts += 1;
          const delay = Math.min(120000, 15000 * Math.pow(2, Math.min(reconnectAttempts - 1, 3)));
          lastConnection = 'Disconnected. Retrying in ' + Math.round(delay / 1000) + ' seconds.';
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { reconnectTimer = null; startBot().catch(e => logger.error({err:e}, 'WhatsApp reconnect failed')); }, delay);
        }
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(msg); } catch (e) { logger.error({err:e}, 'message handler failed'); }
      }
    });
  } catch (e) { connecting = false; logger.error({err:e}, 'WhatsApp startup failed'); throw e; }
}
async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!isGroup(jid) || msg.key.fromMe || !msg.message) return;
  const text = getText(msg);
  const sender = msg.key.participant || msg.participant;
  if (!sender) return;
  const metadata = await sock.groupMetadata(jid);
  await db.ensureGroup(jid, metadata.subject);
  const group = await db.getGroup(jid);
  const senderInfo = metadata.participants.find(p => p.id === sender || p.phoneNumber === sender);
  const senderAdmin = !!(senderInfo && (senderInfo.admin === 'admin' || senderInfo.admin === 'superadmin'));
  const botId = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
  const botInfo = metadata.participants.find(p => p.id === botId || p.id?.startsWith(sock.user?.id?.split(':')[0]));
  const botAdmin = !!(botInfo && (botInfo.admin === 'admin' || botInfo.admin === 'superadmin'));
  const reply = (t, options = {}) => sock.sendMessage(jid, { text: t, ...options }, { quoted: msg });
  const command = text.trim().match(/^!(\w+)(?:\s+([\s\S]*))?$/);
  if (command) {
    const name = command[1].toLowerCase(), arg = (command[2] || '').trim();
    if (['help','rules'].includes(name)) {
      if (name === 'rules') return reply('📜 Group rules\n' + group.rules);
      return reply(`🛡️ Major General commands\n!help · !rules\n!antilink on/off (admin)\n!aimod on/off (admin)\n!setrules <text> (admin)\n!warn @member [reason] (admin)\n!kick @member (admin; bot must be admin)`);
    }
    if (name === 'ask') {
      if (!arg) return reply('Usage: !ask your question');
      try { const answer = await askAI(arg); return reply(answer); }
      catch (e) { logger.warn({err:e}, 'AI request failed'); return reply('⚠️ AI is unavailable. Check the OpenAI API key and try again.'); }
    }
    if (!senderAdmin) return reply('⛔ Only group admins can use that command.');
    if (name === 'antilink' || name === 'aimod') {
      if (!['on','off'].includes(arg.toLowerCase())) return reply('Usage: !' + name + ' on/off');
      await db.setGroup(jid, name === 'antilink' ? 'antilink' : 'ai_moderation', arg.toLowerCase() === 'on');
      return reply('✅ ' + name + ' ' + arg.toLowerCase() + '.');
    }
    if (name === 'setrules') {
      if (!arg) return reply('Usage: !setrules your group rules');
      await db.setGroup(jid, 'rules', arg.slice(0,1500));
      return reply('✅ Group rules updated.');
    }
    if (name === 'warn' || name === 'kick') {
      const targets = [...(msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [])];
      if (!targets.length) return reply('Mention a member. Example: !' + name + ' @member');
      const target = targets[0];
      if (name === 'kick' && !botAdmin) return reply('I need to be a group admin before I can remove members.');
      if (name === 'warn') {
        const id = await db.addWarning(jid,target,arg || 'Group rule violation',sender);
        const count = await db.warningCount(jid,target);
        await db.logEvent(jid,target,'warning',{reason:arg,warningId:id});
        return reply('⚠️ Warning ' + count + ' recorded for @' + target.split('@')[0] + '.', { mentions:[target] });
      }
      await sock.groupParticipantsUpdate(jid,[target],'remove');
      await db.logEvent(jid,target,'kick',{by:sender});
      return reply('👢 Member removed.');
    }
  }
  if (group.antilink && process.env.AUTO_DELETE_LINKS !== 'false' && containsLink(text) && !senderAdmin) {
    if (botAdmin) {
      await sock.sendMessage(jid,{delete:msg.key});
      await db.logEvent(jid,sender,'link_removed',{});
      await reply('🔗 Links are not allowed in this group.');
    } else await reply('⚠️ Link detected. An admin needs to make me a group admin to delete it.');
    return;
  }
  if (group.ai_moderation && process.env.AI_AUTO_MODERATION === 'true' && text && !senderAdmin) {
    try {
      const result = await inspectText(text);
      if (result.flagged && botAdmin) {
        await sock.sendMessage(jid,{delete:msg.key});
        await db.logEvent(jid,sender,'ai_moderation',{categories:result.categories});
        await reply('🛡️ A message was removed by AI moderation. If this was a mistake, contact a group admin.');
      }
    } catch (e) { logger.warn({err:e},'AI moderation unavailable'); }
  }
}
function status() { return { connected, connecting, lastConnection, qrAvailable:!!qrDataUrl, phone:sock?.user?.id || null }; }
function getQr() { return qrDataUrl; }
async function requestPairingCode(phoneNumber) {
  const number = String(phoneNumber || '').trim();
  if (!/^\d{8,15}$/.test(number)) throw new Error('Enter 8–15 digits including your country calling code, without + or spaces.');
  if (!sock || !connecting && !connected && !qrDataUrl) throw new Error('WhatsApp connection is closed. Wait for a fresh QR to appear before requesting a linking code.');
  if (connected || sock.authState?.creds?.registered) throw new Error('This WhatsApp session is already registered or connected.');
  if (!qrDataUrl && !pairingCode) throw new Error('WhatsApp is not ready to issue a pairing code yet. Wait until the QR becomes available.');
  if (typeof sock.requestPairingCode !== 'function') throw new Error('The installed WhatsApp library does not support phone-number pairing.');
  // Always request a new code; never return a possibly expired/rejected code.
  pairingCode = null;
  pairingNumber = number;
  try {
    pairingCode = await sock.requestPairingCode(number);
    qrDataUrl = null;
    lastConnection = 'A fresh pairing code was issued; enter it in WhatsApp Linked devices.';
    return pairingCode;
  } catch (error) { pairingCode = null; pairingNumber = null; throw error; }
}
module.exports = { startBot, status, getQr, requestPairingCode };
