// ═══════════ مینی‌اپ قمارخانه + پنل مدیریت — API وورکر ═══════════
// پورت کامل webapp.py: بازی‌های تک‌نفره/دونفره با state در KV، مچ‌میکینگ،
// پنل ادمین (کاربران، کد هدیه، فروشگاه، VIP، بن، کنترل بخش‌ها، دیزاین، آیتم‌ها)
import * as C from './config.js';
import * as db from './db.js';
import * as U from './utils.js';
import * as G from './games.js';

// ═══════════ KV keys ═══════════
// queue:{game}:{bet}     → آرایه [{uid, name, joined_at}] (صف مچ‌میکینگ)
// waiting:{uid}          → {game, bet, joined_at}
// user_game:{uid}        → game_id
// game:{gid}             → GameState سریالایز‌شده
// solo:{uid}             → سشن بازی تک‌نفره (mines/hilo)

const K = {
  queue: (g, b) => `queue:${g}:${b}`,
  waiting: (uid) => `waiting:${uid}`,
  userGame: (uid) => `user_game:${uid}`,
  game: (gid) => `game:${gid}`,
  solo: (uid) => `solo:${uid}`,
};

// ═══════════ GameState سریالایز‌شده ═══════════
function makeGame(gameId, gameKey, players, bet) {
  const now = Date.now() / 1000;
  return {
    game_id: gameId, game_key: gameKey,
    players, // [{user_id, name}]
    bet, contrib: { [players[0].user_id]: bet, [players[1].user_id]: bet },
    data: null, waiting: [],
    deadline: now + C.TURN_TIMEOUT,
    created_at: now, updated_at: now,
    finished: false, finished_at: 0,
    winner: null, reason: '', payout: 0, version: 0, outcome: null,
  };
}
function gUids(g) { return g.players.map(p => p.user_id); }
function gOpp(g, uid) { const [a, b] = gUids(g); return uid === a ? b : a; }
function gName(g, uid) { const p = g.players.find(p => p.user_id === uid); return p ? p.name : 'بازیکن'; }
function gPot(g) { return Object.values(g.contrib).reduce((s, v) => s + v, 0); }
function gTouch(g) {
  const now = Date.now() / 1000;
  g.updated_at = now;
  g.deadline = now + C.TURN_TIMEOUT;
  g.version += 1;
}
function gFinish(g, winner, reason) {
  if (g.outcome === null && !g.finished) {
    g.outcome = [winner, reason];
    g.waiting = [];
  }
}

// آبجکت رابط بازی — پروکسی روی گیم سریالایز‌شده (تا ماژول‌های games.js بدون تغییر کار کنند)
function gameProxy(g) {
  return {
    ...g,
    get data() { return g.data; },
    set data(v) { g.data = v; },
    get waiting() { return new Set(g.waiting); },
    set waiting(v) { g.waiting = [...v]; },
    uids: () => gUids(g),
    opp: (uid) => gOpp(g, uid),
    name: (uid) => gName(g, uid),
    get pot() { return gPot(g); },
    finish: (w, r) => gFinish(g, w, r),
    touch: () => gTouch(g),
  };
}

// ═══════════ ذخیره/بارگذاری ═══════════
async function saveGame(kv, g, ttl = C.GAME_TTL) {
  await U.kvPutJson(kv, K.game(g.game_id), g, Math.max(60, ttl));
  for (const uid of gUids(g)) {
    if (g.finished) await kv.delete(K.userGame(uid));
    else await kv.put(K.userGame(uid), g.game_id, { expirationTtl: Math.max(60, ttl) });
  }
}
async function loadGame(kv, gid) {
  return await U.kvJson(kv, K.game(gid), null);
}

// ═══════════ پراخت و settle ═══════════
async function settle(d, kv, g, winner, reason) {
  if (g.finished) return;
  g.finished = true;
  g.finished_at = Date.now() / 1000;
  g.winner = winner;
  g.reason = reason;
  g.waiting = [];
  g.version += 1;
  try {
    if (winner === null || winner === undefined) {
      for (const [uid, amount] of Object.entries(g.contrib)) {
        if (amount > 0) await db.addBalance(d, Number(uid), amount);
      }
      g.payout = 0;
    } else {
      const pot = gPot(g);
      g.payout = pot - Math.floor(pot * C.COMMISSION_RATE);
      await db.addBalance(d, winner, g.payout);
    }
  } catch (e) {
    console.error('settle payout error:', e);
  }
  // ماموریت‌ها
  for (const uid of gUids(g)) {
    try {
      const mk = C.MISSION_KEYS[g.game_key] || null;
      await db.progressMission(d, uid, 'play_any_game', 1, 0);
      if (mk) await db.progressMission(d, uid, `play_${mk}`, 1, 0);
      if (uid === winner) {
        const winXp = calcWinXp(Math.max(g.bet, Math.floor(gPot(g) / 2)));
        await db.progressMission(d, uid, 'win_any_game', 1, winXp);
        if (mk) await db.progressMission(d, uid, `win_${mk}`, 1, 0);
      }
    } catch (_) {}
  }
  await saveGame(kv, g, C.FINISHED_GAME_TTL);
}

function calcWinXp(bet) {
  const b = Math.max(0, Math.floor(bet || 0));
  if (b <= 0) return 0;
  if (C.MINIAPP_MAX_BET <= C.MINIAPP_MIN_BET) return C.MAX_WIN_XP;
  const ratio = Math.max(0, Math.min(1, (b - C.MINIAPP_MIN_BET) / (C.MINIAPP_MAX_BET - C.MINIAPP_MIN_BET)));
  return Math.min(C.MAX_WIN_XP, Math.max(C.MIN_WIN_XP, Math.round(C.MIN_WIN_XP + ratio * (C.MAX_WIN_XP - C.MIN_WIN_XP))));
}

async function applyOutcome(d, kv, g) {
  if (g.outcome && !g.finished) {
    const [w, r] = g.outcome;
    await settle(d, kv, g, w, r);
  }
}

async function prepareGame(d, g) {
  const impl = G.GAME_IMPL[g.game_key];
  if (impl.prepare && !g.finished) {
    const bal = {};
    for (const uid of gUids(g)) {
      const u = await db.getUser(d, uid);
      bal[uid] = Number(u?.balance || 0);
    }
    if (g.data) g.data.bal = bal;
  }
}

function gameView(g, uid) {
  const o = gOpp(g, uid);
  const meta = { name: G.GAME_IMPL[g.game_key] ? gameName(g.game_key) : g.game_key, emoji: gameEmoji(g.game_key) };
  let result = null;
  if (g.finished) result = (g.winner === null || g.winner === undefined) ? 'draw' : (g.winner === uid ? 'win' : 'lose');
  let state = {};
  try {
    state = G.GAME_IMPL[g.game_key].view(gameProxy(g), uid);
  } catch (e) {
    console.error('view error', e);
  }
  return {
    game_id: g.game_id, game_key: g.game_key, title: meta.name, emoji: meta.emoji,
    bet: g.bet, pot: gPot(g),
    me: { id: uid, name: gName(g, uid) }, opp: { id: o, name: gName(g, o) },
    your_turn: g.waiting.includes(uid), opp_turn: g.waiting.includes(o),
    deadline_in: g.finished ? 0 : Math.max(0, Math.floor(g.deadline - Date.now() / 1000)),
    turn_timeout: C.TURN_TIMEOUT, finished: g.finished, result, reason: g.reason,
    payout: g.winner === uid ? g.payout : 0, lost: g.contrib[uid] || 0,
    version: g.version, state,
  };
}

function gameName(key) {
  return C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET)[key]?.name || key;
}
function gameEmoji(key) {
  return C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET)[key]?.emoji || '🎮';
}

// ═══════════ احراز هویت درخواست ═══════════
async function getUserForRequest(d, request, body) {
  let initData = request.headers.get('X-Telegram-Init-Data') || '';
  let uid = null, tg = null;
  const url = new URL(request.url);
  if (!initData) initData = url.searchParams.get('init_data') || '';
  if (!initData && body && typeof body._init_data === 'string') initData = body._init_data;
  if (initData) {
    tg = await U.validateInitData(initData, C.env.BOT_TOKEN);
    if (tg) uid = tg.id;
  }
  if (!uid) {
    let tok = request.headers.get('X-Browser-Token') || '';
    if (!tok) tok = url.searchParams.get('token') || '';
    if (!tok && body && typeof body._token === 'string') tok = body._token;
    if (!tok) {
      const cookie = request.headers.get('Cookie') || '';
      const m = cookie.match(/zar_u=([^;]+)/);
      if (m) tok = decodeURIComponent(m[1]);
    }
    uid = await U.validateBrowserToken(tok, C.env.BOT_TOKEN);
  }
  if (!uid) return null;
  let user = await db.getUser(d, uid);
  if (!user && tg) {
    user = await db.ensureUser(d, { id: uid, first_name: tg.first_name || '', username: tg.username || '' });
  }
  if (!user) return null;
  user = { ...user, user_id: Number(uid), _banned: await db.isBanned(d, uid) };
  if (tg && tg.first_name) user.first_name = tg.first_name;
  return user;
}

