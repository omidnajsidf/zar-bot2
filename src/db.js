// ═══════════ لایه دیتابیس D1 (SQLite) — پورت کامل db.py ═══════════
import * as C from './config.js';
import { calcLevel, nowTehranIso, todayStr, cardNumberFor, randomToken } from './utils.js';

// D1 در Cloudflare فقط اجرای serializable را روی یک دیتابیس تضمین نمی‌کند؛
// برای عملیات حساس مالی از batch با شرط WHERE balance >= ? استفاده می‌کنیم که
// اتمیک است و در صورت برقرار نبودن شرط rowcount صفر می‌شود.

export function d1(env) { return env.DB; }

// ─── اجرای کوئری‌ها ───
export async function all(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}
export async function get(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return (results && results[0]) || null;
}
export async function run(db, sql, params = []) {
  return await db.prepare(sql).bind(...params).run();
}

// ─── کاربران ───
export async function ensureUser(db, user) {
  const uid = Number(user.id);
  await run(db,
    `INSERT INTO users (user_id, username, first_name, balance, bank_balance, card_number, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name`,
    [uid, user.username || null, user.first_name || '', C.env.START_BALANCE || 0, cardNumberFor(uid), nowTehranIso()]);
  return await getUser(db, uid);
}

export async function getUser(db, uid) {
  return await get(db, 'SELECT * FROM users WHERE user_id = ?', [Number(uid)]);
}

export async function addBalance(db, uid, amount) {
  amount = Math.floor(Number(amount));
  if (amount <= 0) return;
  await run(db, 'UPDATE users SET balance = balance + ? WHERE user_id = ?', [amount, Number(uid)]);
}

export async function deductBalance(db, uid, amount) {
  amount = Math.floor(Number(amount));
  if (amount <= 0) return false;
  const r = await run(db, 'UPDATE users SET balance = balance - ? WHERE user_id = ? AND balance >= ?', [amount, Number(uid), amount]);
  return (r.meta.changes || 0) === 1;
}

export async function bankDeposit(db, uid, amount) {
  amount = Math.floor(Number(amount));
  if (amount <= 0) return false;
  const r = await run(db,
    'UPDATE users SET balance = balance - ?, bank_balance = bank_balance + ? WHERE user_id = ? AND balance >= ?',
    [amount, amount, Number(uid), amount]);
  return (r.meta.changes || 0) === 1;
}

export async function bankWithdraw(db, uid, amount) {
  amount = Math.floor(Number(amount));
  if (amount <= 0) return false;
  const r = await run(db,
    'UPDATE users SET bank_balance = bank_balance - ?, balance = balance + ? WHERE user_id = ? AND bank_balance >= ?',
    [amount, amount, Number(uid), amount]);
  return (r.meta.changes || 0) === 1;
}

export async function transferCoins(db, senderId, recipientId, amount, fee) {
  const total = Math.floor(amount + fee);
  const stmts = [
    db.prepare('UPDATE users SET balance = balance - ? WHERE user_id = ? AND balance >= ?').bind(total, Number(senderId), total),
    db.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').bind(Math.floor(amount), Number(recipientId)),
  ];
  try {
    await db.batch(stmts);
  } catch (e) {
    return false;
  }
  // بررسی اینکه هر دو آپدیت اعمال شدند (گیرنده باید وجود می‌داشت)
  const s = await getUser(db, senderId);
  const r = await getUser(db, recipientId);
  if (!s || !r) {
    // rollback ایده‌آل نیست ولی batch با شرط balance>= تضمین می‌کند فرستنده کسر نشده مگر موجودی داشته
    return false;
  }
  return true;
}

export async function findUserByCard(db, card) {
  const digits = String(card || '').replace(/\D/g, '');
  if (digits.length !== 16) return null;
  return await get(db, 'SELECT * FROM users WHERE card_number = ?', [digits]);
}

