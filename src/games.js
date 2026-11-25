// ═══════════ منطق بازی‌های کازینو و بازی‌های دونفره — پورت کامل games/*.py ═══════════
import { randInt, choice, shuffle } from './utils.js';

// ─── کارت‌ها ───
export const SUITS = 'SHDC';
export const SUIT_SORT = 'SHCD';

export function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push([r, s]);
  return shuffle(d);
}
export function cj(c) { return { r: c[0], s: c[1], id: `${c[0]}${c[1]}` }; }
export function randCard() { return [randInt(2, 14), choice(SUITS.split(''))]; }

// ═══════════ تک‌نفره‌ی آنی (خروجی: mult = ضریب روی کل شرط) ═══════════
export const WHEEL_SEGMENTS = [0, 1.5, 0, 2, 0.5, 0, 5, 0, 1.5, 0.5, 0, 0.5]; // EV ≈ 0.96

export function playWheel(body) {
  const idx = randInt(0, WHEEL_SEGMENTS.length - 1);
  return { index: idx, mult: WHEEL_SEGMENTS[idx] };
}

export function playCrash(body) {
  let t = parseFloat(body?.target);
  if (t == null || isNaN(t) || t < 1.01 || t > 100) throw new Error('ضریب هدف باید بین ۱٫۰۱ تا ۱۰۰ باشد');
  t = Math.round(t * 100) / 100;
  const r = Math.random();
  const crash = Math.max(1.0, Math.min(Math.floor((0.96 / (1.0 - r)) * 100) / 100, 1000.0));
  const won = crash >= t;
  return { crash, target: t, won, mult: won ? t : 0 };
}

export function playCoin(body) {
  const side = body?.side;
  if (side !== 'heads' && side !== 'tails') throw new Error('شیر یا خط را انتخاب کن');
  const result = choice(['heads', 'tails']);
  const won = result === side;
  return { result, won, mult: won ? 1.9 : 0 };
}

export function playCard(body) {
  const pick = body?.pick;
  if (!['red', 'black', 'S', 'H', 'D', 'C'].includes(pick)) throw new Error('رنگ یا خال را انتخاب کن');
  const c = randCard();
  const red = 'HD'.includes(c[1]);
  let won, mult;
  if (pick === 'red' || pick === 'black') {
    won = (pick === 'red') === red;
    mult = won ? 1.9 : 0;
  } else {
    won = c[1] === pick;
    mult = won ? 3.8 : 0;
  }
  return { card: cj(c), won, mult };
}

export const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const ROULETTE_BETS = { red: 2, black: 2, even: 2, odd: 2, low: 2, high: 2, dozen1: 3, dozen2: 3, dozen3: 3, number: 36 };

export function playRoulette(body) {
  const bt = body?.type;
  if (!ROULETTE_BETS[bt]) throw new Error('نوع شرط رولت نامعتبر است');
  let num = null;
  if (bt === 'number') {
    num = parseInt(body?.number, 10);
    if (!Number.isInteger(num) || num < 0 || num > 36) throw new Error('عدد باید بین ۰ تا ۳۶ باشد');
  }
  const n = randInt(0, 36);
  const color = n === 0 ? 'green' : (ROULETTE_RED.has(n) ? 'red' : 'black');
  const won = {
    red: color === 'red', black: color === 'black',
    even: n !== 0 && n % 2 === 0, odd: n % 2 === 1,
    low: n >= 1 && n <= 18, high: n >= 19 && n <= 36,
    dozen1: n >= 1 && n <= 12, dozen2: n >= 13 && n <= 24, dozen3: n >= 25 && n <= 36,
    number: n === num,
  }[bt];
  return { number: n, color, won, mult: won ? ROULETTE_BETS[bt] : 0 };
}

// ─── پنالتی ───
export function playPenalty(body) {
  const shot = body?.dir;
  if (!['left', 'center', 'right'].includes(shot)) throw new Error('جهت شوت را انتخاب کن');
  const keeper = choice(['left', 'center', 'right']);
  const goal = keeper !== shot;
  return { dir: shot, keeper, goal, won: goal, mult: goal ? 1.45 : 0 };
}

// ═══════════ مین‌یاب ═══════════
export const MINES_CELLS = 25;
export const MINES_EDGE = 0.97;
export const MINES_COUNTS = [1, 3, 5, 10, 15, 20];

export function minesMult(k, m) {
  if (k <= 0) return 1.0;
  let p = 1.0;
  for (let i = 0; i < k; i++) p *= (MINES_CELLS - i) / (MINES_CELLS - m - i);
  return Math.round(p * MINES_EDGE * 10000) / 10000;
}

export function minesStart(bet, count) {
  if (!MINES_COUNTS.includes(count)) throw new Error('تعداد مین نامعتبر است');
  const mines = shuffle([...Array(MINES_CELLS).keys()]).slice(0, count);
  return { type: 'mines', bet, count, mines, revealed: [] };
}

export function minesReveal(s, idx) {
  if (!(idx >= 0 && idx < MINES_CELLS) || s.revealed.includes(idx)) throw new Error('خانه نامعتبر است');
  if (s.mines.includes(idx)) {
    s.finished = true;
    s.boom = idx;
    return 'lose';
  }
  s.revealed.push(idx);
  if (s.revealed.length >= MINES_CELLS - s.count) return 'win';
  return null;
}

export function minesPayout(s) { return Math.floor(s.bet * minesMult(s.revealed.length, s.count)); }

export function minesView(s, reveal = false) {
  const k = s.revealed.length;
  const safeLeft = MINES_CELLS - s.count - k;
  const v = {
    type: 'mines', bet: s.bet, count: s.count, revealed: [...s.revealed],
    mult: minesMult(k, s.count),
    next_mult: safeLeft > 0 ? minesMult(k + 1, s.count) : null,
    potential: k ? minesPayout(s) : 0, finished: !!s.finished,
  };
  if (reveal || s.finished) {
    v.mines = [...s.mines].sort((a, b) => a - b);
    if (s.boom !== undefined) v.boom = s.boom;
  }
  return v;
}

// ═══════════ بالا پایین ═══════════
export function hiloStart(bet) {
  const c = randCard();
  return { type: 'hilo', bet, card: c, mult: 1.0, steps: 0, history: [c] };
}