function auth(handler) {
  return async (request, env, ctx, body) => {
    if (!body || typeof body !== 'object') body = {};
    const user = await getUserForRequest(env.DB, request, body);
    if (!user) return U.errJson('احراز هویت ناموفق بود — مینی‌اپ را از داخل ربات باز کن', 401, 'auth');
    if (user._banned) return U.errJson('🚫 شما از ربات محروم شده‌اید', 403, 'banned');
    try {
      return await handler(request, env, ctx, user, body);
    } catch (e) {
      console.error('api error:', e);
      return U.errJson('خطای داخلی سرور — دوباره تلاش کن', 500, 'server');
    }
  };
}

// ═══════════ شرط‌بندی ═══════════
async function takeBet(d, uid, gameKey, bet, isOwner) {
  const controls = JSON.parse(await db.getSetting(d, 'bot_controls', '{}') || '{}');
  const botOff = (await db.getSetting(d, 'bot_off', '')) === '1';
  if ((botOff || (controls.disabled_sections || []).includes('casino')) && !isOwner) {
    return '⛔ کازینو موقتاً توسط مدیریت غیرفعال شده است.';
  }
  if ((controls.disabled_games || []).includes(gameKey) && !isOwner) {
    return '⛔ این بازی موقتاً توسط مدیریت غیرفعال شده است.';
  }
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  const g = games[gameKey];
  if (!g) return 'بازی نامعتبر است';
  if (!Number.isInteger(bet) || bet <= 0) return 'مبلغ شرط نامعتبر است';
  if (bet < g.min_bet) return `حداقل شرط ${U.fmt(g.min_bet)} است`;
  if (bet > g.max_bet) return `حداکثر شرط ${U.fmt(g.max_bet)} است`;
  if (!(await db.deductBalance(d, uid, bet))) return 'موجودی کافی نیست';
  return null;
}

function soloView(s, reveal = false) {
  if (!s) return null;
  return s.type === 'mines' ? G.minesView(s, reveal) : G.hiloView(s);
}

// ═══════════ مچ‌میکینگ (اتمیک با KV) ═══════════
async function queueAdd(kv, gameKey, bet, uid, name) {
  const key = K.queue(gameKey, bet);
  const cur = (await U.kvJson(kv, key, [])) || [];
  cur.push({ uid: Number(uid), name, joined_at: Date.now() / 1000 });
  await U.kvPutJson(kv, key, cur, C.QUEUE_TTL);
  await U.kvPutJson(kv, K.waiting(uid), { game: gameKey, bet, joined_at: Date.now() / 1000 }, C.QUEUE_TTL);
}

async function queueRemove(kv, uid) {
  const w = await U.kvJson(kv, K.waiting(uid), null);
  if (!w) return null;
  await kv.delete(K.waiting(uid));
  const key = K.queue(w.game, w.bet);
  const cur = (await U.kvJson(kv, key, [])) || [];
  const next = cur.filter(e => e.uid !== Number(uid));
  await U.kvPutJson(kv, key, next, C.QUEUE_TTL);
  return w;
}

async function queuePopOpponent(kv, gameKey, bet, uid) {
  const key = K.queue(gameKey, bet);
  const cur = (await U.kvJson(kv, key, [])) || [];
  const now = Date.now() / 1000;
  // حریف مناسب = غیر از خودم، منقضی نشده، در بازی فعال نباشد
  for (let i = 0; i < cur.length; i++) {
    const e = cur[i];
    if (e.uid === Number(uid)) continue;
    if (now - e.joined_at > C.MATCH_TIMEOUT) continue;
    const inGame = await kv.get(K.userGame(e.uid));
    if (inGame) continue;
    const [opp] = cur.splice(i, 1);
    await U.kvPutJson(kv, key, cur, C.QUEUE_TTL);
    await kv.delete(K.waiting(opp.uid));
    return opp;
  }
  // پاکسازی ورودی‌های منقضی
  const fresh = cur.filter(e => now - e.joined_at <= C.MATCH_TIMEOUT + 15);
  if (fresh.length !== cur.length) await U.kvPutJson(kv, key, fresh, C.QUEUE_TTL);
  return null;
}

async function createGame(kv, gameKey, players, bet) {
  // ترتیب تصادفی
  const ps = Math.random() < 0.5 ? players : [players[1], players[0]];
  const gameId = U.randomId(12);
  const g = makeGame(gameId, gameKey, ps, bet);
  const impl = G.GAME_IMPL[gameKey];
  await impl.init(gameProxy(g));
  gTouch(g);
  await saveGame(kv, g);
  return g;
}

async function activeGameOf(kv, uid) {
  const gid = await kv.get(K.userGame(uid));
  if (!gid) return null;
  const g = await loadGame(kv, gid);
  if (g && !g.finished) return g;
  if (gid) await kv.delete(K.userGame(uid));
  return null;
}

function queueInfo(w) {
  if (!w) return null;
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  return {
    game_key: w.game, bet: w.bet, title: games[w.game]?.name || '', emoji: games[w.game]?.emoji || '',
    remaining: Math.max(0, Math.floor(C.MATCH_TIMEOUT - (Date.now() / 1000 - w.joined_at))),
  };
}

// ═══════════ API: من ═══════════
const apiMe = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const w = await U.kvJson(kv, K.waiting(uid), null);
  const g = await activeGameOf(kv, uid);
  const admins = await db.getAdminIds(d);
  const isAdm = admins.has(uid);
  const controls = JSON.parse(await db.getSetting(d, 'bot_controls', '{}') || '{}');
  const botOff = (await db.getSetting(d, 'bot_off', '')) === '1';
  const casinoOff = (botOff || (controls.disabled_sections || []).includes('casino')) && !isAdm;
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  const enabledGames = Object.entries(games)
    .filter(([k]) => isAdm || !(controls.disabled_games || []).includes(k))
    .map(([key, v]) => ({ key, ...v }));
  const solo = await U.kvJson(kv, K.solo(uid), null);
  const vip = await db.isVip(d, uid);
  return U.json({
    ok: true,
    user: {
      id: uid, name: (user.first_name || user.username || 'بازیکن').slice(0, 32),
      balance: Number(user.balance || 0),
      level: U.calcLevel(Number(user.total_xp || 0))[0],
      vip, vip_days: Math.max(0, Math.ceil((await db.vipExpires(d, uid) - Date.now() / 1000) / 86400)),
    },
    games: enabledGames, commission: C.COMMISSION_RATE,
    match_timeout: C.MATCH_TIMEOUT, turn_timeout: C.TURN_TIMEOUT, max_bet: C.MINIAPP_MAX_BET,
    wheel_segments: G.WHEEL_SEGMENTS, queue: queueInfo(w), game_id: g ? g.game_id : null,
    solo: soloView(solo), refunded: 0,
    casino_off: casinoOff,
    off_msg: '⛔ کازینو موقتاً توسط مدیریت غیرفعال شده است.',
    texts: { hero_title: '', hero_sub: '' },
  });
});

// ═══════════ API: بازی‌های تک‌نفره ═══════════
const apiSoloInstant = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const key = new URL(request.url).pathname.split('/').pop();
  const fn = G.SOLO_INSTANT[key];
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  if (!fn || games[key]?.type !== '1p') return U.errJson('بازی نامعتبر است', 404);
  const uid = user.user_id;
  const bet = U.toInt(body.bet);
  try {
    const res = fn(body);
    const admins = await db.getAdminIds(d);
    const err = await takeBet(d, uid, key, bet, admins.has(uid));
    if (err) return U.errJson(err);
    const win = Math.floor(bet * (Number(res.mult) || 0));
    if (win > 0) await db.addBalance(d, uid, win);
    // ماموریت‌ها
    const mk = C.MISSION_KEYS[key] || 'casino';
    try {
      await db.progressMission(d, uid, 'play_any_game', 1, 0);
      await db.progressMission(d, uid, `play_${mk}`, 1, 0);
      if (win > bet) {
        await db.progressMission(d, uid, 'win_any_game', 1, calcWinXp(bet));
        await db.progressMission(d, uid, `win_${mk}`, 1, 0);
      }
    } catch (_) {}
    const u = await db.getUser(d, uid);
    return U.json({ ok: true, ...res, win, profit: win - bet, balance: Number(u?.balance || 0) });
  } catch (e) {
    if (e instanceof Error && e.message) return U.errJson(e.message);
    return U.errJson('خطا در بازی');
  }
});

async function soloBegin(d, kv, uid, key, bet, factory) {
  const existing = await U.kvJson(kv, K.solo(uid), null);
  if (existing) {
    return [null, U.errJson('یک بازی نیمه‌تمام داری — اول آن را تمام کن', 400, 'active_session', { session: soloView(existing) })];
  }
  const admins = await db.getAdminIds(d);
  const err = await takeBet(d, uid, key, bet, admins.has(uid));
  if (err) return [null, U.errJson(err)];
  const s = factory();
  s.created = Date.now() / 1000;
  await U.kvPutJson(kv, K.solo(uid), s, C.SOLO_SESSION_TTL);
  return [s, null];
}

async function soloPayout(d, kv, uid, s, amount, key) {
  s.finished = true;
  await kv.delete(K.solo(uid));
  if (amount > 0) await db.addBalance(d, uid, amount);
  const mk = C.MISSION_KEYS[key] || 'casino';
  try {
    await db.progressMission(d, uid, 'play_any_game', 1, 0);
    await db.progressMission(d, uid, `play_${mk}`, 1, 0);
    if (amount > s.bet) await db.progressMission(d, uid, 'win_any_game', 1, calcWinXp(s.bet));
  } catch (_) {}
}

