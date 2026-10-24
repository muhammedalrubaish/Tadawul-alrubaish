// فحص المرحلة 0: هل الصفوف المكررة في «صفقات الوكيل» من أوامر شراء متعددة، أم من أمر واحد انباع على دفعات؟
// للقراءة فقط — لا يرسل ولا يلغي أي أمر.
// التشغيل (Node 20.6+) من جذر المستودع، مع ملف .env فيه ALPACA_KEY وALPACA_SECRET (وALPACA_PAPER إن لزم):
//   node --env-file=.env scripts/check-duplicates.mjs
//   node --env-file=.env scripts/check-duplicates.mjs SMCI 2026-10-02,2026-10-21
const KEY = String(process.env.ALPACA_KEY || '').trim();
const SECRET = String(process.env.ALPACA_SECRET || '').trim();
const PAPER = String(process.env.ALPACA_PAPER || 'true').trim().toLowerCase() !== 'false';
const BASE = PAPER ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
if (!KEY || !SECRET) { console.error('❌ ALPACA_KEY / ALPACA_SECRET غير مضبوطين — شغّله بـ --env-file=.env'); process.exit(1); }

const SYM = String(process.argv[2] || 'SMCI').toUpperCase();
const DAYS = String(process.argv[3] || '2026-10-02,2026-10-21').split(',').map(s => s.trim()).filter(Boolean);
const nyDay = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function api(path) {
  const r = await fetch(BASE + path, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } });
  const text = await r.text();
  if (!r.ok) throw new Error(`Alpaca GET ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

// نافذة البحث: من يوم قبل أول تاريخ إلى أسبوعين بعد آخر تاريخ (يغطي البيع اللاحق)
const sorted = [...DAYS].sort();
const after = shift(sorted[0], -1) + 'T00:00:00Z';
const until = shift(sorted[sorted.length - 1], 14) + 'T23:59:59Z';

// كل الأوامر بكل الحالات مع أرجل bracket
const orders = await api(`/v2/orders?status=all&symbols=${SYM}&nested=true&direction=asc&limit=500&after=${after}&until=${until}`);
// كل تنفيذات الرمز في النافذة (صفحات حتى النهاية)
const fills = [];
for (let token = '', page = 0; page < 50; page++) {
  const batch = await api(`/v2/account/activities/FILL?direction=asc&page_size=100&after=${after}&until=${until}` + (token ? `&page_token=${token}` : ''));
  if (!batch.length) break;
  fills.push(...batch.filter(f => f.symbol === SYM));
  token = batch[batch.length - 1].id;
  if (batch.length < 100) break;
}

console.log(`فحص ${SYM} · حساب ${PAPER ? 'تجريبي' : 'حقيقي'} · الأيام: ${DAYS.join('، ')}\n`);
const legsOf = o => (o.legs || []).map(l => ({ ...l, parent: o.id }));
const allLegs = orders.flatMap(legsOf);
for (const day of DAYS) {
  const buys = orders.filter(o => o.side === 'buy' && nyDay(o.submitted_at) === day);
  console.log(`━━ ${day}: ${buys.length} أمر شراء`);
  for (const o of buys) {
    const buyFills = fills.filter(f => f.order_id === o.id);
    console.log(`  • شراء ${o.id.slice(0, 8)} · client_order_id=${o.client_order_id} · الحالة ${o.status} · كمية ${o.qty} · منفَّذ ${o.filled_qty} بمتوسط ${o.filled_avg_price || '—'} · أُرسل ${o.submitted_at} · تنفيذات: ${buyFills.length}`);
    for (const l of legsOf(o)) {
      const legFills = fills.filter(f => f.order_id === l.id);
      const kind = /stop/.test(l.type) ? 'وقف' : 'هدف';
      console.log(`      ↳ رجل ${kind} (${l.type}) · الحالة ${l.status} · ${l.stop_price ? 'stop ' + l.stop_price : 'limit ' + l.limit_price} · منفَّذ ${l.filled_qty} · تنفيذات بيع: ${legFills.length}` +
        (legFills.length ? ' → ' + legFills.map(f => `${f.qty}@${f.price} (${f.type})`).join('، ') : ''));
    }
  }
}

// تنفيذات بيع لا تتبع رجل bracket (إغلاق يدوي أو من الوكيل)
const legIds = new Set(allLegs.map(l => l.id));
const orphanSells = fills.filter(f => f.side !== 'buy' && !legIds.has(f.order_id));
if (orphanSells.length) {
  console.log(`\nتنفيذات بيع خارج أرجل bracket: ${orphanSells.length}`);
  orphanSells.forEach(f => console.log(`  • ${f.transaction_time} · ${f.qty}@${f.price} · order ${String(f.order_id).slice(0, 8)} (${f.type})`));
}

// الحكم
console.log('\n━━ النتيجة');
for (const day of DAYS) {
  const buys = orders.filter(o => o.side === 'buy' && nyDay(o.submitted_at) === day);
  const filledBuys = buys.filter(o => +o.filled_qty > 0);
  const sellFillCounts = filledBuys.map(o => legsOf(o).reduce((n, l) => n + fills.filter(f => f.order_id === l.id).length, 0));
  const verdict = filledBuys.length > 1 ? `🔁 ${filledBuys.length} أوامر شراء منفَّذة — شراء مكرر فعلاً`
    : filledBuys.length === 1 && sellFillCounts[0] > 1 ? `🧩 أمر شراء واحد، انباع على ${sellFillCounts[0]} دفعات — التكرار من العرض (closedTrades)`
    : filledBuys.length === 1 ? '✅ أمر شراء واحد وبيع بدفعة واحدة — التكرار ليس من هذا اليوم'
    : '⚠️ لا أمر شراء منفَّذ في هذا اليوم (تحقق من التاريخ أو الرمز)';
  console.log(`${day}: ${verdict}`);
}
