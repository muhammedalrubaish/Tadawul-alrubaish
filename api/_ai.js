// عقل الوكيل — استدعاء Claude عبر مكتبة Anthropic الرسمية مع حقن بيانات السوق الحية
const Anthropic = require('@anthropic-ai/sdk');
const { snapshot, NAMES } = require('./_market');

const MODEL = String(process.env.AI_MODEL || 'claude-opus-5').trim();
const EFFORT = String(process.env.AI_EFFORT || 'low').trim();
// جهد قرارات التداول أعلى افتراضياً: يُستدعى مرة يومياً ويقرر بمال
const TRADE_EFFORT = String(process.env.AI_TRADE_EFFORT || 'high').trim();
const hasKey = () => !!String(process.env.ANTHROPIC_API_KEY || '').trim();

const SYSTEM = `أنت «مساعد رصد» — وكيل مساعدة على قرار التداول داخل تطبيق رصد لمتداول فرد في السوقين السعودي (تداول) والأمريكي.

قواعدك الصارمة:
- أجب بالعربية الفصحى المبسطة وباختصار عملي. بلا Markdown ولا جداول — نص عادي وأسطر قصيرة، ويمكنك استخدام الرموز التعبيرية باعتدال.
- اعتمد حصراً على بيانات السوق الحية المرفقة في الرسالة. لا تختلق سعراً أو رقماً أبداً؛ إن لم يكن السهم في البيانات فقل ذلك صراحة واقترح البحث عنه في التطبيق.
- كن صارماً في إدارة المخاطر: اذكر دائماً وقف الخسارة قبل الهدف، وحذّر من المخاطرة بأكثر من 1-2٪ من المحفظة في الصفقة الواحدة، وانصح بعدم مطاردة الأسهم بعد ارتفاع حاد.
- درجة الفرصة (0-100) المرفقة تجمع الزخم والسيولة وموقع RSI: ‏72+ إشارة شراء، 50-71 مراقبة، أقل من 50 تجنُّب.
- لا تَعِد بأرباح ولا تستخدم لغة الجزم. اختم أي رأي بجملة قصيرة أن هذا ليس توصية استثمارية وأن القرار قرار المستخدم.
- إن أرفق المستخدم صفقاته المفتوحة فحلّلها مقابل الأسعار الحية: هل اقترب الوقف أو الهدف؟ وهل حجم المركز معقول؟`;

// اختيار مقتضب من اللقطة: أفضل 20 بالدرجة + أقوى 10 حركةً + أي سهم ذُكر في السؤال
function pickContext(list, question) {
  const q = String(question || '');
  const picked = new Map();
  const add = s => { if (s && !picked.has(s.sym)) picked.set(s.sym, s); };
  list.forEach(s => {
    if (q.includes(s.sym) || (s.name && q.includes(s.name))) add(s);
  });
  list.slice(0, 20).forEach(add);
  [...list].sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 10).forEach(add);
  return [...picked.values()];
}

const row = s => `${s.sym} ${s.name}: سعر ${s.price} تغير ${s.chg}% RSI ${s.rsi} سيولة ×${s.vol} درجة ${s.score}`;
const mktName = m => m === 'sa' ? 'السوق السعودي' : 'السوق الأمريكي';

// بناء كتلة البيانات الحية للسوقين (يتحمل فشل أحدهما)
// snapshots: لقطات مجلوبة مسبقاً {sa:list, us:list} لتفادي إعادة جلب مئات الأسعار
async function liveContext(question, snapshots = {}) {
  const parts = [];
  for (const m of ['sa', 'us']) {
    try {
      const list = snapshots[m] || await snapshot(m);
      const sel = pickContext(list, question);
      parts.push(`[${mktName(m)} — ${list.length} سهماً مفحوصاً، مختارات:]\n` + sel.map(row).join('\n'));
    } catch (e) {
      parts.push(`[تعذّر جلب أسعار ${mktName(m)}: ${e.message}]`);
    }
  }
  return parts.join('\n\n');
}