const apiMinesStart = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const bet = U.toInt(body.bet);
  const count = U.toInt(body.mines, 3);
  if (!G.MINES_COUNTS.includes(count)) return U.errJson('تعداد مین نامعتبر است');
  const [s, resp] = await soloBegin(d, kv, uid, 'mines', bet, () => G.minesStart(bet, count));
  if (resp) return resp;
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, session: soloView(s), balance: Number(u?.balance || 0) });
});

const apiMinesReveal = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const idx = U.toInt(body.idx, -1);
  const s = await U.kvJson(kv, K.solo(uid), null);
  if (!s || s.type !== 'mines') return U.errJson('بازی مین‌یاب فعالی نداری', 400, 'no_session');
  try {
    const result = G.minesReveal(s, idx);
    let win = 0;
    if (result === 'lose') await soloPayout(d, kv, uid, s, 0, 'mines');
    else if (result === 'win') { win = G.minesPayout(s); await soloPayout(d, kv, uid, s, win, 'mines'); }
    if (result !== null) await kv.delete(K.solo(uid));
    else await U.kvPutJson(kv, K.solo(uid), s, C.SOLO_SESSION_TTL);
    const u = await db.getUser(d, uid);
    return U.json({ ok: true, session: soloView(s, !!result), result, win, balance: Number(u?.balance || 0) });
  } catch (e) {
    return U.errJson(e.message || 'خطا');
  }
});

const apiMinesCashout = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const s = await U.kvJson(kv, K.solo(uid), null);
  if (!s || s.type !== 'mines') return U.errJson('بازی مین‌یاب فعالی نداری', 400, 'no_session');
  if (!s.revealed.length) return U.errJson('حداقل یک خانه باز کن');
  const win = G.minesPayout(s);
  await soloPayout(d, kv, uid, s, win, 'mines');
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, session: soloView(s, true), result: 'win', win, balance: Number(u?.balance || 0) });
});

const apiHiloStart = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const bet = U.toInt(body.bet);
  const [s, resp] = await soloBegin(d, kv, uid, 'hilo', bet, () => G.hiloStart(bet));
  if (resp) return resp;
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, session: soloView(s), balance: Number(u?.balance || 0) });
});

const apiHiloGuess = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const direction = body.dir;
  const s = await U.kvJson(kv, K.solo(uid), null);
  if (!s || s.type !== 'hilo') return U.errJson('بازی بالا‌پایین فعالی نداری', 400, 'no_session');
  try {
    const [won, nxt] = G.hiloGuess(s, direction);
    if (!won) await soloPayout(d, kv, uid, s, 0, 'hilo');
    else await U.kvPutJson(kv, K.solo(uid), s, C.SOLO_SESSION_TTL);
    const u = await db.getUser(d, uid);
    return U.json({ ok: true, session: soloView(s), result: won ? null : 'lose', next: G.cj(nxt), win: 0, balance: Number(u?.balance || 0) });
  } catch (e) {
    return U.errJson(e.message || 'خطا');
  }
});

const apiHiloCashout = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const s = await U.kvJson(kv, K.solo(uid), null);
  if (!s || s.type !== 'hilo') return U.errJson('بازی بالا‌پایین فعالی نداری', 400, 'no_session');
  if (s.steps < 1) return U.errJson('حداقل یک حدس درست لازم است');
  const win = G.hiloPayout(s);
  await soloPayout(d, kv, uid, s, win, 'hilo');
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, session: soloView(s), result: 'win', win, balance: Number(u?.balance || 0) });
});

const apiSoloState = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const s = await U.kvJson(kv, K.solo(uid), null);
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, session: soloView(s), balance: Number(u?.balance || 0) });
});

// ═══════════ API: مچ‌میکینگ و بازی دونفره ═══════════
const apiMatchJoin = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const gameKey = body.game;
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  if (games[gameKey]?.type !== '2p' || !G.GAME_IMPL[gameKey]) return U.errJson('بازی دونفره نامعتبر است');
  const bet = U.toInt(body.bet);
  const name = (user.first_name || user.username || 'بازیکن').slice(0, 32);

  // بازی فعال؟
  const g0 = await activeGameOf(kv, uid);
  if (g0) return U.errJson('در یک بازی فعال هستی', 400, 'in_game', { game_id: g0.game_id });
  const w0 = await U.kvJson(kv, K.waiting(uid), null);
  if (w0) return U.errJson('در صف انتظار هستی', 400, 'in_queue', { queue: queueInfo(w0) });

  const admins = await db.getAdminIds(d);
  const err = await takeBet(d, uid, gameKey, bet, admins.has(uid));
  if (err) return U.errJson(err);

  // حریف در صف؟
  const opp = await queuePopOpponent(kv, gameKey, bet, uid);
  if (opp) {
    const g = await createGame(kv, gameKey, [{ user_id: opp.uid, name: opp.name || 'بازیکن' }, { user_id: uid, name }], bet);
    const u = await db.getUser(d, uid);
    return U.json({ ok: true, status: 'matched', game_id: g.game_id, balance: Number(u?.balance || 0) });
  }
  await queueAdd(kv, gameKey, bet, uid, name);
  const u = await db.getUser(d, uid);
  const w = await U.kvJson(kv, K.waiting(uid), null);
  return U.json({ ok: true, status: 'waiting', queue: queueInfo(w), balance: Number(u?.balance || 0) });
});

const apiMatchCancel = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const g = await activeGameOf(kv, uid);
  if (g) return U.json({ ok: true, status: 'matched', game_id: g.game_id });
  const w = await queueRemove(kv, uid);
  let refunded = 0;
  if (w) {
    await db.addBalance(d, uid, w.bet);
    refunded = w.bet;
  }
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, status: 'cancelled', refunded, balance: Number(u?.balance || 0) });
});

const apiMatchStatus = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const g = await activeGameOf(kv, uid);
  if (g) return U.json({ ok: true, status: 'matched', game_id: g.game_id });
  const w = await U.kvJson(kv, K.waiting(uid), null);
  const u = await db.getUser(d, uid);
  if (w) {
    if (Date.now() / 1000 - w.joined_at >= C.MATCH_TIMEOUT) {
      await queueRemove(kv, uid);
      await db.addBalance(d, uid, w.bet);
      return U.json({ ok: true, status: 'timeout', refunded: w.bet, balance: Number(u?.balance || 0) + w.bet });
    }
    return U.json({ ok: true, status: 'waiting', queue: queueInfo(w), balance: Number(u?.balance || 0) });
  }
  return U.json({ ok: true, status: 'idle', balance: Number(u?.balance || 0) });
});

async function findGame(kv, uid, gid) {
  let g = gid ? await loadGame(kv, gid) : null;
  if (!g) {
    const myGid = await kv.get(K.userGame(uid));
    if (myGid) g = await loadGame(kv, myGid);
  }
  return (g && gUids(g).includes(uid)) ? g : null;
}

async function checkTimeout(d, kv, g) {
  if (g.finished || Date.now() / 1000 <= g.deadline) return;
  if (Date.now() / 1000 > g.deadline) {
    const stalled = [...g.waiting];
    if (stalled.length === 1) {
      await settle(d, kv, g, gOpp(g, stalled[0]), `⏰ زمان ${gName(g, stalled[0])} تمام شد`);
    } else if (stalled.length === 0) {
      // بدون بازیکن در انتظار ولی زمان گذشته — مساوی
      await settle(d, kv, g, null, '⏰ زمان تمام شد — مساوی');
    } else {
      await settle(d, kv, g, null, '⏰ هر دو بازیکن غیرفعال بودند — مساوی');
    }
  }
}

const apiGameState = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const g = await findGame(kv, uid, body.game_id);
  const u = await db.getUser(d, uid);
  if (!g) return U.json({ ok: true, game: null, balance: Number(u?.balance || 0) });
  await checkTimeout(d, kv, g);
  await prepareGame(d, g);
  return U.json({ ok: true, game: gameView(g, uid), balance: Number(u?.balance || 0) });
});

const apiGameAction = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const g = await findGame(kv, uid, body.game_id);
  if (!g) return U.errJson('بازی پیدا نشد', 404, 'no_game');
  if (!g.finished) {
    const impl = G.GAME_IMPL[g.game_key];
    const proxy = gameProxy(g);
    const dbApi = {
      deduct: (u, amt) => db.deductBalance(d, u, amt),
      add: (u, amt) => db.addBalance(d, u, amt),
      balance: async (u) => { const x = await db.getUser(d, u); return Number(x?.balance || 0); },
    };
    let err = null;
    try {
      err = await impl.action(proxy, uid, body, dbApi);
    } catch (e) {
      console.error('action error', e);
      err = 'خطا در پردازش حرکت';
    }
    await applyOutcome(d, kv, g);
    if (err) {
      await prepareGame(d, g);
      await saveGame(kv, g);
      return U.errJson(err, 400, 'game_error', { game: gameView(g, uid) });
    }
    if (!g.finished) gTouch(g);
    await saveGame(kv, g);
  }
  await prepareGame(d, g);
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, game: gameView(g, uid), balance: Number(u?.balance || 0) });
});

