// عقل الوكيل — مزوّدان للذكاء الاصطناعي مع حقن بيانات السوق الحية:
// DeepSeek (واجهته الأصلية بصيغة chat/completions) أو Claude (مكتبة Anthropic الرسمية)
// الاختيار: AI_PROVIDER=deepseek|anthropic صراحةً، وإلا تلقائياً حسب المفتاح المضبوط (Anthropic أولاً إن وُجد المفتاحان)
const Anthropic = require('@anthropic-ai/sdk');
const { snapshot, NAMES } = require('./_market');

const env = k => String(process.env[k] || '').trim();
const EFFORT = env('AI_EFFORT') || 'low';
// جهد قرارات التداول أعلى افتراضياً (Claude فقط): يُستدعى مرة يومياً ويقرر بمال
const TRADE_EFFORT = env('AI_TRADE_EFFORT') || 'high';

function provider() {
  const p = env('AI_PROVIDER').toLowerCase();
  if (p === 'deepseek' || p === 'anthropic') return p;
  if (env('DEEPSEEK_API_KEY') && !env('ANTHROPIC_API_KEY')) return 'deepseek';
  return 'anthropic';
}
const isDeepSeek = () => provider() === 'deepseek';
const keyName = () => isDeepSeek() ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY';
const hasKey = () => !!env(keyName());
const modelName = () => isDeepSeek() ? (env('DEEPSEEK_MODEL') || 'deepseek-chat') : (env('AI_MODEL') || 'claude-opus-5');
const providerLabel = () => isDeepSeek() ? 'DeepSeek' : 'Claude';
const noKey = () => Object.assign(new Error(`${keyName()} غير مضبوط في إعدادات Vercel`), { code: 'NO_KEY' });

const SYSTEM = `أنت «مساعد رصد» — وكيل مساعدة على قرار التداول داخل تطبيق رصد لمتداول فرد في السوقين السعودي (تداول) والأمريكي.

قواعدك الصارمة:
- أجب بالعربية الفصحى المبسطة وباختصار عملي. بلا Markdown ولا جداول — نص عادي وأسطر قصيرة، ويمكنك استخدام الرموز التعبيرية باعتدال.
- اعتمد حصراً على بيانات السوق الحية المرفقة في الرسالة. لا تختلق سعراً أو رقماً أبداً؛ إن لم يكن السهم في البيانات فقل ذلك صراحة واقترح البحث عنه في التطبيق.
- كن صارماً في إدارة المخاطر: اذكر دائماً وقف الخسارة قبل الهدف، وحذّر من المخاطرة بأكثر من 1-2٪ من المحفظة في الصفقة الواحدة، وانصح بعدم مطاردة الأسهم بعد ارتفاع حاد.
- درجة الفرصة (0-100) المرفقة تجمع الزخم والسيولة وموقع RSI: ‏72+ إشارة شراء، 50-71 مراقبة، أقل من 50 تجنُّب.
- لا تَعِد بأرباح ولا تستخدم لغة الجزم. اختم أي رأي بجملة قصيرة أن هذا ليس توصية استثمارية وأن القرار قرار المستخدم.
- إن أرفق المستخدم صفقاته المفتوحة فحلّلها مقابل الأسعار الحية: هل اقترب الوقف أو الهدف؟ وهل حجم المركز معقول؟`;

// توحيد الكتابة العربية للمطابقة: حذف التشكيل والتطويل، توحيد الهمزات والتاء المربوطة والألف المقصورة، وحذف «ال» في أول الكلمة
const normAr = t => String(t || '')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .toLowerCase();
const words = t => normAr(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w.replace(/^ال(?=..)/, ''));
// كلمات عامة لا تميّز شركة بعينها (تتكرر في أسماء كثيرة أو في صياغة الأسئلة)
const STOP = new Set(['سعوديه', 'سعودي', 'بنك', 'مصرف', 'شركه', 'عربيه', 'عربي', 'وطنيه', 'قابضه', 'اسمنت', 'تامين', 'للتامين', 'سوق', 'اسواق', 'سهم', 'اسهم', 'صناعه', 'صناعيه', 'مياه', 'خدمات', 'وقت']);
// هل ذُكر السهم في السؤال؟ برمزه كلمةً مستقلة (AAPL · aapl · 2222) أو بأي كلمة مميزة من اسمه (ارامكو · الراجحي)
function mentioned(s, qWords, qUpper) {
  const sym = String(s.sym).toUpperCase().replace(/[.\-]/g, '\\$&');
  // الرموز الأمريكية من حرف أو حرفين (C, F, V, MA) تُقبل فقط بحروف كبيرة كي لا تطابق كلمات إنجليزية عادية
  const re = new RegExp(`(^|[^A-Z0-9])${sym}($|[^A-Z0-9])`, s.sym.length <= 2 ? '' : 'i');
  if (re.test(s.sym.length <= 2 ? qUpper.raw : qUpper.up)) return true;
  const nw = words(s.name);
  if (nw.some(w => w.length >= 3 && !STOP.has(w) && qWords.has(w))) return true;
  // الاسم كاملاً كعبارة: لأسماء كلماتها عامة أو قصيرة (البنك العربي · إس تي سي · آي بي إم)
  return nw.length > 0 && qUpper.phrase.includes(' ' + nw.join(' ') + ' ');
}

