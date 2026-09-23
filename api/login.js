// بوابة الدخول — GET: هل الدخول محمي؟ · POST {name, pass}: تحقق من كلمة المرور
// الرمز: APP_PASS إن وُجد، وإلا AI_PASS (الرمز نفسه الذي يحمي المساعد وصفقات الوكيل)، وإلا الدخول مفتوح
const APP = String(process.env.APP_PASS || '').trim();
const AI = String(process.env.AI_PASS || '').trim();
const USER = String(process.env.APP_USER || '').trim();
const PASS = APP || AI;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({ protected: !!PASS, user: !!USER, via: APP ? 'app' : AI ? 'ai' : 'open' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST فقط' });

  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 60);
  const pass = String(body.pass || '').trim().slice(0, 200);

  // لا رمز مضبوط: الدخول مفتوح مع تنبيه للواجهة
  if (!PASS) return res.status(200).json({ ok: true, open: true, name });

  const bad = (USER && name !== USER) || pass !== PASS;
  if (bad) {
    // إبطاء التخمين: تأخير بسيط قبل الرفض
    await new Promise(r => setTimeout(r, 700));
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  // aiPass: كلمة المرور نفسها تصلح رمزاً للمساعد وصفقات الوكيل فلا يُطلب مرة أخرى
  return res.status(200).json({ ok: true, name, via: APP ? 'app' : 'ai', aiPass: !!AI && pass === AI });
};
