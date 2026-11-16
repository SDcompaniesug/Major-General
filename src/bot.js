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
const maintenanceGroups = new Set();
function numberOf(jid) { return String(jid || '').split('@')[0].split(':')[0]; }
function isAdmin(p) { return !!(p && (p.admin === 'admin' || p.admin === 'superadmin')); }
function ownerMatches(jid) {
  const owner = String(process.env.BOT_OWNER_NUMBER || '').replace(/\D/g,'');
  return !!owner && numberOf(jid) === owner;
}
function rememberActivity(key, body) {
  const now=Date.now(), rows=(activity.get(key)||[]).filter(x=>now-x.time<10000);
  rows.push({time:now,body:String(body||'').trim().toLowerCase()});
  activity.set(key,rows);
  return rows;
}
async function handleMessage(msg) {
  const jid=msg.key.remoteJid;
  if(!isGroup(jid)||msg.key.fromMe||!msg.message)return;
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
  const command=text.trim().match(/^!(\w+)(?:\s+([\s\S]*))?$/);
  const name=command?command[1].toLowerCase():'';
  const arg=command?(command[2]||'').trim():'';
  const mentions=msg.message.extendedTextMessage?.contextInfo?.mentionedJid||[];
  if(await db.isMuted(jid,sender) && !senderAdmin) {
    if(botAdmin) await sock.sendMessage(jid,{delete:msg.key});
    else logger.warn({group:jid,user:sender},'Muted member spoke but bot lacks admin permission to delete the message');
    return;
  }
  if(text && !command) await db.addMessage(jid,sender,text);
  const activityRows=rememberActivity(jid+':'+sender,text);
  if(!command && !senderAdmin && botAdmin) {
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
  if(command) {
    if(['help','rules'].includes(name)) {
      if(name==='rules')return reply('📜 Group rules\n'+group.rules);
      return reply('🛡️ MAJOR GENERAL COMMANDS\n\nGeneral: !help · !rules · !ask <question> · !summarize · !translate <language> <text> · !quiz\n\nProtection (admin): !antilink on/off · !antispam on/off · !antiflood on/off · !antibadword on/off · !antiscam on/off · !aimod on/off\n\nGroup (admin): !setrules <text> · !welcome on/off · !goodbye on/off · !setwelcome <text> · !setgoodbye <text> · !lockgroup · !unlockgroup · !tagall · !admins\n\nMembers (admin): !warn @member [reason] · !warns @member · !clearwarns @member · !mute @member [10m|30m|2h|1d] · !unmute @member · !muted · !kick @member · !promote @member · !demote @member\n\nWord filter (admin): !badword add <word> · !badword remove <word> · !autowarn on/off\nOwner: !botstatus · !broadcast <message> · !maintenance on/off');
    }
    if(name==='ask') {
      if(!arg)return reply('Usage: !ask your question');
      try{return reply(await askAI(arg));}catch(e){logger.warn({err:e},'AI request failed');return reply('⚠️ AI is unavailable. Check the server configuration.');}
    }
    if(name==='summarize') {
      const rows=await db.recentMessages(jid,40);
      if(!rows.length)return reply('There is not enough recent conversation to summarize.');
      const transcript=rows.map(x=>numberOf(x.user_jid)+': '+x.body).join('\n');
      try{return reply(await askAI('Summarize this recent group discussion in concise bullet points. Do not invent facts:\n'+transcript));}
      catch(e){return reply('⚠️ Summary service is unavailable.');}
    }
    if(name==='translate') {
      const m=arg.match(/^(\S+)\s+([\s\S]+)$/);
      if(!m)return reply('Usage: !translate <language> <text>');
      try{return reply(await askAI('Translate the following text into '+m[1]+'. Return only the translation:\n'+m[2]));}
      catch(e){return reply('⚠️ Translation service is unavailable.');}
    }
    if(name==='quiz') {
      try{return reply(await askAI('Create one short, friendly general-knowledge quiz question for a WhatsApp group. Include four options A-D, and put the answer after a spoiler-style separate line.'));}catch(e){return reply('⚠️ Quiz service is unavailable.');}
    }
    if(name==='botstatus') {
      if(!ownerMatches(sender))return reply('⛔ Owner only.');
      return reply('🛡️ Major General\nConnection: '+(connected?'Online':'Offline')+'\nGroups tracked: '+(await db.listGroups()).length+'\nMaintenance: '+(maintenanceGroups.has(jid)?'On':'Off'));
    }
    if(name==='broadcast') {
      if(!ownerMatches(sender))return reply('⛔ Owner only.');
      if(!arg)return reply('Usage: !broadcast <message>');
      const groups=await db.listGroups();let sent=0;
      for(const g of groups){try{await sock.sendMessage(g.jid,{text:'📢 MAJOR GENERAL ANNOUNCEMENT\n\n'+arg.slice(0,1500)});sent++;}catch(e){logger.warn({group:g.jid,err:e},'broadcast delivery failed');}}
      return reply('✅ Announcement sent to '+sent+' tracked groups.');
    }
    if(name==='maintenance') {
      if(!ownerMatches(sender))return reply('⛔ Owner only.');
      if(!['on','off'].includes(arg.toLowerCase()))return reply('Usage: !maintenance on/off');
      if(arg.toLowerCase()==='on')maintenanceGroups.add(jid);else maintenanceGroups.delete(jid);
      return reply('Maintenance mode '+arg.toLowerCase()+'.');
    }
    if(maintenanceGroups.has(jid)&&!ownerMatches(sender))return reply('🛠️ The bot is in maintenance mode in this group.');
    const adminCommands=['antilink','aimod','antispam','antiflood','antibadword','antiscam','setrules','warn','kick','warns','clearwarns','mute','unmute','promote','demote','welcome','goodbye','setwelcome','setgoodbye','lockgroup','unlockgroup','tagall','admins','badword','autowarn'];
    if(adminCommands.includes(name)&&!senderAdmin)return reply('⛔ Only group admins can use that command.');
    const toggleMap={antilink:'antilink',aimod:'ai_moderation',antispam:'antispam',antiflood:'antiflood',antibadword:'antibadword',antiscam:'antiscam',welcome:'welcome_enabled',goodbye:'goodbye_enabled',autowarn:'auto_action_enabled'};
    if(toggleMap[name]) {
      if(!['on','off'].includes(arg.toLowerCase()))return reply('Usage: !'+name+' on/off');
      await db.setGroup(jid,toggleMap[name],arg.toLowerCase()==='on');
      return reply('✅ '+name+' '+arg.toLowerCase()+'.');
    }
    if(name==='setrules'||name==='setwelcome'||name==='setgoodbye') {
      if(!arg)return reply('Please provide the text.');
      const key=name==='setrules'?'rules':name==='setwelcome'?'welcome_text':'goodbye_text';
      await db.setGroup(jid,key,arg.slice(0,1500));
      return reply('✅ '+key.replace('_',' ')+' updated.');
    }
    if(name==='badword') {
      const m=arg.match(/^(add|remove)\s+(.+)$/i);
      if(!m)return reply('Usage: !badword add <word> OR !badword remove <word>');
      const word=m[2].trim().toLowerCase().slice(0,60);
      if(m[1].toLowerCase()==='add')await db.addBadWord(jid,word);else await db.removeBadWord(jid,word);
      return reply('✅ Filter word '+(m[1].toLowerCase()==='add'?'added':'removed')+'.');
    }
    if(name==='lockgroup'||name==='unlockgroup') {
      if(!botAdmin)return reply('I need to be a group admin to change group posting permissions.');
      await sock.groupSettingUpdate(jid,name==='lockgroup'?'announcement':'not_announcement');
      return reply(name==='lockgroup'?'🔒 Only admins can send messages now.':'🔓 Group messaging is open to members.');
    }
    if(name==='admins') {
      const admins=metadata.participants.filter(isAdmin);
      return reply('👮 GROUP ADMINS\n'+admins.map((p,i)=>(i+1)+'. @'+numberOf(p.id)).join('\n'),{mentions:admins.map(p=>p.id)});
    }
    if(name==='tagall') {
      if(!botAdmin)return reply('I need to be a group admin to tag everyone reliably.');
      const members=metadata.participants.filter(p=>p.id);
      const mentionsList=members.map(p=>p.id);
      return sock.sendMessage(jid,{text:'📣 Attention everyone!\n'+(arg?arg+'\n':'')+members.map(p=>'@'+numberOf(p.id)).join(' '),mentions:mentionsList},{quoted:msg});
    }
    if(['warn','kick','warns','clearwarns','mute','unmute','promote','demote'].includes(name)) {
      if(!mentions.length)return reply('Mention a member. Example: !'+name+' @member');
      const target=mentions[0], targetInfo=metadata.participants.find(p=>numberOf(p.id)===numberOf(target));
      if(['kick','promote','demote'].includes(name)&&!botAdmin)return reply('I need to be a group admin to perform that action.');
      if(['kick','promote','demote'].includes(name)&&isAdmin(targetInfo))return reply('I will not change another group admin.');
      if(name==='warn') {
        const id=await db.addWarning(jid,target,arg||'Group rule violation',sender);
        const count=await db.warningCount(jid,target);
        await db.logEvent(jid,target,'warning',{reason:arg,warningId:id});
        if(group.auto_action_enabled&&count>=Number(group.auto_action_threshold||3)&&botAdmin&&!isAdmin(targetInfo)) {
          await sock.groupParticipantsUpdate(jid,[target],'remove');
          await db.logEvent(jid,target,'auto_kick',{warningCount:count});
          return reply('⚠️ Warning '+count+' recorded. Automatic threshold reached; member removed.');
        }
        return reply('⚠️ Warning '+count+' recorded for @'+numberOf(target)+'.',{mentions:[target]});
      }
      if(name==='warns') {
        const rows=await db.listWarnings(jid,target);
        return reply('⚠️ Warnings for @'+numberOf(target)+': '+rows.length+'\n'+(rows.map((w,i)=>(i+1)+'. '+w.reason).join('\n')||'No warnings.'),{mentions:[target]});
      }
      if(name==='clearwarns') {const n=await db.clearWarnings(jid,target);return reply('✅ Cleared '+n+' warning(s).');}
      if(name==='mute') {
        if(!botAdmin)return reply('I need to be a group admin to enforce a mute by deleting the member\'s messages.');
        if(isAdmin(targetInfo))return reply('I will not mute another group admin.');
        const durationText=arg.replace(/^@\S+\s*/, '').trim().toLowerCase();
        const durationMatch=durationText.match(/^(\d{1,4})(s|m|h|d)$/);
        const amount=durationMatch?Number(durationMatch[1]):10;
        const unit=durationMatch?durationMatch[2]:'m';
        const multiplier=unit==='s'?1000:unit==='m'?60000:unit==='h'?3600000:86400000;
        const durationMs=amount*multiplier;
        if(!Number.isFinite(durationMs)||durationMs<60000||durationMs>30*86400000)return reply('Usage: !mute @member <1m–30d> (examples: 10m, 30m, 2h, 1d).');
        const until=new Date(Date.now()+durationMs);
        await db.setMute(jid,target,until,sender);
        await db.logEvent(jid,target,'mute',{duration:durationText||'10m',until:until.toISOString()});
        const shown=durationText||'10m';
        return reply('🔇 @'+numberOf(target)+' is muted for '+shown+'. They remain in the group and can read messages. Their messages will be removed until the mute expires, then messaging is restored automatically.',{mentions:[target]});
      }
      if(name==='unmute') {await db.clearMute(jid,target);await db.logEvent(jid,target,'unmute',{});return reply('🔊 Member unmuted.');}
      if(name==='kick') {await sock.groupParticipantsUpdate(jid,[target],'remove');await db.logEvent(jid,target,'kick',{by:sender});return reply('👢 Member removed.');}
      if(name==='promote') {await sock.groupParticipantsUpdate(jid,[target],'promote');await db.logEvent(jid,target,'promote',{by:sender});return reply('⬆️ Member promoted to admin.');}
      if(name==='demote') {await sock.groupParticipantsUpdate(jid,[target],'demote');await db.logEvent(jid,target,'demote',{by:sender});return reply('⬇️ Member demoted.');}
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
module.exports = { startBot, status, getQr, requestPairingCode, prepareAccountSwitch };
