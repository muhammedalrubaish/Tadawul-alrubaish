// نقطة نهاية صفقات الوكيل — GET: حساب Alpaca والمراكز المفتوحة (بوقفها وهدفها) والأوامر المعلّقة والصفقات المغلقة
// بيانات الحساب حساسة: لا تُعرض إلا برمز AI_PASS (الرمز نفسه الذي يحمي المساعد)
const broker = require('./_broker');
const autotrade = require('./_autotrade');
const ai = require('./_ai');
const NAMES = require('./_names');

const PASS = String(process.env.AI_PASS || '').trim();
const n2 = v => +(+v || 0).toFixed(2);
const nameOf = sym => NAMES[sym] || sym;

// بناء الصفقات المغلقة من سجل التنفيذات: لكل بيع يُطابَق أقدم شراء لم يُغلق بعد (FIFO) في الرمز نفسه
function closedTrades(fills) {
  const asc = [...fills].filter(f => f && f.symbol && +f.qty > 0 && +f.price > 0)
    .sort((a, b) => Date.parse(a.transaction_time) - Date.parse(b.transaction_time));
  const lots = {}; // sym → [{qty, price, at}]
  const closed = [];
  for (const f of asc) {
    const sym = f.symbol, qty = +f.qty, price = +f.price, at = f.transaction_time;
    if (f.side === 'buy') { (lots[sym] = lots[sym] || []).push({ qty, price, at }); continue; }
    let left = qty, cost = 0, matched = 0, entryAt = null;
    while (left > 0 && lots[sym] && lots[sym].length) {
      const lot = lots[sym][0];
      const take = Math.min(lot.qty, left);
      cost += take * lot.price; matched += take; left -= take; lot.qty -= take;
      entryAt = entryAt || lot.at;
      if (lot.qty <= 0) lots[sym].shift();
    }
    if (matched > 0) {
      const entry = cost / matched;
      closed.push({ sym, name: nameOf(sym), qty: matched, entry: n2(entry), exit: n2(price), pl: n2((price - entry) * matched), plPct: n2((price / entry - 1) * 100), entryAt, exitAt: at });
    }
  }
  return closed.reverse();
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-rasad-pass');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET فقط' });

  if (!PASS) return res.status(403).json({ error: 'اضبط AI_PASS في إعدادات Vercel أولاً — بيانات حساب الوسيط لا تُعرض بلا رمز', needPass: true });
  if (String(req.headers['x-rasad-pass'] || '') !== PASS) return res.status(401).json({ error: 'رمز المساعد غير صحيح' });

  const c = autotrade.cfg();
  const base = { configured: broker.hasKeys(), paper: broker.PAPER, enabled: c.enabled, mode: c.mode, brain: ai.providerLabel(), limits: { maxPositionUsd: c.maxPositionUsd, maxOpenPositions: c.maxOpenPositions, maxDailyTrades: c.maxDailyTrades, dailyLossLimitUsd: c.dailyLossLimitUsd } };
  if (!base.configured) return res.status(200).json(base);

  try {
    // سجل التنفيذات ثانوي: فشله لا يُسقط الحساب والمراكز المفتوحة، بل يُعرض كتنبيه
    let fillsError = null;
    const [acc, positions, open, fills] = await Promise.all([
      broker.getAccount(), broker.getPositions(), broker.getOpenOrders(),
      broker.getFills(100).catch(e => { fillsError = String((e && e.message) || e); return []; })
    ]);
    // أرجل الوقف والهدف: أوامر بيع معلّقة على رمز مركز مفتوح
    const legs = {};
    (open || []).forEach(o => {
      if (o.side !== 'sell') return;
      const l = legs[o.symbol] = legs[o.symbol] || {};
      if (/stop/.test(o.type) && o.stop_price) l.sl = +o.stop_price;
      else if (o.type === 'limit' && o.limit_price) l.tp = +o.limit_price;
    });
    const pos = (positions || []).map(p => ({
      sym: p.symbol, name: nameOf(p.symbol), qty: +p.qty,
      entry: n2(p.avg_entry_price), price: n2(p.current_price), value: n2(p.market_value),
      pl: n2(p.unrealized_pl), plPct: n2((+p.unrealized_plpc || 0) * 100), today: n2((+p.change_today || 0) * 100),
      sl: (legs[p.symbol] || {}).sl || null, tp: (legs[p.symbol] || {}).tp || null
    }));
    const pending = (open || []).filter(o => o.side === 'buy').map(o => ({
      sym: o.symbol, name: nameOf(o.symbol), qty: +o.qty, type: o.type, limit: o.limit_price ? +o.limit_price : null,
      submittedAt: o.submitted_at, status: o.status
    }));
    const closed = closedTrades(fills || []);
    const wins = closed.filter(t => t.pl > 0).length;
    const realized = n2(closed.reduce((a, t) => a + t.pl, 0));
    const dailyPL = n2(+acc.equity - +acc.last_equity);
    return res.status(200).json({
      ...base,
      account: { equity: n2(acc.equity), lastEquity: n2(acc.last_equity), dailyPL, cash: n2(acc.cash), buyingPower: n2(acc.buying_power), blocked: !!(acc.trading_blocked || acc.account_blocked) },
      positions: pos, pending, closed: closed.slice(0, 30), fillsError,
      stats: { closed: closed.length, wins, losses: closed.length - wins, realized, unrealized: n2(pos.reduce((a, p) => a + p.pl, 0)) },
      at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(502).json({ ...base, error: String((e && e.message) || e) });
  }
};