export function hiloGuess(s, direction) {
  if (direction !== 'hi' && direction !== 'lo') throw new Error('حدس نامعتبر است');
  const r = s.card[0];
  const p = direction === 'hi' ? (14 - r) / 13 : (r - 2) / 13;
  if (p <= 0) throw new Error('این حدس ممکن نیست');
  const nxt = randCard();
  const won = direction === 'hi' ? nxt[0] > r : nxt[0] < r;
  s.history.push(nxt);
  s.card = nxt;
  if (won) {
    s.mult = Math.min(s.mult * 0.97 / p, 1000.0);
    s.steps += 1;
  } else {
    s.finished = true;
  }
  return [won, nxt];
}

export function hiloPayout(s) { return Math.floor(s.bet * s.mult); }

export function hiloView(s) {
  const r = s.card[0];
  const pHi = (14 - r) / 13, pLo = (r - 2) / 13;
  return {
    type: 'hilo', bet: s.bet, card: cj(s.card), mult: Math.round(s.mult * 10000) / 10000,
    steps: s.steps,
    hi_mult: pHi > 0 ? Math.round(s.mult * 0.97 / pHi * 100) / 100 : null,
    lo_mult: pLo > 0 ? Math.round(s.mult * 0.97 / pLo * 100) / 100 : null,
    potential: s.steps ? hiloPayout(s) : 0,
    history: s.history.slice(-8).map(cj), finished: !!s.finished,
  };
}

// ═══════════ بازی‌های دونفره — رابط: init(g) / action(g, uid, body) / view(g, uid) ═══════════
// پایان بازی: g.finish(winnerUid | null, reason)

// ─── بلک‌جک ───
export function bjValue(cards) {
  let total = 0, aces = 0;
  for (const [r] of cards) {
    if (r === 14) { total += 11; aces += 1; }
    else if (r >= 10) total += 10;
    else total += r;
  }
  while (total > 21 && aces) { total -= 10; aces -= 1; }
  return total;
}

function bjResolve(g) {
  const [a, b] = g.uids();
  const va = bjValue(g.data.hands[a]), vb = bjValue(g.data.hands[b]);
  if (va > 21 && vb > 21) g.finish(null, 'هر دو سوختید — مساوی');
  else if (va > 21) g.finish(b, `${g.name(b)} سوخت (${vb})`);
  else if (vb > 21) g.finish(a, `${g.name(a)} سوخت (${va})`);
  else if (va === vb) g.finish(null, `امتیاز برابر (${va}) — مساوی`);
  else {
    const w = va > vb ? a : b;
    g.finish(w, `${g.name(w)} با ${Math.max(va, vb)} در برابر ${Math.min(va, vb)} برد`);
  }
}

export async function bjInit(g) {
  const deck = newDeck();
  const [a, b] = g.uids();
  const hands = { [a]: [deck.pop(), deck.pop()], [b]: [deck.pop(), deck.pop()] };
  const done = {};
  for (const u of [a, b]) done[u] = bjValue(hands[u]) === 21;
  g.data = { deck, hands, done };
  g.waiting = new Set([a, b].filter(u => !done[u]));
  if (g.waiting.size === 0) bjResolve(g);
}

export async function bjAction(g, uid, body) {
  if (!g.waiting.has(uid)) return 'نوبت تو تمام شده — منتظر حریف باش';
  const d = g.data;
  const act = body?.action;
  if (act === 'hit') {
    d.hands[uid].push(d.deck.pop());
    if (bjValue(d.hands[uid]) >= 21) { d.done[uid] = true; g.waiting.delete(uid); }
  } else if (act === 'stand') {
    d.done[uid] = true;
    g.waiting.delete(uid);
  } else {
    return 'حرکت نامعتبر است';
  }
  if (g.waiting.size === 0) bjResolve(g);
  return null;
}

export function bjView(g, uid) {
  const d = g.data;
  const o = g.opp(uid);
  const show = g.finished;
  return {
    my_cards: d.hands[uid].map(cj), my_value: bjValue(d.hands[uid]), my_done: d.done[uid],
    opp_cards: d.hands[o].map((c, i) => (show || i === 0) ? cj(c) : null),
    opp_value: show ? bjValue(d.hands[o]) : null, opp_done: d.done[o],
  };
}

// ─── حکم ───
function sortHand(hand) { return [...hand].sort((a, b) => SUIT_SORT.indexOf(a[1]) - SUIT_SORT.indexOf(b[1]) || a[0] - b[0]); }

export async function hokmInit(g) {
  const deck = newDeck();
  const [a, b] = g.uids();
  const hakem = choice([a, b]);
  g.data = {
    deck, hands: { [hakem]: sortHand(Array.from({ length: 5 }, () => deck.pop())) }, // 5 کارت اول
    hakem, trump: null, phase: 'trump', table: [], tricks: { [a]: 0, [b]: 0 }, last_trick: null,
  };
  g.data.hands[g.opp(hakem)] = [];
  g.waiting = new Set([hakem]);
}

export async function hokmAction(g, uid, body) {
  const d = g.data;
  if (!g.waiting.has(uid)) return 'نوبت تو نیست';
  if (d.phase === 'trump') {
    const suit = body?.suit;
    if (!SUITS.includes(suit)) return 'خال حکم نامعتبر است';
    d.trump = suit;
    const hakem = d.hakem, other = g.opp(hakem);
    d.hands[hakem] = sortHand(d.hands[hakem].concat(Array.from({ length: 8 }, () => d.deck.pop())));
    d.hands[other] = sortHand(Array.from({ length: 13 }, () => d.deck.pop()));
    d.phase = 'play';
    g.waiting = new Set([hakem]);
    return null;
  }
  const cid = String(body?.card || '');
  const hand = d.hands[uid];
  const card = hand.find(c => `${c[0]}${c[1]}` === cid);
  if (!card) return 'این کارت در دست تو نیست';
  if (d.table.length) {
    const led = d.table[0][1][1];
    if (card[1] !== led && hand.some(c => c[1] === led)) return 'باید هم‌خال بازی کنی';
  }
  hand.splice(hand.indexOf(card), 1);
  d.table.push([uid, card]);
  if (d.table.length === 1) {
    g.waiting = new Set([g.opp(uid)]);
    return null;
  }
  const [[u1, c1], [u2, c2]] = d.table;
  let w;
  if (c2[1] === c1[1]) w = c2[0] > c1[0] ? u2 : u1;
  else if (c2[1] === d.trump) w = u2;
  else w = u1;
  d.tricks[w] += 1;
  d.last_trick = { cards: [...d.table], winner: w };
  d.table = [];
  if (d.tricks[w] >= 7) {
    g.finish(w, `${g.name(w)} هفت دست برد`);
    return null;
  }
  g.waiting = new Set([w]);
  return null;
}

