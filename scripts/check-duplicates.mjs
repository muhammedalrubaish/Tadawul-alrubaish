// فحص المرحلة 0 من حاسوب — نفس الفحص المتاح في تيليجرام بأمر «فحص التكرار». للقراءة فقط.
// التشغيل (Node 20.6+) من جذر المستودع، مع ملف .env فيه ALPACA_KEY وALPACA_SECRET (وALPACA_PAPER إن لزم):
//   node --env-file=.env scripts/check-duplicates.mjs
//   node --env-file=.env scripts/check-duplicates.mjs SMCI 2026-10-02,2026-10-21
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (!process.env.ALPACA_KEY || !process.env.ALPACA_SECRET) { console.error('❌ ALPACA_KEY / ALPACA_SECRET غير مضبوطين — شغّله بـ --env-file=.env'); process.exit(1); }
const { checkDuplicates } = require('../api/_dupcheck.js');
const sym = process.argv[2] || 'SMCI';
const days = String(process.argv[3] || '2026-10-02,2026-10-21').split(',').map(s => s.trim()).filter(Boolean);
const html = await checkDuplicates(sym, days);
console.log(html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
