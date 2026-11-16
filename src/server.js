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
app.get('/', (req,res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Major General</title><style>body{font:16px system-ui;background:#0b1220;color:#edf2ff;margin:0;padding:24px}.wrap{max-width:760px;margin:auto}.card{background:#151f32;border:1px solid #263650;border-radius:16px;padding:20px;margin:14px 0}input,button{padding:12px;border-radius:9px;border:1px solid #41516c;background:#0c1729;color:white}button{background:#2563eb;border:0;cursor:pointer}img{max-width:280px;display:block;margin:16px auto}pre{white-space:pre-wrap;color:#b8c8e6}</style></head><body><div class="wrap"><h1>🛡️ Major General</h1><p>WhatsApp group management console</p><div class="card"><h3>Dashboard access</h3><input id="token" type="password" placeholder="Dashboard token" style="width:90%"><button onclick="load()">Connect</button><pre id="status">Enter your dashboard token to view bot status.</pre></div><div class="card"><h3>WhatsApp pairing</h3><button onclick="qr()">Show pairing QR</button><img id="qr"><p id="qrmsg"></p><hr style="border-color:#263650;margin:22px 0"><h3>Switch to a different WhatsApp account</h3><p>This safely backs up the currently linked account session and starts a fresh session. The old account will disconnect from this bot.</p><button onclick="switchAccount()">Back up old account &amp; switch</button><pre id="switchResult"></pre><hr style="border-color:#263650;margin:22px 0"><h3>Switch / pair WhatsApp account</h3><p>Enter the new WhatsApp number with country code. The currently connected account will be backed up on Railway before switching. Digits only, no + sign or spaces.</p><input id="phoneNumber" type="tel" inputmode="numeric" placeholder="e.g. 2567XXXXXXXX" style="width:90%"><button onclick="pairByNumber()">Switch account & get code</button><pre id="pairCode"></pre><p>On this same phone: WhatsApp → Linked devices → Link a device → Link with phone number instead. Enter the code shown here.</p></div><div class="card"><h3>Live overview</h3><button onclick="stats()">Refresh statistics</button><pre id="stats">Connect to load live statistics.</pre></div><div class="card"><h3>Recent moderation activity</h3><button onclick="events()">Refresh activity</button><pre id="events"></pre></div><div class="card"><h3>Group controls</h3><p>Choose a group, toggle protections and edit its rules and automatic messages.</p><select id="settingsGroup" onchange="loadGroupSettings()" style="width:100%;padding:12px;background:#0c1729;color:white"><option value="">Load groups first</option></select><div id="groupSettings"></div><p id="settingsMessage"></p></div><div class="card"><h3>Connected groups</h3><button onclick="groups()">Refresh groups</button><pre id="groups"></pre></div></div><script>const tokenInput=document.getElementById('token');const savedToken=localStorage.getItem('majorGeneralDashboardToken');if(savedToken)tokenInput.value=savedToken;const h=()=>({Authorization:'Bearer '+tokenInput.value});async function load(){let r=await fetch('/api/status',{headers:h()});let j=await r.json();document.getElementById('status').textContent=JSON.stringify(j,null,2);if(r.ok)localStorage.setItem('majorGeneralDashboardToken',tokenInput.value)}async function qr(){let r=await fetch('/api/qr',{headers:h()});let j=await r.json();document.getElementById('qr').src=j.qr||'';document.getElementById('qrmsg').textContent=j.error||'Scan using WhatsApp > Linked devices.'}async function switchAccount(){const out=document.getElementById('switchResult');const phone=document.getElementById('phoneNumber').value;out.textContent='Preparing account switch…';let r=await fetch('/api/switch-account',{method:'POST',headers:{...h(),'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});let j=await r.json();out.textContent=j.message||j.error||'Request completed.'}async function pairByNumber(){const out=document.getElementById('pairCode');const phone=document.getElementById('phoneNumber').value;out.textContent='Backing up the current account and preparing the new session…';let r=await fetch('/api/switch-account',{method:'POST',headers:{...h(),'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});let j=await r.json();if(!r.ok){out.textContent=j.error||'Could not prepare account switch.';return}out.textContent='Previous session backup preserved. Waiting for WhatsApp pairing…';const deadline=Date.now()+45000;let ready=false;while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1000));let sr=await fetch('/api/status',{headers:h()});let st=await sr.json();if(st.qrAvailable){ready=true;break}if(!sr.ok){out.textContent='Dashboard authorization failed. Reconnect the dashboard.';return}}if(!ready){out.textContent='New session started, but WhatsApp pairing is not ready yet. Refresh status and try again.';return}out.textContent='Requesting linking code…';r=await fetch('/api/pairing-code',{method:'POST',headers:{...h(),'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});j=await r.json();out.textContent=j.code?('Linking code: '+j.code+'\\n\\nPrevious account backup preserved.\\n\\n'+j.instructions):(j.error||'Could not get a linking code.');}let groupRows=[];
function esc(v){return String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]))}
async function groups(){let r=await fetch('/api/groups',{headers:h()});groupRows=await r.json();document.getElementById('groups').textContent=JSON.stringify(groupRows,null,2);let sel=document.getElementById('settingsGroup');let prev=sel.value;sel.innerHTML='<option value="">Choose a group</option>'+groupRows.map(g=>'<option value="'+esc(g.jid)+'">'+esc(g.subject||g.jid)+'</option>').join('');sel.value=groupRows.some(g=>g.jid===prev)?prev:(groupRows[0]?.jid||'');loadGroupSettings()}
async function loadGroupSettings(){let g=groupRows.find(x=>x.jid===document.getElementById('settingsGroup').value);let root=document.getElementById('groupSettings');if(!g){root.innerHTML='';return}let opts=[['antilink','Anti-link'],['ai_moderation','AI moderation'],['antispam','Anti-spam'],['antiflood','Anti-flood'],['antibadword','Bad-word filter'],['antiscam','Anti-scam'],['welcome_enabled','Welcome messages'],['goodbye_enabled','Goodbye messages'],['auto_action_enabled','Automatic warning actions']];root.innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0">'+opts.map(([k,n])=>'<label><input type="checkbox" '+(g[k]?'checked':'')+' onchange="saveOne(\''+k+'\',this.checked)"> '+n+'</label>').join('')+'</div><label>Group rules<textarea id="editRules" rows="3" style="width:100%;box-sizing:border-box">'+esc(g.rules)+'</textarea></label><label>Welcome text<textarea id="editWelcome" rows="3" style="width:100%;box-sizing:border-box">'+esc(g.welcome_text)+'</textarea></label><label>Goodbye text<textarea id="editGoodbye" rows="3" style="width:100%;box-sizing:border-box">'+esc(g.goodbye_text)+'</textarea></label><label>Warnings before automatic action <input id="editThreshold" type="number" min="2" max="10" value="'+Number(g.auto_action_threshold||3)+'"></label><button onclick="saveTextSettings()">Save text & threshold</button>'}
async function saveSetting(v){let jid=document.getElementById('settingsGroup').value;let m=document.getElementById('settingsMessage');m.textContent='Saving…';let r=await fetch('/api/groups/'+encodeURIComponent(jid)+'/settings',{method:'PUT',headers:{...h(),'Content-Type':'application/json'},body:JSON.stringify(v)});let j=await r.json();m.textContent=r.ok?'Saved successfully.':(j.error||'Save failed');if(r.ok){let i=groupRows.findIndex(g=>g.jid===jid);groupRows[i]=j.group;loadGroupSettings()}}
async function saveOne(k,v){await saveSetting({[k]:v})}
async function saveTextSettings(){await saveSetting({rules:document.getElementById('editRules').value,welcome_text:document.getElementById('editWelcome').value,goodbye_text:document.getElementById('editGoodbye').value,auto_action_threshold:Number(document.getElementById('editThreshold').value)})}async function stats(){let r=await fetch('/api/stats',{headers:h()});document.getElementById('stats').textContent=JSON.stringify(await r.json(),null,2)}async function events(){let r=await fetch('/api/events',{headers:h()});document.getElementById('events').textContent=JSON.stringify(await r.json(),null,2)}if(savedToken)load().catch(()=>{});</script></body></html>`));
const port = Number(process.env.PORT || 3000);
async function main() {
  await db.initDb();
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log('Major General listening on ' + port));
  bot.startBot().catch(e => console.error('Bot startup error:', e.message));
}
main().catch(e => { console.error('Startup failed:',e); process.exit(1); });
