// دالة خادم Vercel — وسيط أسعار حقيقية
// المصدر الأساسي: Yahoo Finance (مجاني · فوري · بلا مفتاح · يغطي تداول السعودي .SR والأمريكي)
// احتياطي: سهمك SAHMK للسعودي · Twelve Data للأمريكي (من متغيرات البيئة)
const env = process.env;
const clean = v => String(v || '').trim().replace(/^["']+|["']+$/g, '');
let _sahmk = clean(env.SAHMK_API_KEY || env.SAHMK_KEY || env.SAHMK);
let _twelve = clean(env.TWELVEDATA_API_KEY || env.TWELVE_DATA_API_KEY || env.TWELVEDATA_KEY || env.TWELVE_API_KEY);
if (!_sahmk.startsWith('shmk_') && _twelve.startsWith('shmk_')) { const t = _sahmk; _sahmk = _twelve; _twelve = t; }
const SAHMK_KEY = _sahmk;
const TWELVE_KEY = _twelve;

const { SA_SYMS, US_SYMS } = require('./_symbols');

const YH_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; RasadBot/1.0)' };

// مؤشر القوة النسبية RSI(14) بطريقة Wilder من سلسلة الإغلاقات اليومية
function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 0;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgL === 0) return avgG === 0 ? 50 : 100;
  const rs = avgG / avgL;
  return Math.round(100 - 100 / (1 + rs));
}

// نسبة السيولة = حجم تداول اليوم ÷ متوسط حجم آخر 20 جلسة سابقة
function computeVolRatio(vols) {
  const v = (vols || []).filter(x => x > 0);
  if (v.length < 6) return 0;
  const today = v[v.length - 1];
  const hist = v.slice(Math.max(0, v.length - 21), v.length - 1);
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  if (!avg) return 0;
  return today / avg;
}

// جلب سعر سهم واحد من Yahoo Finance مع RSI ونسبة السيولة المحسوبَين من التاريخ
async function yahooOne(ysym) {
  let lastErr;
  for (const host of YH_HOSTS) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(ysym)}?interval=1d&range=3mo`, { headers: UA });
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
      const d = await r.json();
      const res0 = d && d.chart && d.chart.result && d.chart.result[0];
      const m = res0 && res0.meta;
      if (m && m.regularMarketPrice > 0) {
        const ind = (res0.indicators && res0.indicators.quote && res0.indicators.quote[0]) || {};
        const price = +m.regularMarketPrice;
        // أزواج (وقت، إغلاق) متوافقة مع الطوابع الزمنية — تصفية القيم الفارغة دون فقدان المحاذاة
        const ts = res0.timestamp || [];
        const bars = ts.map((t, i) => [t, ind.close ? ind.close[i] : null]).filter(b => b[1] != null && b[1] > 0);
        // يوم التداول بتوقيت البورصة (gmtoffset بالثواني) لمعرفة هل شمعة اليوم موجودة في السلسلة
        const off = +m.gmtoffset || 0;
        const dayOf = t => Math.floor((t + off) / 86400);
        const lastT = bars.length ? bars[bars.length - 1][0] : 0;
        const todayInSeries = !!(lastT && m.regularMarketTime && dayOf(lastT) === dayOf(m.regularMarketTime));
        // الإغلاق السابق الحقيقي = إغلاق آخر جلسة قبل جلسة السعر الحالي
        // (chartPreviousClose هو الإغلاق قبل بداية نافذة الأشهر الثلاثة — كان يجعل «تغير اليوم» تغيّر 3 أشهر)
        const prevBar = todayInSeries ? bars[bars.length - 2] : bars[bars.length - 1];
        const prevClose = prevBar ? +prevBar[1] : 0;
        // RSI: السعر اللحظي يحل محل شمعة اليوم إن وُجدت، وإلا يُضاف كآخر إغلاق (بلا يوم مكرر)
        const closes = bars.map(b => +b[1]);
        if (closes.length && todayInSeries) closes[closes.length - 1] = price;
        else if (closes.length) closes.push(price);
        return {
          price,
          open: prevClose,
          rsi: computeRSI(closes),
          volRatio: computeVolRatio(ind.volume)
        };
      }
      lastErr = new Error('no price');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('yahoo failed');
}

// جلب مجموعة رموز من Yahoo (لاحقة اختيارية مثل .SR للسوق السعودي)
async function fetchYahoo(syms, suffix) {
  const results = await Promise.allSettled(syms.map(async sym => {
    const q = await yahooOne(sym + (suffix || ''));
    return [sym, { price: q.price, open: q.open, rsi: q.rsi || 0, volRatio: q.volRatio || 0 }];
  }));
  const quotes = {};
  results.forEach(res => { if (res.status === 'fulfilled') quotes[res.value[0]] = res.value[1]; });
  return quotes;
}

// احتياطي السوق السعودي — سهمك SAHMK
async function fetchSahmk() {
  if (!SAHMK_KEY) throw new Error('no SAHMK key');
  const headers = { 'X-API-Key': SAHMK_KEY, 'Accept': 'application/json' };
  const quotes = {};
  const r = await fetch(`https://app.sahmk.sa/api/v1/quotes/?identifiers=${SA_SYMS.join(',')}`, { headers });
  if (r.ok) {
    const d = await r.json();
    (d.quotes || []).forEach(q => {
      const price = +q.price, change = +q.change || 0;
      if (price > 0) quotes[q.symbol] = { price, open: price - change, volRatio: 0 };
    });
  }
  const missing = SA_SYMS.filter(sym => !quotes[sym]);
  if (missing.length) {
    const results = await Promise.allSettled(missing.map(async sym => {
      const rq = await fetch(`https://app.sahmk.sa/api/v1/quote/${sym}/`, { headers });
      if (!rq.ok) throw new Error('HTTP ' + rq.status);
      return rq.json();
    }));
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        const q = res.value.quote || res.value;
        const price = +q.price, change = +q.change || 0;
        if (price > 0) quotes[q.symbol || missing[i]] = { price, open: price - change, volRatio: 0 };
      }
    });
  }
  return quotes;
}