export function hokmView(g, uid) {
  const d = g.data;
  const o = g.opp(uid);
  const hand = d.hands[uid];
  const led = d.table.length ? d.table[0][1][1] : null;
  const hasLed = led !== null && hand.some(c => c[1] === led);
  const myTurn = g.waiting.has(uid) && d.phase === 'play';
  const cards = hand.map(c => {
    const j = cj(c);
    j.playable = !!(myTurn && (!hasLed || c[1] === led));
    return j;
  });
  let lt = null;
  if (d.last_trick) {
    lt = {
      cards: d.last_trick.cards.map(([u, c]) => ({ card: cj(c), mine: u === uid })),
      i_won: d.last_trick.winner === uid,
    };
  }
  return {
    phase: d.phase, trump: d.trump, i_am_hakem: d.hakem === uid, my_hand: cards,
    opp_count: d.hands[o].length,
    table: d.table.map(([u, c]) => ({ card: cj(c), mine: u === uid })),
    tricks_me: d.tricks[uid], tricks_opp: d.tricks[o], last_trick: lt,
  };
}

// ─── پوکر تگزاس هولدم (هدز‌آپ، رِیز آزاد) ───
export const HAND_NAMES = ['کارت بالا', 'یک جفت', 'دو جفت', 'سه‌تایی', 'استریت', 'فلاش', 'فول هاوس', 'چهارتایی', 'استریت فلاش'];
export const STREET_NAMES = ['پیش از فلاپ', 'فلاپ', 'ترن', 'ریور', 'شودان'];
const HOLDEM_MAX_RAISES = 4;

export function eval5(cs) {
  const ranks = cs.map(c => c[0]).sort((a, b) => b - a);
  const flush = new Set(cs.map(c => c[1])).size === 1;
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let sh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) sh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) sh = 5;
  }
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(x => x[1]);
  const gr = groups.map(x => parseInt(x[0], 10));
  if (sh && flush) return [8, sh];
  if (shape[0] === 4) return [7, ...gr];
  if (shape[0] === 3 && shape[1] === 2) return [6, ...gr];
  if (flush) return [5, ...ranks];
  if (sh) return [4, sh];
  if (shape[0] === 3) return [3, ...gr];
  if (shape[0] === 2 && shape[1] === 2) return [2, ...gr];
  if (shape[0] === 2) return [1, ...gr];
  return [0, ...ranks];
}