// اختيار مقتضب من اللقطة: أفضل 20 بالدرجة + أقوى 10 حركةً + أي سهم ذُكر في السؤال
function pickContext(list, question) {
  const q = String(question || '');
  const qWords = new Set(words(q));
  const qUpper = { raw: q, up: q.toUpperCase(), phrase: ' ' + words(q).join(' ') + ' ' };
  const picked = new Map();
  const add = s => { if (s && !picked.has(s.sym)) picked.set(s.sym, s); };
  list.forEach(s => { if (mentioned(s, qWords, qUpper)) add(s); });
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

/* ========= مزوّد Claude ========= */
async function claudeText({ system, messages, maxTokens, effort, schema }) {
  const client = new Anthropic();
  const output_config = { effort };
  if (schema) output_config.format = { type: 'json_schema', schema };
  const resp = await client.messages.create({
    model: modelName(), max_tokens: maxTokens, thinking: { type: 'adaptive' }, output_config, system, messages
  });
  if (resp.stop_reason === 'refusal') throw new Error('اعتذر المساعد عن هذا الطلب');
  if (resp.stop_reason === 'max_tokens') throw new Error('الإجابة تجاوزت الحد الأقصى للطول');
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('وصلت إجابة فارغة');
  return text;
}

/* ========= مزوّد DeepSeek (صيغة chat/completions) ========= */
async function deepseekText({ system, messages, maxTokens, json, temperature }) {
  const body = JSON.stringify({
    model: modelName(),
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: maxTokens,
    temperature,
    stream: false,
    ...(json ? { response_format: { type: 'json_object' } } : {})
  });
  let r, d = {};
  // محاولة ثانية واحدة عند الازدحام أو خطأ الخادم (429 / 5xx)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('DEEPSEEK_API_KEY')}` },
        body,
        signal: AbortSignal.timeout(45000)
      });
    } catch (e) {
      throw new Error(e && e.name === 'TimeoutError' ? 'انتهت مهلة الرد من DeepSeek' : 'تعذّر الاتصال بـDeepSeek: ' + (e && e.message));
    }
    const text = await r.text();
    try { d = text ? JSON.parse(text) : {}; } catch (e) { d = {}; }
    if (r.ok || !(r.status === 429 || r.status >= 500) || attempt === 1) break;
    await new Promise(res => setTimeout(res, 1500));
  }
  if (!r.ok) {
    if (r.status === 401) throw new Error('مفتاح DeepSeek غير صحيح (DEEPSEEK_API_KEY)');
    if (r.status === 402) throw new Error('رصيد DeepSeek نفد — اشحن الحساب من platform.deepseek.com');
    throw new Error('DeepSeek: ' + ((d.error && d.error.message) || ('HTTP ' + r.status)));
  }
  const ch = d.choices && d.choices[0];
  if (!ch) throw new Error('وصلت إجابة فارغة من DeepSeek');
  if (ch.finish_reason === 'length') throw new Error('الإجابة تجاوزت الحد الأقصى للطول');
  if (ch.finish_reason === 'content_filter') throw new Error('اعتذر المساعد عن هذا الطلب');
  const out = String((ch.message && ch.message.content) || '').trim();
  if (!out) throw new Error('وصلت إجابة فارغة');
  return out;
}

// سؤال المساعد: يعيد نص الإجابة
async function ask({ question, history = [], portfolio = [], snapshots }) {
  if (!hasKey()) throw noKey();

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

  return isDeepSeek()
    ? deepseekText({ system: SYSTEM, messages: msgs, maxTokens: 1400, temperature: 1.0 })
    : claudeText({ system: SYSTEM, messages: msgs, maxTokens: 1400, effort: EFFORT });
}

