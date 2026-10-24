// فحص المرحلة 0: هل الصفوف المكررة في «صفقات الوكيل» من أوامر شراء متعددة، أم من أمر واحد انباع على دفعات؟
// للقراءة فقط — لا يرسل ولا يلغي أي أمر. يُستدعى من تيليجرام («فحص التكرار») ومن scripts/check-duplicates.mjs
const broker = require('./_broker');

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// يعيد نص HTML (تيليجرام) — sym: الرمز · days: أيام الدخول بتوقيت نيويورك YYYY-MM-DD
async function checkDuplicates(sym = 'SMCI', days = ['2026-10-02', '2026-10-21']) {
  sym = String(sym).toUpperCase();
  // نافذة البحث: من يوم قبل أول تاريخ إلى أسبوعين بعد آخر تاريخ (يغطي البيع اللاحق)
  const sorted = [...days].sort();
  const after = shift(sorted[0], -1) + 'T00:00:00Z';
  const until = shift(sorted[sorted.length - 1], 14) + 'T23:59:59Z';
  const [orders, allFills] = await Promise.all([broker.getSymbolOrders(sym, after, until), broker.getFillsBetween(after, until)]);
  const fills = (allFills || []).filter(f => f.symbol === sym);
  const legsOf = o => o.legs || [];
  const fillsOf = id => fills.filter(f => f.order_id === id);
  const buysOn = day => (orders || []).filter(o => o.side === 'buy' && broker.nyDay(o.submitted_at) === day);

  const lines = [`🔍 <b>فحص تكرار ${esc(sym)}</b> · ${broker.PAPER ? 'حساب تجريبي 🧪' : 'حساب حقيقي 💰'}`];
  for (const day of days) {
    const buys = buysOn(day);
    lines.push('', `<b>${day}</b>: ${buys.length} أمر شراء`);
    for (const o of buys) {
      lines.push(`• شراء <code>${esc(o.client_order_id)}</code> · ${esc(o.status)} · منفَّذ ${o.filled_qty}/${o.qty} بمتوسط ${o.filled_avg_price || '—'} · ${esc(o.submitted_at)} · تنفيذات: ${fillsOf(o.id).length}`);
      for (const l of legsOf(o)) {
        const lf = fillsOf(l.id);
        lines.push(`   ↳ ${/stop/.test(l.type) ? 'وقف' : 'هدف'} ${l.stop_price || l.limit_price} · ${esc(l.status)} · تنفيذات بيع: ${lf.length}` +
          (lf.length ? ' → ' + lf.map(f => `${f.qty}@${f.price}`).join('، ') : ''));
      }
    }
  }

  // تنفيذات بيع لا تتبع رجل bracket (إغلاق يدوي أو من الوكيل)
  const legIds = new Set((orders || []).flatMap(o => legsOf(o).map(l => l.id)));
  const orphan = fills.filter(f => f.side !== 'buy' && !legIds.has(f.order_id));
  if (orphan.length) lines.push('', `بيع خارج أرجل bracket: ${orphan.map(f => `${f.qty}@${f.price} (${esc(f.transaction_time)})`).join('، ')}`);

  lines.push('', '<b>النتيجة</b>');
  for (const day of days) {
    const filled = buysOn(day).filter(o => +o.filled_qty > 0);
    const sells = filled.length === 1 ? legsOf(filled[0]).reduce((n, l) => n + fillsOf(l.id).length, 0) : 0;
    lines.push(`${day}: ` + (filled.length > 1 ? `🔁 ${filled.length} أوامر شراء منفَّذة — شراء مكرر فعلاً`
      : filled.length === 1 && sells > 1 ? `🧩 أمر شراء واحد، انباع على ${sells} دفعات — التكرار من العرض (closedTrades)`
      : filled.length === 1 ? '✅ أمر شراء واحد وبيع بدفعة واحدة — التكرار ليس من هذا اليوم'
      : '⚠️ لا أمر شراء منفَّذ في هذا اليوم (تحقق من التاريخ أو الرمز)'));
  }
  return lines.join('\n');
}

module.exports = { checkDuplicates };
