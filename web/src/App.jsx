import React, { useCallback, useEffect, useMemo, useState } from 'react';

const STORE_KEY = 'majorGeneralDashboardToken';
const navItems = [
  ['overview','◫','Overview'],
  ['groups','▦','Group controls'],
  ['whatsapp','◉','WhatsApp'],
  ['activity','≋','Activity']
];
const protections = [
  ['antilink','Anti-link','Block links shared in the group'],
  ['ai_moderation','AI moderation','Review messages with the AI moderator'],
  ['antispam','Anti-spam','Detect repeated or unwanted messages'],
  ['antiflood','Anti-flood','Control rapid message bursts'],
  ['antibadword','Bad-word filter','Filter words configured for this group'],
  ['antiscam','Anti-scam','Detect suspicious scam messages'],
  ['welcome_enabled','Welcome messages','Greet members who join'],
  ['goodbye_enabled','Goodbye messages','Send a message when members leave'],
  ['auto_action_enabled','Automatic warning action','Apply the configured warning threshold']
];

function Icon({children}) { return <span className="icon" aria-hidden="true">{children}</span>; }
function Toggle({checked,onChange,disabled=false}) {
  return <button type="button" role="switch" aria-checked={!!checked} className={`toggle ${checked?'on':''}`} onClick={()=>onChange(!checked)} disabled={disabled}><span /></button>;
}
function Stat({label,value,detail,icon}) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value ?? '—'}</strong><small>{detail}</small></div>;
}
function Empty({title,detail}) { return <div className="empty"><div className="empty-icon">⌁</div><b>{title}</b><span>{detail}</span></div>; }

