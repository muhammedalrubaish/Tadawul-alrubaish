// الوكيل المجدول — ملخص فرص يومي إلى تيليجرام قبل افتتاح كل سوق + دورة التداول الآلي للسوق الأمريكي
// يعمل عبر Vercel Cron (مرتان يومياً): قبل افتتاح تداول، ثم أثناء جلسة وول ستريت (15:00 UTC — بعد الافتتاح بساعة ونصف صيفاً)
// الشراء بعد الافتتاح عمداً: قبل الافتتاح يُبنى الحد السعري على إغلاق الأمس، فلا يُنفَّذ إلا على الأسهم التي افتتحت ضعيفة
const { send, TOKEN, CHAT } = require('./_telegram');
const { snapshot, fmtOpps, esc } = require('./_market');
const { ask, hasKey } = require('./_ai');
const autotrade = require('./_autotrade');

// هل اليوم يوم تداول في السوق؟ (عطلة نهاية الأسبوع فقط — عطلات السوق الأمريكي الرسمية يفحصها الوسيط في دورة التداول)
function tradingDay(market) {
  const tz = market === 'sa' ? 'Asia/Riyadh' : 'America/New_York';
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date());
  return market === 'sa' ? !(wd === 'Fri' || wd === 'Sat') : !(wd === 'Sat' || wd === 'Sun');
}

// ميزانية الوقت داخل مهلة الدالة (maxDuration = 60 ث في vercel.json) مع هامش للإرسال
const DEADLINE = 50000;

module.exports = async (req, res) => {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};

  // تفويض: سر CRON_SECRET (يرسله Vercel تلقائياً في Authorization) أو تشغيل يدوي بمعرفة التوكن
  // ترويسة User-Agent قابلة للتزييف، لذا تُقبل وحدها فقط عندما لا يكون CRON_SECRET مضبوطاً — اضبطه دائماً
  const ua = String(req.headers['user-agent'] || '');
  const auth = String(req.headers['authorization'] || '');
  const secret = String(process.env.CRON_SECRET || '').trim();
  const authorized =
    (secret && (auth === `Bearer ${secret}` || String(q.key || '') === secret)) ||
    (TOKEN && String(q.key || '') === TOKEN) ||
    (!secret && ua.startsWith('vercel-cron'));
  if (!authorized) return res.status(401).json({ error: 'unauthorized' });

  if (!TOKEN || !CHAT) return res.status(503).json({ error: 'أضف TELEGRAM_TOKEN و TELEGRAM_CHAT في إعدادات Vercel' });

  // السوق: صراحةً بالمعامل، وإلا حسب موعد الكرون (صباح UTC = تداول، ظهر UTC = أمريكا)
  const market = q.market === 'us' || q.market === 'sa' ? q.market : (new Date().getUTCHours() < 10 ? 'sa' : 'us');
  const dry = String(q.dry || '') === '1';
  if (!q.force && !dry && !tradingDay(market)) return res.status(200).json({ skipped: 'عطلة نهاية الأسبوع', market });

  try {
    const list = await snapshot(market);

    // معاينة فقط: ماذا كان الوكيل سيشتري الآن؟ (بلا رسالة ملخص وبلا تنفيذ)
    if (dry) {
      if (market !== 'us') return res.status(400).json({ error: 'التداول الآلي للسوق الأمريكي فقط (market=us)' });
      const trade = await autotrade.runCycle(list, { dry: true });
      if (String(q.notify || '') === '1') await send(CHAT, autotrade.fmtCycle(trade));
      return res.status(200).json({ ok: true, market, scanned: list.length, trade });
    }

    // التداول الآلي أولاً: السوق الأمريكي فقط، ومتوقف تماماً ما لم يُفعَّل صراحةً (AUTOTRADE_ENABLED=true)
    // كان يأتي بعد التعليق الصباحي؛ نداءان للذكاء الاصطناعي (حتى 45 ث لكل منهما) قد يتجاوزان مهلة الدالة (60 ث)
    // فتُقطع دورة التداول بصمت. الآن الدورة الأساسية تسبق التعليق الاختياري.
    let trade = null, tradeMsg = null;
    if (market === 'us') {
      try {
        trade = await autotrade.runCycle(list);
        // يُبلَّغ المستخدم بكل نتيجة عدا «التداول متوقف» الافتراضية كي لا تتكرر الرسالة يومياً
        if (trade && (trade.ok || trade.stopped || (trade.skipped && autotrade.cfg().enabled))) tradeMsg = autotrade.fmtCycle(trade);
      } catch (e) {
        trade = { error: String(e.message || e) };
        tradeMsg = '⚠️ خطأ في دورة التداول الآلي (لم يُنفَّذ أي أمر): ' + esc(String(e.message || e));
      }
    }

    let msgText = `📬 <b>ملخص وكيل رصد اليومي</b>\n\n` + fmtOpps(market, list);

    // تعليق ذكي مقتضب إن كان المفتاح مفعّلاً (اختياري — يتجاوز الفشل بصمت)
    // اللقطة تُمرَّر جاهزة كي لا يعيد المساعد جلب مئات الأسعار داخل مهلة الدالة
    // مقيَّد بالوقت المتبقي كي تصل رسائل تيليجرام دائماً قبل انتهاء المهلة
    const left = DEADLINE - (Date.now() - t0);
    if (hasKey() && left > 8000) {
      try {
        const top = list.slice(0, 8).map(s => `${s.sym} ${s.name} درجة ${s.score} تغير ${s.chg}%`).join('، ');
        const comment = await Promise.race([
          ask({
            question: `هذه أفضل فرص ${market === 'sa' ? 'السوق السعودي' : 'السوق الأمريكي'} اليوم حسب رادار رصد: ${top}. اكتب تعليقاً صباحياً صارماً في 3 جمل كحد أقصى: قراءة عامة للسوق من هذه الأرقام + تحذير مخاطرة واحد محدد.`,
            snapshots: { [market]: list }
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.min(25000, left - 5000)))
        ]);
        msgText += `\n\n🧠 <b>قراءة المساعد:</b>\n${esc(comment.text)}`;
      } catch (_) {}
    }

    await send(CHAT, msgText);
    if (tradeMsg) await send(CHAT, tradeMsg);

    return res.status(200).json({ ok: true, market, scanned: list.length, trade });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