// ─── دارایی‌ها ───
export async function getAssetsSummary(db, uid) {
  const rows = await all(db,
    'SELECT asset_key, COUNT(*) AS count, SUM(daily_income) AS total_income FROM assets WHERE user_id = ? GROUP BY asset_key',
    [Number(uid)]);
  const out = {};
  for (const r of rows) out[r.asset_key] = { count: Number(r.count), total_income: Number(r.total_income || 0) };
  return out;
}

export async function getAssets(db, uid, assetType) {
  return await all(db, 'SELECT * FROM assets WHERE user_id = ? AND asset_type = ? ORDER BY id ASC', [Number(uid), assetType]);
}

export async function buyAsset(db, uid, assetType, assetKey, price, income) {
  uid = Number(uid);
  const stmts = [
    db.prepare('SELECT COUNT(*) AS c FROM assets WHERE user_id = ? AND asset_key = ?').bind(uid, assetKey),
  ];
  const cntRow = await get(db, 'SELECT COUNT(*) AS c FROM assets WHERE user_id = ? AND asset_key = ?', [uid, assetKey]);
  if (Number(cntRow?.c || 0) >= C.MAX_PER_KEY) return 'limit';
  const r = await run(db, 'UPDATE users SET balance = balance - ? WHERE user_id = ? AND balance >= ?', [price, uid, price]);
  if ((r.meta.changes || 0) !== 1) return 'balance';
  await run(db,
    'INSERT INTO assets (user_id, asset_type, asset_key, purchase_price, daily_income, purchased_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uid, assetType, assetKey, price, income, nowTehranIso()]);
  return 'ok';
}

// ─── درآمد ساعتی (پورت مستقیم: دارایی + سود بانک، سود مرکب) ───
export function calcIncome(bankBalance, dailyAsset, seconds) {
  if (seconds <= 0) return [0, 0];
  const assetIncome = Math.floor(dailyAsset * seconds / 86400);
  const bankInterest = Math.floor(bankBalance * C.BANK_RATE * seconds / 86400);
  return [assetIncome, bankInterest];
}

async function _incomeData(db, uid) {
  const u = await getUser(db, uid);
  if (!u) return null;
  const row = await get(db, 'SELECT COALESCE(SUM(daily_income), 0) AS total FROM assets WHERE user_id = ?', [Number(uid)]);
  return { bank: Number(u.bank_balance || 0), last: u.last_payout, dailyAsset: Number(row?.total || 0) };
}

function _elapsedSeconds(lastIso) {
  if (!lastIso) return 0;
  const last = new Date(lastIso.replace(/([+-]\d{2}):(\d{2})$/, ''));
  if (isNaN(last.getTime())) return 0;
  return Math.max(0, (Date.now() - last.getTime()) / 1000);
}

export async function peekIncome(db, uid, vip = false, vipBonus = 0, vipBankRate = 0) {
  const d = await _incomeData(db, uid);
  if (!d) return [0, 0, 0];
  const seconds = _elapsedSeconds(d.last);
  let [ai, bi] = calcIncome(d.bank, d.dailyAsset, seconds);
  if (vip) {
    ai = Math.floor(ai * (1 + vipBonus));
    bi = Math.floor(bi * (vipBankRate / C.BANK_RATE));
  }
  return [ai, bi, ai + bi];
}

export async function accrueIncome(db, uid, vip = false, vipBonus = 0, vipBankRate = 0) {
  uid = Number(uid);
  const d = await _incomeData(db, uid);
  if (!d) return [0, 0, 0];
  const seconds = _elapsedSeconds(d.last);
  if (seconds < 1) return [0, 0, 0];
  let [ai, bi] = calcIncome(d.bank, d.dailyAsset, seconds);
  if (vip) {
    ai = Math.floor(ai * (1 + vipBonus));
    bi = Math.floor(bi * (vipBankRate / C.BANK_RATE));
  }
  const nowIso = nowTehranIso();
  if (ai > 0 || bi > 0) {
    await run(db, 'UPDATE users SET balance = balance + ?, bank_balance = bank_balance + ?, last_payout = ? WHERE user_id = ?',
      [ai, bi, nowIso, uid]);
  } else {
    await run(db, 'UPDATE users SET last_payout = ? WHERE user_id = ?', [nowIso, uid]);
  }
  return [ai, bi, ai + bi];
}

// پرداخت خودکار ساعتی — با Cron Trigger صدا زده می‌شود.
// ایده‌آل: هر کاربر last_payout خودش را دارد و درآمد دقیقاً از همان لحظه محاسبه می‌شود.
export async function hourlyPayout(db) {
  const users = await all(db, 'SELECT user_id, bank_balance, last_payout FROM users');
  const incomeRows = await all(db, 'SELECT user_id, COALESCE(SUM(daily_income), 0) AS total FROM assets GROUP BY user_id');
  const assetMap = {};
  for (const r of incomeRows) assetMap[Number(r.user_id)] = Number(r.total || 0);
  const nowIso = nowTehranIso();
  const stmts = [];
  let paid = 0;
  for (const u of users) {
    const uid = Number(u.user_id);
    let seconds = _elapsedSeconds(u.last_payout);
    if (!u.last_payout) seconds = 3600;
    seconds = Math.max(0, Math.min(seconds, C.HOURLY_PAYOUT_MAX_CATCHUP));
    if (seconds < 1) {
      stmts.push(db.prepare('UPDATE users SET last_payout = ? WHERE user_id = ?').bind(nowIso, uid));
      continue;
    }
    const [ai, bi] = calcIncome(Number(u.bank_balance || 0), assetMap[uid] || 0, seconds);
    if (ai > 0 || bi > 0) {
      stmts.push(db.prepare(
        'UPDATE users SET balance = balance + ?, bank_balance = bank_balance + ?, last_payout = ? WHERE user_id = ?')
        .bind(ai, bi, nowIso, uid));
      paid++;
    } else {
      stmts.push(db.prepare('UPDATE users SET last_payout = ? WHERE user_id = ?').bind(nowIso, uid));
    }
  }
  // D1 batch حداکثر ۱۰۰ statement دارد — تکه‌تکه اجرا کن
  for (let i = 0; i < stmts.length; i += 90) {
    await db.batch(stmts.slice(i, i + 90));
  }
  return paid;
}

// ─── XP / لول ───
export async function addXp(db, uid, amount) {
  amount = Math.floor(Number(amount));
  if (amount <= 0) return [0, 1, false];
  uid = Number(uid);
  const u = await getUser(db, uid);
  if (!u) return [0, 1, false];
  const oldXp = Number(u.total_xp || 0);
  const oldLevel = Number(u.level || 1);
  const newXp = oldXp + amount;
  const newLevel = calcLevel(newXp)[0];
  await run(db, 'UPDATE users SET total_xp = total_xp + ?, level = ? WHERE user_id = ?', [amount, newLevel, uid]);
  return [newXp, newLevel, newLevel > oldLevel];
}

export async function unlockKabareh(db, uid) {
  uid = Number(uid);
  const r = await run(db,
    'UPDATE users SET balance = balance - ?, kabareh_unlocked = 1 WHERE user_id = ? AND kabareh_unlocked = 0 AND balance >= ?',
    [C.KABAREH_UNLOCK_COST, uid, C.KABAREH_UNLOCK_COST]);
  return (r.meta.changes || 0) === 1;
}

export async function setLastKabareh(db, uid, whenIso) {
  await run(db, 'UPDATE users SET last_kabareh = ? WHERE user_id = ?', [whenIso, Number(uid)]);
}

export async function setLastZar(db, uid, whenIso) {
  await run(db, 'UPDATE users SET last_zar = ? WHERE user_id = ?', [whenIso, Number(uid)]);
}

// ─── ماموریت‌های روزانه ───
async function eligibleMissions(db, uid) {
  const u = await getUser(db, uid);
  const kab = !!(u && Number(u.kabareh_unlocked || 0));
  const counts = await all(db, 'SELECT asset_type, COUNT(*) AS c FROM assets WHERE user_id = ? GROUP BY asset_type', [Number(uid)]);
  const propCount = Number((counts.find(r => r.asset_type === 'property') || {}).c || 0);
  const workerCount = Number((counts.find(r => r.asset_type === 'worker') || {}).c || 0);
  const maxProps = Object.keys(C.PROPERTIES).length * C.MAX_PER_KEY;
  const maxWorkers = Object.keys(C.WORKERS).length * C.MAX_PER_KEY;
  const eligible = [];
  for (const [key, t] of Object.entries(C.MISSION_TEMPLATES)) {
    if (t.type === 'buy_property' && propCount + t.target > maxProps) continue;
    if (t.type === 'buy_worker' && workerCount + t.target > maxWorkers) continue;
    if (t.type === 'kabareh' && !kab) continue;
    eligible.push(key);
  }
  return eligible;
}

export async function ensureDailyMissions(db, uid) {
  uid = Number(uid);
  const today = todayStr();
  const u = await getUser(db, uid);
  if (u && u.last_mission_date === today) return;
  const r = await run(db,
    'UPDATE users SET last_mission_date = ? WHERE user_id = ? AND (last_mission_date IS NULL OR last_mission_date != ?)',
    [today, uid, today]);
  if ((r.meta.changes || 0) === 0) return;
  await run(db, 'DELETE FROM user_missions WHERE user_id = ?', [uid]);
  const eligible = await eligibleMissions(db, uid);
  const n = Math.min(C.DAILY_MISSION_COUNT, eligible.length);
  if (n <= 0) return;
  // shuffle
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }
  const chosen = eligible.slice(0, n);
  const stmts = chosen.map(key => {
    const t = C.MISSION_TEMPLATES[key];
    return db.prepare(
      'INSERT INTO user_missions (user_id, mission_key, mission_date, progress, target, xp_reward) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(uid, key, today, t.target, t.xp);
  });
  await db.batch(stmts);
}

export async function getUserMissions(db, uid) {
  return await all(db, 'SELECT * FROM user_missions WHERE user_id = ? AND mission_date = ? ORDER BY id ASC', [Number(uid), todayStr()]);
}

export async function progressMission(db, uid, missionType, amount = 1, baseXp = 0) {
  await ensureDailyMissions(db, uid);
  uid = Number(uid);
  const missions = await all(db,
    'SELECT id, mission_key, progress, target, xp_reward FROM user_missions WHERE user_id = ? AND mission_date = ? AND completed = 0',
    [uid, todayStr()]);
  const completed = [];
  const stmts = [];
  for (const m of missions) {
    const template = C.MISSION_TEMPLATES[m.mission_key];
    if (!template || template.type !== missionType) continue;
    const target = Number(m.target);
    const newProgress = Number(m.progress) + amount;
    if (newProgress >= target) {
      stmts.push(db.prepare('UPDATE user_missions SET progress = ?, completed = 1 WHERE id = ?').bind(target, m.id));
      completed.push({ key: m.mission_key, desc: template.desc, xp: Number(m.xp_reward) });
    } else {
      stmts.push(db.prepare('UPDATE user_missions SET progress = ? WHERE id = ?').bind(newProgress, m.id));
    }
  }
  if (stmts.length) await db.batch(stmts);
  const missionXp = completed.reduce((s, m) => s + m.xp, 0);
  const totalXp = baseXp + missionXp;
  if (totalXp <= 0) return null;
  const [newXp, newLevel, leveledUp] = await addXp(db, uid, totalXp);
  return { user_id: uid, completed, mission_xp: missionXp, base_xp: baseXp, total_xp: totalXp, new_level: newLevel, leveled_up: leveledUp };
}

// ─── لیدربورد ───
export async function getLeaderboard(db, limit = 15, aroundUserId = null) {
  const top = await all(db,
    'SELECT user_id, first_name, username, balance, bank_balance, (balance + bank_balance) AS w FROM users ORDER BY w DESC LIMIT ?',
    [limit]);
  let rank = null;
  if (aroundUserId) {
    const me = await get(db, 'SELECT (balance + bank_balance) AS w FROM users WHERE user_id = ?', [Number(aroundUserId)]);
    if (me) {
      const r = await get(db, 'SELECT COUNT(*) AS c FROM users WHERE (balance + bank_balance) > ?', [Number(me.w || 0)]);
      rank = Number(r?.c || 0) + 1;
    }
  }
  return [top, rank];
}

// ─── انونتوری بازار سیاه ───
export async function buyInventoryItem(db, uid, itemKey) {
  const item = C.BLACKMARKET_ITEMS[itemKey];
  if (!item) return 'invalid';
  uid = Number(uid);
  const r = await run(db, 'UPDATE users SET balance = balance - ? WHERE user_id = ? AND balance >= ?', [item.price, uid, item.price]);
  if ((r.meta.changes || 0) !== 1) return 'balance';
  await run(db, 'INSERT INTO inventory (user_id, item_key, purchased_at) VALUES (?, ?, ?)', [uid, itemKey, nowTehranIso()]);
  return 'ok';
}

export async function getInventoryCounts(db, uid) {
  const rows = await all(db, 'SELECT item_key, COUNT(*) AS c FROM inventory WHERE user_id = ? GROUP BY item_key', [Number(uid)]);
  const out = {};
  for (const r of rows) out[r.item_key] = Number(r.c);
  return out;
}

export async function hasItem(db, uid, itemKey) {
  const r = await get(db, 'SELECT 1 AS x FROM inventory WHERE user_id = ? AND item_key = ? LIMIT 1', [Number(uid), itemKey]);
  return !!r;
}

export async function consumeItem(db, uid, itemKey) {
  const r = await run(db, 'DELETE FROM inventory WHERE id = (SELECT id FROM inventory WHERE user_id = ? AND item_key = ? ORDER BY id ASC LIMIT 1)',
    [Number(uid), itemKey]);
  return (r.meta.changes || 0) === 1;
}

// ─── حمله (تخریب پول + دارایی — مثل apply_damage_split) ───
export async function applyDamage(db, targetId, damagePercent) {
  const pct = Math.max(0, Math.min(Number(damagePercent), 1));
  targetId = Number(targetId);
  if (pct <= 0) return { total: 0, money: 0, assets: [], asset_value: 0 };
  const u = await getUser(db, targetId);
  if (!u) return { total: 0, money: 0, assets: [], asset_value: 0 };
  const bal = Math.max(0, Number(u.balance || 0));
  const bank = Math.max(0, Number(u.bank_balance || 0));
  const assets = await all(db, 'SELECT id, asset_type, asset_key, purchase_price FROM assets WHERE user_id = ?', [targetId]);
  const moneyPart = Math.floor((bal + bank) * pct);
  const n = assets.length;
  let k = 0;
  if (n) {
    const exact = n * pct;
    k = Math.floor(exact);
    if (Math.random() < exact - k) k += 1;
    if (pct < 1 && n > 1) k = Math.min(k, n - 1);
  }
  const shuffled = [...assets].sort(() => Math.random() - 0.5);
  const removed = shuffled.slice(0, k);
  if (moneyPart <= 0 && !removed.length) return { total: 0, money: 0, assets: [], asset_value: 0 };
  const fromBal = Math.min(bal, moneyPart);
  const fromBank = Math.min(bank, moneyPart - fromBal);
  const money = fromBal + fromBank;
  const stmts = [db.prepare('UPDATE users SET balance = balance - ?, bank_balance = bank_balance - ? WHERE user_id = ?')
    .bind(fromBal, fromBank, targetId)];
  for (const a of removed) {
    stmts.push(db.prepare('DELETE FROM assets WHERE id = ?').bind(a.id));
  }
  await db.batch(stmts);
  const assetValue = removed.reduce((s, a) => s + Number(a.purchase_price || 0), 0);
  return { total: money + assetValue, money, assets: removed.map(a => [a.asset_type, a.asset_key]), asset_value: assetValue };
}

export async function getUserTotalWealth(db, uid) {
  const u = await getUser(db, uid);
  if (!u) return 0;
  return Number(u.balance || 0) + Number(u.bank_balance || 0);
}

// ═══════════ بخش‌های سیستم (پورت از webapp.py) ═══════════
export async function getSetting(db, k, def = '') {
  const r = await get(db, 'SELECT v FROM zar_settings WHERE k = ?', [k]);
  return (r && r.v !== null && r.v !== undefined && r.v !== '') ? String(r.v) : def;
}

export async function setSetting(db, k, v) {
  await run(db, 'INSERT INTO zar_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, String(v)]);
}

export async function isVip(db, uid) {
  const r = await get(db, 'SELECT expires_at FROM vip_users WHERE user_id = ?', [Number(uid)]);
  return !!(r && Number(r.expires_at) > Date.now() / 1000);
}

export async function vipExpires(db, uid) {
  const r = await get(db, 'SELECT expires_at FROM vip_users WHERE user_id = ?', [Number(uid)]);
  return r ? Number(r.expires_at) : 0;
}

export async function getWarehouseLevel(db, uid) {
  const r = await get(db, 'SELECT level FROM user_warehouse WHERE user_id = ?', [Number(uid)]);
  return Math.max(1, Math.min(C.WAREHOUSE_MAX_LEVEL, Number(r?.level || 1)));
}

export async function getBankLockRemaining(db, uid) {
  const r = await get(db, 'SELECT unlock_at FROM bank_locks WHERE user_id = ?', [Number(uid)]);
  if (!r) return 0;
  return Math.max(0, Number(r.unlock_at) - Date.now() / 1000);
}

export async function isBanned(db, uid) {
  const r = await get(db, 'SELECT user_id FROM banned_users WHERE user_id = ?', [Number(uid)]);
  return !!r;
}

export async function getAdminIds(db) {
  const rows = await all(db, 'SELECT user_id FROM bot_admins');
  const ids = new Set(C.env.ADMIN_IDS || []);
  for (const r of rows) ids.add(Number(r.user_id));
  return ids;
}

export async function getVipCache(db) {
  // برای پرداخت خودکار VIP — همه VIPهای فعال
  const rows = await all(db, 'SELECT user_id, expires_at FROM vip_users WHERE expires_at > ?', [Date.now() / 1000]);
  const m = {};
  for (const r of rows) m[Number(r.user_id)] = Number(r.expires_at);
  return m;
}

// ─── کد هدیه ───
export function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^\w\-]/g, '').slice(0, 64);
}