const apiGameLeave = auth(async (request, env, ctx, user, body) => {
  const d = env.DB, kv = env.STATE;
  const uid = user.user_id;
  const g = await findGame(kv, uid, body.game_id);
  if (!g) {
    const u = await db.getUser(d, uid);
    return U.json({ ok: true, game: null, balance: Number(u?.balance || 0) });
  }
  if (!g.finished) {
    await settle(d, kv, g, gOpp(g, uid), `${gName(g, uid)} بازی را ترک کرد`);
  }
  const u = await db.getUser(d, uid);
  return U.json({ ok: true, game: gameView(g, uid), balance: Number(u?.balance || 0) });
});

const apiBalance = auth(async (request, env, ctx, user, body) => {
  const d = env.DB;
  const u = await db.getUser(d, user.user_id);
  return U.json({ ok: true, balance: Number(u?.balance || 0) });
});

// ═══════════ پنل مدیریت ═══════════
const ADMIN_COOKIE = 'zar_admin';

function adminSecret() {
  // SHA-256 با encoder — sync نیست؛ از مقایسه رشته‌ای با توکن ذخیره‌شده استفاده می‌کنیم
  // کوکی: base64(payload).hex(hmac(sha256(adminSecretRaw), payload))
  return `zar-admin:${C.env.BOT_TOKEN}:admin:${C.env.ADMIN_PASSWORD}`;
}

async function hmacHex(keyStr, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeAdminCookie() {
  const payload = JSON.stringify({ u: 'admin', exp: Math.floor(Date.now() / 1000) + 24 * 3600 });
  const sig = await hmacHex(adminSecret(), payload);
  return btoa(payload) + '.' + sig;
}

async function validAdminCookie(tok) {
  if (!tok || !tok.includes('.')) return false;
  try {
    const [rawB64, sig] = tok.split('.');
    const raw = atob(rawB64);
    const expected = await hmacHex(adminSecret(), raw);
    if (expected !== sig) return false;
    const p = JSON.parse(raw);
    return p.exp > Date.now() / 1000 && p.u === 'admin';
  } catch (_) { return false; }
}

const adminFails = new Map(); // ip → [ts] (تا ۱۵ تلاش در ۱۰ دقیقه)

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '?';
}

async function adminOk(request, body) {
  const cookie = (request.headers.get('Cookie') || '').match(/zar_admin=([^;]+)/);
  if (cookie && await validAdminCookie(decodeURIComponent(cookie[1]))) return true;
  // Basic auth برای API
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Basic ')) {
    try {
      const [u, p] = atob(h.slice(6)).split(':');
      return u === 'admin' && p === C.env.ADMIN_PASSWORD;
    } catch (_) { return false; }
  }
  return false;
}

function admin(handler) {
  return async (request, env, ctx) => {
    const ip = clientIp(request);
    const now = Date.now() / 1000;
    const fails = (adminFails.get(ip) || []).filter(t => now - t < 600);
    adminFails.set(ip, fails);
    if (fails.length >= 20) return U.errJson('تلاش‌های ناموفق زیاد — ۱۰ دقیقه بعد امتحان کن', 429);
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (_) { body = {}; }
    }
    const ok = request.url.includes('/admin/api/login') ? false : await adminOk(request, body);
    if (!ok && !request.url.includes('/admin/api/login')) {
      return U.errJson('نیاز به ورود', 401, 'auth');
    }
    try {
      return await handler(request, env, ctx, body);
    } catch (e) {
      console.error('admin error', e);
      return U.errJson(`خطای سرور: ${e.message}`, 500);
    }
  };
}

async function adminLogin(request, env, ctx, body) {
  const ip = clientIp(request);
  const now = Date.now() / 1000;
  const fails = (adminFails.get(ip) || []).filter(t => now - t < 600);
  adminFails.set(ip, fails);
  if (fails.length >= 15) return U.errJson('تلاش‌های ناموفق زیاد — ۱۰ دقیقه بعد امتحان کن', 429);
  const u = String(body.username || '').trim();
  const p = String(body.password || '');
  if (u !== 'admin' || p !== C.env.ADMIN_PASSWORD) {
    fails.push(now);
    adminFails.set(ip, fails);
    return U.errJson('نام کاربری یا رمز اشتباه است', 401);
  }
  adminFails.delete(ip);
  const resp = U.json({ ok: true });
  const cookie = await makeAdminCookie();
  const headers = new Headers(resp.headers);
  headers.append('Set-Cookie', `${ADMIN_COOKIE}=${cookie}; Max-Age=86400; HttpOnly; SameSite=Lax; Secure; Path=/`);
  return new Response(resp.body, { status: resp.status, headers });
}

async function adminLogout() {
  const resp = U.json({ ok: true });
  const headers = new Headers(resp.headers);
  headers.append('Set-Cookie', `${ADMIN_COOKIE}=; Max-Age=0; Path=/`);
  return new Response(resp.body, { status: resp.status, headers });
}

// ─── user detail (برای پنل) ───
async function userDetail(d, kv, uid) {
  const u = await db.get(d,
    'SELECT user_id, username, first_name, balance, bank_balance, total_xp, level, card_number, created_at FROM users WHERE user_id = ?', [uid]);
  if (!u) return null;
  const assets = await db.all(d, 'SELECT asset_type, asset_key, COUNT(*) AS c, SUM(daily_income) AS inc FROM assets WHERE user_id = ? GROUP BY asset_type, asset_key', [uid]);
  const inv = await db.all(d, 'SELECT item_key, COUNT(*) AS c FROM inventory WHERE user_id = ? GROUP BY item_key', [uid]);
  const gifts = await db.all(d, 'SELECT code, redeemed_at FROM gift_redemptions WHERE user_id = ? ORDER BY id DESC LIMIT 10', [uid]);
  const xp = Number(u.total_xp || 0);
  const inGame = !!(await kv.get(K.userGame(uid)));
  const inQueue = !!(await kv.get(K.waiting(uid)));
  const vipExp = await db.vipExpires(d, uid);
  return {
    user_id: Number(u.user_id), username: u.username, first_name: u.first_name,
    balance: Number(u.balance || 0), bank: Number(u.bank_balance || 0), xp, level: U.calcLevel(xp)[0],
    card: u.card_number, created_at: u.created_at,
    properties: Object.fromEntries(assets.filter(r => r.asset_type === 'property').map(r => [r.asset_key, Number(r.c)])),
    workers: Object.fromEntries(assets.filter(r => r.asset_type === 'worker').map(r => [r.asset_key, Number(r.c)])),
    daily_income: assets.reduce((s, r) => s + Number(r.inc || 0), 0),
    items: Object.fromEntries(inv.map(r => [r.item_key, Number(r.c)])),
    gifts: gifts.map(g => ({ code: g.code, at: Number(g.redeemed_at) })),
    in_game: inGame, in_queue: inQueue,
    banned: await db.isBanned(d, uid),
    vip: vipExp > Date.now() / 1000,
    vip_days: Math.max(0, Math.ceil((vipExp - Date.now() / 1000) / 86400)),
    vip_expires: vipExp > Date.now() / 1000 ? vipExp : null,
    warehouse_level: await db.getWarehouseLevel(d, uid),
  };
}

// ─── handlers پنل ───
async function adminStats(request, env, ctx, body) {
  const d = env.DB, kv = env.STATE;
  const s = await db.get(d, 'SELECT COUNT(*) AS users, COALESCE(SUM(balance),0) AS bal, COALESCE(SUM(bank_balance),0) AS bank FROM users');
  const gc = await db.get(d, 'SELECT COUNT(*) AS c FROM gift_codes WHERE active = 1');
  // بازی‌های فعال — شمردن کلیدهای KV گران است؛ تخمین از D1: بازی فعال در KV است. برای پنل ساده‌تر: 0
  let queue = 0;
  const list = await kv.list({ prefix: 'waiting:' });
  queue = list.keys.length;
  return U.json({
    ok: true, users: Number(s?.users || 0), balance: Number(s?.bal || 0), bank: Number(s?.bank || 0),
    gifts: Number(gc?.c || 0), games: 0, queue,
    redis: false, default_password: C.env.ADMIN_PASSWORD === 'admin' || !C.env.ADMIN_PASSWORD,
    bot_off: (await db.getSetting(d, 'bot_off', '')) === '1',
    catalog: {
      properties: Object.entries(C.PROPERTIES).map(([k, v]) => ({ key: k, name: v.name, emoji: v.emoji, price: v.price })),
      workers: Object.entries(C.WORKERS).map(([k, v]) => ({ key: k, name: v.name, emoji: v.emoji, price: v.price })),
      items: Object.entries(C.BLACKMARKET_ITEMS).map(([k, v]) => ({ key: k, name: v.name, emoji: v.emoji, price: v.price, type: v.type })),
      max_per_key: C.MAX_PER_KEY,
    },
  });
}