function combos(arr, k) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i <= arr.length - (k - cur.length); i++) {
      cur.push(arr[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

export function bestHand(cards) {
  if (cards.length < 5) {
    const ranks = cards.map(c => c[0]).sort((a, b) => b - a);
    if (ranks.length === 2 && ranks[0] === ranks[1]) return [1, ranks[0]];
    return [0, ...ranks];
  }
  return combos(cards, 5).map(eval5).reduce((best, cur) => cur > best ? cur : best);
}

export function handName(score) {
  return (score[0] === 8 && score[1] === 14) ? 'رویال فلاش' : HAND_NAMES[score[0]];
}

function holdemMinRaise(g) { return Math.max(1, Math.floor(g.bet / 10)); }
function hlog(g, text) { g.data.log = [...g.data.log, text].slice(-6); }

function holdemShowdown(g) {
  const d = g.data;
  const [a, b] = g.uids();
  d.street = 4;
  d.showdown = true;
  const sa = bestHand(d.hole[a].concat(d.board)), sb = bestHand(d.hole[b].concat(d.board));
  d.final = { [a]: handName(sa), [b]: handName(sb) };
  if (sa.join() === sb.join()) {
    g.finish(null, `دست برابر (${handName(sa)}) — پات تقسیم شد`);
  } else {
    const w = sa > sb ? a : b;
    g.finish(w, `${g.name(w)} با ${d.final[w]} برد`);
  }
}

function holdemNextStreet(g) {
  const d = g.data;
  const [a, b] = g.uids();
  if (d.street >= 3) { holdemShowdown(g); return; }
  d.street += 1;
  d.sbets = { [a]: 0, [b]: 0 };
  d.acted = new Set();
  d.raises = 0;
  hlog(g, `— ${STREET_NAMES[d.street]} —`);
  g.waiting = new Set([b]);
}

export async function holdemInit(g) {
  const deck = newDeck();
  const [a, b] = g.uids();
  g.data = {
    hole: { [a]: [deck.pop(), deck.pop()], [b]: [deck.pop(), deck.pop()] },
    board: Array.from({ length: 5 }, () => deck.pop()), // فقط سمت سرور
    street: 0, sbets: { [a]: 0, [b]: 0 }, acted: new Set(), raises: 0,
    log: [], showdown: false, allin: false, bal: { [a]: 0, [b]: 0 },
  };
  g.waiting = new Set([a]);
}

export async function holdemPrepare(g, getBalance) {
  for (const u of g.uids()) g.data.bal[u] = await getBalance(u);
}

function raiseBounds(g, uid) {
  const d = g.data;
  const o = g.opp(uid);
  const diff = Math.max(0, (d.sbets[o] || 0) - (d.sbets[uid] || 0));
  const mx = Math.max(0, Math.min((d.bal[uid] || 0) - diff, d.bal[o] || 0));
  return [diff, holdemMinRaise(g), mx];
}

export async function holdemAction(g, uid, body, db /* {deduct, add, balance} */) {
  const d = g.data;
  if (!g.waiting.has(uid)) return 'نوبت تو نیست';
  const act = body?.action;
  const o = g.opp(uid);
  const diff = (d.sbets[o] || 0) - (d.sbets[uid] || 0);
  const name = g.name(uid);
  const fmtN = n => Math.floor(n).toLocaleString('en-US');
  if (act === 'fold') {
    hlog(g, `${name} فولد کرد`);
    g.finish(o, `${name} فولد کرد`);
    return null;
  }
  if (act === 'check') {
    if (diff > 0) return 'باید کال یا فولد کنی';
    hlog(g, `${name} چک کرد`);
  } else if (act === 'call') {
    if (diff <= 0) {
      hlog(g, `${name} چک کرد`);
    } else if (await db.deduct(uid, diff)) {
      g.contrib[uid] += diff;
      d.sbets[uid] += diff;
      hlog(g, `${name} کال کرد (${fmtN(diff)})`);
    } else {
      // آل‌این کوتاه: هر چه دارد می‌گذارد و مازاد رِیز به حریف برمی‌گردد
      let pay = Math.max(0, await db.balance(uid));
      if (pay > 0 && !(await db.deduct(uid, pay))) pay = 0;
      const short = diff - pay;
      g.contrib[uid] += pay;
      d.sbets[uid] += pay;
      if (short > 0) {
        g.contrib[o] -= short;
        d.sbets[o] -= short;
        await db.add(o, short);
      }
      d.allin = true;
      hlog(g, `${name} آل‌این کال کرد (${fmtN(pay)})`);
      holdemShowdown(g);
      return null;
    }
  } else if (act === 'raise') {
    if (d.raises >= HOLDEM_MAX_RAISES) return 'سقف رِیز این مرحله پر شده';
    const [diff0, mn, mx] = raiseBounds(g, uid);
    const amount = parseInt(body?.amount || '0', 10) || 0;
    if (mx <= 0) return 'موجودی تو یا حریف برای رِیز کافی نیست';
    if (amount > mx) return `حداکثر رِیز ${fmtN(mx)} است`;
    if (amount < Math.min(mn, mx)) return `حداقل رِیز ${fmtN(Math.min(mn, mx))} است`;
    const total = diff0 + amount;
    if (!(await db.deduct(uid, total))) return 'موجودی کافی نیست';
    g.contrib[uid] += total;
    d.sbets[uid] += total;
    d.raises += 1;
    d.acted = new Set([uid]);
    hlog(g, `${name} رِیز کرد (+${fmtN(amount)})` + (amount === mx ? ' — آل‌این!' : ''));
    g.waiting = new Set([o]);
    return null;
  } else {
    return 'حرکت نامعتبر است';
  }
  d.acted.add(uid);
  if (d.acted.size >= 2 && d.sbets[uid] === d.sbets[o]) {
    holdemNextStreet(g);
  } else {
    g.waiting = new Set([o]);
  }
  return null;
}

export function holdemView(g, uid) {
  const d = g.data;
  const o = g.opp(uid);
  const street = d.street;
  const n = d.showdown ? 5 : [0, 3, 4, 5, 5][Math.min(street, 4)];
  const board = d.board.slice(0, n);
  const [diff, mn, mx] = raiseBounds(g, uid);
  const showOpp = d.showdown;
  return {
    street, street_name: STREET_NAMES[Math.min(street, 4)], board: board.map(cj),
    my_cards: d.hole[uid].map(cj),
    opp_cards: showOpp ? d.hole[o].map(cj) : [null, null],
    my_hand: handName(bestHand(d.hole[uid].concat(board))),
    opp_hand: showOpp ? (d.final || {})[o] : null,
    can_check: diff <= 0, call_amount: diff,
    min_raise: mx > 0 ? Math.min(mn, mx) : 0, max_raise: mx,
    can_raise: d.raises < HOLDEM_MAX_RAISES && mx > 0,
    my_balance: d.bal[uid] || 0,
    my_contrib: g.contrib[uid] || 0, opp_contrib: g.contrib[o] || 0,
    log: d.log, showdown: d.showdown,
  };
}

// ─── سنگ کاغذ قیچی ───
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const RPS_MAX_ROUNDS = 9;

export async function rpsInit(g) {
  const [a, b] = g.uids();
  g.data = { score: { [a]: 0, [b]: 0 }, picks: {}, history: [], round: 1 };
  g.waiting = new Set([a, b]);
}

export async function rpsAction(g, uid, body) {
  const pick = body?.pick;
  if (!RPS_BEATS[pick]) return 'انتخاب نامعتبر است';
  if (!g.waiting.has(uid)) return 'این دست را انتخاب کرده‌ای — منتظر حریف باش';
  const d = g.data;
  d.picks[uid] = pick;
  g.waiting.delete(uid);
  if (Object.keys(d.picks).length < 2) return null;
  const [a, b] = g.uids();
  const pa = d.picks[a], pb = d.picks[b];
  let w = null;
  if (RPS_BEATS[pa] === pb) w = a;
  else if (RPS_BEATS[pb] === pa) w = b;
  if (w !== null) d.score[w] += 1;
  d.history.push({ picks: { [a]: pa, [b]: pb }, winner: w });
  d.picks = {};
  if (Math.max(d.score[a], d.score[b]) >= 2) {
    const win = d.score[a] > d.score[b] ? a : b;
    g.finish(win, `${g.name(win)} دو دست برد`);
    return null;
  }
  if (d.round >= RPS_MAX_ROUNDS) {
    if (d.score[a] === d.score[b]) {
      g.finish(null, '۹ دست تمام شد — مساوی');
    } else {
      const win = d.score[a] > d.score[b] ? a : b;
      g.finish(win, `${g.name(win)} با امتیاز بیشتر برد`);
    }
    return null;
  }
  d.round += 1;
  g.waiting = new Set([a, b]);
  return null;
}

export function rpsView(g, uid) {
  const d = g.data;
  const o = g.opp(uid);
  const hist = d.history.map(h => ({
    me: h.picks[uid], opp: h.picks[o],
    result: h.winner === null ? 'draw' : (h.winner === uid ? 'win' : 'lose'),
  }));
  return {
    score_me: d.score[uid], score_opp: d.score[o], my_pick: d.picks[uid],
    opp_picked: o in d.picks, round: d.round, history: hist,
  };
}

// ─── دوز ───
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export async function tttInit(g) {
  const [a, b] = g.uids();
  g.data = { board: Array(9).fill(0), marks: { [a]: 1, [b]: 2 }, line: null };
  g.waiting = new Set([a]);
}

export async function tttAction(g, uid, body) {
  if (!g.waiting.has(uid)) return 'نوبت تو نیست';
  const i = parseInt(body?.cell, 10);
  const board = g.data.board;
  if (!(i >= 0 && i < 9) || board[i]) return 'این خانه قابل انتخاب نیست';
  const mark = g.data.marks[uid];
  board[i] = mark;
  for (const line of TTT_LINES) {
    if (line.every(x => board[x] === mark)) {
      g.data.line = line;
      g.finish(uid, `${g.name(uid)} سه‌تا در یک خط چید`);
      return null;
    }
  }
  if (board.every(Boolean)) {
    g.finish(null, 'صفحه پر شد — مساوی');
    return null;
  }
  g.waiting = new Set([g.opp(uid)]);
  return null;
}

export function tttView(g, uid) {
  return { board: g.data.board, my_mark: g.data.marks[uid], line: g.data.line };
}

// ─── چهار در یک ردیف ───
const C4_ROWS = 6, C4_COLS = 7;

function c4Line(board, r, c, d) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [[r, c]];
    for (const sign of [1, -1]) {
      let rr = r + dr * sign, cc = c + dc * sign;
      while (rr >= 0 && rr < C4_ROWS && cc >= 0 && cc < C4_COLS && board[rr * C4_COLS + cc] === d) {
        cells.push([rr, cc]);
        rr += dr * sign;
        cc += dc * sign;
      }
    }
    if (cells.length >= 4) return cells.map(([x, y]) => x * C4_COLS + y);
  }
  return null;
}

export async function c4Init(g) {
  const [a, b] = g.uids();
  g.data = { board: Array(C4_ROWS * C4_COLS).fill(0), discs: { [a]: 1, [b]: 2 }, line: null, last: null };
  g.waiting = new Set([a]);
}

export async function c4Action(g, uid, body) {
  if (!g.waiting.has(uid)) return 'نوبت تو نیست';
  const c = parseInt(body?.col, 10);
  if (!(c >= 0 && c < C4_COLS)) return 'ستون نامعتبر است';
  const board = g.data.board;
  const d = g.data.discs[uid];
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    if (board[r * C4_COLS + c] === 0) {
      board[r * C4_COLS + c] = d;
      g.data.last = r * C4_COLS + c;
      const line = c4Line(board, r, c, d);
      if (line) {
        g.data.line = line;
        g.finish(uid, `${g.name(uid)} چهار مهره پشت‌سرهم چید`);
      } else if (board.every(Boolean)) {
        g.finish(null, 'صفحه پر شد — مساوی');
      } else {
        g.waiting = new Set([g.opp(uid)]);
      }
      return null;
    }
  }
  return 'این ستون پر است';
}

