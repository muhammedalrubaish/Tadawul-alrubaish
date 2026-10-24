// عميل وسيط Alpaca (تداول أمريكي فقط) — أوامر تعليقية (bracket) بوقف وهدف مُنفَّذين من الوسيط نفسه
// أمان افتراضي: حساب تجريبي (paper) ما لم يُضبط ALPACA_PAPER=false صراحة
const KEY = String(process.env.ALPACA_KEY || '').trim();
const SECRET = String(process.env.ALPACA_SECRET || '').trim();
const PAPER = String(process.env.ALPACA_PAPER || 'true').trim().toLowerCase() !== 'false';
const BASE = PAPER ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';

function hdrs() {
  if (!KEY || !SECRET) throw new Error('ALPACA_KEY أو ALPACA_SECRET غير مضبوطين');
  return { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' };
}

async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: hdrs(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!r.ok) throw new Error(`Alpaca ${method} ${path}: ${data.message || ('HTTP ' + r.status)}`);
  return data;
}

const getAccount = () => api('GET', '/v2/account');
const getPositions = () => api('GET', '/v2/positions');
const getClock = () => api('GET', '/v2/clock');

// هل يفتح السوق الأمريكي اليوم؟ (يشمل العطلات الرسمية — الوسيط هو مصدر الحقيقة)
async function marketOpensToday() {
  const c = await getClock();
  if (c.is_open) return true;
  const et = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  return et(c.timestamp) === et(c.next_open);
}

// أوامر الشراء المنفَّذة اليوم (لعدّ صفقات اليوم دون أي تخزين خاص بنا — الحساب لدى الوسيط هو مصدر الحقيقة)
async function getTodayFilledBuyOrders() {
  const today = new Date().toISOString().slice(0, 10);
  const orders = await api('GET', `/v2/orders?status=closed&after=${today}T00:00:00Z&direction=asc&limit=200`);
  return (orders || []).filter(o => o.side === 'buy' && o.filled_at);
}

// يوم التداول بتوقيت نيويورك (YYYY-MM-DD) — أساس المعرّف الثابت وفحص «أمر اليوم»
const nyDay = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));

// كل أوامر الشراء المُرسلة اليوم (بتوقيت نيويورك) بكل حالاتها: منفَّذ · ملغى · مرفوض · معلّق
// يمنع إعادة شراء رمز في اليوم نفسه حتى لو خرج بوقف أو أُلغي أمره
async function getTodayBuyOrders() {
  const after = new Date(Date.now() - 36 * 3600e3).toISOString();
  const today = nyDay(Date.now());
  const orders = await api('GET', `/v2/orders?status=all&direction=desc&limit=500&nested=false&after=${encodeURIComponent(after)}`);
  return (orders || []).filter(o => o.side === 'buy' && nyDay(o.submitted_at) === today);
}

// أوامر الشراء المعلّقة (لم تُنفَّذ بعد): تُحسب ضمن الانكشاف وتُلغى إن قدُمت
const getOpenBuyOrders = async () => (await api('GET', '/v2/orders?status=open&limit=200&nested=false') || []).filter(o => o.side === 'buy');
const cancelOrder = id => api('DELETE', `/v2/orders/${encodeURIComponent(id)}`);

// أمر تعليقي (bracket): دخول بحد سعري (أو بسعر السوق) + وقف خسارة وهدف ربح يُنفَّذهما الوسيط تلقائياً
// gtc إلزامي: مع «day» تنتهي أرجل الوقف والهدف عند الإغلاق ويبقى المركز مكشوفاً في اليوم التالي
// clientOrderId ثابت لليوم والرمز: Alpaca يرفض تكرار المعرّف، فدورتان متزامنتان لا تشتريان مرتين
async function submitBracketOrder({ symbol, qty, tp, sl, limit, clientOrderId }) {
  const body = {
    symbol, qty, side: 'buy', time_in_force: 'gtc',
    order_class: 'bracket',
    take_profit: { limit_price: +(+tp).toFixed(2) },
    stop_loss: { stop_price: +(+sl).toFixed(2) }
  };
  if (clientOrderId) body.client_order_id = clientOrderId;
  if (limit > 0) { body.type = 'limit'; body.limit_price = +(+limit).toFixed(2); }
  else body.type = 'market';
  return api('POST', '/v2/orders', body);
}

