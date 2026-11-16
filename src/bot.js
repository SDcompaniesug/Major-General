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
let authResetAttempted = false, authResetInProgress = false, reconnectAttempts = 0, reconnectTimer = null, switchingAccount = false, socketGeneration = 0, targetPhoneNumber = null;
const isGroup = jid => jid && jid.endsWith('@g.us');
function getText(msg) {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || '';
}
async function startBot() {
  if (connecting) return;
  connecting = true;
  const generation = ++socketGeneration;
  fs.mkdirSync(authDir, { recursive: true });
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}
    logger.info({ waWebVersion:version || 'library-default', pairingBrowser:'Ubuntu/Chrome' }, 'Starting WhatsApp socket');
    sock = makeWASocket({ version, auth: state, logger: logger.child({ level: 'warn' }), browser: ['Ubuntu','Chrome','20.0.04'], markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      if (generation !== socketGeneration) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrDataUrl = await QRCode.toDataURL(qr); lastConnection = 'Scan QR from dashboard'; }
      if (connection === 'open') {
        const actualNumber = String(sock?.user?.id || '').split('@')[0].split(':')[0].replace(/\\D/g, '');
        if (targetPhoneNumber && actualNumber !== targetPhoneNumber) {
          connected = false; connecting = false; qrDataUrl = null;
          lastConnection = 'Wrong WhatsApp account connected. Expected ' + targetPhoneNumber + ', received ' + (actualNumber || 'unknown') + '. Do not use this session.';
          logger.error({ expectedPhone:targetPhoneNumber, actualPhone:actualNumber || null }, 'WhatsApp account identity mismatch');
          return;
        }
        authResetAttempted = false; authResetInProgress = false; reconnectAttempts = 0;
        if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null;
        connected = true; qrDataUrl = null; pairingCode = null; pairingNumber = null;
        targetPhoneNumber = null; lastConnection = 'Connected'; connecting = false;
        logger.info({ phone:actualNumber || null }, 'WhatsApp connected');
      }
      if (connection === 'close') {
        if (generation !== socketGeneration) return;
        connected = false; connecting = false; qrDataUrl = null;
        const disconnectError = lastDisconnect?.error;
        const code = disconnectError?.output?.statusCode || disconnectError?.data?.statusCode || disconnectError?.statusCode || null;
        const reason = disconnectError?.message || disconnectError?.cause?.message || String(disconnectError || 'unknown error');
        lastConnection = 'Connection closed (' + (code || 'unknown') + '): ' + String(reason).slice(0,160);
        logger.warn('WA_DISCONNECT status=' + (code || 'unknown') + ' reason=' + String(reason).replace(/[\\r\\n]/g,' ').slice(0,240));
        if (switchingAccount) { lastConnection = 'Old account disconnected; preparing the new account.'; return; }
        pairingCode = null;
        pairingNumber = null;
        logger.warn({ statusCode:code || null, reason:String(reason).slice(0,160) }, 'WhatsApp connection closed');
        if (switchingAccount) { lastConnection = 'Switching WhatsApp account; previous session is being preserved.'; return; }
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
    sock.ev.on('group-participants.update', update => handleParticipantUpdate(update).catch(e => logger.error({err:e}, 'participant update failed')));
  } catch (e) { connecting = false; logger.error({err:e}, 'WhatsApp startup failed'); throw e; }
}
const activity = new Map();
const privateReplyTimes = new Map();
function numberOf(jid) { return String(jid || '').split('@')[0].split(':')[0]; }
function isAdmin(p) { return !!(p && (p.admin === 'admin' || p.admin === 'superadmin')); }
function rememberActivity(key, body) {
  const now=Date.now(), rows=(activity.get(key)||[]).filter(x=>now-x.time<10000);
  rows.push({time:now,body:String(body||'').trim().toLowerCase()});
  activity.set(key,rows);
  return rows;
}
async function handleMessage(msg) {
  const jid=msg.key.remoteJid;
  if(msg.key.fromMe||!msg.message||!jid)return;
  if(!isGroup(jid)) {
    if(!jid.endsWith('@s.whatsapp.net')&&!jid.endsWith('@lid'))return;
    const text=getText(msg).trim();
    if(!text)return;
    const sender=msg.key.participant||jid;
    const now=Date.now(), last=privateReplyTimes.get(sender)||0;
    if(now-last<2500)return;
    privateReplyTimes.set(sender,now);
    const reply=t=>sock.sendMessage(jid,{text:String(t).slice(0,4000)},{quoted:msg});
    try{return reply(await askAI(text));}
    catch(e){logger.warn({err:e},'private chat AI request failed');return reply('I could not answer just now. Please try again in a moment.');}
  }
  const text=getText(msg), sender=msg.key.participant||msg.participant;
  if(!sender)return;
  const metadata=await sock.groupMetadata(jid);
  await db.ensureGroup(jid,metadata.subject);
  const group=await db.getGroup(jid);
  const senderInfo=metadata.participants.find(p=>p.id===sender||p.phoneNumber===sender||numberOf(p.id)===numberOf(sender));
  const senderAdmin=isAdmin(senderInfo);
  const botNumber=numberOf(sock.user?.id);
  const botInfo=metadata.participants.find(p=>numberOf(p.id)===botNumber||numberOf(p.phoneNumber)===botNumber);
  const botAdmin=isAdmin(botInfo);
  const reply=(t,options={})=>sock.sendMessage(jid,{text:t,...options},{quoted:msg});
  if(await db.isMuted(jid,sender) && !senderAdmin) {
    if(botAdmin) await sock.sendMessage(jid,{delete:msg.key});
    else logger.warn({group:jid,user:sender},'Muted member spoke but bot lacks admin permission to delete the message');
    return;
  }
  if(text) await db.addMessage(jid,sender,text);
  const activityRows=rememberActivity(jid+':'+sender,text);
  if(!senderAdmin && botAdmin) {
    if(group.antiflood && activityRows.length>6) {
      await sock.sendMessage(jid,{delete:msg.key});
      await db.logEvent(jid,sender,'flood_removed',{count:activityRows.length});
      return reply('🚦 Please slow down. Message flood detected.');
    }
    if(group.antispam && text && activityRows.filter(x=>x.body===text.trim().toLowerCase()).length>=3) {
      await sock.sendMessage(jid,{delete:msg.key});
      await db.logEvent(jid,sender,'spam_removed',{});
      return reply('🛡️ Repeated spam was removed.');
    }
    if(group.antibadword && text) {
      const words=await db.getBadWords(jid);
      const hit=words.find(w=>w && text.toLowerCase().includes(w));
      if(hit) {
        await sock.sendMessage(jid,{delete:msg.key});
        await db.logEvent(jid,sender,'badword_removed',{word:hit});
        return reply('⚠️ Please keep the conversation respectful.');
      }
    }
    if(group.antiscam && text && /(send\s+(?:money|cash|crypto)|verify\s+your\s+account|claim\s+(?:your\s+)?prize|investment\s+guaranteed|password\s+or\s+otp)/i.test(text)) {
      await sock.sendMessage(jid,{delete:msg.key});
      await db.logEvent(jid,sender,'scam_removed',{});
      return reply('🚨 A potentially deceptive message was removed. Never share passwords, PINs or OTPs.');
    }
  }

  if(group.antilink&&process.env.AUTO_DELETE_LINKS!=='false'&&containsLink(text)&&!senderAdmin) {
    if(botAdmin){await sock.sendMessage(jid,{delete:msg.key});await db.logEvent(jid,sender,'link_removed',{});await reply('🔗 Links are not allowed in this group.');}
    else await reply('⚠️ Link detected. An admin needs to make me a group admin to delete it.');
    return;
  }
  if(group.ai_moderation&&process.env.AI_AUTO_MODERATION==='true'&&text&&!senderAdmin) {
    try {const result=await inspectText(text);if(result.flagged&&botAdmin){await sock.sendMessage(jid,{delete:msg.key});await db.logEvent(jid,sender,'ai_moderation',{categories:result.categories});await reply('🛡️ A message was removed by AI moderation. If this was a mistake, contact a group admin.');}}
    catch(e){logger.warn({err:e},'AI moderation unavailable');}
  }
}
async function handleParticipantUpdate(update) {
  const jid=update.id;
  if(!isGroup(jid))return;
  try {
    const metadata=await sock.groupMetadata(jid);
    await db.ensureGroup(jid,metadata.subject);
    const group=await db.getGroup(jid);
    for(const participant of update.participants||[]) {
      const id=typeof participant==='string'?participant:(participant.id||participant.phoneNumber);
      if(!id)continue;
      if(update.action==='add'&&group.welcome_enabled) {
        const message=String(group.welcome_text||'Welcome @user to @group!').replace(/@user/g,'@'+numberOf(id)).replace(/@group/g,metadata.subject||'the group');
        await sock.sendMessage(jid,{text:message,mentions:[id]});
      }
      if(update.action==='remove'&&group.goodbye_enabled) {
        const message=String(group.goodbye_text||'Goodbye @user.').replace(/@user/g,'@'+numberOf(id)).replace(/@group/g,metadata.subject||'the group');
        await sock.sendMessage(jid,{text:message,mentions:[id]});
      }
    }
  } catch(e) {logger.warn({err:e,group:jid},'participant update handler failed');}
}