export function c4View(g, uid) {
  return { board: g.data.board, my_disc: g.data.discs[uid], line: g.data.line, last: g.data.last, rows: C4_ROWS, cols: C4_COLS };
}

// ─── اتللو (رِوِرسی ۸×۸) ───
const O_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function oFlips(board, idx, d) {
  if (board[idx]) return [];
  const r = Math.floor(idx / 8), c = idx % 8;
  const o = 3 - d;
  const flips = [];
  for (const [dr, dc] of O_DIRS) {
    const line = [];
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr * 8 + cc] === o) {
      line.push(rr * 8 + cc);
      rr += dr;
      cc += dc;
    }
    if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && board[rr * 8 + cc] === d) {
      flips.push(...line);
    }
  }
  return flips;
}

function oMoves(board, d) {
  const out = [];
  for (let i = 0; i < 64; i++) if (!board[i] && oFlips(board, i, d).length) out.push(i);
  return out;
}

export async function othInit(g) {
  const [a, b] = g.uids();
  const board = Array(64).fill(0);
  board[27] = 2; board[36] = 2; board[28] = 1; board[35] = 1;
  g.data = { board, discs: { [a]: 1, [b]: 2 }, last: null, flipped: [], passed: null };
  g.waiting = new Set([a]);
}

export async function othAction(g, uid, body) {
  if (!g.waiting.has(uid)) return 'نوبت تو نیست';
  const i = parseInt(body?.cell, 10);
  const board = g.data.board;
  const d = g.data.discs[uid];
  if (!(i >= 0 && i < 64)) return 'خانه نامعتبر است';
  const fl = oFlips(board, i, d);
  if (!fl.length) return 'حرکت مجاز نیست — باید حداقل یک مهره‌ی حریف را محاصره کنی';
  board[i] = d;
  for (const x of fl) board[x] = d;
  g.data.last = i;
  g.data.flipped = fl;
  g.data.passed = null;
  const o = g.opp(uid);
  if (oMoves(board, 3 - d).length) {
    g.waiting = new Set([o]);
  } else if (oMoves(board, d).length) {
    g.waiting = new Set([uid]);
    g.data.passed = o;
  } else {
    const [a, b] = g.uids();
    const ca = board.filter(x => x === g.data.discs[a]).length;
    const cb = board.filter(x => x === g.data.discs[b]).length;
    if (ca === cb) g.finish(null, `${ca} – ${cb} — مساوی`);
    else {
      const w = ca > cb ? a : b;
      g.finish(w, `${g.name(w)} با ${Math.max(ca, cb)} مهره در برابر ${Math.min(ca, cb)} برد`);
    }
  }
  return null;
}

export function othView(g, uid) {
  const board = g.data.board;
  const d = g.data.discs[uid];
  return {
    board, my_disc: d,
    valid: g.waiting.has(uid) ? oMoves(board, d) : [],
    me: board.filter(x => x === d).length, opp: board.filter(x => x === 3 - d).length,
    last: g.data.last, flipped: g.data.flipped,
    opp_passed: g.data.passed === g.opp(uid), i_passed: g.data.passed === uid,
  };
}