export default function App() {
  const [token,setToken] = useState(()=>localStorage.getItem(STORE_KEY)||'');
  const [connected,setConnected] = useState(false);
  const [page,setPage] = useState('overview');
  const [status,setStatus] = useState(null);
  const [stats,setStats] = useState(null);
  const [groups,setGroups] = useState([]);
  const [events,setEvents] = useState([]);
  const [selected,setSelected] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(false);
  const [qr,setQr] = useState('');
  const [phone,setPhone] = useState('');
  const [pairResult,setPairResult] = useState('');
  const [draft,setDraft] = useState({rules:'',welcome_text:'',goodbye_text:'',auto_action_threshold:3});
  const [members,setMembers] = useState([]);
  const [memberMeta,setMemberMeta] = useState(null);
  const [memberBusy,setMemberBusy] = useState(false);

  const api = useCallback(async (url, options={}) => {
    const response = await fetch(url,{...options,headers:{Authorization:'Bearer '+token,...(options.headers||{})}});
    const data = await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error || 'Request failed ('+response.status+')');
    return data;
  },[token]);

  const refresh = useCallback(async () => {
    if(!token.trim()) return;
    setBusy(true); setNotice('');
    try {
      const [s,st,g,e] = await Promise.all([
        api('/api/status'),api('/api/stats'),api('/api/groups'),api('/api/events')
      ]);
      setStatus(s); setStats(st.stats||{}); setGroups(Array.isArray(g)?g:[]);
      setEvents(Array.isArray(e)?e:[]);
      setSelected(current => current && g.some(x=>x.jid===current) ? current : (g[0]?.jid||''));
      setConnected(true); localStorage.setItem(STORE_KEY,token);
    } catch(err) {
      setConnected(false); setNotice(err.message);
    } finally { setBusy(false); }
  },[api,token]);

  useEffect(()=>{ if(token) refresh(); },[]);

  const group = useMemo(()=>groups.find(g=>g.jid===selected)||null,[groups,selected]);
  useEffect(()=>{
    if(group) setDraft({rules:group.rules||'',welcome_text:group.welcome_text||'',goodbye_text:group.goodbye_text||'',auto_action_threshold:group.auto_action_threshold||3});
    setMembers([]);setMemberMeta(null);
    if(selected&&page==='groups')loadMembers(selected);
  },[selected,page]);

  async function loadMembers(jid=selected) {
    if(!jid)return;
    setMemberBusy(true);
    try { const data=await api('/api/groups/'+encodeURIComponent(jid)+'/members');setMembers(data.members||[]);setMemberMeta(data); }
    catch(err){setMembers([]);setMemberMeta({error:err.message});}
    finally{setMemberBusy(false);}
  }
  async function memberAction(member,action) {
    const label=action==='remove'?'remove this member from the group':action==='demote'?'remove this member’s admin role':'promote this member to admin';
    if(!window.confirm('Are you sure you want to '+label+'?'))return;
    setMemberBusy(true);setNotice('Sending '+action+' request to WhatsApp…');
    try {
      await api('/api/groups/'+encodeURIComponent(selected)+'/members/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memberJid:member.id})});
      setNotice('WhatsApp confirmed the '+action+' request. Refreshing members…');
      await loadMembers(selected);
      setNotice('Member list updated.');
    } catch(err){setNotice(err.message);}
    finally{setMemberBusy(false);}
  }
  async function saveSetting(values) {
    if(!selected) return;
    setNotice('Saving changes…');
    try {
      const result=await api('/api/groups/'+encodeURIComponent(selected)+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
      setGroups(old=>old.map(g=>g.jid===selected?result.group:g));
      setNotice('Changes saved.');
    } catch(err) { setNotice(err.message); }
  }
  async function connect() { await refresh(); }
  function disconnect() { localStorage.removeItem(STORE_KEY);setToken('');setConnected(false);setStatus(null);setNotice('Dashboard disconnected.'); }
  async function showQr() {
    setPairResult('');setQr('');
    try { const data=await api('/api/qr');setQr(data.qr||''); }
    catch(err){setPairResult(err.message);}
  }
  async function pairAccount() {
    setPairResult('Preparing account switch…');setQr('');
    try {
      const switched=await api('/api/switch-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
      setPairResult(switched.message||'New session prepared. Waiting for WhatsApp…');
      const deadline=Date.now()+45000;let ready=false;
      while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1200));const st=await api('/api/status');if(st.qrAvailable){ready=true;break;}}
      if(!ready){setPairResult('Session started. Pairing is not ready yet; refresh status and try again.');return;}
      const result=await api('/api/pairing-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
      setPairResult(result.code?'Linking code: '+result.code+'\n\n'+result.instructions:(result.error||'Could not get a linking code.'));
    } catch(err){setPairResult(err.message);}
  }

  if(!connected) return <main className="login-screen"><div className="login-glow" /><div className="login-card">
    <div className="brand-mark large">MG</div><div className="eyebrow">S.D COMPANIES · WHATSAPP AUTOMATION</div>
    <h1>Major General</h1><p className="muted">Your group. Your rules. One command center.</p>
    <label className="field-label" htmlFor="dashboard-token">Dashboard access token</label>
    <input id="dashboard-token" className="text-input" type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="Enter your private token" onKeyDown={e=>e.key==='Enter'&&connect()} />
    <button className="primary-btn full" onClick={connect} disabled={busy||!token.trim()}>{busy?'Connecting…':'Connect dashboard'} <span>→</span></button>
    {notice&&<div className="notice error">{notice}</div>}
    <div className="secure-note"><span>▣</span> Protected connection · Token is saved on this device only</div>
  </div></main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">MG</div><div><b>MAJOR GENERAL</b><small>CONTROL CENTER</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{navItems.map(([id,icon,label])=><button key={id} className={page===id?'nav-item active':'nav-item'} onClick={()=>setPage(id)}><Icon>{icon}</Icon>{label}{id==='groups'&&<span className="nav-count">{groups.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="connection"><span className="live-dot" /><div><b>Dashboard connected</b><small>Secure session active</small></div></div><button className="logout-btn" onClick={disconnect}>↪ Sign out</button><div className="version">MAJOR GENERAL · ADMIN</div></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div><div className="breadcrumb">CONTROL CENTER <span>/</span> {page.toUpperCase()}</div><h1>{navItems.find(n=>n[0]===page)?.[2]}</h1></div><div className="top-actions"><div className="bot-pill"><span className={status?.connected?'live-dot':'idle-dot'} />{status?.connected?'WhatsApp online':'WhatsApp offline'}</div><button className="icon-btn" onClick={refresh} title="Refresh dashboard">↻</button><div className="avatar">MG</div></div></header>
      {notice&&<div className={notice.toLowerCase().includes('saved')?'notice success':'notice'}>{notice}<button onClick={()=>setNotice('')}>×</button></div>}
      {page==='overview'&&<section className="page-content">
        <div className="welcome-row"><div><div className="eyebrow">LIVE COMMAND CENTER</div><h2>Welcome back, Commander.</h2><p>Here’s what’s happening across your WhatsApp groups.</p></div><button className="secondary-btn" onClick={refresh}>↻ Refresh data</button></div>
        <div className="stats-grid"><Stat label="Connected groups" value={stats?.groups} detail="Groups recorded by the bot" icon="▦"/><Stat label="Protected groups" value={stats?.protectedGroups} detail="At least one protection enabled" icon="⛨"/><Stat label="Warnings · 7 days" value={stats?.warningsLast7Days} detail="Member warnings recorded" icon="⚑"/><Stat label="Moderation events" value={stats?.moderationEventsLast7Days} detail="Events in the last 7 days" icon="≋"/></div>
        <div className="overview-grid"><div className="panel"><div className="panel-heading"><div><h3>Connected groups</h3><p>Your groups registered with Major General</p></div><button className="text-btn" onClick={()=>setPage('groups')}>Manage groups →</button></div>
          {groups.length?groups.slice(0,5).map(g=><button className="group-row" key={g.jid} onClick={()=>{setSelected(g.jid);setPage('groups')}}><div className="group-avatar">▦</div><div className="group-meta"><b>{g.subject||g.jid}</b><small>{g.jid}</small></div><span className="row-arrow">→</span></button>):<Empty title="No groups yet" detail="Add Major General to a WhatsApp group to get started."/>}
        </div><div className="panel"><div className="panel-heading"><div><h3>Bot status</h3><p>WhatsApp connection health</p></div><span className={status?.connected?'status-tag online':'status-tag offline'}>{status?.connected?'ONLINE':'OFFLINE'}</span></div>
          <div className="status-line"><span>Connection</span><b>{status?.connection||status?.lastConnection|| (status?.connected?'Connected':'Not connected')}</b></div><div className="status-line"><span>Currently muted</span><b>{stats?.currentlyMuted??0} members</b></div><div className="status-line"><span>Session</span><b>Persistent</b></div><button className="secondary-btn full" onClick={()=>setPage('whatsapp')}>WhatsApp settings →</button>
        </div></div>
        <div className="panel"><div className="panel-heading"><div><h3>Recent moderation</h3><p>Latest recorded bot activity</p></div><button className="text-btn" onClick={()=>setPage('activity')}>View activity →</button></div>
          {events.length?events.slice(0,5).map((e,i)=><div className="event-row" key={i}><span className="event-dot"/><div><b>{String(e.event_type||'Event').replaceAll('_',' ')}</b><small>{e.group_jid} · {e.user_jid}</small></div><time>{e.created_at?new Date(e.created_at).toLocaleString():''}</time></div>):<Empty title="No activity recorded" detail="Moderation events will appear here as the bot works."/>}
        </div>
      </section>}

      {page==='groups'&&<section className="page-content">
        <div className="welcome-row"><div><div className="eyebrow">GROUP CONFIGURATION</div><h2>Protection & group settings</h2><p>Configure each group independently. Changes save directly to the cloud database.</p></div><button className="secondary-btn" onClick={refresh}>↻ Refresh groups</button></div>
        <div className="group-layout"><div className="panel group-picker"><div className="panel-heading"><div><h3>Your groups</h3><p>{groups.length} connected</p></div></div>
          {groups.length?groups.map(g=><button key={g.jid} className={selected===g.jid?'picker-row selected':'picker-row'} onClick={()=>setSelected(g.jid)}><div className="group-avatar">▦</div><div className="group-meta"><b>{g.subject||g.jid}</b><small>{g.jid}</small></div><span className="row-arrow">›</span></button>):<Empty title="No groups found" detail="Refresh after the bot has joined a group."/>}
        </div><div className="group-editor">
          {!group?<div className="panel"><Empty title="Select a group" detail="Choose a group on the left to configure its protections."/></div>:<>
            <div className="panel"><div className="panel-heading"><div><div className="eyebrow">SELECTED GROUP</div><h3>{group.subject||'WhatsApp group'}</h3><p>{group.jid}</p></div><span className={memberMeta?.botAdmin?'status-tag online':'status-tag offline'}>{memberMeta?.botAdmin?'BOT IS ADMIN':'BOT NEEDS ADMIN'}</span></div>
              <div className="member-heading"><div><b>Live members</b><small>{members.length} members · WhatsApp group metadata</small></div><button className="secondary-btn" onClick={()=>loadMembers(selected)} disabled={memberBusy}>↻ Refresh</button></div>
              {memberMeta?.error&&<div className="warning-note">{memberMeta.error}</div>}
              {memberMeta&&!memberMeta.botAdmin&&<div className="warning-note">Promote Major General to group admin in WhatsApp before using member controls. It cannot promote itself.</div>}
              <div className="members-list">{memberBusy&&!members.length?<div className="member-empty">Loading members…</div>:members.map(m=><div className="member-row" key={m.id}><div className="member-avatar">{(m.name||m.number||'?').slice(0,1).toUpperCase()}</div><div className="member-info"><b>{m.name||m.number}</b><small>{m.number}{m.admin==='superadmin'?' · Group creator':m.admin==='admin'?' · Admin':''}{m.isBot?' · Major General':''}</small></div><div className="member-actions">
                {m.isBot?<span className="status-tag online">BOT</span>:m.admin==='superadmin'?<span className="status-tag">OWNER</span>:m.admin==='admin'?<><button className="member-action" disabled={memberBusy||!memberMeta?.botAdmin} onClick={()=>memberAction(m,'demote')}>Demote</button><button className="member-action danger" disabled={memberBusy||!memberMeta?.botAdmin} onClick={()=>memberAction(m,'remove')}>Remove</button></>:<><button className="member-action" disabled={memberBusy||!memberMeta?.botAdmin} onClick={()=>memberAction(m,'promote')}>Make admin</button><button className="member-action danger" disabled={memberBusy||!memberMeta?.botAdmin} onClick={()=>memberAction(m,'remove')}>Remove</button></>}
              </div></div>):<div className="member-empty">No members loaded. Refresh to try again.</div>}</div>
              <div className="protection-list">{protections.map(([key,title,desc])=><div className="protection-row" key={key}><div><b>{title}</b><small>{desc}</small></div><Toggle checked={!!group[key]} onChange={value=>saveSetting({[key]:value})}/></div>)}</div>
            </div>
            <div className="panel"><div className="panel-heading"><div><h3>Group messages & rules</h3><p>Customize what Major General sends in this group.</p></div></div>
              <label className="form-label">Group rules<textarea rows="4" value={draft.rules} onChange={e=>setDraft(d=>({...d,rules:e.target.value}))} placeholder="Write the rules members should follow…"/></label>
              <label className="form-label">Welcome message<textarea rows="3" value={draft.welcome_text} onChange={e=>setDraft(d=>({...d,welcome_text:e.target.value}))} placeholder="Message sent when a member joins…"/></label>
              <label className="form-label">Goodbye message<textarea rows="3" value={draft.goodbye_text} onChange={e=>setDraft(d=>({...d,goodbye_text:e.target.value}))} placeholder="Message sent when a member leaves…"/></label>
              <label className="form-label threshold">Warnings before automatic action<input type="number" min="2" max="10" value={draft.auto_action_threshold} onChange={e=>setDraft(d=>({...d,auto_action_threshold:Number(e.target.value)}))}/></label>
              <div className="form-footer"><span>Text fields allow up to 1,500 characters.</span><button className="primary-btn" onClick={()=>saveSetting({rules:draft.rules,welcome_text:draft.welcome_text,goodbye_text:draft.goodbye_text,auto_action_threshold:Number(draft.auto_action_threshold)})}>Save group settings <span>→</span></button></div>
            </div>
          </>}
        </div></div>
      </section>}

      {page==='whatsapp'&&<section className="page-content">
        <div className="welcome-row"><div><div className="eyebrow">ACCOUNT & SESSION</div><h2>WhatsApp connection</h2><p>View the active session or link a different WhatsApp account.</p></div><button className="secondary-btn" onClick={refresh}>↻ Refresh status</button></div>
        <div className="whatsapp-grid"><div className="panel"><div className="panel-heading"><div><h3>Current connection</h3><p>Live bot session status</p></div><span className={status?.connected?'status-tag online':'status-tag offline'}>{status?.connected?'CONNECTED':'DISCONNECTED'}</span></div><div className="connection-hero"><div className="wa-logo">◉</div><div><b>{status?.connected?'WhatsApp is connected':'WhatsApp is not connected'}</b><small>{status?.lastConnection||status?.connection||'Connection state unavailable'}</small></div></div><button className="secondary-btn full" onClick={showQr}>Show pairing QR</button>{qr&&<div className="qr-wrap"><img src={qr} alt="WhatsApp pairing QR code"/><small>Scan from WhatsApp → Linked devices → Link a device.</small></div>}</div>
          <div className="panel"><div className="panel-heading"><div><h3>Link another number</h3><p>Use the phone number linking method.</p></div></div><div className="warning-note">Switching accounts disconnects the currently linked WhatsApp account. Its session backup is preserved by the bot.</div><label className="form-label">New WhatsApp number<input type="tel" inputMode="numeric" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="Country code + number, digits only"/></label><button className="primary-btn full" onClick={pairAccount} disabled={!phone.trim()}>Switch account & get code <span>→</span></button>{pairResult&&<pre className="pair-result">{pairResult}</pre>}</div></div>
      </section>}

      {page==='activity'&&<section className="page-content"><div className="welcome-row"><div><div className="eyebrow">MODERATION LOG</div><h2>Recent activity</h2><p>Review moderation events recorded by the bot.</p></div><button className="secondary-btn" onClick={refresh}>↻ Refresh activity</button></div><div className="panel">
        {events.length?<div className="activity-table"><div className="table-head"><span>EVENT</span><span>GROUP</span><span>MEMBER</span><span>TIME</span></div>{events.map((e,i)=><div className="table-row" key={i}><b>{String(e.event_type||'Event').replaceAll('_',' ')}</b><span>{e.group_jid}</span><span>{e.user_jid}</span><time>{e.created_at?new Date(e.created_at).toLocaleString():''}</time></div>)}</div>:<Empty title="Nothing to show yet" detail="New moderation events will appear here."/>}
      </div></section>}
      <footer className="footer">MAJOR GENERAL <span>·</span> POWERED BY S.D COMPANIES <span>·</span> SECURE CONTROL CENTER</footer>
    </main>
  </div>;
}