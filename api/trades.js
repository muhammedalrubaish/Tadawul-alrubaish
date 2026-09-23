// نقطة نهاية صفقات الوكيل — GET: حساب Alpaca والمراكز المفتوحة (بوقفها وهدفها) والأوامر المعلّقة والصفقات المغلقة
// بيانات الحساب حساسة: لا تُعرض إلا برمز AI_PASS (الرمز نفسه الذي يحمي المساعد)
const broker = require('./_broker');
const autotrade = require('./_autotrade');
const ai = require('./_ai');
const NAMES = require('./_names');
const { snapshot } = require('./_market');
const tg = require('./_telegram');

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

/* ========= تقرير الفعالية: الوكيل مقابل السوق (SPY) بمعايير محددة مسبقاً ========= */
const YH_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const nyDay = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

// شموع SPY اليومية (افتتاح/إغلاق) لآخر 6 أشهر — معيار المقارنة: «لو اشتريت السوق كله بدل سهم الوكيل»
async function spyBars() {
  for (const host of YH_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/SPY?interval=1d&range=6mo`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RasadBot/1.0)' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      const r0 = d && d.chart && d.chart.result && d.chart.result[0];
      const q = (r0 && r0.indicators && r0.indicators.quote && r0.indicators.quote[0]) || {};
      const bars = (r0.timestamp || []).map((t, i) => ({ d: nyDay(t * 1000), o: +q.open[i], c: +q.close[i] })).filter(b => b.o > 0 && b.c > 0);
      const last = r0.meta && +r0.meta.regularMarketPrice;
      if (bars.length) return { bars, last: last > 0 ? last : bars[bars.length - 1].c };
    } catch (_) { /* المضيف التالي */ }
  }
  return null;
}
// عائد SPY من افتتاح يوم الدخول حتى إغلاق يوم الخروج (أو السعر الحالي للمراكز المفتوحة) — تقريبي على مستوى اليوم
function spyReturn(spy, entryAt, exitAt) {
  if (!spy || !entryAt) return null;
  const eDay = nyDay(entryAt);
  const entryBar = spy.bars.find(b => b.d >= eDay);
  if (!entryBar) return null;
  let exitPx = spy.last;
  if (exitAt) {
    const xDay = nyDay(exitAt);
    const before = spy.bars.filter(b => b.d <= xDay);
    if (!before.length) return null;
    exitPx = before[before.length - 1].c;
  }
  return (exitPx / entryBar.o - 1) * 100;
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

// المعايير محددة قبل بدء التجربة كي لا تُفصَّل على النتيجة بعدها
const CRITERIA = { days: 30, minTrades: 10, minAvgRet: 0.15, minProfitFactor: 1.2 };
function buildPerf(closed, positions, fills, spy) {
  const buys = (fills || []).filter(f => f.side === 'buy').map(f => Date.parse(f.transaction_time)).filter(Number.isFinite);
  const startedAt = buys.length ? new Date(Math.min(...buys)).toISOString() : null;
  const days = startedAt ? Math.floor((Date.now() - Date.parse(startedAt)) / 864e5) : 0;
  const rows = closed.map(t => { const sp = spyReturn(spy, t.entryAt, t.exitAt); return { ret: t.plPct, spy: sp, alpha: sp == null ? null : t.plPct - sp, pl: t.pl }; });
  const withSpy = rows.filter(r => r.alpha != null);
  const gains = rows.filter(r => r.pl > 0).reduce((a, r) => a + r.pl, 0);
  const losses = Math.abs(rows.filter(r => r.pl < 0).reduce((a, r) => a + r.pl, 0));
  const n = rows.length;
  const avgRet = avg(rows.map(r => r.ret));
  const avgAlpha = avg(withSpy.map(r => r.alpha));
  const pf = losses > 0 ? gains / losses : (gains > 0 ? Infinity : null);
  const r2 = v => v == null || !Number.isFinite(v) ? v : +v.toFixed(2);
  const checks = [
    { key: 'days', label: `مدة التجربة ${CRITERIA.days} يوماً على الأقل`, value: `${days} يوماً`, ok: days >= CRITERIA.days },
    { key: 'sample', label: `${CRITERIA.minTrades} صفقات مغلقة على الأقل`, value: `${n} صفقة`, ok: n >= CRITERIA.minTrades },
    { key: 'expectancy', label: `متوسط ربح الصفقة فوق ${CRITERIA.minAvgRet}٪ (يغطي الانزلاق)`, value: avgRet == null ? '—' : `${r2(avgRet)}٪`, ok: avgRet != null && avgRet > CRITERIA.minAvgRet },
    { key: 'alpha', label: 'يتفوق على شراء السوق (SPY) لنفس الأيام', value: avgAlpha == null ? '—' : `${avgAlpha >= 0 ? '+' : ''}${r2(avgAlpha)}٪ للصفقة`, ok: avgAlpha != null && avgAlpha > 0 },
    { key: 'pf', label: `مجموع الأرباح ÷ مجموع الخسائر ≥ ${CRITERIA.minProfitFactor}`, value: pf == null ? '—' : pf === Infinity ? 'بلا خسائر' : String(r2(pf)), ok: pf != null && pf >= CRITERIA.minProfitFactor }
  ];
  const ready = checks[0].ok && checks[1].ok;
  const verdict = !startedAt ? 'not_started' : !ready ? 'running' : checks.every(c => c.ok) ? 'convincing' : 'not_convincing';
  const openAlpha = avg(positions.map(p => { const sp = spyReturn(spy, p.entryAt, null); return sp == null ? null : p.plPct - sp; }).filter(v => v != null));
  return {
    startedAt, days, target: CRITERIA.days, closed: n, winRate: n ? Math.round(rows.filter(r => r.pl > 0).length / n * 100) : null,
    avgRet: r2(avgRet), avgSpy: r2(avg(withSpy.map(r => r.spy))), avgAlpha: r2(avgAlpha), profitFactor: pf === Infinity ? 'inf' : r2(pf),
    openAlpha: r2(openAlpha), spyOk: !!spy, checks, verdict
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-rasad-pass');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET أو POST فقط' });

  if (!PASS) return res.status(403).json({ error: 'اضبط AI_PASS في إعدادات Vercel أولاً — بيانات حساب الوسيط لا تُعرض بلا رمز', needPass: true });
  if (String(req.headers['x-rasad-pass'] || '') !== PASS) return res.status(401).json({ error: 'رمز المساعد غير صحيح' });

  const c = autotrade.cfg();
  const base = {
    configured: broker.hasKeys(), paper: broker.PAPER, enabled: c.enabled, mode: c.mode, brain: ai.providerLabel(),
    // قائمة جاهزية التفعيل تُعرض في التطبيق
    ready: { aiKey: ai.hasKey(), aiKeyName: ai.keyName(), cron: !!String(process.env.CRON_SECRET || '').trim(), telegram: !!(tg.TOKEN && tg.CHAT) },
    limits: { maxPositionUsd: c.maxPositionUsd, maxOpenPositions: c.maxOpenPositions, maxDailyTrades: c.maxDailyTrades, dailyLossLimitUsd: c.dailyLossLimitUsd }
  };
  if (!base.configured) return res.status(200).json(base);

  // POST {action:'preview'|'run'}: معاينة قرار الوكيل بلا تنفيذ، أو دورة فعلية فورية (تتطلب AUTOTRADE_ENABLED)
  if (req.method === 'POST') {
    const action = String((req.body || {}).action || '');
    if (action !== 'preview' && action !== 'run') return res.status(400).json({ error: 'action يجب أن يكون preview أو run' });
    if (action === 'run' && !c.enabled) return res.status(409).json({ error: 'التنفيذ متوقف — اضبط AUTOTRADE_ENABLED=true في Vercel وأعد النشر أولاً' });
    try {
      const list = await snapshot('us');
      const r = await autotrade.runCycle(list, { dry: action === 'preview' });
      // الدورة الفعلية تُبلَّغ في تيليجرام أيضاً ليبقى سجلها في مكان واحد
      if (action === 'run' && tg.TOKEN && tg.CHAT) { try { await tg.send(tg.CHAT, autotrade.fmtCycle(r)); } catch (_) {} }
      return res.status(200).json({ ok: true, action, result: r });
    } catch (e) {
      return res.status(502).json({ error: 'لم يُنفَّذ أي أمر: ' + String((e && e.message) || e) });
    }
  }

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
    // تاريخ دخول كل مركز مفتوح = أقدم شراء لم يُغلق بعد (لمقارنته بالسوق من اليوم نفسه)
    const openLots = {};
    [...(fills || [])].filter(f => f && f.symbol).sort((a, b) => Date.parse(a.transaction_time) - Date.parse(b.transaction_time)).forEach(f => {
      const L = openLots[f.symbol] = openLots[f.symbol] || [];
      if (f.side === 'buy') L.push({ qty: +f.qty, at: f.transaction_time });
      else { let left = +f.qty; while (left > 0 && L.length) { const t = Math.min(L[0].qty, left); L[0].qty -= t; left -= t; if (L[0].qty <= 0) L.shift(); } }
    });
    pos.forEach(p => { const L = openLots[p.sym]; p.entryAt = L && L.length ? L[0].at : null; });
    let perf = null;
    try { perf = buildPerf(closed, pos, fills, await spyBars()); } catch (_) { perf = null; }
    const wins = closed.filter(t => t.pl > 0).length;
    const realized = n2(closed.reduce((a, t) => a + t.pl, 0));
    const dailyPL = n2(+acc.equity - +acc.last_equity);
    return res.status(200).json({
      ...base,
      account: { equity: n2(acc.equity), lastEquity: n2(acc.last_equity), dailyPL, cash: n2(acc.cash), buyingPower: n2(acc.buying_power), blocked: !!(acc.trading_blocked || acc.account_blocked) },
      positions: pos, pending, closed: closed.slice(0, 30), fillsError, perf,
      stats: { closed: closed.length, wins, losses: closed.length - wins, realized, unrealized: n2(pos.reduce((a, p) => a + p.pl, 0)) },
      at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(502).json({ ...base, error: String((e && e.message) || e) });
  }
};

module.exports.buildPerf = buildPerf;
module.exports.closedTrades = closedTrades;
