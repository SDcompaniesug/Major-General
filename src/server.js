const express = require('express');
const path = require('path');
const db = require('./db');
const bot = require('./bot');
const app = express();
app.use(express.json({ limit:'32kb' }));
app.get('/health', (req,res) => res.json({ ok:true, service:'major-general' }));
function auth(req,res,next) {
  const expected = process.env.DASHBOARD_TOKEN;
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!expected || supplied !== expected) return res.status(401).json({ error:'Unauthorized' });
  next();
}
app.get('/api/status', auth, (req,res) => res.json(bot.status()));
app.post('/api/switch-account', auth, async (req,res) => {
  try {
    const result = await bot.prepareAccountSwitch(req.body?.phoneNumber);
    res.json(result);
  } catch (e) { res.status(400).json({ error:e.message || 'Could not prepare the new WhatsApp account.' }); }
});
app.post('/api/pairing-code', auth, async (req,res) => {
  try {
    const code = await bot.requestPairingCode(req.body?.phoneNumber);
    res.json({ code, instructions:'On the phone with this WhatsApp account, open WhatsApp > Linked devices > Link a device > Link with phone number instead, then enter this code.' });
  } catch (e) { res.status(400).json({ error:e.message || 'Could not create pairing code.' }); }
});
app.get('/api/qr', auth, (req,res) => {
  const qr = bot.getQr();
  if (!qr) return res.status(404).json({ error:'QR not available. Check bot status; it may already be connected.' });
  res.json({ qr });
});
app.put('/api/groups/:jid/settings', auth, async (req,res) => {
  try {
    const jid=String(req.params.jid||'');
    if(!jid.endsWith('@g.us')) return res.status(400).json({error:'Invalid group'});
    const current=await db.getGroup(jid);
    if(!current) return res.status(404).json({error:'Group not found'});
    const allowed=['antilink','ai_moderation','antispam','antiflood','antibadword','antiscam','welcome_enabled','goodbye_enabled','rules','welcome_text','goodbye_text','auto_action_enabled','auto_action_threshold'];
    const updates=req.body||{}; const keys=Object.keys(updates);
    if(!keys.length||keys.some(k=>!allowed.includes(k))) return res.status(400).json({error:'Unsupported setting'});
    for(const key of keys){const value=updates[key];
      if(['rules','welcome_text','goodbye_text'].includes(key)){if(typeof value!=='string'||!value.trim()||value.length>1500)return res.status(400).json({error:key+' must be 1–1500 characters'});}
      else if(key==='auto_action_threshold'){if(!Number.isInteger(value)||value<2||value>10)return res.status(400).json({error:'Warning threshold must be 2–10'});}
      else if(typeof value!=='boolean')return res.status(400).json({error:key+' must be true or false'});
    }
    for(const key of keys) await db.setGroup(jid,key,updates[key]);
    res.json({ok:true,group:await db.getGroup(jid)});
  } catch(e) { res.status(500).json({error:'Could not save group settings'}); }
});
app.get('/api/groups', auth, async (req,res) => {
  try { res.json(await db.listGroups()); } catch(e) { res.status(500).json({error:'Could not load groups'}); }
});
app.get('/api/stats', auth, async (req,res) => {
  try { res.json({bot:bot.status(),stats:await db.dashboardStats(),groups:await db.listGroups()}); }
  catch(e) { res.status(500).json({error:'Could not load dashboard statistics'}); }
});
app.get('/api/events', auth, async (req,res) => {
  try {
    const r=await db.pool.query('SELECT group_jid,user_jid,event_type,details,created_at FROM moderation_events ORDER BY created_at DESC LIMIT 50');
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:'Could not load moderation events'}); }
});
app.use(express.static(path.join(__dirname, '../dist')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname, '../dist/index.html')));

const port = Number(process.env.PORT || 3000);
async function main() {
  await db.initDb();
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log('Major General listening on ' + port));
  bot.startBot().catch(e => console.error('Bot startup error:', e.message));
}
main().catch(e => { console.error('Startup failed:',e); process.exit(1); });