/* ========= قرارات التداول الآلي (مخرجات مهيكلة) ========= */
const DECIDE_SYSTEM = `أنت مدير محفظة آلي لحساب تداول أمريكي صغير لمتداول فرد. مهمتك اختيار صفقات شراء اليوم من قائمة مرشّحين محددة، أو الامتناع.

القواعد الملزمة:
- اشترِ فقط من قائمة المرشّحين المرفقة، ولا تخترع رمزاً خارجها. لا تشترِ سهماً مملوكاً بالفعل.
- الأصل هو الامتناع: لا تشترِ إلا إذا اجتمعت قوة سعرية معقولة وسيولة أعلى من المتوسط وRSI غير متشبع شرائياً (فوق 75 = مطاردة). سهم ارتفع أكثر من 5٪ اليوم يُعد مطاردة ما لم تكن السيولة استثنائية.
- لكل قرار شراء حدّد stop_loss_pct: المسافة من سعر الدخول إلى وقف الخسارة كرقم موجب بين 2 و8 (مثال: 4 يعني وقفاً أدنى من الدخول بـ4٪)، وtake_profit_pct: المسافة إلى الهدف كرقم موجب بين 3 و20، بحيث يكون الهدف 1.5 ضعف الوقف على الأقل. اجعل الوقف تحت أقرب دعم منطقي لا رقماً عشوائياً. لغير الشراء ضع صفراً في الاثنين.
- confidence عدد صحيح من 0 إلى 100 يعبّر عن جودة الفرصة مقارنة بالبديل (عدم التداول). لا تعطِ فوق 70 إلا لفرصة واضحة.
- التنويع: لا تختر أكثر من سهمين من القطاع نفسه في اليوم الواحد. راعِ المراكز المفتوحة الحالية.
- في السوق الهابط عموماً (أغلب المرشّحين سالبون) امتنع كلياً ووضّح السبب في market_view.
- close: يُسمح به فقط لمركز مفتوح مذكور، وفقط إذا انهار منطقه (لا لمجرد تذبذب بسيط). إن لم يُسمح بالبيع في الرسالة فلا تُخرج close.
- reason: جملة أو جملتان بالعربية، مبنيتان على الأرقام المرفقة فقط. market_view: قراءة عامة في 3 جمل كحد أقصى.
- أخرج قراراً لكل مرشّح تراه جديراً بالذكر (buy أو skip)، ولا يلزم ذكر كل المرشّحين. الحدود النهائية (عدد الصفقات، حجمها) يطبّقها النظام بعدك.`;

// DeepSeek لا يلزم ببنية محددة (وضع JSON عام فقط)، لذا تُشرح البنية نصاً مع مثال، ويُفحص الناتج في sanitize
const DECIDE_JSON_FORMAT = `

أخرج الجواب ككائن JSON واحد فقط، بلا أي نص قبله أو بعده، بهذه البنية حرفياً:
{"market_view": "نص", "decisions": [{"sym": "NVDA", "action": "buy", "confidence": 75, "stop_loss_pct": 4, "take_profit_pct": 8, "reason": "نص"}]}
- action واحدة من: buy أو skip أو close.
- إن لم تجد فرصة فأرجع decisions مصفوفة فارغة [] مع شرح في market_view.`;

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
          stop_loss_pct: { type: 'number', description: 'مسافة الوقف تحت الدخول كرقم موجب (2 إلى 8). صفر لغير الشراء' },
          take_profit_pct: { type: 'number', description: 'مسافة الهدف فوق الدخول كرقم موجب (3 إلى 20). صفر لغير الشراء' },
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

// فحص صارم لكل حقل: أي قرار ناقص أو بنوع خاطئ يُسقط بدل أن يصل إلى الوسيط
function sanitizeDecisions(out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.decisions)) throw new Error('قرارات الوكيل ناقصة البنية');
  const ACT = new Set(['buy', 'skip', 'close']);
  const num = v => { const x = typeof v === 'string' ? parseFloat(v) : v; return typeof x === 'number' && Number.isFinite(x) ? x : NaN; };
  const decisions = out.decisions
    .filter(d => d && typeof d === 'object')
    .map(d => ({
      sym: String(d.sym || '').trim().toUpperCase(),
      action: String(d.action || '').trim().toLowerCase(),
      confidence: Math.round(num(d.confidence)),
      // القيمة المطلقة: وقف مكتوب بإشارة سالبة (-4) يعني المسافة نفسها لا وقفاً أضيق
      stop_loss_pct: Math.abs(num(d.stop_loss_pct)),
      take_profit_pct: Math.abs(num(d.take_profit_pct)),
      reason: String(d.reason || '').slice(0, 400)
    }))
    .filter(d => /^[A-Z][A-Z0-9.\-]{0,7}$/.test(d.sym) && ACT.has(d.action)
      && Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 100)
    .filter(d => d.action !== 'buy' || (d.stop_loss_pct > 0 && d.take_profit_pct > 0));
  return { market_view: String(out.market_view || '').slice(0, 600), decisions };
}

// طلب قرارات شراء من الذكاء الاصطناعي: يعيد {market_view, decisions[]} — التحقق من الحدود يتم في _autotrade.js
async function decide({ candidates, positions, account, limits, canSell }) {
  if (!hasKey()) throw noKey();

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
  const messages = [{ role: 'user', content: userMsg }];

  const text = isDeepSeek()
    ? await deepseekText({ system: DECIDE_SYSTEM + DECIDE_JSON_FORMAT, messages, maxTokens: 3000, json: true, temperature: 0.2 })
    : await claudeText({ system: DECIDE_SYSTEM, messages, maxTokens: 4000, effort: TRADE_EFFORT, schema: DECISION_SCHEMA });
  let out;
  try { out = JSON.parse(text); } catch (e) { throw new Error('تعذّر قراءة قرارات الوكيل (JSON غير صالح)'); }
  return sanitizeDecisions(out);
}

module.exports = { ask, decide, hasKey, provider, providerLabel, modelName, keyName, sanitizeDecisions, pickContext };
