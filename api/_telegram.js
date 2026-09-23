// وحدة تيليجرام المشتركة — إرسال الرسائل ونداء الـBot API
const TOKEN = String(process.env.TELEGRAM_TOKEN || '').trim();
const CHAT = String(process.env.TELEGRAM_CHAT || '').trim();

// سر التحقق من الويبهوك: مشتق حتمياً من التوكن (تيليجرام يعيده مع كل تحديث)
const SECRET = TOKEN.replace(/[^A-Za-z0-9]/g, '').slice(-32);

async function api(method, payload) {
  if (!TOKEN) throw new Error('TELEGRAM_TOKEN غير مضبوط');
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`Telegram ${method}: ${d.description || r.status}`);
  return d.result;
}

// إرسال نص (HTML) مع تقسيم تلقائي عند تجاوز حد تيليجرام 4096 حرفاً
// extra: حقول إضافية للرسالة الأخيرة (مثل reply_markup لأزرار الردود السريعة)
async function send(chatId, text, extra) {
  const chunks = [];
  let t = String(text);
  while (t.length > 4000) {
    let cut = t.lastIndexOf('\n\n', 4000);
    if (cut < 1000) cut = 4000;
    chunks.push(t.slice(0, cut));
    t = t.slice(cut);
  }
  chunks.push(t);
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i], parse_mode: 'HTML', disable_web_page_preview: true };
    if (extra && i === chunks.length - 1) Object.assign(payload, extra);
    await api('sendMessage', payload);
  }
}

// لوحة أزرار تحت حقل الكتابة: كل زر يرسل نصه كرسالة عادية (تختفي بعد الضغط)
const quickReplies = replies => (Array.isArray(replies) && replies.length)
  ? { reply_markup: { keyboard: replies.map(r => [{ text: String(r) }]), resize_keyboard: true, one_time_keyboard: true, input_field_placeholder: 'اختر رداً أو اكتب سؤالك…' } }
  : { reply_markup: { remove_keyboard: true } };

module.exports = { api, send, quickReplies, TOKEN, CHAT, SECRET };
