// تست SQL: ساخت اسکیمای D1 در SQLite محلی + شبیه‌سازی کامل db.js با دیتابیس واقعی
// (D1 همان SQLite است — این تست تمام کوئری‌های اصلی لایه دیتابیس را راستی‌آزمایی می‌کند)
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import * as db from '../src/db.js';
import * as C from '../src/config.js';
import * as U from '../src/utils.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
}

// ───适配 db.js به SQLite محلی: رابط شبیه D1 ───
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
          async run() {
            const r = stmt.run(obj);
            return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
          },
          async all() { return { results: stmt.all(obj) }; },
        };
      },
      async run() { const r = stmt.run(); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      async all() { return { results: stmt.all() }; },
    };
  }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

const schema = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf-8');
const d1 = new SQLiteAsD1(':memory:');
d1.sq.exec(schema);
console.log('══ اسکیما ══');
ok(true, 'اسکیمای 0001_init.sql بدون خطا اجرا شد');

// ─── users ───
console.log('══ users ══');
await db.run(d1, "INSERT INTO users (user_id, username, first_name, balance, bank_balance, card_number, created_at) VALUES (1, 'ali', 'علی', 100000, 50000, '6037000000000001', '2026-01-01 00:00:00+03:30')");
await db.run(d1, "INSERT INTO users (user_id, username, first_name, balance, bank_balance, card_number, created_at) VALUES (2, 'reyhane', 'ریحانه', 200000, 0, '6037000000000002', '2026-01-01 00:00:00+03:30')");
const u1 = await db.getUser(d1, 1);
ok(u1 && Number(u1.balance) === 100000 && Number(u1.bank_balance) === 50000, 'getUser');
ok((await db.getUser(d1, 999)) === null, 'getUser ناموجود → null');

const ensured = await db.ensureUser(d1, { id: 3, username: 'sara', first_name: 'سارا' });
ok(Number(ensured.user_id) === 3 && ensured.card_number === '6037000000000003', 'ensureUser + کارت خودکار');
const ensured2 = await db.ensureUser(d1, { id: 3, username: 'sara2', first_name: 'سارا جدید' });
ok(ensured2.first_name === 'سارا جدید' && Number(ensured2.balance) === 0, 'ensureUser آپدیت بدون تکرار');

await db.addBalance(d1, 1, 50000);
ok(Number((await db.getUser(d1, 1)).balance) === 150000, 'addBalance');
ok(await db.deductBalance(d1, 1, 150000), 'deductBalance موفق');
ok(!(await db.deductBalance(d1, 1, 1)), 'deductBalance بیشتر از موجودی → false');
ok(Number((await db.getUser(d1, 1)).balance) === 0, 'موجودی صفر شد');

// واریز بانک: ابتدا موجودی برگردانیم
await db.addBalance(d1, 1, 20000);
ok(await db.bankDeposit(d1, 1, 10000), 'bankDeposit از balance به bank');
ok(Number((await db.getUser(d1, 1)).balance) === 10000 && Number((await db.getUser(d1, 1)).bank_balance) === 60000, 'bankDeposit صحیح');
ok(!(await db.bankWithdraw(d1, 1, 999999)), 'bankWithdraw بیشتر از بانک → false');
ok(await db.bankWithdraw(d1, 1, 10000), 'bankWithdraw موفق');
ok(Number((await db.getUser(d1, 1)).bank_balance) === 50000, 'bankWithdraw صحیح');

ok(await db.transferCoins(d1, 2, 1, 50000, 500), 'transferCoins');
// کاربر ۱: 20000 + 50000 = 70000 | کاربر ۲: 200000 - 50500 = 149500
ok(Number((await db.getUser(d1, 1)).balance) === 70000 && Number((await db.getUser(d1, 2)).balance) === 149500, `transferCoins مبالغ صحیح (گیرنده 70000، فرستنده 149500)`);

const byCard = await db.findUserByCard(d1, '6037-0000-0000-0002');
ok(byCard && Number(byCard.user_id) === 2, 'findUserByCard با ۱۶ رقم');
ok((await db.findUserByCard(d1, '123')) === null, 'findUserByCard کوتاه → null');

// ─── assets ───
console.log('══ assets ══');
ok((await db.buyAsset(d1, 2, 'property', 'supermarket', 500000, 175000)) === 'balance', 'buyAsset بدون موجودی → balance');
await db.addBalance(d1, 2, 3000000);
ok((await db.buyAsset(d1, 2, 'property', 'supermarket', 500000, 175000)) === 'ok', 'buyAsset موفق');
const summary = await db.getAssetsSummary(d1, 2);
ok(summary.supermarket && summary.supermarket.count === 1 && summary.supermarket.total_income === 175000, 'getAssetsSummary');
for (let i = 0; i < 4; i++) { await db.addBalance(d1, 2, 500000); await db.buyAsset(d1, 2, 'property', 'supermarket', 500000, 175000); }
ok((await db.buyAsset(d1, 2, 'property', 'supermarket', 500000, 175000)) === 'limit', 'buyAsset بعد از ۵ عدد → limit');