async function getGroupMembers(jid) {
  if(!connected||!sock)throw new Error('WhatsApp is not connected.');
  if(!isGroup(jid))throw new Error('Invalid group.');
  const metadata=await sock.groupMetadata(jid);
  const botNumber=numberOf(sock.user?.id);
  const botInfo=metadata.participants.find(p=>numberOf(p.id)===botNumber||numberOf(p.phoneNumber)===botNumber);
  return {jid:metadata.id||jid,subject:metadata.subject||'',botAdmin:isAdmin(botInfo),members:metadata.participants.map(p=>({
    id:p.id,phoneNumber:p.phoneNumber||null,name:p.name||p.notify||p.verifiedName||numberOf(p.id),
    number:numberOf(p.phoneNumber||p.id),admin:p.admin||null,isBot:numberOf(p.id)===botNumber
  }))};
}


function status() { return { connected, connecting, lastConnection, qrAvailable:!!qrDataUrl, phone:sock?.user?.id || null }; }
function getQr() { return qrDataUrl; }
async function prepareAccountSwitch(phoneNumber) {
  const number = String(phoneNumber || '').trim();
  if (!/^\d{8,15}$/.test(number)) throw new Error('Enter 8–15 digits including the country code.');
  if (switchingAccount) throw new Error('An account switch is already in progress.');
  switchingAccount = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socketGeneration++;
  targetPhoneNumber = number;
  connecting = false;
  connected = false;
  qrDataUrl = null;
  pairingCode = null;
  pairingNumber = null;
  lastConnection = 'Backing up the currently linked WhatsApp session.';
  const oldSocket = sock;
  sock = null;
  try {
    if (oldSocket && typeof oldSocket.end === 'function') oldSocket.end(new Error('Switching to a different WhatsApp account'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const backupDir = authDir + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { await fs.promises.rename(authDir, backupDir); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.promises.mkdir(authDir, { recursive: true });
    lastConnection = 'Previous account backed up. Starting a fresh WhatsApp session for ' + number + '.';
    await startBot();
    switchingAccount = false;
    return { prepared: true, backupCreated: true, phoneNumber: number, message: 'Fresh session started for ' + number + '. Wait for the pairing code, then verify the connected number in the dashboard.' };
  } catch (e) {
    switchingAccount = false;
    connecting = false;
    lastConnection = 'Account switch failed: ' + String(e.message || e).slice(0,140);
    throw e;
  }
}
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
module.exports = { startBot, status, getQr, requestPairingCode, prepareAccountSwitch, getGroupMembers };
