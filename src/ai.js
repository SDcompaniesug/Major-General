const OpenAI = require('openai');
let client;
function getClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
async function askAI(prompt) {
  const openai = getClient();
  const result = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: 'You are Major General, a helpful and respectful WhatsApp group assistant. Be concise, avoid unsafe instructions, and do not claim to perform group admin actions.' },
      { role: 'user', content: String(prompt).slice(0, 6000) }
    ],
    max_tokens: 500
  });
  return (result.choices?.[0]?.message?.content || 'I could not generate a response.').slice(0, 3500);
}
module.exports = { askAI };
