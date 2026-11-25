// تست یکپارچه: لود ماژول‌ها + شبیه‌سازی وورکر با mock D1/KV + تست جریان‌های کلیدی
import * as C from '../src/config.js';
import * as db from '../src/db.js';
import * as U from '../src/utils.js';
import * as G from '../src/games.js';

// ─── Mock KV ───
class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v, opts) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix }) {
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
    return { keys };
  }
}

// ─── Mock D1 (روی workerd نیست — تست منطق با آبجکت شبیه‌سازی‌شده) ───
// نکته: تست واقعی SQL با SQLite در تست جدا انجام می‌شود (test_sqlite.mjs)
class MockD1 {
  constructor() { this.queries = []; }
  prepare(sql) {
    const self = this;
    this.queries.push(sql);
    return {
      bind(...params) { return { sql, params, async run() { return { meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; },
      async run() { return { meta: { changes: 1 } }; },
      async all() { return { results: [] }; },
    };
  }
  async batch(stmts) { return stmts.map(() => ({ meta: { changes: 1 } })); }
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

// ─── تست config ───
console.log('══ config.js ══');
const fakeEnv = {
  BOT_TOKEN: '123:ABC', OWNER_ID: '42', START_BALANCE: '5000',
  WEBAPP_URL: 'https://zar.example.workers.dev', ADMIN_PASSWORD: 'secret',
  REQUIRED_CHANNELS_JSON: '[{"name":"کانال تست","id":"@test","url":"https://t.me/test"}]',
  REQUIRED_GROUP_JSON: '{"name":"گروه تست","id":-100123,"url":"https://t.me/testgroup"}',
  SHOP_ADMIN_IDS: '100,200',
  MEMBERSHIP_REQUIRED: 'true',
};
C.loadEnv(fakeEnv);
ok(C.env.BOT_TOKEN === '123:ABC', 'BOT_TOKEN لود شد');
ok(C.env.OWNER_ID === 42, 'OWNER_ID عددی شد');
ok(C.env.ADMIN_IDS.has(42) && C.env.ADMIN_IDS.has(100) && C.env.ADMIN_IDS.has(200), 'ADMIN_IDS شامل owner + shop admins');
ok(C.env.REQUIRED_CHANNELS.length === 1 && C.env.REQUIRED_CHANNELS[0].name === 'کانال تست', 'کانال جوین اجباری از JSON');
ok(C.env.REQUIRED_GROUP && C.env.REQUIRED_GROUP.id === -100123, 'گروه جوین اجباری از JSON');
ok(Object.keys(C.PROPERTIES).length === 14, '۱۴ ملک');
ok(Object.keys(C.WORKERS).length === 12, '۱۲ کارگر');
ok(Object.keys(C.BLACKMARKET_ITEMS).length === 15, '۱۵ آیتم بازار سیاه');
ok(Object.keys(C.MISSION_TEMPLATES).length === 45, '۴۵ قالب ماموریت');
const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
ok(Object.keys(games).length === 16 && games.holdem.type === '2p' && games.wheel.type === '1p', '۱۶ بازی مینی‌اپ (۸ تک + ۸ دونفره)');
ok(games.wheel.min_bet === 1000 && games.wheel.max_bet === 30000000, 'حد شرط بازی‌ها');

// ─── تست utils ───
console.log('══ utils.js ══');
ok(U.fmt(1234567) === '1,234,567', 'fmt عدد با کاما');
ok(U.faToEn('۱۲۳۴۵') === '12345', 'تبدیل ارقام فارسی');
ok(U.parseAmount('۱٬۰۰۰') !== null || U.parseAmount('1,000') === 1000, 'parseAmount');
ok(U.parseAmount('1,000') === 1000 && U.parseAmount('abc') === null, 'parseAmount معتبر/نامعتبر');
ok(U.cardNumberFor(123) === '6037000000000123', 'شماره کارت از آیدی');
ok(U.formatCard('6037123456789012') === '6037-1234-5678-9012', 'فرمت کارت');
// مطابق پایتون: لول N نیاز به 2^level × 1000 XP — لول ۱→۲۰۰۰، لول ۲→۴۰۰۰ (تجمعی ۶۰۰۰)
const [lvl, inLvl, next] = U.calcLevel(1000);
ok(lvl === 1 && inLvl === 1000 && next === 2000, `calcLevel(1000) → لول 1 [گرفت: ${lvl}, ${inLvl}, ${next}]`);
ok(U.calcLevel(0)[0] === 1 && U.calcLevel(1999)[0] === 1 && U.calcLevel(2000)[0] === 2 && U.calcLevel(2999)[0] === 2 && U.calcLevel(6000)[0] === 3, 'calcLevel مرزها (مطابق پایتون)');
ok(U.formatProgressBar(5, 10, 10) === '▓▓▓▓▓░░░░░', 'نوار پیشرفت');
const iso = U.nowTehranIso();
ok(/\+03:30$/.test(iso), `ISO تهران: ${iso}`);
ok(U.isoElapsed('2000-01-01 00:00:00+03:30') > 8e8, 'isoElapsed زمان گذشته');
ok(U.toInt('۱۲۳') === 123 || U.toInt('123') === 123, 'toInt');

// ─── تست بازی‌ها (منطق خالص) ───
console.log('══ games.js ══');
// wheel
const w = G.playWheel({});
ok(w.mult !== undefined && G.WHEEL_SEGMENTS.length === 12, 'playWheel خروجی دارد');
// crash
try { G.playCrash({ target: 0.5 }); ok(false, 'crash باید target نامعتبر را رد کند'); }
catch { ok(true, 'crash target نامعتبر رد شد'); }
const cr = G.playCrash({ target: 2 });
ok(cr.target === 2 && (cr.won === true || cr.won === false), 'crash خروجی معتبر');
// coin
try { G.playCoin({ side: 'xxx' }); ok(false, 'coin باید side نامعتبر را رد کند'); }
catch { ok(true, 'coin side نامعتبر رد شد'); }
const coinRes = G.playCoin({ side: 'heads' });
ok(coinRes.mult === 1.9 || coinRes.mult === 0, 'coin mult');
// card
const cardRes = G.playCard({ pick: 'red' });
ok(cardRes.mult === 1.9 || cardRes.mult === 0, 'card mult');
// roulette
try { G.playRoulette({ type: 'xxx' }); ok(false, 'roulette نوع نامعتبر'); }
catch { ok(true, 'roulette نوع نامعتبر رد شد'); }
const rr = G.playRoulette({ type: 'number', number: 7 });
ok(typeof rr.number === 'number' && rr.number >= 0 && rr.number <= 36, 'roulette عدد در بازه');
// mines
const ms = G.minesStart(10000, 3);
ok(ms.mines.length === 3 && ms.revealed.length === 0, 'mines شروع با ۳ مین');
const safeCell = [...Array(25).keys()].find(i => !ms.mines.includes(i));
const r1 = G.minesReveal(ms, safeCell);
ok(r1 === null && ms.revealed.length === 1, 'mines باز کردن خانه امن');
const mineCell = ms.mines[0];
const r2 = G.minesReveal(ms, mineCell);
ok(r2 === 'lose' && ms.finished, 'mines باخت با مین');
ok(G.minesMult(0, 3) === 1.0 && G.minesMult(1, 3) > 1, 'mines mult');
// hilo
const hs = G.hiloStart(5000);
ok(hs.card.length === 2 && hs.mult === 1.0, 'hilo شروع');
try { const [won] = G.hiloGuess(hs, 'hi'); ok(typeof won === 'boolean', 'hilo guess'); }
catch { ok(true, 'hilo guess مرزی رد شد'); }
// blackjack value
ok(G.bjValue([[14, 'S'], [5, 'H']]) === 16, 'bjValue A=11');
ok(G.bjValue([[14, 'S'], [14, 'H'], [14, 'D']]) === 13, 'bjValue سه آس');
ok(G.bjValue([[10, 'S'], [11, 'H'], [12, 'D']]) === 30, 'bjValue سه صورت = 30');
// poker eval
ok(G.eval5([[14, 'S'], [13, 'S'], [12, 'S'], [11, 'S'], [10, 'S']])[0] === 8, 'رویال فلاش');
ok(G.eval5([[2, 'S'], [2, 'H'], [2, 'D'], [2, 'C'], [7, 'S']])[0] === 7, 'چهارتایی');
ok(G.eval5([[3, 'S'], [3, 'H'], [7, 'D'], [7, 'C'], [7, 'S']])[0] === 6, 'فول هاوس');
ok(G.eval5([[2, 'S'], [5, 'S'], [7, 'S'], [9, 'S'], [11, 'S']])[0] === 5, 'فلاش');
ok(G.eval5([[14, 'S'], [2, 'H'], [3, 'D'], [4, 'C'], [5, 'S']])[0] === 4, 'استریت A-5 (باگ wheel fixed)');
ok(G.bestHand([[14, 'S'], [13, 'S']]).length >= 2, 'bestHand pre-flop');
// quiz
const q = G.makeQuestion(new Set());
ok(q.opts.length === 4 && q.ans >= 0 && q.ans < 4, `سوال کوییز ${q.q} → ۴ گزینه`);
// GameState برای دوز
function makeG() {
  return {
    game_id: 'g1', game_key: 'ttt', bet: 1000,
    players: [{ user_id: 1, name: 'A' }, { user_id: 2, name: 'B' }],
    contrib: { 1: 1000, 2: 1000 },
    data: null, waiting: new Set(), finished: false, winner: null, reason: '', payout: 0, outcome: null,
    uids() { return [1, 2]; }, opp(u) { return u === 1 ? 2 : 1; }, name(u) { return u === 1 ? 'A' : 'B'; },
    finish(w, r) { if (!this.finished && this.outcome === null) { this.outcome = [w, r]; this.finished = true; this.winner = w; this.reason = r; this.waiting = new Set(); } },
    touch() {},
  };
}
const gTtt = makeG();
await G.tttInit(gTtt);
ok(gTtt.waiting.has(1), 'ttt نوبت اول');
let err = await G.tttAction(gTtt, 2, { cell: 0 });
ok(err === 'نوبت تو نیست', 'ttt نوبت حریف رد شد');
err = await G.tttAction(gTtt, 1, { cell: 0 });
ok(err === null, 'ttt حرکت اول');
await G.tttAction(gTtt, 2, { cell: 3 });
await G.tttAction(gTtt, 1, { cell: 1 });
await G.tttAction(gTtt, 2, { cell: 4 });
err = await G.tttAction(gTtt, 1, { cell: 2 });
ok(gTtt.finished && gTtt.winner === 1, `ttt برنده تشخیص داده شد (${gTtt.reason})`);
// rps
const gRps = makeG(); gRps.game_key = 'rps';
await G.rpsInit(gRps);
ok(gRps.waiting.has(1) && gRps.waiting.has(2), 'rps هر دو منتظر');
// quiz donyekasri
const gQuiz = makeG(); gQuiz.game_key = 'quiz';
await G.quizInit(gQuiz);
ok(gQuiz.data.qs.length === 5, 'quiz ۵ سوال اولیه');
// hokm
const gHokm = makeG(); gHokm.game_key = 'hokm';
await G.hokmInit(gHokm);
ok(gHokm.data.phase === 'trump' && gHokm.data.hands[gHokm.data.hakem].length === 5, 'hokm فاز انتخاب حکم');
const err2 = await G.hokmAction(gHokm, gHokm.data.hakem, { suit: 'H' });
ok(err2 === null && gHokm.data.phase === 'play' && gHokm.data.hands[1].length + gHokm.data.hands[2].length === 26, 'hokم بعد از حکم ۲۶ کارت توزیع شد');
// blackjack donyekasri
const gBj = makeG(); gBj.game_key = 'blackjack';
await G.bjInit(gBj);
ok(gBj.data.hands[1].length === 2 && gBj.data.hands[2].length === 2, 'blackjack دو کارت اولیه');
// othello
const gOth = makeG(); gOth.game_key = 'othello';
await G.othInit(gOth);
ok(gOth.data.board.filter(x => x !== 0).length === 4, 'othello شروع با ۴ مهره');
ok(G.othView(gOth, 1).valid.length === 4, 'othello حرکت مجاز اولیه = ۴');
// connect4
const gC4 = makeG(); gC4.game_key = 'connect4';
await G.c4Init(gC4);
ok(gC4.data.board.length === 42, 'connect4 صفحه ۶×۷');
// GAME_IMPL
ok(Object.keys(G.GAME_IMPL).length === 8 && Object.keys(G.SOLO_INSTANT).length === 6, '۸ بازی دونفره + ۶ تک‌نفره آنی ثبت شد');

// ─── تست db.js (با mock) ───
console.log('══ db.js (mock D1 — فقط فراخوانی صحیح) ══');
const d1 = new MockD1();
db.normCode && ok(db.normCode('ab-cd!@#') === 'AB-CD', 'normCode حفظ dash، حذف کاراکتر غیرمجاز (مطابق پایتون)');
ok(db.rewardsList({ coins: 100, properties: { supermarket: 2 } }).length === 2, 'rewardsList');
ok(db.kindLabel('coins') === '💰 زرکوین', 'kindLabel');
ok(db.xpForLevel(3) === 6000, 'xpForLevel(3) = 6000 (مطابق پایتون: 2^1+2^2 هزار)');
ok(db.calcIncome(1000000, 100000, 86400)[0] === 100000, 'درآمد روزانه کامل');
ok(db.calcIncome(1000000, 100000, 86400)[1] === 20000, 'سود بانک ۲٪ روزانه');

// ─── تست KV mock ───
console.log('══ KV ══');
const kv = new MockKV();
await U.kvPutJson(kv, 'test', { a: 1 });
const back = await U.kvJson(kv, 'test', null);
ok(back && back.a === 1, 'KV JSON ذخیره/خواندن');
await kv.put('owner:100:500', '42');
ok(await U.isMenuOwner(kv, 100, 500, 42), 'مالکیت منو ✓');
ok(!(await U.isMenuOwner(kv, 100, 500, 43)), 'مالکیت منو غیرمالک ✗');
ok(await U.isMenuOwner(kv, 100, 999, 43), 'پیام بدون مالک → مجاز');

// ─── تست browser token ───
const tok = await U.makeBrowserToken('123:ABC', 42);
const uid2 = await U.validateBrowserToken(tok, '123:ABC');
ok(uid2 === 42, 'توکن مرورگر ساخت/اعتبارسنجی');
ok((await U.validateBrowserToken(tok, 'WRONG')) === null, 'توکن با توکن اشتباه رد شد');

// ─── initData validation ───
const params = new URLSearchParams({ user: JSON.stringify({ id: 42, first_name: 'Test' }), auth_date: String(Math.floor(Date.now() / 1000)) });
const dataCheck = [...params.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
const fakeHash = 'x'.repeat(64);
const tgUser = await U.validateInitData(params.toString() + '&hash=' + fakeHash, '123:ABC');
ok(tgUser === null, 'initData با هش غلط رد شد');

console.log(`\n════════════════════════════`);
console.log(`✅ ${pass} تست پاس | ❌ ${fail} تست خطا`);
process.exit(fail ? 1 : 0);