// ─── کوییز (۱۹۰+ سوال + سوال ریاضی تصادفی) ───
const QUIZ_RAW = [
  ['بنیان‌گذار سلسله هخامنشیان کیست؟', 'کوروش کبیر', 'داریوش', 'خشایارشا', 'اردشیر'],
  ['تخت جمشید در کدام استان است؟', 'فارس', 'خوزستان', 'کرمان', 'یزد'],
  ['آخرین پادشاه هخامنشی کیست؟', 'داریوش سوم', 'خشایارشا', 'اردشیر', 'کوروش'],
  ['بنیان‌گذار سلسله ساسانیان کیست؟', 'اردشیر بابکان', 'شاپور', 'یزدگرد', 'انوشیروان'],
  ['اولین پادشاه صفویه کیست؟', 'شاه اسماعیل اول', 'شاه عباس اول', 'شاه طهماسب', 'شاه سلطان حسین'],
  ['پایتخت صفویان در اوج قدرت کجا بود؟', 'اصفهان', 'تبریز', 'قزوین', 'شیراز'],
  ['بنیان‌گذار سلسله افشاریه کیست؟', 'نادرشاه', 'کریم‌خان', 'آغامحمدخان', 'شاه سلطان حسین'],
  ['پایتخت کریم‌خان زند کجا بود؟', 'شیراز', 'تهران', 'اصفهان', 'کرمان'],
  ['آخرین پادشاه قاجار کیست؟', 'احمدشاه', 'مظفرالدین‌شاه', 'محمدعلی‌شاه', 'رضاشاه'],
  ['انقلاب مشروطه در چه سالی رخ داد؟', '1285 شمسی', '1290 شمسی', '1275 شمسی', '1300 شمسی'],
  ['ملی شدن صنعت نفت ایران در چه سالی رخ داد؟', '1329 شمسی', '1325 شمسی', '1335 شمسی', '1340 شمسی'],
  ['رهبر نهضت ملی شدن نفت ایران چه کسی بود؟', 'دکتر مصدق', 'دکتر فاطمی', 'آیت‌الله کاشانی', 'رضاشاه'],
  ['جنگ ایران و عراق چند سال طول کشید؟', '8 سال', '6 سال', '10 سال', '5 سال'],
  ['کتیبه بیستون متعلق به کدام پادشاه است؟', 'داریوش اول', 'کوروش', 'خشایارشا', 'اردشیر'],
  ['جنگ جهانی اول در چه سالی آغاز شد؟', '1914', '1918', '1939', '1920'],
  ['جنگ جهانی دوم در چه سالی پایان یافت؟', '1945', '1944', '1946', '1943'],
  ['انقلاب کبیر فرانسه در چه سالی رخ داد؟', '1789', '1776', '1800', '1815'],
  ['دیوار برلین در چه سالی فروپاشید؟', '1989', '1991', '1985', '1993'],
  ['اولین انسان روی ماه چه کسی بود؟', 'نیل آرمسترانگ', 'یوری گاگارین', 'باز آلدرین', 'مایکل کالینز'],
  ['اولین انسان در فضا چه کسی بود؟', 'یوری گاگارین', 'نیل آرمسترانگ', 'جان گلن', 'آلن شپرد'],
  ['جنگ سرد بین کدام دو کشور بود؟', 'آمریکا و شوروی', 'آمریکا و چین', 'آلمان و فرانسه', 'انگلستان و آلمان'],
  ['فروپاشی اتحاد جماهیر شوروی در چه سالی رخ داد؟', '1991', '1989', '1993', '1985'],
  ['کشف آمریکا توسط کریستف کلمب در چه سالی بود؟', '1492', '1450', '1500', '1480'],
  ['کدام تمدن باستانی اهرام ثلاثه را ساخت؟', 'مصر', 'بابل', 'یونان', 'روم'],
  ['قانون حمورابی متعلق به کدام تمدن است؟', 'بابل', 'مصر', 'یونان', 'ایران'],
  ['انقلاب صنعتی ابتدا در کدام کشور آغاز شد؟', 'انگلستان', 'آمریکا', 'آلمان', 'فرانسه'],
  ['چه کسی اولین رئیس‌جمهور آمریکا بود؟', 'جورج واشنگتن', 'آبراهام لینکلن', 'توماس جفرسون', 'جان آدامز'],
  ['پایتخت ایران کجاست؟', 'تهران', 'اصفهان', 'شیراز', 'مشهد'],
  ['بزرگ‌ترین دریاچه ایران کدام است؟', 'دریاچه ارومیه', 'دریاچه خزر', 'دریاچه هامون', 'دریاچه نمک'],
  ['بلندترین قله ایران کدام است؟', 'دماوند', 'علم‌کوه', 'زردکوه', 'تفتان'],
  ['دماوند در کدام استان قرار دارد؟', 'مازندران', 'تهران', 'گیلان', 'سمنان'],
  ['طولانی‌ترین رودخانه ایران کدام است؟', 'کارون', 'سفیدرود', 'ارس', 'زاینده‌رود'],
  ['بزرگ‌ترین استان ایران از نظر مساحت کدام است؟', 'سیستان و بلوچستان', 'کرمان', 'فارس', 'خراسان رضوی'],
  ['کوچک‌ترین استان ایران کدام است؟', 'البرز', 'قم', 'تهران', 'گیلان'],
  ['شهر اصفهان در کنار کدام رود قرار دارد؟', 'زاینده‌رود', 'کارون', 'سفیدرود', 'ارس'],
  ['بندرعباس مرکز کدام استان است؟', 'هرمزگان', 'سیستان و بلوچستان', 'بوشهر', 'خوزستان'],
  ['کدام شهر به نصف جهان معروف است؟', 'اصفهان', 'شیراز', 'تبریز', 'مشهد'],
  ['میدان نقش جهان در کدام شهر است؟', 'اصفهان', 'شیراز', 'تهران', 'تبریز'],
  ['برج آزادی در کدام شهر است؟', 'تهران', 'اصفهان', 'شیراز', 'تبریز'],
  ['حرم امام رضا در کدام شهر است؟', 'مشهد', 'قم', 'شیراز', 'تهران'],
  ['حرم حضرت معصومه در کدام شهر است؟', 'قم', 'مشهد', 'شیراز', 'تهران'],
  ['پایتخت فرانسه کجاست؟', 'پاریس', 'لندن', 'برلین', 'مادرید'],
  ['پایتخت آلمان کجاست؟', 'برلین', 'مونیخ', 'هامبورگ', 'فرانکفورت'],
  ['پایتخت انگلستان کجاست؟', 'لندن', 'منچستر', 'لیورپول', 'بیرمنگام'],
  ['پایتخت ایتالیا کجاست؟', 'رم', 'میلان', 'ونیز', 'ناپل'],
  ['پایتخت اسپانیا کجاست؟', 'مادرید', 'بارسلونا', 'سویا', 'والنسیا'],
  ['پایتخت روسیه کجاست؟', 'مسکو', 'سن‌پترزبورگ', 'کی‌یف', 'نووسیبیرسک'],
  ['پایتخت چین کجاست؟', 'پکن', 'شانگهای', 'هنگ‌کنگ', 'گوانگژو'],
  ['پایتخت ژاپن کجاست؟', 'توکیو', 'اوزاکا', 'کیوتو', 'هیروشیما'],
  ['پایتخت هند کجاست؟', 'دهلی نو', 'بمبئی', 'کلکته', 'بنگلور'],
  ['پایتخت ترکیه کجاست؟', 'آنکارا', 'استانبول', 'ازمیر', 'بورسا'],
  ['پایتخت عربستان سعودی کجاست؟', 'ریاض', 'جده', 'مکه', 'مدینه'],
  ['پایتخت افغانستان کجاست؟', 'کابل', 'هرات', 'قندهار', 'مزار شریف'],
  ['پایتخت پاکستان کجاست؟', 'اسلام‌آباد', 'کراچی', 'لاهور', 'پیشاور'],
  ['پایتخت آذربایجان کجاست؟', 'باکو', 'گنجه', 'سومقاییت', 'لنکران'],
  ['پایتخت ارمنستان کجاست؟', 'ایروان', 'گیومری', 'وانادزور', 'آبویان'],
  ['پایتخت گرجستان کجاست؟', 'تفلیس', 'باتومی', 'کوتایسی', 'سوخومی'],
  ['پایتخت آمریکا کجاست؟', 'واشنگتن', 'نیویورک', 'لس‌آنجلس', 'شیکاگو'],
  ['پایتخت کانادا کجاست؟', 'اتاوا', 'تورنتو', 'مونترال', 'ونکوور'],
  ['پایتخت استرالیا کجاست؟', 'کانبرا', 'سیدنی', 'ملبورن', 'بریزبن'],
  ['پایتخت برزیل کجاست؟', 'برازیلیا', 'ریودوژانیرو', 'سائوپائولو', 'سالوادور'],
  ['پایتخت مصر کجاست؟', 'قاهره', 'اسکندریه', 'جیزه', 'اقصر'],
  ['بزرگ‌ترین اقیانوس جهان کدام است؟', 'آرام', 'اطلس', 'هند', 'منجمد شمالی'],
  ['بزرگ‌ترین قاره جهان کدام است؟', 'آسیا', 'آفریقا', 'آمریکای شمالی', 'اروپا'],
  ['بلندترین قله جهان کدام است؟', 'اورست', 'K2', 'کنچن‌جونگا', 'دماوند'],
  ['طولانی‌ترین رود جهان کدام است؟', 'نیل', 'آمازون', 'می‌سی‌سی‌پی', 'دانوب'],
  ['بزرگ‌ترین بیابان گرم جهان کدام است؟', 'صحرای آفریقا', 'بیابان عربستان', 'گبی', 'کالاهاری'],
  ['بزرگ‌ترین کشور جهان از نظر مساحت کدام است؟', 'روسیه', 'کانادا', 'چین', 'آمریکا'],
  ['کوچک‌ترین کشور جهان کدام است؟', 'واتیکان', 'موناکو', 'سان مارینو', 'لیختن‌اشتاین'],
  ['واحد اندازه‌گیری نیرو چیست؟', 'نیوتن', 'ژول', 'وات', 'پاسکال'],
  ['واحد اندازه‌گیری انرژی چیست؟', 'ژول', 'نیوتن', 'وات', 'آمپر'],
  ['واحد اندازه‌گیری توان چیست؟', 'وات', 'ژول', 'نیوتن', 'هرتز'],
  ['قانون جاذبه توسط چه کسی کشف شد؟', 'نیوتن', 'انیشتین', 'گالیله', 'کپلر'],
  ['نسبیت توسط چه کسی مطرح شد؟', 'اینشتین', 'نیوتن', 'بور', 'پلانک'],
  ['فرمول معروف E=mc² متعلق به کیست؟', 'اینشتین', 'نیوتن', 'گالیله', 'کپلر'],
  ['نماد شیمیایی طلا چیست؟', 'Au', 'Ag', 'Pt', 'Cu'],
  ['نماد شیمیایی نقره چیست؟', 'Ag', 'Au', 'Fe', 'Zn'],
  ['نماد شیمیایی آهن چیست؟', 'Fe', 'Ir', 'In', 'Fr'],
  ['نماد شیمیایی سدیم چیست؟', 'Na', 'Sd', 'So', 'Sm'],
  ['نماد شیمیایی پتاسیم چیست؟', 'K', 'P', 'Pt', 'Ka'],
  ['فرمول شیمیایی آب چیست؟', 'H₂O', 'CO₂', 'O₂', 'H₂O₂'],
  ['فرمول شیمیایی نمک خوراکی چیست؟', 'NaCl', 'KCl', 'CaCO₃', 'NaOH'],
  ['فراوان‌ترین گاز در جو زمین کدام است؟', 'نیتروژن', 'اکسیژن', 'دی‌اکسید کربن', 'آرگون'],
  ['آب در چند درجه سانتی‌گراد می‌جوشد؟', '100', '90', '110', '80'],
  ['آب در چند درجه سانتی‌گراد یخ می‌زند؟', '0', '-10', '10', '5'],
  ['سرعت نور تقریباً چند کیلومتر بر ثانیه است؟', '300 هزار', '150 هزار', '3 هزار', '3 میلیون'],
  ['قلب انسان در حالت استراحت در دقیقه چند بار می‌تپد؟', '60 تا 100', '30 تا 50', '150 تا 200', '10 تا 20'],
  ['بزرگ‌ترین سیاره منظومه شمسی کدام است؟', 'مشتری', 'زحل', 'نپتون', 'اورانوس'],
  ['نزدیک‌ترین سیاره به خورشید کدام است؟', 'عطارد', 'زهرة', 'زمین', 'مریخ'],
  ['قرمزترین سیاره کدام است؟', 'مریخ', 'زهره', 'مشتری', 'عطارد'],
  ['چند سیاره در منظومه شمسی داریم؟', '8', '9', '7', '10'],
  ['اژدهاکومودو در کدام کشور زندگی می‌کند؟', 'اندونزی', 'استرالیا', 'هند', 'آفریقای جنوبی'],
  ['سریع‌ترین حیوان خشکی چیست؟', 'یوزپلنگ', 'شیر', 'اسب', 'کنگورو'],
  ['بزرگ‌ترین حیوان خشکی چیست؟', 'فیل آفریقایی', 'کرگدن', 'زرافه', 'هیپوپوتام'],
  ['بزرگ‌ترین پستاندار جهان چیست؟', 'نهنگ آبی', 'فیل', 'کوسه سفید', 'خرچنگ'],
  ['طولانی‌ترین جانور جهان چیست؟', 'کرم نواری صندوقی', 'نهنگ آبی', 'خرچنگ غول‌پیکر', 'مار آناکوندا'],
  ['پرنده‌ای که نمی‌تواند پرواز کند کدام است؟', 'پنگوئن', 'کبوتر', 'عقاب', 'پرستو'],
  ['حشره‌ای که بیشترین جابجایی را دارد کدام است؟', 'زنبور عسل', 'مورچه', 'پشه', 'مگس'],
  ['خون‌خوارترین حشره کدام است؟', 'پشه', 'زنبور', 'مورچه', 'سوسک'],
  ['کدام حیوان با دم خود درخت را می‌گیرد؟', 'میمون', 'سگ', 'گربه', 'خرگوش'],
  ['حس بویایی کدام حیوان قوی‌تر است؟', 'سگ', 'انسان', 'گربه', 'پرنده'],
];

