# Major General

WhatsApp group moderation bot using Baileys, OpenAI moderation and Neon PostgreSQL.

## Features
- Persistent multi-device WhatsApp Web session (mount Railway volume at /data).
- Multi-group configuration, welcome-free lightweight setup and group discovery as messages arrive.
- Admin-only commands: !help, !rules, !ask <question>, !antilink on/off, !aimod on/off, !setrules, !warn @member, !kick @member.
- Link deletion requires the bot to be a group admin.
- OpenAI moderation API integration; automatic deletion is OFF by default and requires AI_AUTO_MODERATION=true.
- Token-protected dashboard with QR pairing, status and group list.

## Deploy on Railway
1. Connect this repository, branch main, to a Railway service.
2. Set variables: DATABASE_URL, DASHBOARD_TOKEN, OPENAI_API_KEY, AUTH_DIR=/data/baileys-auth, PORT=3000, HOST=0.0.0.0, AUTO_DELETE_LINKS=true, AI_AUTO_MODERATION=false.
3. Mount a persistent Railway volume at /data.
4. Expose port 3000 and healthcheck /health.
5. Open the Railway domain. Enter DASHBOARD_TOKEN, then show QR and scan it from WhatsApp > Linked devices.
6. Add the account to a test group and promote it to admin.

## Safety and limitations
Baileys is an unofficial WhatsApp Web client, not Meta's official Groups API. Protocol changes, account restrictions and logout can occur. Use a dedicated number and comply with WhatsApp terms. Do not use this for unsolicited bulk messaging.
The bot cannot remove users or delete other users' messages unless it has the relevant group-admin privileges. AI moderation uses OpenAI's moderation endpoint and may make mistakes. Keep automatic AI deletion disabled until tested with your group's rules. WhatsApp message content is sent to OpenAI only when AI moderation is enabled for that group and the Railway AI_AUTO_MODERATION switch is true.
Use !ask <question> in a group for an AI answer (requires OPENAI_API_KEY). AI moderation is a separate feature and remains disabled until explicitly enabled.\nThe dashboard uses a bearer token; keep it private and use HTTPS. Session files and secrets must never be committed to GitHub.