async function adminSearch(request, env, ctx, body) {
  const d = env.DB;
  const q = String(body.q || '').replace(/[۰-۹]/g, x => '۰۱۲۳۴۵۶۷۸۹'.indexOf(x)).replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x)).trim().replace(/^@/, '');
  if (!q) return U.json({ ok: true, results: [] });
  const cols = 'user_id, username, first_name, balance, bank_balance, total_xp';
  let rows;
  if (/^\d{1,19}$/.test(q)) {
    rows = await db.all(d, `SELECT ${cols} FROM users WHERE user_id = ? OR card_number = ? LIMIT 20`, [parseInt(q, 10), q]);
  } else {
    const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    rows = await db.all(d, `SELECT ${cols} FROM users WHERE (username LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\') ORDER BY balance DESC LIMIT 20`, [like, like]);
  }
  const out = [];
  for (const r of rows) {
    out.push({
      user_id: Number(r.user_id), username: r.username, first_name: r.first_name,
      balance: Number(r.balance || 0), bank: Number(r.bank_balance || 0),
      level: U.calcLevel(Number(r.total_xp || 0))[0],
      banned: await db.isBanned(d, Number(r.user_id)),
    });
  }
  return U.json({ ok: true, results: out });
}

async function adminUser(request, env, ctx, body) {
  const uid = U.toInt(body.user_id);
  const u = uid ? await userDetail(env.DB, env.STATE, uid) : null;
  if (!u) return U.errJson('کاربر پیدا نشد', 404);
  return U.json({ ok: true, user: u });
}

async function adminAdjust(request, env, ctx, body) {
  const d = env.DB;
  const uid = U.toInt(body.user_id);
  const kind = body.kind;
  const key = String(body.key || '');
  const amount = U.toInt(body.amount, 0) || 0;
  if (!C.GRANT_KINDS.includes(kind)) return U.errJson('نوع تغییر نامعتبر است');
  if (!amount || Math.abs(amount) > 1e15) return U.errJson('مقدار نامعتبر است');
  if (['property', 'worker', 'item'].includes(kind)) {
    const store = { property: C.PROPERTIES, worker: C.WORKERS, item: C.BLACKMARKET_ITEMS }[kind];
    if (!(key in store)) return U.errJson('آیتم نامعتبر است');
  }
  if (!uid || !(await db.get(d, 'SELECT user_id FROM users WHERE user_id = ?', [uid]))) return U.errJson('کاربر پیدا نشد', 404);
  const done = amount > 0
    ? await db.grantSmart(d, uid, kind, key, Math.abs(amount))
    : await db.revokeSmart(d, uid, kind, key, Math.abs(amount));
  const msg = `${db.kindLabel(kind, key)}: ${amount > 0 ? '+' : '−'}${U.fmt(done)}` + (done < Math.abs(amount) ? ' (بیشتر از این ممکن نبود — سقف/موجودی)' : '');
  return U.json({ ok: true, done, message: msg, user: await userDetail(d, env.STATE, uid) });
}

async function adminGiftsList(request, env, ctx, body) {
  const d = env.DB;
  const rows = await db.all(d, 'SELECT * FROM gift_codes ORDER BY created_at DESC LIMIT 300');
  const out = rows.map(r => {
    let rewards = {};
    try { rewards = JSON.parse(r.rewards || '{}'); } catch (_) {}
    return {
      code: r.code, rewards,
      rewards_text: db.rewardsText(db.rewardsList(rewards)).replace(/• /g, ''),
      max_uses: Number(r.max_uses), used: Number(r.used_count), min_level: Number(r.min_level),
      expires_at: r.expires_at ? Number(r.expires_at) : null, active: !!Number(r.active),
      note: r.note || '', created_at: Number(r.created_at),
    };
  });
  return U.json({ ok: true, gifts: out });
}

async function adminGiftsCreate(request, env, ctx, body) {
  const d = env.DB;
  let code = db.normCode(body.code) || U.randomToken(8).toUpperCase();
  const raw = body.rewards || {};
  const rewards = {};
  for (const k of ['coins', 'bank', 'xp', 'levels']) {
    const n = U.toInt(raw[k], 0) || 0;
    if (n < 0 || n > 1e15) return U.errJson('مقدار جایزه نامعتبر است');
    if (n) rewards[k] = k === 'levels' ? Math.min(n, C.MAX_LEVEL) : n;
  }
  for (const [field, store] of [['properties', C.PROPERTIES], ['workers', C.WORKERS], ['items', C.BLACKMARKET_ITEMS]]) {
    const sub = {};
    for (const [key, n] of Object.entries(raw[field] || {})) {
      if (!(key in store)) return U.errJson(`آیتم نامعتبر: ${key}`);
      const v = U.toInt(n, 0) || 0;
      if (v > 0) sub[key] = Math.min(v, 100);
    }
    if (Object.keys(sub).length) rewards[field] = sub;
  }
  if (!Object.keys(rewards).length) return U.errJson('حداقل یک جایزه تعیین کن');
  const maxUses = Math.max(0, U.toInt(body.max_uses, 0) || 0);
  const minLevel = Math.max(0, U.toInt(body.min_level, 0) || 0);
  const hours = Math.max(0, U.toInt(body.expires_hours, 0) || 0);
  const expires = hours ? Date.now() / 1000 + hours * 3600 : null;
  const note = String(body.note || '').slice(0, 255);
  if (await db.get(d, 'SELECT code FROM gift_codes WHERE code = ?', [code])) return U.errJson('این کد قبلاً ساخته شده');
  await db.run(d,
    'INSERT INTO gift_codes (code, rewards, max_uses, used_count, min_level, expires_at, active, note, created_at) VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?)',
    [code, JSON.stringify(rewards), maxUses, minLevel, expires, note, Date.now() / 1000]);
  return U.json({ ok: true, code });
}

async function adminGiftsToggle(request, env, ctx, body) {
  const n = await db.run(env.DB, 'UPDATE gift_codes SET active = 1 - active WHERE code = ?', [db.normCode(body.code)]);
  return U.json({ ok: !!(n.meta.changes || 0) });
}

async function adminGiftsDelete(request, env, ctx, body) {
  const d = env.DB;
  const code = db.normCode(body.code);
  await db.run(d, 'DELETE FROM gift_codes WHERE code = ?', [code]);
  await db.run(d, 'DELETE FROM gift_redemptions WHERE code = ?', [code]);
  return U.json({ ok: true });
}

async function adminShopProducts(request, env, ctx, body) {
  const d = env.DB;
  const prods = await db.all(d, 'SELECT * FROM shop_products ORDER BY sort ASC, id ASC');
  const sold = await db.all(d, "SELECT product_id, COUNT(*) AS c FROM shop_orders WHERE status = 'paid' GROUP BY product_id");
  const soldMap = Object.fromEntries(sold.map(r => [Number(r.product_id), Number(r.c)]));
  const out = prods.map(p => {
    let rw = {};
    try { rw = JSON.parse(p.rewards || '{}'); } catch (_) {}
    return {
      id: Number(p.id), title: p.title, description: p.description || '', rewards: rw,
      rewards_text: db.rewardsText(db.rewardsList(rw)).replace(/• /g, ''),
      price_toman: Number(p.price_toman || 0), price_stars: Number(p.price_stars || 0),
      active: !!Number(p.active), sort: Number(p.sort || 0), sold: soldMap[Number(p.id)] || 0,
    };
  });
  return U.json({
    ok: true, products: out,
    card_number: await db.getSetting(d, 'card_number', ''),
    card_holder: await db.getSetting(d, 'card_holder', ''),
  });
}