function mathQuestion() {
  const a = randInt(6, 49), b = randInt(3, 29);
  const op = choice(['+', '-', '×']);
  const ans = op === '+' ? a + b : (op === '-' ? a - b : a * b);
  const wrong = new Set();
  while (wrong.size < 3) {
    const w = ans + choice([-1, 1]) * randInt(1, 12);
    if (w !== ans) wrong.add(w);
  }
  const opts = shuffle([ans, ...wrong]);
  return { q: `حاصل ${a} ${op} ${b} چند است؟`, opts: opts.map(String), ans: opts.indexOf(ans) };
}

export function makeQuestion(exclude = new Set()) {
  if (Math.random() < 0.15) return mathQuestion();
  const pool = QUIZ_RAW.filter(r => !exclude.has(r[0]));
  const r = choice(pool.length ? pool : QUIZ_RAW);
  const opts = shuffle(r.slice(1));
  return { q: r[0], opts, ans: opts.indexOf(r[1]) };
}

export const QUIZ_PER_GAME = 5;
const QUIZ_MAX_EXTRA = 3;

export async function quizInit(g) {
  const [a, b] = g.uids();
  const used = new Set();
  const qs = [];
  for (let i = 0; i < QUIZ_PER_GAME; i++) {
    const q = makeQuestion(used);
    used.add(q.q);
    qs.push(q);
  }
  g.data = { qs, idx: 0, answers: {}, score: { [a]: 0, [b]: 0 }, history: [], extra: 0 };
  g.waiting = new Set([a, b]);
}