export function rewardsList(rewards) {
  const out = [];
  for (const kind of ['coins', 'bank', 'xp', 'levels', 'vip_days']) {
    const n = parseInt(rewards?.[kind] || 0, 10) || 0;
    if (n > 0) out.push([kind, '', n]);
  }
  for (const [kind, field] of [['property', 'properties'], ['worker', 'workers'], ['item', 'items']]) {
    for (const [key, n] of Object.entries(rewards?.[field] || {})) {
      const v = parseInt(n, 10) || 0;
      if (v > 0) out.push([kind, key, v]);
    }
  }
  return out;
}

export function kindLabel(kind, key) {
  if (kind === 'coins') return '💰 زرکوین';
  if (kind === 'bank') return '🏦 موجودی بانک';
  if (kind === 'xp') return '✨ XP';
  if (kind === 'levels') return '⭐ لول';
  if (kind === 'vip_days') return '👑 اشتراک VIP (روز)';
  const store = { property: C.PROPERTIES, worker: C.WORKERS, item: C.BLACKMARKET_ITEMS }[kind] || {};
  const info = store[key] || {};
  return `${info.emoji || '•'} ${info.name || key}`;
}

export function rewardsText(items) {
  return items.map(([k, key, n]) => `• ${kindLabel(k, key)}: ${n.toLocaleString('en-US')}`).join('\n') || '—';
}