async function adminShopSave(request, env, ctx, body) {
  const d = env.DB;
  const pid = U.toInt(body.id, 0) || 0;
  const title = String(body.title || '').trim().slice(0, 64);
  if (!title) return U.errJson('عنوان محصول را وارد کن');
  const raw = body.rewards || {};
  const rewards = {};
  for (const k of ['coins', 'bank', 'xp', 'levels', 'vip_days']) {
    const n = U.toInt(raw[k], 0) || 0;
    if (n < 0 || n > 1e15) return U.errJson('مقدار جایزه نامعتبر است');
    if (n) rewards[k] = k === 'levels' ? Math.min(n, C.MAX_LEVEL) : (k === 'vip_days' ? Math.min(n, 3650) : n);
  }
  for (const [field, store] of [['properties', C.PROPERTIES], ['workers', C.WORKERS], ['items', C.BLACKMARKET_ITEMS]]) {
    const sub = {};
    for (const [key, n] of Object.entries(raw[field] || {})) {
      if (!(key in store)) return U.errJson(`آیتم نامعتبر: ${key}`);
      const v = U.toInt(n, 0) || 0;
      if (v > 0) sub[key] = Math.min(v, 100);
    }
    if (Object.keys(sub).length) rewards[field] = sub;
  }
  if (!Object.keys(rewards).length) return U.errJson('حداقل یک مورد (پول/لول/ملک/...) تعیین کن');
  const toman = Math.max(0, U.toInt(body.price_toman, 0) || 0);
  const stars = Math.max(0, Math.min(100000, U.toInt(body.price_stars, 0) || 0));
  if (!toman && !stars) return U.errJson('حداقل یکی از قیمت‌ها (تومان یا استارز) را وارد کن');
  const desc = String(body.description || '').slice(0, 500);
  const sort = U.toInt(body.sort, 0) || 0;
  const rj = JSON.stringify(rewards);
  if (pid) {
    await db.run(d, 'UPDATE shop_products SET title = ?, description = ?, rewards = ?, price_toman = ?, price_stars = ?, sort = ? WHERE id = ?',
      [title, desc, rj, toman, stars, sort, pid]);
  } else {
    await db.run(d, 'INSERT INTO shop_products (title, description, rewards, price_toman, price_stars, active, sort, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [title, desc, rj, toman, stars, sort, Date.now() / 1000]);
  }
  return U.json({ ok: true });
}

async function adminShopToggle(request, env, ctx, body) {
  const n = await db.run(env.DB, 'UPDATE shop_products SET active = 1 - active WHERE id = ?', [U.toInt(body.id, 0)]);
  return U.json({ ok: !!(n.meta.changes || 0) });
}

async function adminShopDelete(request, env, ctx, body) {
  const n = await db.run(env.DB, 'DELETE FROM shop_products WHERE id = ?', [U.toInt(body.id, 0)]);
  return U.json({ ok: !!(n.meta.changes || 0) });
}

async function adminShopSettings(request, env, ctx, body) {
  const d = env.DB;
  const card = String(body.card_number || '')
    .replace(/[۰-۹]/g, x => '۰۱۲۳۴۵۶۷۸۹'.indexOf(x))
    .replace(/[^\d\-\s]/g, '').trim().slice(0, 30);
  await db.setSetting(d, 'card_number', card);
  await db.setSetting(d, 'card_holder', String(body.card_holder || '').trim().slice(0, 64));
  return U.json({ ok: true });
}

async function adminShopOrders(request, env, ctx, body) {
  const d = env.DB;
  const status = String(body.status || '');
  let where = '', args = [];
  if (['pending', 'awaiting_receipt', 'review', 'paid', 'rejected', 'cancelled'].includes(status)) {
    where = 'WHERE o.status = ?';
    args = [status];
  }
  const rows = await db.all(d, `SELECT o.*, u.first_name, u.username FROM shop_orders o LEFT JOIN users u ON u.user_id = o.user_id ${where} ORDER BY o.id DESC LIMIT 200`, args);
  const rev = await db.get(d, "SELECT COUNT(*) AS c FROM shop_orders WHERE status = 'review'");
  return U.json({
    ok: true, review_count: Number(rev?.c || 0),
    orders: rows.map(r => ({
      id: Number(r.id), user_id: Number(r.user_id), name: r.first_name || '', username: r.username || '',
      title: r.title, method: r.method, amount: Number(r.amount), status: r.status,
      receipt: !!r.receipt_file_id, created_at: Number(r.created_at),
    })),
  });
}

async function deliverOrderAdmin(d, token, oid, allowed) {
  const o = await db.get(d, 'SELECT * FROM shop_orders WHERE id = ?', [oid]);
  if (!o) return [null, 'سفارش پیدا نشد'];
  if (!allowed.includes(o.status)) return [null, `وضعیت فعلی سفارش: ${o.status}`];
  let rewards = {};
  try { rewards = JSON.parse(o.rewards || '{}'); } catch (_) {}
  const granted = [], skipped = [];
  for (const [kind, key, n] of db.rewardsList(rewards)) {
    const done = await db.grantSmart(d, Number(o.user_id), kind, key, n);
    if (done > 0) granted.push([kind, key, done]);
    if (done < n) skipped.push([kind, key, n - done]);
  }
  await db.run(d, "UPDATE shop_orders SET status = 'paid', updated_at = ? WHERE id = ?", [Date.now() / 1000, oid]);
  let text = `✅ <b>خرید تحویل شد!</b>\n━━━━━━━━━━━━━━━━━━\n🛒 ${U.esc(o.title)} (سفارش #${oid})\n${db.rewardsText(granted)}`;
  if (skipped.length) text += '\n\n⚠️ به‌خاطر سقف مجاز اضافه نشد:\n' + db.rewardsText(skipped);
  return [Number(o.user_id), text];
}

async function adminShopApprove(request, env, ctx, body) {
  const oid = U.toInt(body.id, 0);
  const [buyer, text] = await deliverOrderAdmin(env.DB, C.env.BOT_TOKEN, oid, ['review', 'awaiting_receipt', 'pending']);
  if (!buyer) return U.errJson(text.replace(/<[^>]+>/g, ''));
  await U.sendMessage(C.env.BOT_TOKEN, buyer, text);
  return U.json({ ok: true });
}

async function adminShopReject(request, env, ctx, body) {
  const d = env.DB;
  const oid = U.toInt(body.id, 0);
  const o = await db.get(d, 'SELECT user_id FROM shop_orders WHERE id = ?', [oid]);
  const n = await db.run(d, "UPDATE shop_orders SET status = 'rejected', updated_at = ? WHERE id = ? AND status IN ('review', 'awaiting_receipt', 'pending')", [Date.now() / 1000, oid]);
  if (!(n.meta.changes || 0)) return U.errJson('این سفارش قابل رد نیست');
  if (o) await U.sendMessage(C.env.BOT_TOKEN, Number(o.user_id), `❌ سفارش #${oid} تأیید نشد. در صورت مشکل با پشتیبانی تماس بگیر.`);
  return U.json({ ok: true });
}

async function adminBan(request, env, ctx, body) {
  const d = env.DB, kv = env.STATE;
  const uid = U.toInt(body.user_id, 0);
  if (!uid) return U.errJson('آیدی نامعتبر است');
  const admins = await db.getAdminIds(d);
  if (admins.has(uid)) return U.errJson('این کاربر مالک یا ادمین ربات است — اول از تب «ادمین‌ها» حذفش کن');
  if (!(await db.get(d, 'SELECT user_id FROM users WHERE user_id = ?', [uid]))) return U.errJson('کاربر پیدا نشد', 404);
  await db.run(d, 'INSERT INTO banned_users (user_id, reason, banned_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at',
    [uid, String(body.reason || '').slice(0, 255), Date.now() / 1000]);
  // حذف از صف/بازی
  const w = await queueRemove(kv, uid);
  if (w) await db.addBalance(d, uid, w.bet);
  const gid = await kv.get(K.userGame(uid));
  if (gid) {
    const g = await loadGame(kv, gid);
    if (g && !g.finished) await settle(d, kv, g, gOpp(g, uid), `${gName(g, uid)} از ربات محروم شد`);
  }
  await kv.delete(K.solo(uid));
  await U.sendMessage(C.env.BOT_TOKEN, uid, '🚫 شما از ربات محروم شدید.');
  return U.json({ ok: true, user: await userDetail(d, kv, uid) });
}

async function adminUnban(request, env, ctx, body) {
  const d = env.DB;
  const uid = U.toInt(body.user_id, 0);
  await db.run(d, 'DELETE FROM banned_users WHERE user_id = ?', [uid]);
  await U.sendMessage(C.env.BOT_TOKEN, uid, '✅ محرومیت شما برداشته شد. خوش برگشتی!');
  return U.json({ ok: true, user: await userDetail(d, env.STATE, uid) });
}

async function adminBotToggle(request, env, ctx, body) {
  const d = env.DB;
  const off = typeof body.off === 'boolean' ? body.off : null;
  const cur = (await db.getSetting(d, 'bot_off', '')) === '1';
  const newVal = off === null ? !cur : off;
  await db.setSetting(d, 'bot_off', newVal ? '1' : '0');
  const admins = await db.getAdminIds(d);
  for (const aid of admins) {
    await U.sendMessage(C.env.BOT_TOKEN, aid, `🤖 وضعیت ربات تغییر کرد:\n${newVal ? '🔴 <b>خاموش</b> — ربات به جز ادمین‌ها جواب نمی‌دهد' : '🟢 <b>روشن</b>'}`);
  }
  return U.json({ ok: true, off: newVal });
}

async function adminAdminsList(request, env, ctx, body) {
  const d = env.DB;
  const owner = C.env.OWNER_ID;
  const fixed = [...C.env.ADMIN_IDS].sort((a, b) => (a !== owner) - (b !== owner) || a - b);
  const names = {};
  if (fixed.length) {
    const ph = fixed.map(() => '?').join(',');
    for (const r of await db.all(d, `SELECT user_id, first_name, username FROM users WHERE user_id IN (${ph})`, fixed)) {
      names[Number(r.user_id)] = r;
    }
  }
  const out = fixed.map(uid => {
    const r = names[uid] || {};
    return { user_id: uid, name: r.first_name || '', username: r.username || '', role: uid === owner ? 'owner' : 'env', note: '', added_at: null, removable: false };
  });
  const rows = await db.all(d, 'SELECT a.user_id, a.note, a.added_at, u.first_name, u.username FROM bot_admins a LEFT JOIN users u ON u.user_id = a.user_id ORDER BY a.added_at ASC');
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (fixed.includes(uid)) continue;
    out.push({ user_id: uid, name: r.first_name || '', username: r.username || '', role: 'panel', note: r.note || '', added_at: Number(r.added_at), removable: true });
  }
  return U.json({ ok: true, admins: out });
}

