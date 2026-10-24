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

module.exports = { saveDecision, hasStore };