// ─── درآمد ───
console.log('══ درآمد ساعتی ══');
// کاربر ۲: ۵ سوپرمارکت = 875000 درآمد روزانه، bank=0 → فقط درآمد دارایی
await db.run(d1, 'UPDATE users SET bank_balance = 0, last_payout = NULL WHERE user_id = 2');
const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + '+03:30';
await db.run(d1, 'UPDATE users SET last_payout = ? WHERE user_id = 2', [oneHourAgo]);
const [ai, bi] = await db.peekIncome(d1, 2);
// یک ساعت + زمان اجرای تست‌های قبلی (چند ثانیه) — بازه قابل قبول
ok(ai >= 36458 && ai <= 36470, `peekIncome درآمد دارایی ۱ ساعته (${ai} ≈ 36458)`);
ok(bi === 0, 'peekIncome سود بانک صفر (بانک صفر)');
const [ai2, bi2] = await db.accrueIncome(d1, 2);
ok(ai2 === ai && bi2 === bi, 'accrueIncome همان مقادیر peek');
ok((await db.peekIncome(d1, 2))[2] === 0, 'بعد از accrue درآمد انباشته صفر شد');

// hourlyPayout — کاربر ۱ با بانک ۵۰۰۰۰
const before1 = Number((await db.getUser(d1, 1)).bank_balance);
await db.run(d1, 'UPDATE users SET last_payout = ? WHERE user_id = 1', [oneHourAgo]);
await db.hourlyPayout(d1);
const u1After = await db.getUser(d1, 1);
ok(Number(u1After.bank_balance) === before1 + Math.floor(50000 * 0.02 * 3600 / 86400), `hourlyPayout سود بانک کاربر ۱ (+${Number(u1After.bank_balance) - before1})`);

// ─── XP ───
console.log('══ XP و لول ══');
const [nxp, nlvl, lup] = await db.addXp(d1, 1, 2500);
ok(nxp === 2500 && nlvl === 2 && lup === true, `addXp → لول‌آپ (${nlvl})`);
await db.run(d1, 'UPDATE users SET total_xp = 5999, level = 2 WHERE user_id = 1');
const [nxp2, nlvl2, lup2] = await db.addXp(d1, 1, 1);
ok(nxp2 === 6000 && nlvl2 === 3 && lup2 === true, 'مرز ۶۰۰۰ XP → لول ۳');

// ─── ماموریت‌ها ───
console.log('══ ماموریت‌ها ══');
await db.ensureDailyMissions(d1, 1);
let missions = await db.getUserMissions(d1, 1);
ok(missions.length === 6, `۶ ماموریت روزانه ساخته شد (${missions.length})`);
const firstMission = missions[0];
const tmpl = C.MISSION_TEMPLATES[firstMission.mission_key];
const res1 = await db.progressMission(d1, 1, tmpl.type, tmpl.target, 50);
ok(res1 && res1.completed.length >= 1 && res1.total_xp === 50 + tmpl.xp, `progressMission کامل شد (+${res1?.total_xp} XP)`);
await db.ensureDailyMissions(d1, 1);
missions = await db.getUserMissions(d1, 1);
ok(missions.length === 6 && missions.every(m => m.completed === 0 || m.completed === 1), 'ensureDailyMissions دوباره → همان روز، بدون بازسازی');

// ─── لیدربورد ───
console.log('══ لیدربورد ══');
const [top, rank] = await db.getLeaderboard(d1, 15, 1);
ok(top.length === 3, 'لیدربورد ۳ کاربر');
ok(rank === 2 || rank === 1, `رتبه کاربر ۱ = ${rank}`);

// ─── انونتوری + حمله ───
console.log('══ انونتوری و حمله ══');
await db.addBalance(d1, 1, 100000000);
ok((await db.buyInventoryItem(d1, 1, 'missile_launcher')) === 'ok', 'خرید لانچر');
ok((await db.buyInventoryItem(d1, 1, 'cruise_missile')) === 'ok', 'خرید موشک');
ok(await db.hasItem(d1, 1, 'cruise_missile'), 'hasItem');
const counts = await db.getInventoryCounts(d1, 1);
ok(counts.cruise_missile === 1 && counts.missile_launcher === 1, 'getInventoryCounts');
ok(await db.consumeItem(d1, 1, 'cruise_missile'), 'consumeItem');
ok(!(await db.hasItem(d1, 1, 'cruise_missile')), 'موشک مصرف شد');

// حمله: کاربر ۱ به کاربر ۲ — ۲۰٪ تخریب
const u2Before = await db.getUser(d1, 2);
const u2Wealth = Number(u2Before.balance) + Number(u2Before.bank_balance);
const dmg = await db.applyDamage(d1, 2, 0.20);
ok(dmg.money === Math.floor(u2Wealth * 0.2), `applyDamage پول ۲۰٪ (${dmg.money} از ${u2Wealth})`);
const u2After = await db.getUser(d1, 2);
ok(Number(u2After.balance) + Number(u2After.bank_balance) === u2Wealth - dmg.money, 'ثروت هدف بعد از حمله');

