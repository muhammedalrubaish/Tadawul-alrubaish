// «فحص الوقف [رمز]» — تشخيص للقراءة فقط: ماذا تعيد Alpaca لأوامر الرمز بكل طريقة نقرؤها بها، وماذا تعيد getOpenOrders بالضبط
// لا يرسل ولا يلغي أي أمر
const broker = require('./_broker');

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = o => o.stop_price ? `stop ${o.stop_price}` : o.limit_price ? `limit ${o.limit_price}` : 'market';
const line = (o, pad = '') => `${pad}• <code>${esc(String(o.id).slice(0, 8))}</code> ${esc(o.side)} ${esc(o.type)} · <b>${esc(o.status)}</b> · ${esc(px(o))} · ${esc(o.order_class || '-')}${o.symbol ? '' : ' · ⚠️ بلا symbol'}`;
// عُقد الرمز من قائمة متداخلة: الأب إن كان للرمز، مع أرجله
const tree = (list, sym) => (list || []).filter(o => o.symbol === sym || (o.legs || []).some(l => l.symbol === sym))
  .map(o => [line(o), ...(o.legs || []).map(l => line(l, '   ↳ '))].join('\n'));

async function stopCheck(sym) {
  sym = String(sym).toUpperCase();
  const after = new Date(Date.now() - 90 * 864e5).toISOString();
  const [positions, flat, openNested, allNested, final] = await Promise.all([
    broker.getPositions(),
    broker.listOrders('status=open&limit=500&nested=false'),
    broker.listOrders('status=open&limit=500&nested=true'),
    broker.listOrders(`status=all&limit=500&nested=true&direction=desc&after=${encodeURIComponent(after)}&symbols=${encodeURIComponent(sym)}`),
    broker.getOpenOrders()
  ]);
  const pos = (positions || []).find(p => p.symbol === sym);
  const mine = final.filter(o => o.symbol === sym);
  const stop = mine.find(o => o.side === 'sell' && /stop/.test(o.type) && o.stop_price);
  const out = [`🔍 <b>فحص الوقف ${esc(sym)}</b> · ${broker.PAPER ? 'حساب تجريبي 🧪' : 'حساب حقيقي 💰'}`,
    pos ? `المركز: ${+pos.qty} سهم · دخول ${(+pos.avg_entry_price).toFixed(2)} · حالي ${(+pos.current_price).toFixed(2)}` : 'المركز: لا مركز مفتوح لهذا الرمز'];
  const sec = (title, rows) => out.push('', `<b>${title}</b>`, ...(rows.length ? rows : ['(لا شيء)']));
  sec('1) status=open · nested=false', (flat || []).filter(o => o.symbol === sym).map(o => line(o)));
  sec('2) status=open · nested=true', tree(openNested, sym));
  sec('3) status=all · nested=true (90 يوماً)', tree(allNested, sym).slice(0, 4));
  sec('4) ما تعيده getOpenOrders للرمز', mine.map(o => line(o)));
  out.push('', '<b>النتيجة</b>', stop ? `✅ وقف مطابق: ${esc(stop.stop_price)} (${esc(stop.status)}) — الصفحة يجب أن تعرضه` : '🚨 لا رجل وقف مطابقة (side=sell · type فيه stop · stop_price) — الصفحة ستعرض «بلا وقف»');
  return out.join('\n');
}

module.exports = { stopCheck };