async function adminAdminsAdd(request, env, ctx, body) {
  const d = env.DB;
  const uid = U.toInt(body.user_id, 0) || 0;
  if (uid <= 0) return U.errJson('آیدی عددی نامعتبر است');
  const admins = await db.getAdminIds(d);
  if (admins.has(uid)) return U.errJson('این کاربر از قبل ادمین است');
  if (await db.isBanned(d, uid)) return U.errJson('این کاربر بن است — اول رفع بن کن');
  const u = await db.get(d, 'SELECT first_name FROM users WHERE user_id = ?', [uid]);
  if (!u) return U.errJson('کاربری با این آیدی در ربات پیدا نشد — باید اول ربات را استارت کرده باشد', 404);
  await db.run(d, 'INSERT INTO bot_admins (user_id, note, added_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET note = excluded.note',
    [uid, String(body.note || '').slice(0, 255), Date.now() / 1000]);
  await U.sendMessage(C.env.BOT_TOKEN, uid, '🛡 شما <b>ادمین ربات</b> شدید.\n• رسیدهای خرید برای تأیید یا رد به شما هم ارسال می‌شود\n• در حالت خاموشی، ربات برای شما کار می‌کند');
  return U.json({ ok: true, name: u.first_name || '' });
}

async function adminAdminsRemove(request, env, ctx, body) {
  const d = env.DB;
  const uid = U.toInt(body.user_id, 0) || 0;
  if (C.env.ADMIN_IDS.has(uid)) return U.errJson('این ادمین از تنظیمات سرور (OWNER_ID یا SHOP_ADMIN_IDS) است و از پنل قابل حذف نیست');
  const n = await db.run(d, 'DELETE FROM bot_admins WHERE user_id = ?', [uid]);
  if (!(n.meta.changes || 0)) return U.errJson('این کاربر ادمین نیست');
  await U.sendMessage(C.env.BOT_TOKEN, uid, 'ℹ️ دسترسی ادمین شما برداشته شد.');
  return U.json({ ok: true });
}

async function adminVipList(request, env, ctx, body) {
  const d = env.DB;
  const rows = await db.all(d, 'SELECT v.user_id, v.expires_at, v.note, v.updated_at, u.first_name, u.username FROM vip_users v LEFT JOIN users u ON u.user_id = v.user_id ORDER BY v.expires_at DESC LIMIT 300');
  const now = Date.now() / 1000;
  return U.json({ ok: true, vips: rows.map(r => {
    const exp = Number(r.expires_at);
    const rem = exp > now ? Math.ceil((exp - now) / 86400) : 0;
    return { user_id: Number(r.user_id), name: r.first_name || '', username: r.username || '', expires_at: exp, days_left: rem, active: exp > now, note: r.note || '' };
  }) });
}

async function adminVipSet(request, env, ctx, body) {
  const d = env.DB;
  const uid = U.toInt(body.user_id, 0) || 0;
  const days = U.toInt(body.days, 0) || 0;
  if (uid <= 0) return U.errJson('آیدی عددی نامعتبر است');
  if (days <= 0 || days > 3650) return U.errJson('تعداد روز نامعتبر است');
  const u = await db.get(d, 'SELECT first_name FROM users WHERE user_id = ?', [uid]);
  if (!u) return U.errJson('کاربری با این آیدی در ربات پیدا نشد', 404);
  const note = String(body.note || '').slice(0, 255);
  const now = Date.now() / 1000;
  const cur = await db.vipExpires(d, uid);
  const base = body.reset ? now : Math.max(now, cur);
  const newExp = base + days * 86400;
  await db.run(d, 'INSERT INTO vip_users (user_id, expires_at, note, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at, note = excluded.note, updated_at = excluded.updated_at',
    [uid, newExp, note, now]);
  await U.sendMessage(C.env.BOT_TOKEN, uid,
    `👑 <b>اشتراک VIP شما فعال شد!</b>\n━━━━━━━━━━━━━━━━━━\n⏳ مدت: <b>${days} روز</b>\n`
    + `🚀 تا ${C.VIP_LAUNCHER_MAX} عدد از هر وسیله شلیک\n🏭 +${C.VIP_AMMO_BONUS} ظرفیت مهمات در هر لول انبار\n`
    + `🏠 +${Math.round(C.VIP_INCOME_BONUS * 100)}٪ سود ملک و کارگر\n🏦 سود روزانه ${Math.round(C.VIP_BANK_RATE * 100)}٪ بانک`);
  return U.json({ ok: true, days_left: Math.ceil((newExp - now) / 86400) });
}

async function adminVipRemove(request, env, ctx, body) {
  const d = env.DB;
  const uid = U.toInt(body.user_id, 0) || 0;
  if (uid <= 0) return U.errJson('آیدی نامعتبر است');
  await db.run(d, 'DELETE FROM vip_users WHERE user_id = ?', [uid]);
  await U.sendMessage(C.env.BOT_TOKEN, uid, 'ℹ️ اشتراک VIP شما توسط مدیریت غیرفعال شد.');
  return U.json({ ok: true });
}

async function adminControlsGet(request, env, ctx, body) {
  const d = env.DB;
  const controls = JSON.parse(await db.getSetting(d, 'bot_controls', '{}') || '{}');
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  return U.json({
    ok: true,
    games: Object.entries(games).map(([k, v]) => ({ key: k, name: v.name, emoji: v.emoji, type: v.type, disabled: (controls.disabled_games || []).includes(k) })),
    sections: Object.entries(C.BOT_SECTIONS).map(([k, v]) => ({ key: k, name: v, disabled: (controls.disabled_sections || []).includes(k) })),
    texts: controls.texts || {},
  });
}

async function adminControlsSave(request, env, ctx, body) {
  const d = env.DB;
  const games = C.buildGames(C.MINIAPP_MIN_BET, C.MINIAPP_MAX_BET);
  const dg = (body.disabled_games || []).filter(k => k in games);
  const ds = (body.disabled_sections || []).filter(k => k in C.BOT_SECTIONS);
  const rawT = body.texts && typeof body.texts === 'object' ? body.texts : {};
  const texts = {};
  for (const [k, v] of Object.entries(rawT)) {
    if (typeof v === 'string' && v.trim()) texts[String(k).slice(0, 40)] = v.trim().slice(0, 1000);
  }
  const controls = { disabled_games: dg, disabled_sections: ds, texts };
  await db.setSetting(d, 'bot_controls', JSON.stringify(controls));
  return U.json({ ok: true });
}

async function adminDesignGet(request, env, ctx, body) {
  const d = env.DB;
  const design = JSON.parse(await db.getSetting(d, 'design', '{}') || '{}');
  const menuColors = JSON.parse(await db.getSetting(d, 'menu_colors', '{}') || '{}');
  return U.json({
    ok: true,
    design: Object.assign({}, C.DEFAULT_DESIGN, design),
    defaults: C.DEFAULT_DESIGN,
    menu_colors: menuColors,
    menu_buttons: C.MENU_BUTTONS.map(([k, v]) => ({ key: k, label: v })),
    colors: C.MENU_COLORS,
  });
}