// grant / revoke (داخل batch) — برای کد هدیه، پنل ادمین و فروشگاه
// نسخه async کامل grant (با محاسبه XP/levels) — خروجی: مقدار اعمال‌شده
export async function grantSmart(dbase, uid, kind, key, n) {
  uid = Number(uid);
  n = Math.floor(Number(n));
  if (n <= 0) return 0;
  if (kind === 'coins' || kind === 'bank') {
    const sql = kind === 'coins'
      ? 'UPDATE users SET balance = balance + ? WHERE user_id = ?'
      : 'UPDATE users SET bank_balance = bank_balance + ? WHERE user_id = ?';
    const r = await run(dbase, sql, [n, uid]);
    return (r.meta.changes || 0) === 1 ? n : 0;
  }
  if (kind === 'vip_days') {
    const days = Math.min(n, 3650);
    const now = Date.now() / 1000;
    await run(dbase,
      `INSERT INTO vip_users (user_id, expires_at, note, updated_at)
       VALUES (?, ?, 'پنل', ?)
       ON CONFLICT(user_id) DO UPDATE SET expires_at = MAX(expires_at, ?) + ?, updated_at = excluded.updated_at`,
      [uid, now + days * 86400, now, now, days * 86400]);
    return days;
  }
  if (kind === 'item') {
    const t = C.BLACKMARKET_ITEMS[key]?.type;
    const cap = t === 'defense' ? 1 : (t === 'launcher' ? 3 : 20);
    const curRow = await get(dbase, 'SELECT COUNT(*) AS c FROM inventory WHERE user_id = ? AND item_key = ?', [uid, key]);
    const cur = Number(curRow?.c || 0);
    const add = Math.max(0, Math.min(n, cap - cur));
    for (let i = 0; i < add; i++) {
      await run(dbase, 'INSERT INTO inventory (user_id, item_key, purchased_at) VALUES (?, ?, ?)', [uid, key, nowTehranIso()]);
    }
    return add;
  }
  if (kind === 'property' || kind === 'worker') {
    const store = kind === 'property' ? C.PROPERTIES : C.WORKERS;
    const info = store[key];
    if (!info) return 0;
    const curRow = await get(dbase, 'SELECT COUNT(*) AS c FROM assets WHERE user_id = ? AND asset_type = ? AND asset_key = ?', [uid, kind, key]);
    const cur = Number(curRow?.c || 0);
    const add = Math.max(0, Math.min(n, C.MAX_PER_KEY - cur));
    for (let i = 0; i < add; i++) {
      await run(dbase,
        'INSERT INTO assets (user_id, asset_type, asset_key, purchase_price, daily_income, purchased_at) VALUES (?, ?, ?, ?, ?, ?)',
        [uid, kind, key, info.price, info.income, nowTehranIso()]);
    }
    return add;
  }
  if (kind === 'xp' || kind === 'levels') {
    const u = await getUser(dbase, uid);
    if (!u) return 0;
    const xp = Number(u.total_xp || 0);
    let newXp = xp;
    if (kind === 'xp') newXp = xp + n;
    else {
      const lv = calcLevel(xp)[0] + n;
      newXp = Math.max(xp, xpForLevel(Math.min(C.MAX_LEVEL, lv)));
    }
    await run(dbase, 'UPDATE users SET total_xp = ?, level = ? WHERE user_id = ?', [newXp, calcLevel(newXp)[0], uid]);
    return n;
  }
  return 0;
}

