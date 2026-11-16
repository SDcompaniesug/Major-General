const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }, max: 5 });
async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
  await pool.query(schema);
}
async function ensureGroup(jid, subject) {
  await pool.query('INSERT INTO groups(jid,subject) VALUES($1,$2) ON CONFLICT(jid) DO UPDATE SET subject=EXCLUDED.subject, updated_at=NOW()', [jid, subject || '']);
}
async function getGroup(jid) {
  const r = await pool.query('SELECT * FROM groups WHERE jid=$1', [jid]);
  return r.rows[0];
}
async function getSetting(key, fallback=null) {
  const r=await pool.query('SELECT value FROM bot_settings WHERE key=$1',[key]);
  return r.rowCount ? r.rows[0].value : fallback;
}
async function setSetting(key,value) {
  await pool.query('INSERT INTO bot_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()',[key,JSON.stringify(value)]);
}
async function setGroup(jid, key, value) {
  const allowed = { antilink:'antilink', ai_moderation:'ai_moderation', rules:'rules', antispam:'antispam', antiflood:'antiflood', antibadword:'antibadword', antiscam:'antiscam', welcome_enabled:'welcome_enabled', goodbye_enabled:'goodbye_enabled', welcome_text:'welcome_text', goodbye_text:'goodbye_text', auto_action_enabled:'auto_action_enabled', auto_action_threshold:'auto_action_threshold' };
  if (!allowed[key]) throw new Error('Invalid group setting');
  await pool.query(`UPDATE groups SET ${allowed[key]}=$2, updated_at=NOW() WHERE jid=$1`, [jid, value]);
}
async function addWarning(groupJid, userJid, reason, moderatorJid) {
  const r = await pool.query('INSERT INTO warnings(group_jid,user_jid,reason,moderator_jid) VALUES($1,$2,$3,$4) RETURNING id', [groupJid,userJid,reason,moderatorJid]);
  return r.rows[0].id;
}
async function warningCount(groupJid, userJid) {
  const r = await pool.query('SELECT COUNT(*)::int AS count FROM warnings WHERE group_jid=$1 AND user_jid=$2', [groupJid,userJid]);
  return r.rows[0].count;
}
async function logEvent(groupJid,userJid,eventType,details={}) {
  await pool.query('INSERT INTO moderation_events(group_jid,user_jid,event_type,details) VALUES($1,$2,$3,$4)', [groupJid,userJid,eventType,JSON.stringify(details)]);
}
async function clearWarnings(groupJid,userJid) {
  const r=await pool.query('DELETE FROM warnings WHERE group_jid=$1 AND user_jid=$2',[groupJid,userJid]); return r.rowCount;
}
async function listWarnings(groupJid,userJid) {
  const r=await pool.query('SELECT id,reason,moderator_jid,created_at FROM warnings WHERE group_jid=$1 AND user_jid=$2 ORDER BY created_at DESC LIMIT 20',[groupJid,userJid]); return r.rows;
}
async function setMute(groupJid,userJid,until,by) {
  await pool.query('INSERT INTO member_mutes(group_jid,user_jid,muted_until,moderator_jid) VALUES($1,$2,$3,$4) ON CONFLICT(group_jid,user_jid) DO UPDATE SET muted_until=EXCLUDED.muted_until,moderator_jid=EXCLUDED.moderator_jid',[groupJid,userJid,until,by]);
}
async function clearMute(groupJid,userJid) { await pool.query('DELETE FROM member_mutes WHERE group_jid=$1 AND user_jid=$2',[groupJid,userJid]); }
async function isMuted(groupJid,userJid) {
  const r=await pool.query('SELECT muted_until FROM member_mutes WHERE group_jid=$1 AND user_jid=$2 AND muted_until>NOW()',[groupJid,userJid]); return r.rowCount>0;
}
async function addMessage(groupJid,userJid,body) {
  await pool.query('INSERT INTO group_messages(group_jid,user_jid,body) VALUES($1,$2,$3)',[groupJid,userJid,String(body||'').slice(0,2000)]);
}
async function recentMessages(groupJid,limit=40) {
  const r=await pool.query('SELECT user_jid,body,created_at FROM group_messages WHERE group_jid=$1 ORDER BY created_at DESC LIMIT $2',[groupJid,Math.min(100,Math.max(1,limit))]); return r.rows.reverse();
}
async function addBadWord(groupJid,word) { await pool.query('INSERT INTO group_bad_words(group_jid,word) VALUES($1,$2) ON CONFLICT DO NOTHING',[groupJid,word.toLowerCase()]); }
async function removeBadWord(groupJid,word) { await pool.query('DELETE FROM group_bad_words WHERE group_jid=$1 AND word=$2',[groupJid,word.toLowerCase()]); }
async function getBadWords(groupJid) { const r=await pool.query('SELECT word FROM group_bad_words WHERE group_jid=$1',[groupJid]); return r.rows.map(x=>x.word); }
async function dashboardStats() {
  const [g,w,e,m]=await Promise.all([
    pool.query('SELECT COUNT(*)::int AS groups, COUNT(*) FILTER(WHERE antilink OR ai_moderation OR antispam OR antiflood OR antibadword OR antiscam)::int AS protected_groups FROM groups'),
    pool.query('SELECT COUNT(*)::int AS warnings FROM warnings WHERE created_at>NOW()-INTERVAL \'7 days\''),
    pool.query('SELECT COUNT(*)::int AS events FROM moderation_events WHERE created_at>NOW()-INTERVAL \'7 days\''),
    pool.query('SELECT COUNT(*)::int AS muted_members FROM member_mutes WHERE muted_until>NOW()')
  ]);
  return {groups:g.rows[0].groups,protectedGroups:g.rows[0].protected_groups,warningsLast7Days:w.rows[0].warnings,moderationEventsLast7Days:e.rows[0].events,currentlyMuted:m.rows[0].muted_members};
}
async function listGroups() {
  const r = await pool.query('SELECT jid,subject,antilink,ai_moderation,antispam,antiflood,antibadword,antiscam,welcome_enabled,goodbye_enabled,welcome_text,goodbye_text,rules,auto_action_enabled,auto_action_threshold,updated_at FROM groups ORDER BY subject');
  return r.rows;
}
module.exports = { pool, initDb, ensureGroup, getGroup, getSetting, setSetting, setGroup, addWarning, warningCount, logEvent, listGroups, clearWarnings, listWarnings, setMute, clearMute, isMuted, addMessage, recentMessages, addBadWord, removeBadWord, getBadWords, dashboardStats };