// احتياطي السوق الأمريكي — Twelve Data
async function fetchTwelve() {
  if (!TWELVE_KEY) throw new Error('no Twelve key');
  const grp = US_SYMS.slice(0, 8);
  const r = await fetch(`https://api.twelvedata.com/quote?symbol=${grp.join(',')}&apikey=${TWELVE_KEY}`);
  if (!r.ok) throw new Error('Twelve Data HTTP ' + r.status);
  const d = await r.json();
  if (d.status === 'error') throw new Error('Twelve Data: ' + d.message);
  const quotes = {};
  grp.forEach(sym => {
    const q = d[sym];
    if (q && q.close) {
      const price = parseFloat(q.close);
      if (price > 0) quotes[sym] = { price, open: parseFloat(q.previous_close) || 0, volRatio: 0 };
    }
  });
  return quotes;
}

// المنطق الأساسي: يُستدعى من نقطة /api/quotes ومباشرة من وحدات الوكيل الأخرى
// (نداء دالة داخل نفس العملية بدل طلب HTTP ذاتي — يتفادى أي حاجز مصادقة على روابط Vercel الداخلية)
async function getQuotes(market) {
  let quotes = {}, source = 'yahoo';
  try { quotes = await fetchYahoo(market === 'sa' ? SA_SYMS : US_SYMS, market === 'sa' ? '.SR' : ''); }
  catch (e) { quotes = {}; }
  if (!Object.keys(quotes).length) {
    source = market === 'sa' ? 'sahmk' : 'twelvedata';
    quotes = market === 'sa' ? await fetchSahmk() : await fetchTwelve();
  }
  if (!Object.keys(quotes).length) throw new Error('لم تصل أسعار من أي مصدر');
  return { source, quotes };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const market = String((req.query && req.query.market) || 'sa').toLowerCase();
  if (market !== 'sa' && market !== 'us') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'market must be sa or us' });
  }
  try {
    const { source, quotes } = await getQuotes(market);
    // أسعار فورية مع تخزين مؤقت قصير
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ market, source, count: Object.keys(quotes).length, quotes });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
module.exports.getQuotes = getQuotes;