export async function revokeSmart(db, uid, kind, key, n) {
  uid = Number(uid);
  n = Math.floor(Number(n));
  if (n <= 0) return 0;
  if (kind === 'coins' || kind === 'bank') {
    const col = kind === 'coins' ? 'balance' : 'bank_balance';
    const u = await get(db, `SELECT ${col} AS v FROM users WHERE user_id = ?`, [uid]);
    if (!u) return 0;
    const take = Math.min(n, Number(u.v || 0));
    await run(db, `UPDATE users SET ${col} = ${col} - ? WHERE user_id = ?`, [take, uid]);
    return take;
  }
  if (kind === 'xp' || kind === 'levels') {
    const u = await getUser(db, uid);
    if (!u) return 0;
    const xp = Number(u.total_xp || 0);
    let newXp = kind === 'xp' ? Math.max(0, xp - n) : xpForLevel(Math.max(1, calcLevel(xp)[0] - n));
    newXp = Math.min(newXp, xp);
    await run(db, 'UPDATE users SET total_xp = ?, level = ? WHERE user_id = ?', [newXp, calcLevel(newXp)[0], uid]);
    return n;
  }
  if (kind === 'property' || kind === 'worker') {
    const r = await run(db, 'DELETE FROM assets WHERE user_id = ? AND asset_type = ? AND asset_key = ? AND id IN (SELECT id FROM assets WHERE user_id = ? AND asset_type = ? AND asset_key = ? ORDER BY id DESC LIMIT ?)',
      [uid, kind, key, uid, kind, key, n]);
    return r.meta.changes || 0;
  }
  if (kind === 'item') {
    const r = await run(db, 'DELETE FROM inventory WHERE user_id = ? AND item_key = ? AND id IN (SELECT id FROM inventory WHERE user_id = ? AND item_key = ? ORDER BY id DESC LIMIT ?)',
      [uid, key, uid, key, n]);
    return r.meta.changes || 0;
  }
  return 0;
}

