const OpenAI = require('openai');
let client;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
function containsLink(text) {
  return /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|bit\.ly\/)/i.test(text || '');
}
async function inspectText(text) {
  const ai = getOpenAI();
  if (!ai || !text || !text.trim()) return { flagged: false, categories: [] };
  const result = await ai.moderations.create({ model: 'omni-moderation-latest', input: text.slice(0, 8000) });
  const item = result.results && result.results[0];
  return { flagged: !!(item && item.flagged), categories: item ? Object.keys(item.categories || {}).filter(k => item.categories[k]) : [] };
}
module.exports = { containsLink, inspectText };
