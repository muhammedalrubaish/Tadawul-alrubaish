// نقطة نهاية المساعد الذكي داخل رصد — POST {q, history, portfolio}
const { ask, hasKey, providerLabel, modelName } = require('./_ai');

const PASS = String(process.env.AI_PASS || '').trim();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-rasad-pass');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // فحص الحالة للواجهة: هل المساعد مفعّل؟ وهل يتطلب رمزاً؟
  if (req.method === 'GET') {
    return res.status(200).json({ ai: hasKey(), pass: !!PASS, provider: providerLabel(), model: modelName() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST فقط' });

  // حماية اختيارية من استنزاف المفتاح: رمز AI_PASS يُدخله المستخدم مرة في التطبيق
  if (PASS && String(req.headers['x-rasad-pass'] || '') !== PASS) {
    return res.status(401).json({ error: 'رمز المساعد غير صحيح' });
  }

  const body = req.body || {};
  const q = String(body.q || '').trim().slice(0, 2000);
  if (!q) return res.status(400).json({ error: 'أرسل سؤالاً في الحقل q' });

  try {
    const answer = await ask({ question: q, history: body.history, portfolio: body.portfolio });
    return res.status(200).json({ answer });
  } catch (e) {
    const code = e && e.code === 'NO_KEY' ? 503 : 502;
    return res.status(code).json({ error: String((e && e.message) || e) });
  }
};
