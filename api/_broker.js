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

// أوامر الشراء المعلّقة (لم تُنفَّذ بعد): تُحسب ضمن الانكشاف وتُلغى إن قدُمت
const getOpenBuyOrders = async () => (await api('GET', '/v2/orders?status=open&limit=200&nested=false') || []).filter(o => o.side === 'buy');
const cancelOrder = id => api('DELETE', `/v2/orders/${encodeURIComponent(id)}`);

// أمر تعليقي (bracket): دخول بحد سعري (أو بسعر السوق) + وقف خسارة وهدف ربح يُنفَّذهما الوسيط تلقائياً
// gtc إلزامي: مع «day» تنتهي أرجل الوقف والهدف عند الإغلاق ويبقى المركز مكشوفاً في اليوم التالي
async function submitBracketOrder({ symbol, qty, tp, sl, limit }) {
  const body = {
    symbol, qty, side: 'buy', time_in_force: 'gtc',
    order_class: 'bracket',
    take_profit: { limit_price: +(+tp).toFixed(2) },
    stop_loss: { stop_price: +(+sl).toFixed(2) }
  };
  if (limit > 0) { body.type = 'limit'; body.limit_price = +(+limit).toFixed(2); }
  else body.type = 'market';
  return api('POST', '/v2/orders', body);
}

// كل الأوامر المعلّقة (أرجل الوقف/الهدف للمراكز المفتوحة + أوامر شراء لم تُنفَّذ)
const getOpenOrders = () => api('GET', '/v2/orders?status=open&limit=200&nested=false');
// سجل التنفيذات (شراء وبيع) من نشاط الحساب — لبناء الصفقات المغلقة وربحها المحقق
// الحد الأقصى لدى Alpaca 100 سجل في الصفحة
const getFills = (n = 100) => api('GET', `/v2/account/activities/FILL?direction=desc&page_size=${Math.min(100, Math.max(1, n))}`);

const closePosition = symbol => api('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`);
const closeAllPositions = () => api('DELETE', `/v2/positions?cancel_orders=true`);
const cancelAllOrders = () => api('DELETE', '/v2/orders');
const hasKeys = () => !!(KEY && SECRET);

module.exports = {
  getAccount, getPositions, getClock, marketOpensToday, getTodayFilledBuyOrders, getOpenBuyOrders, getOpenOrders, getFills, cancelOrder,
  submitBracketOrder, closePosition, closeAllPositions, cancelAllOrders, hasKeys, PAPER
};
