# Major General

WhatsApp group assistant and moderation bot using Baileys, OpenAI and Neon PostgreSQL.

## Commands

- General: `!help`, `!rules`, `!ask <question>`, `!summarize`, `!translate <language> <text>`, `!quiz`.
- Protection (group admin): `!antilink on/off`, `!antispam on/off`, `!antiflood on/off`, `!antibadword on/off`, `!antiscam on/off`, `!aimod on/off`.
- Group tools (group admin): `!setrules <text>`, `!welcome on/off`, `!goodbye on/off`, `!setwelcome <text>`, `!setgoodbye <text>`, `!lockgroup`, `!unlockgroup`, `!tagall`, `!admins`.
- Member tools (group admin): `!warn @member [reason]`, `!warns @member`, `!clearwarns @member`, `!mute @member`, `!unmute @member`, `!kick @member`, `!promote @member`, `!demote @member`.
- Word filter (group admin): `!badword add <word>`, `!badword remove <word>`.
- Owner-only: `!botstatus`, `!broadcast <message>`, `!maintenance on/off` (requires `BOT_OWNER_NUMBER`).

## Protection behavior

- Anti-spam removes repeated identical messages; anti-flood removes messages after a short burst threshold.
- Anti-badword uses the group's custom word list.
- Anti-scam checks for common high-risk scam phrases. It is a basic heuristic, not a guarantee.
- Mute is implemented as timed message deletion while the bot is a group admin; WhatsApp does not provide a per-member mute permission.
- Auto-warning removal is OFF by default. Admins can enable it with `!autowarn on`; the default threshold is three warnings.
- AI moderation is OFF by default and requires both `!aimod on` for a group and `AI_AUTO_MODERATION=true` on Railway.
- Welcome and goodbye templates support `@user` and `@group`.

## Railway setup

Set `DATABASE_URL`, `DASHBOARD_TOKEN`, `OPENAI_API_KEY`, `AUTH_DIR=/data/baileys-auth`, `PORT=3000`, `HOST=0.0.0.0`, `AUTO_DELETE_LINKS=true`, `AI_AUTO_MODERATION=false`. Set `BOT_OWNER_NUMBER` to the owner's WhatsApp number in international digits-only format to enable owner commands. Mount a persistent Railway volume at `/data` and configure health check `/health`.

Dashboard: `/api/status`, `/api/groups`, `/api/stats`, and `/api/events` require the bearer dashboard token. The browser remembers the token locally after a successful connection.

## Safety and limitations

Baileys is an unofficial WhatsApp Web client, not Meta's official Groups API. Protocol changes or account restrictions can occur; use a dedicated number and comply with WhatsApp terms. The bot needs group-admin permissions for deleting messages, removing/promoting members and changing group posting permissions. AI summaries/translations send the requested text to OpenAI. AI moderation sends group message text only when both AI moderation switches are enabled. Keep automatic actions disabled until tested in a test group. Do not use the bot for unsolicited bulk messaging. Keep dashboard tokens, database URLs, API keys and session files private; never commit them to Git.
