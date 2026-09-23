// الوكيل المجدول — ملخص فرص يومي إلى تيليجرام قبل افتتاح كل سوق + دورة التداول الآلي للسوق الأمريكي
// يعمل عبر Vercel Cron (مرتان يومياً): قبل افتتاح تداول ثم قبل افتتاح وول ستريت
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

module.exports = async (req, res) => {
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

    let msgText = `📬 <b>ملخص وكيل رصد اليومي</b>\n\n` + fmtOpps(market, list);

    // تعليق ذكي مقتضب إن كان المفتاح مفعّلاً (اختياري — يتجاوز الفشل بصمت)
    // اللقطة تُمرَّر جاهزة كي لا يعيد المساعد جلب مئات الأسعار داخل مهلة الدالة
    if (hasKey()) {
      try {
        const top = list.slice(0, 8).map(s => `${s.sym} ${s.name} درجة ${s.score} تغير ${s.chg}%`).join('، ');
        const comment = await ask({
          question: `هذه أفضل فرص ${market === 'sa' ? 'السوق السعودي' : 'السوق الأمريكي'} اليوم حسب رادار رصد: ${top}. اكتب تعليقاً صباحياً صارماً في 3 جمل كحد أقصى: قراءة عامة للسوق من هذه الأرقام + تحذير مخاطرة واحد محدد.`,
          snapshots: { [market]: list }
        });
        msgText += `\n\n🧠 <b>قراءة المساعد:</b>\n${esc(comment)}`;
      } catch (_) {}
    }

    await send(CHAT, msgText);

    // التداول الآلي: السوق الأمريكي فقط، ومتوقف تماماً ما لم يُفعَّل صراحةً (AUTOTRADE_ENABLED=true)
    let trade = null;
    if (market === 'us') {
      try {
        trade = await autotrade.runCycle(list);
        // يُبلَّغ المستخدم بكل نتيجة عدا «التداول متوقف» الافتراضية كي لا تتكرر الرسالة يومياً
        if (trade && (trade.ok || trade.stopped || (trade.skipped && autotrade.cfg().enabled))) await send(CHAT, autotrade.fmtCycle(trade));
      } catch (e) {
        trade = { error: String(e.message || e) };
        await send(CHAT, '⚠️ خطأ في دورة التداول الآلي (لم يُنفَّذ أي أمر): ' + esc(String(e.message || e)));
      }
    }

    return res.status(200).json({ ok: true, market, scanned: list.length, trade });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