function textOf(resp) {
  if (resp.stop_reason === 'refusal') throw new Error('اعتذر المساعد عن هذا الطلب');
  if (resp.stop_reason === 'max_tokens') throw new Error('الإجابة تجاوزت الحد الأقصى للطول');
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('وصلت إجابة فارغة');
  return text;
}

// سؤال المساعد: يعيد نص الإجابة
async function ask({ question, history = [], portfolio = [], snapshots }) {
  if (!hasKey()) throw Object.assign(new Error('ANTHROPIC_API_KEY غير مضبوط في إعدادات Vercel'), { code: 'NO_KEY' });
  const client = new Anthropic();

  const ctx = await liveContext(question, snapshots);
  let userMsg = `بيانات السوق الحية الآن (${new Date().toISOString().slice(0, 16)} UTC):\n${ctx}`;
  if (Array.isArray(portfolio) && portfolio.length) {
    const pf = portfolio.slice(0, 20).map(t =>
      `${t.sym} ${NAMES[t.sym] || ''}: كمية ${t.qty} دخول ${t.entry}${t.sl ? ' وقف ' + t.sl : ''}${t.tp ? ' هدف ' + t.tp : ''}`).join('\n');
    userMsg += `\n\n[صفقات المستخدم المفتوحة:]\n${pf}`;
  }
  userMsg += `\n\nسؤال المستخدم: ${question}`;

  // آخر جولات المحادثة (مُتحقق من أدوارها) ثم الرسالة الحاملة للبيانات
  const msgs = (Array.isArray(history) ? history : [])
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-6)
    .map(h => ({ role: h.role, content: h.content.slice(0, 2000) }));
  msgs.push({ role: 'user', content: userMsg });

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    thinking: { type: 'adaptive' },
    // «low» يوازن سرعة الرد مع جودة تناسب المحادثة؛ يُرفع بمتغير AI_EFFORT (medium/high) عند الحاجة
    output_config: { effort: EFFORT },
    system: SYSTEM,
    messages: msgs
  });
  return textOf(resp);
}

/* ========= قرارات التداول الآلي (مخرجات مهيكلة) ========= */
const DECIDE_SYSTEM = `أنت مدير محفظة آلي لحساب تداول أمريكي صغير لمتداول فرد. مهمتك اختيار صفقات شراء اليوم من قائمة مرشّحين محددة، أو الامتناع.

القواعد الملزمة:
- اشترِ فقط من قائمة المرشّحين المرفقة، ولا تخترع رمزاً خارجها. لا تشترِ سهماً مملوكاً بالفعل.
- الأصل هو الامتناع: لا تشترِ إلا إذا اجتمعت قوة سعرية معقولة وسيولة أعلى من المتوسط وRSI غير متشبع شرائياً (فوق 75 = مطاردة). سهم ارتفع أكثر من 5٪ اليوم يُعد مطاردة ما لم تكن السيولة استثنائية.
- لكل قرار شراء حدّد وقف الخسارة كنسبة سالبة من الدخول (بين 2 و8) وهدف الربح كنسبة موجبة (بين 3 و20)، بحيث يكون الهدف 1.5 ضعف الوقف على الأقل. اجعل الوقف تحت أقرب دعم منطقي لا رقماً عشوائياً.
- confidence من 0 إلى 100 يعبّر عن جودة الفرصة مقارنة بالبديل (عدم التداول). لا تعطِ فوق 70 إلا لفرصة واضحة.
- التنويع: لا تختر أكثر من سهمين من القطاع نفسه في اليوم الواحد. راعِ المراكز المفتوحة الحالية.
- في السوق الهابط عموماً (أغلب المرشّحين سالبون) امتنع كلياً ووضّح السبب في market_view.
- close: يُسمح به فقط لمركز مفتوح مذكور، وفقط إذا انهار منطقه (لا لمجرد تذبذب بسيط). إن لم يُسمح بالبيع في الرسالة فلا تُخرج close.
- reason: جملة أو جملتان بالعربية، مبنيتان على الأرقام المرفقة فقط. market_view: قراءة عامة في 3 جمل كحد أقصى.
- أخرج قراراً لكل مرشّح تراه جديراً بالذكر (buy أو skip)، ولا يلزم ذكر كل المرشّحين. الحدود النهائية (عدد الصفقات، حجمها) يطبّقها النظام بعدك.`;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    market_view: { type: 'string', description: 'قراءة عامة للسوق اليوم بالعربية (3 جمل كحد أقصى)' },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sym: { type: 'string', description: 'رمز السهم كما ورد في القائمة' },
          action: { type: 'string', enum: ['buy', 'skip', 'close'] },
          confidence: { type: 'integer', description: '0-100' },
          stop_loss_pct: { type: 'number', description: 'نسبة وقف الخسارة تحت الدخول (2 إلى 8). صفر لغير الشراء' },
          take_profit_pct: { type: 'number', description: 'نسبة الهدف فوق الدخول (3 إلى 20). صفر لغير الشراء' },
          reason: { type: 'string', description: 'سبب القرار بالعربية' }
        },
        required: ['sym', 'action', 'confidence', 'stop_loss_pct', 'take_profit_pct', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['market_view', 'decisions'],
  additionalProperties: false
};

