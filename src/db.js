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
async function setGroup(jid, key, value) {
  const allowed = { antilink: 'antilink', ai_moderation: 'ai_moderation', rules: 'rules' };
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
async function listGroups() {
  const r = await pool.query('SELECT jid,subject,antilink,ai_moderation,updated_at FROM groups ORDER BY subject');
  return r.rows;
}
module.exports = { pool, initDb, ensureGroup, getGroup, setGroup, addWarning, warningCount, logEvent, listGroups };