// ─── کاباره ───
console.log('══ کاباره ══');
// کاربر ۱ الان پول زیادی دارد — کاربر ۳ را استفاده می‌کنیم که ۰ دارد
ok(!(await db.unlockKabareh(d1, 3)), 'unlockKabareh بدون پول کافی → false');
await db.addBalance(d1, 3, C.KABAREH_UNLOCK_COST);
ok(await db.unlockKabareh(d1, 3), 'unlockKabareh موفق');
ok(!(await db.unlockKabareh(d1, 3)), 'unlockKabareh دوباره → false');
await db.setLastKabareh(d1, 3, U.nowTehranIso());
ok((await db.getUser(d1, 3)).last_kabareh !== null, 'setLastKabareh');

// ─── settings / vip / ban ───
console.log('══ تنظیمات و VIP ══');
await db.setSetting(d1, 'card_number', '6037-9999-9999-9999');
ok((await db.getSetting(d1, 'card_number', '')) === '6037-9999-9999-9999', 'set/getSetting');
ok((await db.getSetting(d1, 'nonexistent', 'def')) === 'def', 'getSetting پیش‌فرض');
ok(!(await db.isVip(d1, 1)), 'isVip بدون اشتراک → false');
ok((await db.grantSmart(d1, 1, 'vip_days', '', 30)) === 30, 'grantSmart vip_days');
ok(await db.isVip(d1, 1), 'VIP فعال شد');
await db.run(d1, 'INSERT INTO banned_users (user_id, reason, banned_at) VALUES (2, ?, ?)', ['test', Date.now() / 1000]);
ok(await db.isBanned(d1, 2), 'isBanned');
await db.run(d1, 'INSERT INTO bot_admins (user_id, note, added_at) VALUES (77, ?, ?)', ['t', Date.now() / 1000]);
const admins = await db.getAdminIds(d1);
ok(admins.has(77), 'getAdminIds شامل ادمین پنل');

// ─── کد هدیه ══
console.log('══ کد هدیه ══');
await db.run(d1, "INSERT INTO gift_codes (code, rewards, max_uses, used_count, min_level, expires_at, active, note, created_at) VALUES ('TEST123', ?, 10, 0, 0, NULL, 1, '', ?)",
  [JSON.stringify({ coins: 500000, properties: { supermarket: 1 } }), Date.now() / 1000]);
const bal1 = Number((await db.getUser(d1, 1)).balance);
const [gok, gtxt] = await db.redeemGift(d1, 1, 'test123');
ok(gok === true, 'redeemGift موفق');
ok(Number((await db.getUser(d1, 1)).balance) === bal1 + 500000, 'هدیه سکه واریز شد');
const summary1 = await db.getAssetsSummary(d1, 1);
ok((summary1.supermarket?.count || 0) === 1, 'هدیه ملک اضافه شد');
const [gok2] = await db.redeemGift(d1, 1, 'TEST123');
ok(gok2 === false, 'استفاده دوباره از کد → رد');

// ─── grantSmart/revokeSmart ───
console.log('══ grant/revoke ══');
ok((await db.grantSmart(d1, 1, 'bank', '', 100000)) === 100000, 'grantSmart bank');
// bank قبلی = 50000 + سود ساعتی (≈41) → بعد از grant ≈ 150041
const bankAfterGrant = Number((await db.getUser(d1, 1)).bank_balance);
ok(bankAfterGrant >= 150000 && bankAfterGrant <= 150100, `bank افزایش یافت (${bankAfterGrant} ≈ 150041)`);
const taken = await db.revokeSmart(d1, 1, 'bank', '', 30000);
ok(taken === 30000, 'revokeSmart bank');
ok((await db.grantSmart(d1, 1, 'property', 'fruit', 2)) === 2, 'grantSmart property ×۲');
ok((await db.getAssetsSummary(d1, 1)).fruit?.count === 2, 'دو ملک fruit اضافه شد');
const rem = await db.revokeSmart(d1, 1, 'property', 'fruit', 1);
ok(rem === 1 && (await db.getAssetsSummary(d1, 1)).fruit?.count === 1, 'revokeSmart property');
const xpBefore = Number((await db.getUser(d1, 1)).total_xp);
await db.grantSmart(d1, 1, 'xp', '', 1000);
ok(Number((await db.getUser(d1, 1)).total_xp) === xpBefore + 1000, 'grantSmart xp');
// سقف item: دفاع فقط ۱ عدد
ok((await db.grantSmart(d1, 1, 'item', 'missile_defense', 5)) === 1, 'grantSmart item defense → سقف ۱');
ok((await db.grantSmart(d1, 1, 'item', 'missile_defense', 1)) === 0, 'grantSmart item defense دوباره → ۰');

console.log(`\n════════════════════════════`);
console.log(`✅ ${pass} تست پاس | ❌ ${fail} تست خطا`);
process.exit(fail ? 1 : 0);
