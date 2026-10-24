// سجل قرارات الوكيل في Vercel Blob (متجر خاص) — ملف مستقل لكل أمر شراء نُفّذ باسم معرّفه الثابت
// decisions/rasad-<YYYYMMDD>-<SYM>.json: يربط ثقة الوكيل ونسب الوقف والهدف وسببه بالصفقة لاحقاً عبر client_order_id
// كتابة فقط بلا قراءة قبلها: المعرّف فريد لكل يوم ورمز، فلا تتنافس دورتان على الملف نفسه
const TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const hasStore = () => !!TOKEN;

async function saveDecision(rec) {
  if (!hasStore()) throw new Error('BLOB_READ_WRITE_TOKEN غير مضبوط');
  const { put } = require('@vercel/blob');
  return put(`decisions/${rec.client_order_id}.json`, JSON.stringify(rec), {
    access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json', token: TOKEN
  });
}

// قراءة سجلات قرارات بمعرّفاتها → { client_order_id: سجل } — المعرّفات القديمة (قبل المرحلة 0) عشوائية فتُتجاوز
// ثانوي: أي فشل أو بطء يعيد ما تيسّر بلا أن يُسقط صفحة الصفقات
async function readDecisions(ids, timeoutMs = 5000) {
  const out = {};
  const want = [...new Set((ids || []).filter(id => /^rasad-\d{8}-[A-Z0-9.\-]+$/.test(String(id))))];
  if (!hasStore() || !want.length) return out;
  const { get } = require('@vercel/blob');
  const one = async id => {
    try {
      const r = await get(`decisions/${id}.json`, { access: 'private', token: TOKEN });
      if (r && r.stream) out[id] = JSON.parse(await new Response(r.stream).text());
    } catch (_) { /* سجل ناقص لا يمنع غيره */ }
  };
  await Promise.race([Promise.all(want.map(one)), new Promise(res => setTimeout(res, timeoutMs))]);
  return out;
}

module.exports = { saveDecision, readDecisions, hasStore };