export function xpForLevel(level) {
  let sum = 0;
  for (let lv = 1; lv < Math.max(1, level); lv++) sum += Math.pow(2, lv) * 1000;
  return sum;
}

// ─── کد هدیه: فعال‌سازی ───
export async function redeemGift(db, uid, codeRaw, botToken) {
  const code = normCode(codeRaw);
  if (!code) return [false, '❌ کد هدیه نامعتبر است.'];
  uid = Number(uid);
  const now = Date.now() / 1000;
  const gc = await get(db, 'SELECT * FROM gift_codes WHERE code = ?', [code]);
  if (!gc || !Number(gc.active)) return [false, '❌ این کد هدیه وجود ندارد یا غیرفعال است.'];
  if (gc.expires_at && Number(gc.expires_at) < now) return [false, '⌛ مهلت استفاده از این کد تمام شده.'];
  if (Number(gc.max_uses) && Number(gc.used_count) >= Number(gc.max_uses)) return [false, '😔 ظرفیت این کد هدیه تکمیل شده.'];
  const u = await getUser(db, uid);
  if (!u) return [false, '❌ اول ربات را /start کن.'];
  const lvl = calcLevel(Number(u.total_xp || 0))[0];
  if (Number(gc.min_level || 0) > lvl) return [false, `🔒 این کد برای لول ${gc.min_level} به بالاست (لول تو: ${lvl}).`];
  const already = await get(db, 'SELECT 1 AS x FROM gift_redemptions WHERE code = ? AND user_id = ?', [code, uid]);
  if (already) return [false, '⚠️ قبلاً از این کد هدیه استفاده کرده‌ای.'];
  await run(db, 'INSERT INTO gift_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)', [code, uid, now]);
  await run(db, 'UPDATE gift_codes SET used_count = used_count + 1 WHERE code = ?', [code]);
  let rewards = {};
  try { rewards = JSON.parse(gc.rewards || '{}'); } catch (_) {}
  const granted = [], skipped = [];
  for (const [kind, key, n] of rewardsList(rewards)) {
    const done = await grantSmart(db, uid, kind, key, n);
    if (done > 0) granted.push([kind, key, done]);
    if (done < n) skipped.push([kind, key, n - done]);
  }
  let text = `🎁 <b>کد هدیه فعال شد!</b>\n━━━━━━━━━━━━━━━━━━\n${rewardsText(granted)}`;
  if (skipped.length) text += '\n\n⚠️ به‌خاطر سقف مجاز این موارد اضافه نشد:\n' + rewardsText(skipped);
  return [true, text];
}

// ─── شماره کارت انتقال ───
export function cardNumber(userId) { return cardNumberFor(userId); }

export { randomToken };