// كل الأوامر المعلّقة (أرجل الوقف/الهدف للمراكز المفتوحة + أوامر شراء لم تُنفَّذ)
const getOpenOrders = () => api('GET', '/v2/orders?status=open&limit=200&nested=false');
// سجل التنفيذات (شراء وبيع) من نشاط الحساب — لبناء الصفقات المغلقة وربحها المحقق
// الحد الأقصى لدى Alpaca 100 سجل في الصفحة: نتصفّح بـ page_token حتى maxPages (500 تنفيذ افتراضياً)
// complete=false إن بقي في السجل ما هو أقدم من آخر صفحة جُلبت
async function getFills(maxPages = 5) {
  const fills = [];
  let token = '';
  for (let page = 0; page < maxPages; page++) {
    const batch = await api('GET', `/v2/account/activities/FILL?direction=desc&page_size=100` + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
    if (!batch || !batch.length) return { fills, complete: true };
    fills.push(...batch);
    token = batch[batch.length - 1].id;
    if (batch.length < 100) return { fills, complete: true };
  }
  const more = await api('GET', `/v2/account/activities/FILL?direction=desc&page_size=1&page_token=${encodeURIComponent(token)}`);
  return { fills, complete: !(more && more.length) };
}

// كل الأوامر بكل حالاتها مع أرجل bracket (nested=true) منذ تاريخ — لقراءة الوقف والهدف المخططين ونوع الخروج
// Alpaca يعيد 500 أمر كحد أقصى في الطلب، فنتقدّم بالمؤشر after = وقت آخر أمر في الدفعة
async function getOrdersNested(after, maxPages = 5) {
  const orders = [];
  let cursor = after;
  for (let page = 0; page < maxPages; page++) {
    const batch = await api('GET', `/v2/orders?status=all&nested=true&direction=asc&limit=500&after=${encodeURIComponent(cursor)}`);
    if (!batch || !batch.length) break;
    orders.push(...batch);
    if (batch.length < 500) break;
    cursor = batch[batch.length - 1].submitted_at;
  }
  return orders;
}

// كل أوامر الشراء في آخر N يوماً بكل حالاتها (نُفِّذ · أُلغي · انتهى · مرفوض · معلّق)
// يكشف الأوامر التي أرسلها الوكيل ولم تُنفَّذ — لا تظهر في سجل التنفيذات
async function getRecentBuyOrders(days = 30) {
  const after = new Date(Date.now() - days * 864e5).toISOString();
  const orders = await api('GET', `/v2/orders?status=all&direction=desc&limit=100&nested=false&after=${encodeURIComponent(after)}`);
  return (orders || []).filter(o => o.side === 'buy');
}

// أوامر رمز واحد بكل حالاتها مع أرجل bracket (الوقف والهدف) بين تاريخين
const getSymbolOrders = (symbol, after, until) =>
  api('GET', `/v2/orders?status=all&symbols=${encodeURIComponent(symbol)}&nested=true&direction=asc&limit=500&after=${encodeURIComponent(after)}&until=${encodeURIComponent(until)}`);

// كل التنفيذات بين تاريخين، صفحة بعد صفحة (100 لكل صفحة) حتى maxPages
async function getFillsBetween(after, until, maxPages = 20) {
  const all = [];
  for (let token = '', page = 0; page < maxPages; page++) {
    const batch = await api('GET', `/v2/account/activities/FILL?direction=asc&page_size=100&after=${encodeURIComponent(after)}&until=${encodeURIComponent(until)}` + (token ? `&page_token=${encodeURIComponent(token)}` : ''));
    if (!batch || !batch.length) break;
    all.push(...batch);
    token = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return all;
}

const closePosition = symbol => api('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`);
const closeAllPositions = () => api('DELETE', `/v2/positions?cancel_orders=true`);
const cancelAllOrders = () => api('DELETE', '/v2/orders');
const hasKeys = () => !!(KEY && SECRET);

module.exports = {
  getAccount, getPositions, getClock, marketOpensToday, getTodayFilledBuyOrders, getTodayBuyOrders, nyDay, getOpenBuyOrders, getOpenOrders, getFills, getOrdersNested, getRecentBuyOrders, getSymbolOrders, getFillsBetween, cancelOrder,
  submitBracketOrder, closePosition, closeAllPositions, cancelAllOrders, hasKeys, PAPER
};
