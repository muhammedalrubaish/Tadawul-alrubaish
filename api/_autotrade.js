// منطق التداول الآلي — السوق الأمريكي فقط، ضمن حدود صارمة مضبوطة بمتغيرات بيئة
// مبدأ الأمان: كل حد أقصى يُقرأ من البيئة بقيمة افتراضية متحفظة، والمفتاح الرئيسي (AUTOTRADE_ENABLED)
// يجب ضبطه صراحة إلى "true" وإلا فالتداول متوقف تماماً. الوقف والهدف يُنفَّذان من الوسيط نفسه (bracket order).
// وضعان: «ai» يقرر Claude من قائمة مرشّحين (الافتراضي عند وجود ANTHROPIC_API_KEY) · «rules» معادلة الدرجة فقط
const broker = require('./_broker');
const ai = require('./_ai');
const { plan, esc } = require('./_market');
const SECTORS = require('./_sectors');

const num = (v, d) => { const n = +v; return Number.isFinite(n) && n > 0 ? n : d; };
const flag = (v, d) => { const s = String(v == null ? '' : v).trim().toLowerCase(); return s ? s === 'true' : d; };
const cfg = () => {
  const modeEnv = String(process.env.AUTOTRADE_MODE || '').trim().toLowerCase();
  return {
    enabled: flag(process.env.AUTOTRADE_ENABLED, false),
    mode: modeEnv === 'rules' || modeEnv === 'ai' ? modeEnv : (ai.hasKey() ? 'ai' : 'rules'),
    maxPositionUsd: num(process.env.AUTOTRADE_MAX_POSITION_USD, 200),
    maxOpenPositions: num(process.env.AUTOTRADE_MAX_OPEN_POSITIONS, 5),
    maxDailyTrades: num(process.env.AUTOTRADE_MAX_DAILY_TRADES, 3),
    dailyLossLimitUsd: num(process.env.AUTOTRADE_DAILY_LOSS_LIMIT_USD, 100),
    minScore: num(process.env.AUTOTRADE_MIN_SCORE, 72),
    // وضع ai: حد أدنى لدرجة الفرصة لدخول قائمة المرشّحين + حد أدنى لثقة الوكيل + حجم القائمة
    aiPoolScore: num(process.env.AUTOTRADE_AI_POOL_SCORE, 50),
    aiPoolSize: num(process.env.AUTOTRADE_AI_POOL_SIZE, 25),
    minConfidence: num(process.env.AUTOTRADE_AI_MIN_CONFIDENCE, 70),
    aiCanSell: flag(process.env.AUTOTRADE_AI_CAN_SELL, false),
    // أقصى انزلاق مقبول للدخول ٪ فوق آخر سعر معروف (أمر بحد سعري: لا نطارد الفجوات الصاعدة)
    maxSlippagePct: num(process.env.AUTOTRADE_MAX_SLIPPAGE_PCT, 1)
  };
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// تحويل قرار الوكيل إلى خطة أسعار مُتحقَّق منها ضمن الحدود (وقف 2–8٪ · هدف 3–20٪ · هدف ≥ 1.5× الوقف)
function planFromDecision(price, d) {
  const slPct = clamp(+d.stop_loss_pct || 3.5, 2, 8);
  const tpPct = clamp(Math.max(+d.take_profit_pct || 0, slPct * 1.5), 3, 20);
  return { sl: price * (1 - slPct / 100), tp1: price * (1 + tpPct / 100), slPct, tpPct };
}

// دورة تداول واحدة: تُستدعى من الكرون اليومي للسوق الأمريكي بعد جلب لقطة الأسعار
// list: لقطة السوق الأمريكي (نفس المستخدمة في الملخص اليومي) — لا نداء شبكي إضافي
// dry=true: يُعيد ما كان سيفعله الوكيل دون إرسال أي أمر (لا يشترط AUTOTRADE_ENABLED)
async function runCycle(list, { dry = false } = {}) {
  const c = cfg();
  if (!dry && !c.enabled) return { skipped: 'AUTOTRADE_ENABLED ليس true — التداول الآلي متوقف' };
  if (!broker.hasKeys()) return { skipped: 'ALPACA_KEY/ALPACA_SECRET غير مضبوطين' };
  if (c.mode === 'ai' && !ai.hasKey()) return { skipped: 'AUTOTRADE_MODE=ai يتطلب ANTHROPIC_API_KEY' };

  const account = await broker.getAccount();
  if (account.trading_blocked || account.account_blocked) {
    return { skipped: 'الحساب موقوف لدى الوسيط (trading_blocked/account_blocked)' };
  }
  if (!dry && !(await broker.marketOpensToday())) return { skipped: 'السوق الأمريكي لا يفتح اليوم (عطلة رسمية)' };

  // قاطع الدائرة: خسارة اليوم (تغيّر حقوق الملكية منذ إغلاق الأمس) تتجاوز الحد المسموح
  const dailyPL = +account.equity - +account.last_equity;
  if (dailyPL <= -c.dailyLossLimitUsd) {
    return { stopped: 'daily_loss_limit', dailyPL: +dailyPL.toFixed(2), limit: c.dailyLossLimitUsd, notify: true };
  }

  // أوامر شراء معلّقة من دورات سابقة لم تُنفَّذ (السعر تجاوز حدّنا): تُلغى إن قدُمت أكثر من ساعة
  const openBuys = await broker.getOpenBuyOrders();
  const cancelled = [];
  for (const o of openBuys) {
    if (Date.now() - Date.parse(o.submitted_at) > 3600e3) {
      if (!dry) { try { await broker.cancelOrder(o.id); cancelled.push(o.symbol); } catch (_) {} }
      else cancelled.push(o.symbol);
    }
  }
  const pendingSyms = new Set(openBuys.filter(o => !cancelled.includes(o.symbol)).map(o => o.symbol));

  const positions = await broker.getPositions();
  const exposure = positions.length + pendingSyms.size;
  if (exposure >= c.maxOpenPositions) {
    return { skipped: 'max_open_positions', count: exposure, limit: c.maxOpenPositions };
  }

  const todayBuys = await broker.getTodayFilledBuyOrders();
  if (todayBuys.length + pendingSyms.size >= c.maxDailyTrades) {
    return { skipped: 'max_daily_trades', count: todayBuys.length + pendingSyms.size, limit: c.maxDailyTrades };
  }

  const held = new Set([...positions.map(p => p.symbol), ...pendingSyms]);
  const budget = Math.max(0, Math.min(c.maxOpenPositions - exposure, c.maxDailyTrades - todayBuys.length - pendingSyms.size));

  // اختيار المرشّحين: وضع القواعد يشتري أعلى الدرجات مباشرة؛ وضع الذكاء يعرض قائمة أوسع على Claude ليقرر
  let picks = [], closes = [], marketView = '', aiDecisions = [];
  if (c.mode === 'rules') {
    picks = list.filter(s => s.score >= c.minScore && !held.has(s.sym)).slice(0, budget)
      .map(s => ({ s, ...plan(s.price), reason: `درجة ${s.score} ≥ ${c.minScore}`, confidence: s.score }));
  } else {
    const pool = list.filter(s => s.score >= c.aiPoolScore && !held.has(s.sym)).slice(0, c.aiPoolSize)
      .map(s => ({ ...s, sector: SECTORS[s.sym] || '' }));
    if (!pool.length) return { skipped: `لا مرشّحين بدرجة ≥ ${c.aiPoolScore} اليوم`, mode: c.mode };
    const out = await ai.decide({
      candidates: pool, positions, account, canSell: c.aiCanSell,
      limits: { maxPositionUsd: c.maxPositionUsd, budget, minConfidence: c.minConfidence }
    });
    marketView = String(out.market_view || '').slice(0, 600);
    aiDecisions = out.decisions;
    const bySym = new Map(pool.map(s => [s.sym, s]));
    picks = aiDecisions
      .filter(d => d.action === 'buy' && bySym.has(d.sym) && +d.confidence >= c.minConfidence)
      .sort((a, b) => +b.confidence - +a.confidence)
      .filter((d, i, arr) => arr.findIndex(x => x.sym === d.sym) === i)
      .slice(0, budget)
      .map(d => { const s = bySym.get(d.sym); return { s, ...planFromDecision(s.price, d), reason: String(d.reason || ''), confidence: +d.confidence }; });
    if (c.aiCanSell) {
      const heldSyms = new Set(positions.map(p => p.symbol));
      closes = aiDecisions.filter(d => d.action === 'close' && heldSyms.has(d.sym) && +d.confidence >= c.minConfidence)
        .map(d => ({ sym: d.sym, reason: String(d.reason || '') }));
    }
  }

  const executed = [], failed = [], closed = [];
  for (const p of picks) {
    const s = p.s;
    const limit = s.price * (1 + c.maxSlippagePct / 100);
    const qty = Math.floor(c.maxPositionUsd / limit);
    if (qty < 1) { failed.push({ sym: s.sym, error: 'سعر السهم أعلى من الحد الأقصى للصفقة (AUTOTRADE_MAX_POSITION_USD)' }); continue; }
    const rec = { sym: s.sym, name: s.name, qty, price: s.price, limit: +limit.toFixed(2), tp: p.tp1, sl: p.sl, score: s.score, confidence: p.confidence, reason: p.reason };
    if (dry) { executed.push(rec); continue; }
    try {
      const order = await broker.submitBracketOrder({ symbol: s.sym, qty, tp: p.tp1, sl: p.sl, limit });
      executed.push({ ...rec, orderId: order.id });
    } catch (e) {
      failed.push({ sym: s.sym, error: e.message });
    }
  }
  for (const cl of closes) {
    if (dry) { closed.push(cl); continue; }
    try { await broker.closePosition(cl.sym); closed.push(cl); }
    catch (e) { failed.push({ sym: cl.sym, error: 'إغلاق: ' + e.message }); }
  }
  return {
    ok: true, dry, mode: c.mode, paper: broker.PAPER, marketView, executed, closed, failed, cancelled,
    considered: aiDecisions.filter(d => !(d.action === 'buy' && executed.some(e => e.sym === d.sym)) && !(d.action === 'close' && closed.some(x => x.sym === d.sym))).slice(0, 8),
    dailyPL: +dailyPL.toFixed(2), budget
  };
}

// نص إشعار تيليجرام لنتيجة الدورة
function fmtCycle(r) {
  if (r.skipped) return `🤖 التداول الآلي: تخطّي هذه الدورة — ${esc(String(r.skipped))}`;
  if (r.stopped === 'daily_loss_limit') return `🛑 <b>توقف تلقائي</b>: خسارة اليوم ${r.dailyPL}$ تجاوزت الحد ${r.limit}$ — لن تُفتح صفقات جديدة اليوم.`;
  const mode = r.paper ? '(حساب تجريبي 🧪)' : '(حساب حقيقي 💰)';
  const brain = r.mode === 'ai' ? '🧠 قرار Claude' : '📐 قواعد الدرجة';
  const lines = [`🤖 <b>${r.dry ? 'معاينة قرار الوكيل — بلا تنفيذ' : 'دورة التداول الآلي'}</b> ${mode} · ${brain}`];
  if (r.marketView) lines.push(`📊 ${esc(r.marketView)}`);
  if (r.executed.length) {
    lines.push(...r.executed.map(e =>
      `🟢 ${r.dry ? 'كان سيشتري' : 'أمر شراء'}: <b>${esc(e.name)}</b> <code>${e.sym}</code> — ${e.qty} سهماً بحد ${e.limit}$ (آخر سعر ${e.price}) · هدف ${e.tp.toFixed(2)} · وقف ${e.sl.toFixed(2)} · ثقة ${e.confidence}` +
      (e.reason ? `\n   ↳ ${esc(e.reason)}` : '')));
  } else lines.push('لا صفقات جديدة اليوم — لم تستوفِ أي فرصة الشروط.');
  if (r.closed && r.closed.length) lines.push(...r.closed.map(x => `🔻 ${r.dry ? 'كان سيغلق' : 'إغلاق'} <code>${x.sym}</code>${x.reason ? ' — ' + esc(x.reason) : ''}`));
  if (r.considered && r.considered.length) {
    lines.push('', '<b>مرشّحون استُبعدوا:</b>', ...r.considered.map(d => `• <code>${esc(d.sym)}</code> (${esc(d.action)} · ثقة ${d.confidence}) — ${esc(String(d.reason || '').slice(0, 160))}`));
  }
  if (r.cancelled && r.cancelled.length) lines.push(`↩️ ${r.dry ? 'كانت ستُلغى' : 'أُلغيت'} أوامر شراء قديمة لم تُنفَّذ: ${r.cancelled.map(esc).join('، ')}`);
  if (r.failed && r.failed.length) lines.push(...r.failed.map(f => `⚠️ فشل ${esc(f.sym)}: ${esc(f.error)}`));
  lines.push(`ربح/خسارة اليوم: ${r.dailyPL >= 0 ? '+' : ''}${r.dailyPL}$`);
  return lines.join('\n');
}

module.exports = { runCycle, fmtCycle, cfg };
