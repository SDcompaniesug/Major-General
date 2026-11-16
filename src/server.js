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
app.post('/api/pairing-code', auth, async (req,res) => {
  try {
    const code = await bot.requestPairingCode(req.body?.phoneNumber);
    res.json({ code, instructions:'On this same phone, open WhatsApp > Linked devices > Link a device > Link with phone number instead, then enter this code.' });
  } catch (e) { res.status(400).json({ error:e.message || 'Could not create pairing code.' }); }
});
app.get('/api/qr', auth, (req,res) => {
  const qr = bot.getQr();
  if (!qr) return res.status(404).json({ error:'QR not available. Check bot status; it may already be connected.' });
  res.json({ qr });
});
app.get('/api/groups', auth, async (req,res) => {
  try { res.json(await db.listGroups()); } catch(e) { res.status(500).json({error:'Could not load groups'}); }
});
app.get('/', (req,res) => res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Major General</title><style>body{font:16px system-ui;background:#0b1220;color:#edf2ff;margin:0;padding:24px}.wrap{max-width:760px;margin:auto}.card{background:#151f32;border:1px solid #263650;border-radius:16px;padding:20px;margin:14px 0}input,button{padding:12px;border-radius:9px;border:1px solid #41516c;background:#0c1729;color:white}button{background:#2563eb;border:0;cursor:pointer}img{max-width:280px;display:block;margin:16px auto}pre{white-space:pre-wrap;color:#b8c8e6}</style></head><body><div class="wrap"><h1>🛡️ Major General</h1><p>WhatsApp group management console</p><div class="card"><h3>Dashboard access</h3><input id="token" type="password" placeholder="Dashboard token" style="width:90%"><button onclick="load()">Connect</button><pre id="status">Enter your dashboard token to view bot status.</pre></div><div class="card"><h3>WhatsApp pairing</h3><button onclick="qr()">Show pairing QR</button><img id="qr"><p id="qrmsg"></p><hr style="border-color:#263650;margin:22px 0"><h3>Pair with phone number (no second device)</h3><p>Enter your WhatsApp number with country code. Digits only, no + sign or spaces.</p><input id="phoneNumber" type="tel" inputmode="numeric" placeholder="e.g. 2567XXXXXXXX" style="width:90%"><button onclick="pairByNumber()">Get linking code</button><pre id="pairCode"></pre><p>On this same phone: WhatsApp → Linked devices → Link a device → Link with phone number instead. Enter the code shown here.</p></div><div class="card"><h3>Connected groups</h3><button onclick="groups()">Refresh groups</button><pre id="groups"></pre></div></div><script>const h=()=>({Authorization:'Bearer '+document.getElementById('token').value});async function load(){let r=await fetch('/api/status',{headers:h()});document.getElementById('status').textContent=JSON.stringify(await r.json(),null,2)}async function qr(){let r=await fetch('/api/qr',{headers:h()});let j=await r.json();document.getElementById('qr').src=j.qr||'';document.getElementById('qrmsg').textContent=j.error||'Scan using WhatsApp > Linked devices.'}async function pairByNumber(){let out=document.getElementById('pairCode');out.textContent='Requesting code…';let r=await fetch('/api/pairing-code',{method:'POST',headers:{...h(),'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:document.getElementById('phoneNumber').value})});let j=await r.json();out.textContent=j.code?('Linking code: '+j.code+'\\n\\n'+j.instructions):(j.error||'Could not get a code.')}async function groups(){let r=await fetch('/api/groups',{headers:h()});document.getElementById('groups').textContent=JSON.stringify(await r.json(),null,2)}</script></body></html>`));
const port = Number(process.env.PORT || 3000);
async function main() {
  await db.initDb();
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log('Major General listening on ' + port));
  bot.startBot().catch(e => console.error('Bot startup error:', e.message));
}
main().catch(e => { console.error('Startup failed:',e); process.exit(1); });