export async function quizAction(g, uid, body) {
  const d = g.data;
  if (!g.waiting.has(uid)) return 'به این سوال جواب داده‌ای — منتظر حریف باش';
  const ans = parseInt(body?.answer, 10);
  if (!Number.isInteger(ans)) return 'گزینه نامعتبر است';
  const q = d.qs[d.idx];
  if (!(ans >= 0 && ans < q.opts.length)) return 'گزینه نامعتبر است';
  d.answers[uid] = ans;
  g.waiting.delete(uid);
  if (g.waiting.size) return null;
  const [a, b] = g.uids();
  for (const u of [a, b]) {
    if (d.answers[u] === q.ans) d.score[u] += 1;
  }
  d.history.push({ q, answers: { ...d.answers } });
  d.answers = {};
  d.idx += 1;
  if (d.idx >= d.qs.length) {
    if (d.score[a] !== d.score[b]) {
      const w = d.score[a] > d.score[b] ? a : b;
      g.finish(w, `${g.name(w)} با ${d.score[w]} جواب درست برد`);
      return null;
    }
    if (d.extra >= QUIZ_MAX_EXTRA) {
      g.finish(null, 'امتیازها برابر ماند — مساوی');
      return null;
    }
    d.extra += 1;
    d.qs.push(makeQuestion(new Set(d.qs.map(x => x.q))));
  }
  g.waiting = new Set([a, b]);
  return null;
}

export function quizView(g, uid) {
  const d = g.data;
  const o = g.opp(uid);
  const cur = d.idx < d.qs.length ? d.qs[d.idx] : null;
  let last = null;
  if (d.history.length) {
    const h = d.history[d.history.length - 1];
    last = { q: h.q.q, opts: h.q.opts, correct: h.q.ans, mine: h.answers[uid], opp: h.answers[o] };
  }
  return {
    idx: d.idx, total: d.qs.length, sudden: d.idx >= QUIZ_PER_GAME,
    question: (cur && !g.finished) ? { q: cur.q, opts: cur.opts } : null,
    my_answer: d.answers[uid], opp_answered: o in d.answers,
    score_me: d.score[uid], score_opp: d.score[o], last,
  };
}

// ═══════════ ثبت بازی‌ها ═══════════
export const SOLO_INSTANT = {
  wheel: playWheel, crash: playCrash, coin: playCoin,
  card: playCard, roulette: playRoulette, penalty: playPenalty,
};

export const GAME_IMPL = {
  holdem: { init: holdemInit, action: holdemAction, view: holdemView, prepare: true },
  hokm: { init: hokmInit, action: hokmAction, view: hokmView },
  blackjack: { init: bjInit, action: bjAction, view: bjView },
  rps: { init: rpsInit, action: rpsAction, view: rpsView },
  ttt: { init: tttInit, action: tttAction, view: tttView },
  connect4: { init: c4Init, action: c4Action, view: c4View },
  othello: { init: othInit, action: othAction, view: othView },
  quiz: { init: quizInit, action: quizAction, view: quizView },
};
