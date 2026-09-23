// ويبهوك تيليجرام — واجهة الوكيل من الهاتف
// الأوامر: «فرص» فحص فوري · رمز سهم (2222 أو AAPL) بطاقة تحليل · أي سؤال آخر → المساعد الذكي
const { api, send, TOKEN, CHAT, SECRET } = require('./_telegram');
const { snapshot, fmtOpps, fmtSym, esc } = require('./_market');
const { ask, hasKey, providerLabel } = require('./_ai');
const autotrade = require('./_autotrade');
const broker = require('./_broker');

const HELP = `👋 أهلاً! أنا <b>وكيل رصد</b> — أراقب السوقين السعودي والأمريكي وأعمل عنك حتى والتطبيق مغلق.

الأوامر:
• <b>فرص</b> — فحص فوري لأفضل الفرص في السوقين
• <b>رمز سهم</b> — مثل <code>2222</code> أو <code>AAPL</code> — بطاقة تحليل فورية
• <b>أي سؤال حر</b> — أجيب بالذكاء الاصطناعي مع الأسعار الحية
• <b>حالة التداول</b> — حساب Alpaca والصفقات المفتوحة (إن كان التداول الآلي مضبوطاً)
• <b>رأي الوكيل</b> — معاينة ما سيشتريه الذكاء الاصطناعي الآن (بلا تنفيذ)
• <b>تداول الآن</b> — تشغيل دورة التداول الآلي فوراً (تنفيذ فعلي إن كان مفعّلاً)
• <b>أوقف الكل</b> — إغلاق طارئ فوري لكل صفقات التداول الآلي المفتوحة

وأرسل لك تلقائياً ملخص الفرص قبل افتتاح كل سوق يومياً 📬`;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // ===== GET: الحالة والتهيئة =====
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q.health) {
      const c = autotrade.cfg();
      return res.status(200).json({ tg: !!TOKEN, chat: !!CHAT, ai: hasKey(), provider: providerLabel(), autotrade: { broker: broker.hasKeys(), enabled: c.enabled, mode: c.mode, paper: broker.PAPER, maxPositionUsd: c.maxPositionUsd, maxDailyTrades: c.maxDailyTrades, maxOpenPositions: c.maxOpenPositions, dailyLossLimitUsd: c.dailyLossLimitUsd } });
    }
    // تهيئة الويبهوك: /api/tg?setup=<TELEGRAM_TOKEN> — تتطلب معرفة التوكن نفسه
    if (q.setup) {
      if (!TOKEN) return res.status(503).json({ error: 'أضف TELEGRAM_TOKEN في إعدادات Vercel أولاً' });
      if (String(q.setup) !== TOKEN) return res.status(401).json({ error: 'التوكن غير مطابق' });
      const url = `https://${req.headers.host}/api/tg`;
      try {
        await api('setWebhook', { url, secret_token: SECRET, drop_pending_updates: true, allowed_updates: ['message'] });
        const me = await api('getMe', {});
        return res.status(200).json({ ok: true, webhook: url, bot: '@' + me.username, chatConfigured: !!CHAT, aiConfigured: hasKey() });
      } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
    }
    return res.status(200).json({ ok: true, hint: 'استخدم ?setup=<TOKEN> للتهيئة أو ?health=1 للحالة' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST فقط' });
  // تحقق أن التحديث قادم من تيليجرام فعلاً (السر المضبوط في setWebhook)
  if (!TOKEN || String(req.headers['x-telegram-bot-api-secret-token'] || '') !== SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const msg = (req.body || {}).message;
  // نرد 200 دائماً كي لا يعيد تيليجرام الإرسال
  const done = () => res.status(200).json({ ok: true });
  if (!msg || !msg.chat) return done();
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();

  try {
    // أول تشغيل: ساعد المستخدم على معرفة معرّف محادثته
    if (!CHAT) {
      await send(chatId, `معرّف محادثتك هو: <code>${chatId}</code>\n\nأضفه كمتغير بيئة باسم <b>TELEGRAM_CHAT</b> في إعدادات مشروع Vercel ثم أعد النشر، وسيعمل الوكيل لك وحدك.`);
      return done();
    }
    // البوت خاص بصاحبه فقط
    if (String(chatId) !== CHAT) return done();

    if (!text || text === '/start' || /مساعدة|help/i.test(text)) {
      await send(chatId, HELP);
      return done();
    }

    // «فرص» — فحص فوري للسوقين
    if (/^\/?(فرص|الفرص|opps)$/i.test(text)) {
      await send(chatId, '🔍 أفحص السوقين الآن…');
      for (const m of ['sa', 'us']) {
        try { await send(chatId, fmtOpps(m, await snapshot(m))); }
        catch (e) { await send(chatId, `تعذّر فحص ${m === 'sa' ? 'السوق السعودي' : 'السوق الأمريكي'}: ${esc(e.message)}`); }
      }
      return done();
    }

    // «حالة التداول» — حساب الوسيط والصفقات المفتوحة وحدود المخاطرة الحالية
    if (/^\/?(حالة التداول|حالة الوكيل|trade status)$/i.test(text)) {
      const c = autotrade.cfg();
      if (!broker.hasKeys()) { await send(chatId, 'التداول الآلي غير مضبوط — أضف <b>ALPACA_KEY</b> و<b>ALPACA_SECRET</b> في إعدادات Vercel لتفعيله.'); return done(); }
      try {
        const [acc, positions] = await Promise.all([broker.getAccount(), broker.getPositions()]);
        const dailyPL = +acc.equity - +acc.last_equity;
        const posLines = positions.length
          ? positions.map(p => `• ${p.symbol}: ${p.qty} سهم · قيمة ${(+p.market_value).toFixed(2)}$ · ربح/خسارة ${(+p.unrealized_pl >= 0 ? '+' : '')}${(+p.unrealized_pl).toFixed(2)}$`).join('\n')
          : 'لا صفقات مفتوحة حالياً.';
        await send(chatId,
          `🤖 <b>حالة التداول الآلي</b> — ${broker.PAPER ? 'حساب تجريبي 🧪 (مال وهمي)' : 'حساب حقيقي 💰'}\n` +
          `التفعيل: ${c.enabled ? 'مفعّل ✓' : 'متوقف ✗ (AUTOTRADE_ENABLED)'} · القرار: ${c.mode === 'ai' ? '🧠 ' + providerLabel() : '📐 قواعد الدرجة'}\n` +
          `حقوق الملكية: ${(+acc.equity).toFixed(2)}$ · ربح/خسارة اليوم: ${dailyPL >= 0 ? '+' : ''}${dailyPL.toFixed(2)}$\n` +
          `الحدود: صفقة ≤${c.maxPositionUsd}$ · ${c.maxOpenPositions} صفقات مفتوحة كحد أقصى · ${c.maxDailyTrades} صفقات/يوم · وقف خسارة يومي ${c.dailyLossLimitUsd}$\n\n` +
          `<b>الصفقات المفتوحة:</b>\n${esc(posLines)}`);
      } catch (e) { await send(chatId, '⚠️ تعذّر الاتصال بالوسيط: ' + esc(e.message)); }
      return done();
    }

    // «رأي الوكيل» — معاينة قرار الذكاء الاصطناعي بلا تنفيذ · «تداول الآن» — دورة فعلية فوراً
    const dryM = /^\/?(رأي الوكيل|راي الوكيل|قرار الوكيل|preview)$/i.test(text);
    if (dryM || /^\/?(تداول الآن|تداول الان|شغّل التداول|شغل التداول|trade now)$/i.test(text)) {
      if (!broker.hasKeys()) { await send(chatId, 'التداول الآلي غير مضبوط — أضف <b>ALPACA_KEY</b> و<b>ALPACA_SECRET</b> في إعدادات Vercel.'); return done(); }
      await send(chatId, dryM ? '🧠 أفحص السوق الأمريكي وأستشير الوكيل… (معاينة بلا تنفيذ)' : '⚙️ أشغّل دورة التداول الآلي الآن…');
      try {
        const list = await snapshot('us');
        const r = await autotrade.runCycle(list, { dry: dryM });
        await send(chatId, autotrade.fmtCycle(r));
      } catch (e) { await send(chatId, '⚠️ تعذّرت الدورة (لم يُنفَّذ أي أمر): ' + esc(e.message)); }
      return done();
    }

    // «أوقف الكل» — إغلاق طارئ فوري: إلغاء كل الأوامر المعلّقة وتصفية كل الصفقات المفتوحة
    if (/^\/?(أوقف الكل|طوارئ|emergency stop)$/i.test(text)) {
      if (!broker.hasKeys()) { await send(chatId, 'التداول الآلي غير مضبوط أصلاً — لا صفقات لإيقافها.'); return done(); }
      try {
        await broker.cancelAllOrders();
        await broker.closeAllPositions();
        await send(chatId, '🛑 تم إلغاء كل الأوامر المعلّقة وإصدار أمر تصفية لكل الصفقات المفتوحة فوراً.\nملاحظة: التصفية قد تستغرق لحظات لتكتمل — تحقق من «حالة التداول» بعد قليل.\nلإيقاف التداول الآلي نهائياً اضبط <b>AUTOTRADE_ENABLED=false</b> في Vercel وأعد النشر.');
      } catch (e) { await send(chatId, '⚠️ فشل الإيقاف الطارئ: ' + esc(e.message) + '\nراجع حسابك في Alpaca مباشرة للتأكد.'); }
      return done();
    }

    // رمز سهم صريح: 4 أرقام سعودي أو رمز أمريكي
    const symM = text.toUpperCase().match(/^([0-9]{4}|[A-Z][A-Z0-9.\-]{0,6})$/);
    if (symM) {
      const sym = symM[1];
      const market = /^[0-9]{4}$/.test(sym) ? 'sa' : 'us';
      const list = await snapshot(market);
      const s = list.find(x => x.sym === sym);
      if (s) { await send(chatId, fmtSym(s, market)); return done(); }
      // ليس في قائمتنا؟ جرّبه سؤالاً للمساعد إن كان مفعّلاً
    }

    // سؤال حر → المساعد الذكي
    if (!hasKey()) {
      await send(chatId, 'المساعد الذكي غير مفعّل بعد — أضف <b>DEEPSEEK_API_KEY</b> (أو ANTHROPIC_API_KEY) في إعدادات Vercel.\nما زال بإمكانك إرسال «فرص» أو رمز سهم.');
      return done();
    }
    const answer = await ask({ question: text });
    await send(chatId, esc(answer));
    return done();
  } catch (e) {
    try { await send(chatId, '⚠️ حدث خطأ: ' + esc(String((e && e.message) || e))); } catch (_) {}
    return done();
  }
};
