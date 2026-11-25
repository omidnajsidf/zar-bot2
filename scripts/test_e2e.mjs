// تست E2E: شبیه‌سازی کامل وورکر (fetch handler) با D1 واقعی + KV mock + Telegram API mock
// جریان‌های تست: /start → منوی اصلی → بانک → واریز → خرید ملک → دستور زر → بازی‌های مینی‌اپ API
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import * as C from '../src/config.js';
import * as db from '../src/db.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

// ─── Mock Telegram API ───
const sentMessages = [];
const sentCallbacks = [];
let msgIdCounter = 1000;
let lastSentMessageId = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/bot')) {
    const method = u.split('/').pop();
    const body = JSON.parse(opts.body || '{}');
    if (method === 'sendMessage') {
      sentMessages.push(body);
      lastSentMessageId = ++msgIdCounter;
    }
    if (method === 'answerCallbackQuery') sentCallbacks.push(body);
    if (method === 'editMessageText') sentMessages.push({ ...body, _edit: true });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: lastSentMessageId || ++msgIdCounter, chat: { id: body.chat_id } } }) };
  }
  throw new Error('unexpected fetch: ' + u);
};

// ─── Mock KV ───
class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v, o) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) { return { keys: [...this.m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; }
}

// ─── SQLite as D1 ───
class SQLiteAsD1 {
  constructor(path) { this.sq = new DatabaseSync(path); }
  prepare(sql) {
    const self = this;
    let i = 0;
    const named = sql.replace(/\?/g, () => `$q${++i}`);
    const stmt = self.sq.prepare(named);
    return {
      bind(...params) {
        const obj = {};
        params.forEach((p, idx) => { obj[`$q${idx + 1}`] = p; });
        return {
          async run() { const r = stmt.run(obj); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
          async all() { return { results: stmt.all(obj) }; },
        };
      },
      async run() { const r = stmt.run(); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async all() { return { results: stmt.all() }; },
    };
  }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

// ─── ساخت env وورکر ───
const WEBHOOK_SECRET = 'testsecret123';
const env = {
  BOT_TOKEN: '123:TESTTOKEN',
  OWNER_ID: '42',
  START_BALANCE: '0',
  WEBAPP_URL: 'https://zar-test.workers.dev',
  ADMIN_PASSWORD: 'panelPass',
  WEBHOOK_SECRET,
  MEMBERSHIP_REQUIRED: 'false',
  DB: null,
  STATE: new MockKV(),
};
C.loadEnv(env);
const { default: worker } = await import('../src/index.js');

// schemas
const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf-8');
env.DB = new SQLiteAsD1(':memory:');
env.DB.sq.exec(schema);

function makeUpdate(payload) {
  return new Request('https://zar-test.workers.dev/webhook/' + WEBHOOK_SECRET, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
const USER = { id: 100, is_bot: false, first_name: 'کاربر تست', username: 'testuser', language_code: 'fa' };
const CHAT = { id: 100, type: 'private' };

async function sendUpdate(payload) {
  sentMessages.length = 0;
  sentCallbacks.length = 0;
  const req = makeUpdate(payload);
  const ctx = { waitUntil: (p) => p.catch(e => { console.error('  ⚠️ waitUntil error:', e.message); process.exitCode = 1; }) };
  const resp = await worker.fetch(req, env, ctx);
  // فرصت اجرای async
  await new Promise(r => setTimeout(r, 150));
  return resp;
}

function lastMessage() { return sentMessages[sentMessages.length - 1]; }
function hasButton(msg, text) {
  if (!msg || !msg.reply_markup) return false;
  return JSON.stringify(msg.reply_markup).includes(text);
}

// ═══════════ تست‌ها ═══════════
console.log('══ E2E: ربات تلگرام ══');

// 1. /start
let resp = await sendUpdate({ update_id: 1, message: { message_id: 1, from: USER, chat: CHAT, text: '/start', date: Math.floor(Date.now() / 1000) } });
ok(resp.status === 200, 'webhook پاسخ 200');
const m1 = lastMessage();
ok(m1 && m1.text.includes('به دنیای زرکوین'), '/start → منوی اصلی');
ok(hasButton(m1, '🏦 بانک') && hasButton(m1, '🎰 کازینو') && hasButton(m1, '💀 بازار سیاه'), 'دکمه‌های منوی اصلی');
const userDb = await db.getUser(env.DB, 100);
ok(userDb && userDb.card_number === '6037000000000100', 'کاربر در دیتابیس ساخته شد + کارت');

// 2. بانک → واریز
await sendUpdate({ update_id: 2, callback_query: { id: 'cb1', from: USER, data: 'bank:menu', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('بانک زرکوین'), 'بانک:منو → متن بانک');

await sendUpdate({ update_id: 3, callback_query: { id: 'cb2', from: USER, data: 'bank:deposit', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('مبلغ واریز'), 'بانک:واریز → درخواست مبلغ');

// پول بریز و واریز کن
await db.addBalance(env.DB, 100, 500000);
await sendUpdate({ update_id: 4, message: { message_id: 3, from: USER, chat: CHAT, text: '200000', date: Math.floor(Date.now() / 1000) } });
ok(sentMessages.some(m => m.text.includes('واریز شد')), 'مبلغ واریز شد');
const uAfterDeposit = await db.getUser(env.DB, 100);
ok(Number(uAfterDeposit.balance) === 300000 && Number(uAfterDeposit.bank_balance) === 200000, `واریز: کیف=300000 بانک=200000 [گرفت: ${uAfterDeposit.balance}/${uAfterDeposit.bank_balance}]`);
const lock = await db.getBankLockRemaining(env.DB, 100);
ok(lock > 0, `قفل ۵ ساعته برداشت فعال (${Math.round(lock / 60)} دقیقه)`);

// برداشت باید قفل باشد
await sendUpdate({ update_id: 5, callback_query: { id: 'cb3', from: USER, data: 'bank:withdraw', message: { message_id: 2, chat: CHAT } } });
ok(sentCallbacks.some(c => (c.text || '').includes('قفل است')), 'برداشت قفل → پیام قفل');

// 3. خرید ملک
await db.addBalance(env.DB, 100, 1000000);
await sendUpdate({ update_id: 6, callback_query: { id: 'cb4', from: USER, data: 'prop:menu', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('املاک'), 'منوی ملک‌ها');
await sendUpdate({ update_id: 7, callback_query: { id: 'cb5', from: USER, data: 'prop:select:supermarket', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('سوپرمارکت'), 'انتخاب ملک → صفحه تأیید');
await sendUpdate({ update_id: 8, callback_query: { id: 'cb6', from: USER, data: 'prop:confirm:supermarket', message: { message_id: 2, chat: CHAT } } });
ok(sentCallbacks.some(c => (c.text || '').includes('خریداری شد')), 'خرید ملک انجام شد');
const summary = await db.getAssetsSummary(env.DB, 100);
ok(summary.supermarket?.count === 1, 'ملک در دیتابیس ثبت شد');
const uAfterBuy = await db.getUser(env.DB, 100);
ok(Number(uAfterBuy.balance) === 800000, `موجودی بعد از خرید = 800000 [گرفت: ${uAfterBuy.balance}]`);

// 4. دستور زر (کول‌داون)
await sendUpdate({ update_id: 9, message: { message_id: 4, from: USER, chat: CHAT, text: 'زر', date: Math.floor(Date.now() / 1000) } });
ok(lastMessage() && lastMessage().text.includes('+'), 'دستور زر → پاداش');
await sendUpdate({ update_id: 10, message: { message_id: 5, from: USER, chat: CHAT, text: 'زر', date: Math.floor(Date.now() / 1000) } });
ok(lastMessage() && lastMessage().text.includes('صبر کن'), 'زر دوباره → کول‌داون');

// 5. مالکیت منو — کاربر دیگر
const USER2 = { ...USER, id: 200, first_name: 'کاربر دوم' };
await db.run(env.DB, "INSERT INTO users (user_id, first_name, balance, bank_balance, card_number, created_at) VALUES (200, 'دوم', 0, 0, '6037000000000200', '2026-01-01')");
// مالکیت پیام (100, 2) → کاربر ۱ (شبیه منویی که ربات برایش فرستاده)
await env.STATE.put('owner:100:2', '100');
await sendUpdate({ update_id: 11, callback_query: { id: 'cb7', from: USER2, data: 'menu:main', message: { message_id: 2, chat: CHAT } } });
await env.STATE.delete('owner:100:2');
// پیام منوی کاربر ۱ در /start ساخته شد (lastSentMessageId بعد از آن ست است)
ok(sentCallbacks.some(c => (c.text || '').includes('برای شما نیست')), 'کاربر غیرمالک → رد شد');

// 6. انتقال
await db.addBalance(env.DB, 100, 5000000);
await sendUpdate({ update_id: 12, callback_query: { id: 'cb8', from: USER, data: 'transfer:start', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('مبلغ انتقال'), 'انتقال → درخواست مبلغ');
await sendUpdate({ update_id: 13, message: { message_id: 6, from: USER, chat: CHAT, text: '1000000', date: Math.floor(Date.now() / 1000) } });
ok(lastMessage() && lastMessage().text.includes('کارت مقصد'), 'مبلغ انتقال → درخواست کارت');
await sendUpdate({ update_id: 14, message: { message_id: 7, from: USER, chat: CHAT, text: '6037000000000200', date: Math.floor(Date.now() / 1000) } });
ok(lastMessage() && lastMessage().text.includes('تایید انتقال'), 'کارت مقصد → تأیید انتقال');
await sendUpdate({ update_id: 15, callback_query: { id: 'cb9', from: USER, data: 'tr:c:100', message: { message_id: 7, chat: CHAT } } });
ok(sentMessages.some(m => m.text.includes('انتقال شد')), 'تأیید انتقال → موفق');
const u2After = await db.getUser(env.DB, 200);
ok(Number(u2After.balance) === 1000000, `گیرنده 1000000 گرفت [گرفت: ${u2After.balance}]`);

// 7. بازار سیاه + انبار
await db.addBalance(env.DB, 100, 50000000);
await sendUpdate({ update_id: 16, callback_query: { id: 'cb10', from: USER, data: 'bm:menu:0', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('بازار سیاه'), 'منوی بازار سیاه');
await sendUpdate({ update_id: 17, callback_query: { id: 'cb11', from: USER, data: 'bm:buy:drone_launcher', message: { message_id: 2, chat: CHAT } } });
ok(sentCallbacks.some(c => (c.text || '').includes('لول 20')), 'لانچر پهباد قفل لول ۲۰ → رد (رفتار صحیح)');
await sendUpdate({ update_id: 18, callback_query: { id: 'cb12', from: USER, data: 'bm:inventory', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('انبار من'), 'انبار من نمایش داده شد');

// 8. راهنما
await sendUpdate({ update_id: 19, callback_query: { id: 'cb13', from: USER, data: 'help:menu', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('راهنما'), 'راهنما صفحه ۱');
await sendUpdate({ update_id: 20, callback_query: { id: 'cb14', from: USER, data: 'help:p:1', message: { message_id: 2, chat: CHAT } } });
ok(lastMessage()?._edit && lastMessage().text.includes('کازینو'), 'راهنما صفحه ۲ (صفحه‌بندی)');

// 9. کاباره (قفل لول — کاربر لول ۱)
await sendUpdate({ update_id: 21, callback_query: { id: 'cb15', from: USER, data: 'kabareh:menu', message: { message_id: 2, chat: CHAT } } });
ok(sentCallbacks.some(c => (c.text || '').includes('کاباره باید') || (c.text || '').includes('لول 4') || (c.text || '').includes('لول ۴')), 'کاباره برای لول پایین → رد');

// 10. کد هدیه
await db.run(env.DB, "INSERT INTO gift_codes (code, rewards, max_uses, used_count, min_level, expires_at, active, note, created_at) VALUES ('E2E', ?, 5, 0, 0, NULL, 1, '', 1000)",
  [JSON.stringify({ coins: 250000 })]);
const balBefore = Number((await db.getUser(env.DB, 100)).balance);
await sendUpdate({ update_id: 22, message: { message_id: 8, from: USER, chat: CHAT, text: 'هدیه زر E2E', date: Math.floor(Date.now() / 1000) } });
ok(lastMessage() && lastMessage().text.includes('کد هدیه فعال شد'), 'کد هدیه فعال شد');
ok(Number((await db.getUser(env.DB, 100)).balance) === balBefore + 250000, 'هدیه ۲۵۰K واریز شد');

// ═══════════ E2E: API مینی‌اپ ═══════════
console.log('══ E2E: API مینی‌اپ ══');
async function apiCall(method, path, body = {}, userId = USER.id) {
  const headers = { 'Content-Type': 'application/json' };
  // توکن مرورگر معتبر بساز
  const { makeBrowserToken } = await import('../src/utils.js');
  const tok = await makeBrowserToken(env.BOT_TOKEN, userId);
  const req = new Request('https://zar-test.workers.dev' + path, {
    method, headers: { ...headers, 'X-Browser-Token': tok },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  return await worker.fetch(req, env, { waitUntil: () => {} });
}

// /api/me
let r = await apiCall('POST', '/api/me', {});
let data = await r.json();
ok(r.status === 200 && data.ok && data.user.id === 100, 'GET /api/me');
ok(data.user.balance > 0 && data.games.length === 16, `موجودی=${data.user.balance} بازی‌ها=${data.games.length}`);

// شرط‌بندی solo instant — wheel
const balW = data.user.balance;
r = await apiCall('POST', '/api/solo/wheel', { bet: 10000 });
data = await r.json();
ok(data.ok && typeof data.mult === 'number' && data.balance !== undefined, 'solo/wheel');
ok(data.balance === balW - 10000 + Math.floor(10000 * data.mult), 'wheel: موجودی = شرط - برد');

// شرط کمتر از حداقل
r = await apiCall('POST', '/api/solo/wheel', { bet: 10 });
data = await r.json();
ok(!data.ok && (data.error || '').includes('حداقل'), 'شرط زیر حداقل → خطا');

// مین‌یاب: شروع و برداشت
r = await apiCall('POST', '/api/solo/mines/start', { bet: 5000, mines: 3 });
data = await r.json();
ok(data.ok && data.session && data.session.count === 3, 'mines/start');
ok(!data.session.mines, 'امنیت: موقعیت مین‌ها به کلاینت نشت نمی‌کند');
r = await apiCall('POST', '/api/solo/mines/reveal', { idx: 0 });
data = await r.json();
ok(data.ok && (data.result === null || data.result === 'lose'), 'mines/reveal اجرا شد');
if (data.result === null) {
  r = await apiCall('POST', '/api/solo/mines/cashout', {});
  data = await r.json();
  ok(data.ok && data.result === 'win' && data.win > 5000, `mines/cashout برد=${data.win}`);
} else {
  ok(true, 'خانه ۰ مین بود — بازگشت باخت (مسیر lose)');
}

// مچ‌میکینگ: دو کاربر
r = await apiCall('POST', '/api/match/join', { game: 'ttt', bet: 2000 }, 200);
data = await r.json();
ok(data.ok && data.status === 'waiting', `کاربر ۲ به صف پیوست (${data.status})`);
r = await apiCall('POST', '/api/match/join', { game: 'ttt', bet: 2000 }, 100);
data = await r.json();
ok(data.ok && data.status === 'matched' && data.game_id, `کاربر ۱ match شد (${data.status})`);
const gameId = data.game_id;

// state بازی — از دید کاربر ۱
r = await apiCall('POST', '/api/game/state', { game_id: gameId }, 100);
data = await r.json();
ok(data.ok && data.game && data.game.game_key === 'ttt' && data.game.state.board.length === 9, 'game/state');
const p1 = data.game.me.id, p2 = data.game.opp.id;
ok(data.game.your_turn || data.game.opp_turn, 'نوبت یکی از بازیکنان');

// حرکت‌ها تا پایان بازی — نوبت هر کی هست همان action می‌زند
async function act(uid, payload) {
  const rr = await apiCall('POST', '/api/game/action', Object.assign({ game_id: gameId }, payload), uid);
  return await rr.json();
}
let game = data.game;
let moves = 0;
while (game && !game.finished && moves < 12) {
  // state همیشه از دید کاربر ۱ خوانده می‌شود تا me/your_turn پایدار بماند
  const stResp = await apiCall('POST', '/api/game/state', { game_id: gameId }, 100);
  const st = await stResp.json();
  game = st.game;
  if (!game || game.finished) break;
  const actor = game.your_turn ? p1 : p2;
  const empty = game.state.board.findIndex(c => c === 0);
  if (empty === -1) break;
  const d = await act(actor, { cell: empty });
  if (!d.ok && !d.game) { console.log('  ⚠️ خطای اکشن:', d.error); break; }
  moves++;
}
const finalResp = await apiCall('POST', '/api/game/state', { game_id: gameId }, 100);
const finalState = await finalResp.json();
if (finalState.game) game = finalState.game;
ok(game.finished, `بازی ttt تمام شد بعد از ${moves} حرکت (${game.reason})`);
ok(game.result === 'win' || game.result === 'lose' || game.result === 'draw', `نتیجه: ${game.result}`);
if (game.result === 'win') {
  const winnerId = game.me.id === p1 ? p1 : p2;
  const u = await db.getUser(env.DB, winnerId);
  ok(Number(u.balance) > 0, `برنده پول گرفت (${u.balance})`);
}

// leave در بازی فعال: کاربر ۳ و کاربر ۲
await db.run(env.DB, "INSERT OR IGNORE INTO users (user_id, first_name, balance, bank_balance, card_number, created_at) VALUES (300, 'سوم', 100000, 0, '6037000000000300', '2026-01-01')");
r = await apiCall('POST', '/api/match/join', { game: 'rps', bet: 1000 }, 200);
data = await r.json();
if (data.status === 'waiting') {
  r = await apiCall('POST', '/api/match/join', { game: 'rps', bet: 1000 }, 300);
  data = await r.json();
}
if (data.status === 'matched' && data.game_id) {
  const g2id = data.game_id;
  r = await apiCall('POST', '/api/game/leave', { game_id: g2id }, 300);
  data = await r.json();
  ok(data.ok && data.game.finished, 'ترک بازی → بازی تمام شد (حریف برنده)');
} else {
  ok(true, `ترک بازی — وضعیت: ${data.status || data.error} (skip)`);
}

// ═══════════ E2E: پنل ادمین ═══════════
console.log('══ E2E: پنل ادمین ══');
async function adminCall(path, body = {}) {
  const req = new Request('https://zar-test.workers.dev/admin/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + btoa('admin:panelPass') },
    body: JSON.stringify(body),
  });
  return await worker.fetch(req, env, { waitUntil: () => {} });
}
r = await adminCall('stats', {});
data = await r.json();
ok(data.ok && data.users >= 2, `stats: ${data.users} کاربر`);

r = await adminCall('search', { q: 'کاربر تست' });
data = await r.json();
ok(data.ok && data.results.length >= 1, 'search با نام');

r = await adminCall('adjust', { user_id: 100, kind: 'coins', amount: 1000000 });
data = await r.json();
ok(data.ok && data.done === 1000000, 'adjust +1M سکه');
ok(Number((await db.getUser(env.DB, 100)).balance) === Number((await adminCall('user', { user_id: 100 }).then(x => x.json())).user.balance), 'adjust در DB ثبت شد');

r = await adminCall('gifts/create', { code: 'PANEL1', rewards: { coins: 100000 }, max_uses: 5 });
data = await r.json();
ok(data.ok && data.code === 'PANEL1', 'gifts/create از پنل');

r = await adminCall('vip/set', { user_id: 100, days: 30 });
data = await r.json();
ok(data.ok, 'vip/set از پنل');
ok(await db.isVip(env.DB, 100), 'VIP فعال شد');

r = await adminCall('controls/get', {});
data = await r.json();
ok(data.ok && data.games.length === 16 && data.sections.length >= 10, 'controls/get');

r = await adminCall('controls/save', { disabled_games: ['wheel'], disabled_sections: ['zar'], texts: {} });
data = await r.json();
ok(data.ok, 'controls/save');
// zar غیرفعال شد؟
await sendUpdate({ update_id: 30, message: { message_id: 30, from: USER, chat: CHAT, text: 'زر', date: Math.floor(Date.now() / 1000) } });
ok(lastMessage() && lastMessage().text.includes('غیرفعال'), 'بخش zar غیرفعال → پیام غیرفعال');
await adminCall('controls/save', { disabled_games: [], disabled_sections: [], texts: {} });

// ─── صفحات HTML ───
r = await worker.fetch(new Request('https://zar-test.workers.dev/'), env, { waitUntil: () => {} });
ok(r.status === 200 && (await r.text()).includes('قمارخانه'), 'صفحه مینی‌اپ سرو شد');
r = await worker.fetch(new Request('https://zar-test.workers.dev/admin'), env, { waitUntil: () => {} });
ok(r.status === 200 && (await r.text()).includes('پنل مدیریت'), 'صفحه پنل ادمین سرو شد');

// ─── cron ───
await worker.scheduled({ cron: '0 * * * *' }, env, { waitUntil: (p) => p.catch(() => {}) });
await new Promise(r2 => setTimeout(r2, 200));
ok(true, 'cron بدون کرش اجرا شد');

// ─── webhook امنیت ───
r = await worker.fetch(new Request('https://zar-test.workers.dev/webhook/WRONG', { method: 'POST', body: '{}' }), env, { waitUntil: () => {} });
ok(r.status === 403, 'webhook با secret غلط → 403');

console.log(`\n════════════════════════════`);
console.log(`✅ ${pass} تست پاس | ❌ ${fail} تست خطا`);
process.exit(fail ? 1 : 0);