function cleanHex(v, def) {
  const s = String(v || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : def;
}

async function adminDesignSave(request, env, ctx, body) {
  const d = env.DB;
  const raw = body.design && typeof body.design === 'object' ? body.design : body;
  let newD;
  if (body.reset) newD = { ...C.DEFAULT_DESIGN };
  else {
    newD = {};
    for (const [k, dv] of Object.entries(C.DEFAULT_DESIGN)) newD[k] = cleanHex(raw[k], dv);
  }
  await db.setSetting(d, 'design', JSON.stringify(newD));
  const rawMc = body.menu_colors && typeof body.menu_colors === 'object' ? body.menu_colors : null;
  if (body.reset) {
    await db.setSetting(d, 'menu_colors', '{}');
  } else if (rawMc !== null) {
    const validKeys = new Set(C.MENU_BUTTONS.map(([k]) => k));
    const newMc = {};
    for (const [k, v] of Object.entries(rawMc)) {
      if (validKeys.has(k) && C.MENU_COLORS.includes(v) && v) newMc[k] = v;
    }
    await db.setSetting(d, 'menu_colors', JSON.stringify(newMc));
  }
  return U.json({ ok: true, design: newD });
}

// ─── آیتم‌های بازی (قیمت/درآمد قابل ویرایش) ───
async function adminGameItemsList(request, env, ctx, body) {
  const d = env.DB;
  const rows = await db.all(d, 'SELECT category, item_key, data, active, sort FROM game_items ORDER BY sort, item_key');
  const out = { property: [], worker: [], item: [] };
  for (const r of rows) {
    let dd = {};
    try { dd = JSON.parse(r.data); } catch (_) { continue; }
    if (typeof dd !== 'object') continue;
    dd._key = r.item_key;
    dd._active = !!Number(r.active);
    dd._sort = Number(r.sort || 0);
    (out[r.category] || []).push(dd);
  }
  return U.json({ ok: true, items: out });
}

async function adminGameItemsSave(request, env, ctx, body) {
  const d = env.DB;
  const cat = String(body.category || '');
  const key = String(body.key || '').trim();
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  if (!['property', 'worker', 'item'].includes(cat)) return U.errJson('دسته نامعتبر است');
  if (!/^[a-zA-Z0-9_]{2,64}$/.test(key)) return U.errJson('کلید آیتم باید حروف/عدد/آندرلاین انگلیسی باشد (۲ تا ۶۴ کاراکتر)');
  const existing = await db.get(d, 'SELECT data FROM game_items WHERE category = ? AND item_key = ?', [cat, key]);
  let base = {};
  if (existing) { try { base = JSON.parse(existing.data); } catch (_) {} }
  const name = String(data.name || base.name || '').trim().slice(0, 100);
  if (!name) return U.errJson('نام آیتم را وارد کن');
  const emoji = String(data.emoji || base.emoji || '•').trim().slice(0, 16);
  const price = U.toInt(data.price ?? base.price ?? 0, 0) || 0;
  if (price < 0 || price > 1e15) return U.errJson('قیمت نامعتبر است');
  const merged = { ...base, name, emoji, price };
  if (cat === 'property' || cat === 'worker') {
    const income = U.toInt(data.income ?? base.income ?? 0, 0) || 0;
    if (income < 0 || income > 1e15) return U.errJson('درآمد نامعتبر است');
    merged.income = income;
  } else {
    const itype = String(data.type || base.type || 'projectile');
    if (!['launcher', 'projectile', 'defense'].includes(itype)) return U.errJson('نوع آیتم نامعتبر است');
    merged.type = itype;
    if (itype === 'projectile') {
      const dmg = parseFloat(data.damage ?? base.damage ?? 0);
      if (isNaN(dmg) || dmg < 0 || dmg > 1) return U.errJson('درصد تخریب باید بین ۰ تا ۱ باشد (مثلاً 0.2 = ۲۰٪)');
      merged.damage = dmg;
      if (data.command) merged.command = String(data.command).slice(0, 100);
      merged.defense_type = String(data.defense_type || base.defense_type || '') || null;
    } else if (itype === 'defense') {
      const dc = parseFloat(data.defense_chance ?? base.defense_chance ?? 0);
      if (isNaN(dc) || dc < 0 || dc > 1) return U.errJson('احتمال دفاع باید بین ۰ تا ۱ باشد');
      merged.defense_chance = dc;
      merged.defends_against = String(data.defends_against || base.defends_against || '') || null;
    } else if (itype === 'launcher') {
      let launches = data.launches ?? base.launches ?? [];
      if (typeof launches === 'string') launches = launches.split(',').map(x => x.trim()).filter(Boolean);
      if (!Array.isArray(launches)) return U.errJson('لیست مهمات نامعتبر است');
      merged.launches = launches.filter(x => C.BLACKMARKET_ITEMS[x]?.type === 'projectile');
    }
  }
  const sort = U.toInt(body.sort ?? 0, 0) || 0;
  await db.run(d,
    'INSERT INTO game_items (category, item_key, data, active, sort) VALUES (?, ?, ?, 1, ?) ON CONFLICT(category, item_key) DO UPDATE SET data = excluded.data, active = 1, sort = excluded.sort',
    [cat, key, JSON.stringify(merged), sort]);
  return U.json({ ok: true });
}

async function adminGameItemsToggle(request, env, ctx, body) {
  const d = env.DB;
  const cat = String(body.category || '');
  const key = String(body.key || '');
  if (!['property', 'worker', 'item'].includes(cat) || !key) return U.errJson('آیتم نامعتبر است');
  const n = await db.run(d, 'UPDATE game_items SET active = 1 - active WHERE category = ? AND item_key = ?', [cat, key]);
  if (!(n.meta.changes || 0)) return U.errJson('آیتم پیدا نشد', 404);
  return U.json({ ok: true });
}

// ─── تنظیمات بازی (حد شرط، سود بانک، پایه انبار) ───
async function adminGameSettingsGet(request, env, ctx, body) {
  const d = env.DB;
  const s = JSON.parse(await db.getSetting(d, 'game_settings', '{}') || '{}');
  return U.json({ ok: true, settings: {
    min_bet: s.min_bet ?? C.MINIAPP_MIN_BET,
    max_bet: s.max_bet ?? C.MINIAPP_MAX_BET,
    bank_rate: s.bank_rate ?? C.BANK_RATE,
    warehouse_base: s.warehouse_base ?? C.WAREHOUSE_UPGRADE_BASE,
  } });
}

async function adminGameSettingsSave(request, env, ctx, body) {
  const d = env.DB;
  const s = body.settings && typeof body.settings === 'object' ? body.settings : body;
  const minBet = U.toInt(s.min_bet, C.MINIAPP_MIN_BET);
  const maxBet = U.toInt(s.max_bet, C.MINIAPP_MAX_BET);
  const whBase = U.toInt(s.warehouse_base, C.WAREHOUSE_UPGRADE_BASE);
  const bankRate = parseFloat(s.bank_rate ?? C.BANK_RATE);
  if (minBet === null || minBet < 0 || maxBet === null || maxBet < minBet) return U.errJson('حداقل/حداکثر شرط نامعتبر است');
  if (isNaN(bankRate) || bankRate < 0 || bankRate > 1) return U.errJson('سود بانک باید بین ۰ تا ۱ باشد (مثلاً 0.02 = ۲٪)');
  if (whBase === null || whBase <= 0) return U.errJson('مبلغ پایه ارتقای انبار نامعتبر است');
  await db.setSetting(d, 'game_settings', JSON.stringify({
    min_bet: minBet, max_bet: maxBet, bank_rate: bankRate, warehouse_base: whBase,
  }));
  return U.json({ ok: true });
}

// ═══════════ روتینگ ═══════════
export async function handleApi(request, env, ctx, path) {
  const method = request.method;
  const kv = env.STATE;

  // ─── صفحات HTML ───
  if (method === 'GET' && ['/', '/miniapp', '/webapp', '/casino', '/app'].includes(path)) {
    return serveAsset(env, 'miniapp.html');
  }
  if (method === 'GET' && (path === '/admin' || path === '/admin/')) {
    return serveAsset(env, 'admin.html');
  }
  if (method === 'GET' && path === '/health') {
    return U.json({ ok: true, games: 'kv', queue: 'kv' });
  }

  // ─── API مینی‌اپ ───
  const routes = {
    'POST /api/me': apiMe,
    'POST /api/balance': apiBalance,
    'POST /api/solo/state': apiSoloState,
    'POST /api/solo/mines/start': apiMinesStart,
    'POST /api/solo/mines/reveal': apiMinesReveal,
    'POST /api/solo/mines/cashout': apiMinesCashout,
    'POST /api/solo/hilo/start': apiHiloStart,
    'POST /api/solo/hilo/guess': apiHiloGuess,
    'POST /api/solo/hilo/cashout': apiHiloCashout,
    'POST /api/match/join': apiMatchJoin,
    'POST /api/match/cancel': apiMatchCancel,
    'POST /api/match/status': apiMatchStatus,
    'POST /api/game/state': apiGameState,
    'POST /api/game/action': apiGameAction,
    'POST /api/game/leave': apiGameLeave,
  };
  const key = `${method} ${path}`;
  if (routes[key]) return routes[key](request, env, ctx, await readBody(request));

  // solo instant: /api/solo/{game}
  if (method === 'POST' && path.startsWith('/api/solo/')) {
    return apiSoloInstant(request, env, ctx, await readBody(request));
  }

  // ─── پنل ادمین ───
  if (method === 'POST' && path === '/admin/api/login') return adminLogin(request, env, ctx, await readBody(request));
  if (method === 'POST' && path === '/admin/api/logout') return adminLogout();

  const adminRoutes = {
    'stats': adminStats, 'search': adminSearch, 'user': adminUser, 'adjust': adminAdjust,
    'gifts/list': adminGiftsList, 'gifts/create': adminGiftsCreate, 'gifts/toggle': adminGiftsToggle, 'gifts/delete': adminGiftsDelete,
    'shop/products': adminShopProducts, 'shop/save': adminShopSave, 'shop/toggle': adminShopToggle,
    'shop/delete': adminShopDelete, 'shop/orders': adminShopOrders, 'shop/approve': adminShopApprove,
    'shop/reject': adminShopReject, 'shop/settings': adminShopSettings,
    'ban': adminBan, 'unban': adminUnban, 'bot/toggle': adminBotToggle,
    'admins/list': adminAdminsList, 'admins/add': adminAdminsAdd, 'admins/remove': adminAdminsRemove,
    'vip/list': adminVipList, 'vip/set': adminVipSet, 'vip/remove': adminVipRemove,
    'controls/get': adminControlsGet, 'controls/save': adminControlsSave,
    'design/get': adminDesignGet, 'design/save': adminDesignSave,
    'gameitems/list': adminGameItemsList, 'gameitems/save': adminGameItemsSave, 'gameitems/toggle': adminGameItemsToggle,
    'gamesettings/get': adminGameSettingsGet, 'gamesettings/save': adminGameSettingsSave,
  };
  if (method === 'POST' && path.startsWith('/admin/api/')) {
    const sub = path.slice('/admin/api/'.length);
    if (adminRoutes[sub]) return adminRoutes[sub](request, env, ctx, await readBody(request));
  }

  return new Response('Not Found', { status: 404 });
}

async function readBody(request) {
  try { return await request.json(); } catch (_) { return {}; }
}

// سرو فایل‌های HTML — از ماژول import شده (src/assets.js)
import { ASSETS } from './assets.js';

export function serveAsset(env, name) {
  const html = ASSETS[name];
  if (!html) return new Response('not found: ' + name, { status: 500 });
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(name === 'admin.html' ? { 'X-Frame-Options': 'DENY' } : {}),
    },
  });
}