// طلب قرارات شراء من Claude: يعيد {market_view, decisions[]} — التحقق من الحدود يتم في _autotrade.js
async function decide({ candidates, positions, account, limits, canSell }) {
  if (!hasKey()) throw Object.assign(new Error('ANTHROPIC_API_KEY غير مضبوط في إعدادات Vercel'), { code: 'NO_KEY' });
  const client = new Anthropic();

  const cand = candidates.map(s => `${s.sym} (${s.name}${s.sector ? ' · ' + s.sector : ''}): سعر ${s.price} تغير اليوم ${s.chg}% RSI ${s.rsi} سيولة ×${s.vol} درجة ${s.score}`).join('\n');
  const pos = positions.length
    ? positions.map(p => `${p.symbol}: ${p.qty} سهم · متوسط الدخول ${(+p.avg_entry_price).toFixed(2)} · الحالي ${(+p.current_price).toFixed(2)} · ربح/خسارة ${((+p.unrealized_plpc) * 100).toFixed(2)}%`).join('\n')
    : 'لا مراكز مفتوحة.';
  const dailyPL = +account.equity - +account.last_equity;
  const userMsg =
    `التاريخ والوقت: ${new Date().toISOString().slice(0, 16)} UTC (قبل افتتاح وول ستريت غالباً؛ الأسعار أدناه آخر تداول)\n\n` +
    `[الحساب] حقوق الملكية ${(+account.equity).toFixed(2)}$ · قوة شرائية ${(+account.buying_power).toFixed(2)}$ · ربح/خسارة اليوم ${dailyPL.toFixed(2)}$\n` +
    `[الحدود التي سيطبقها النظام] حجم الصفقة ≤ ${limits.maxPositionUsd}$ · صفقات جديدة مسموحة اليوم: ${limits.budget} · الحد الأدنى للثقة ${limits.minConfidence}\n` +
    `[البيع] ${canSell ? 'مسموح إغلاق مركز مفتوح بقرار close' : 'غير مسموح — لا تُخرج close'}\n\n` +
    `[المراكز المفتوحة]\n${pos}\n\n` +
    `[المرشّحون للشراء — ${candidates.length} سهماً مرتبين بدرجة الفرصة]\n${cand}\n\n` +
    `قرّر الآن.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: TRADE_EFFORT, format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    system: DECIDE_SYSTEM,
    messages: [{ role: 'user', content: userMsg }]
  });
  const text = textOf(resp);
  let out;
  try { out = JSON.parse(text); } catch (e) { throw new Error('تعذّر قراءة قرارات الوكيل (JSON غير صالح)'); }
  if (!out || !Array.isArray(out.decisions)) throw new Error('قرارات الوكيل ناقصة البنية');
  return out;
}

module.exports = { ask, decide, hasKey, MODEL };
