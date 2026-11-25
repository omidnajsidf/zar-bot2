// ═══════════ ربات تلگرام زرکوین — نسخه Webhook برای Cloudflare Workers ═══════════
// پورت کامل bot.py + هندلرهای ربات از webapp.py (فروشگاه، انبار، راهنمای صفحه‌بندی‌شده، قفل بانک)
import * as C from './config.js';
import * as db from './db.js';
import * as U from './utils.js';
import * as G from './games.js';

// ═══════════ وضعیت‌های متنی کاربر (در KV — جایگزین حافظه) ═══════════
const STATE_TTL = 3600;

async function getState(kv, uid) {
  return await U.kvJson(kv, `state:${uid}`, null);
}
async function setState(kv, uid, state) {
  await U.kvPutJson(kv, `state:${uid}`, state, STATE_TTL);
}
async function clearState(kv, uid) {
  await kv.delete(`state:${uid}`);
}

// ═══════════ جوین اجباری ═══════════
async function checkMembership(token, uid) {
  const missing = [];
  if (!C.env.MEMBERSHIP_REQUIRED) return [true, []];
  for (const ch of (C.env.REQUIRED_CHANNELS || [])) {
    try {
      const m = await U.getChatMember(token, ch.id, uid);
      if (m.status === 'left' || m.status === 'kicked') missing.push(ch.name);
    } catch (_) { missing.push(ch.name); }
  }
  const gr = C.env.REQUIRED_GROUP;
  if (gr && gr.id) {
    try {
      const m = await U.getChatMember(token, gr.id, uid);
      if (m.status === 'left' || m.status === 'kicked') missing.push(gr.name);
    } catch (_) { missing.push(gr.name); }
  }
  return [missing.length === 0, missing];
}

function joinKeyboard() {
  const rows = [];
  for (const ch of (C.env.REQUIRED_CHANNELS || [])) {
    rows.push([{ text: `📢 ${ch.name}`, url: ch.url }]);
  }
  const gr = C.env.REQUIRED_GROUP;
  if (gr && gr.url) rows.push([{ text: `💬 ${gr.name}`, url: gr.url }]);
  rows.push([{ text: '✅ عضو شدم، بررسی کن!', callback_data: 'check_membership' }]);
  return { inline_keyboard: rows };
}

function joinText(missing = null) {
  let text = '🔒 <b>برای استفاده از ربات، ابتدا باید عضو کانال‌ها و گروه زیر بشی:</b>\n━━━━━━━━━━━━━━━━━━\n\n';
  if (missing && missing.length) {
    text += '❌ <b>هنوز عضو این‌ها نشدی:</b>\n' + missing.map(m => `• ${m}`).join('\n') + '\n\n';
  }
  for (const ch of (C.env.REQUIRED_CHANNELS || [])) text += `📢 ${ch.name}\n`;
  const gr = C.env.REQUIRED_GROUP;
  if (gr && gr.url) text += `💬 ${gr.name}\n`;
  text += '\n👇 روی دکمه‌های زیر بزن و عضو شو، بعد دکمه «✅ عضو شدم» رو بزن:';
  return text;
}

async function verifyMembership(token, uid) {
  const [ok, missing] = await checkMembership(token, uid);
  return ok ? true : { ok: false, missing };
}

// ═══════════ دکمه مینی‌اپ ═══════════
function miniappButton(text = '🎰 کازینو') {
  const deep = (C.env.WEBAPP_DEEP_LINK || '').trim();
  if (deep) return { text, url: deep };
  const url = (C.env.WEBAPP_URL || '').trim();
  if (url) return { text, web_app: { url } };
  return { text, callback_data: 'menu:main' };
}

function miniappKeyboard(text = '🎰 ورود به کازینو', back = true) {
  const rows = [[miniappButton(text)]];
  if (back) rows.push([{ text: '🔙 بازگشت', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

const MOVED_TEXT = '🎰 همه‌ی بازی‌ها به «کازینو» (مینی‌اپ) منتقل شدند!\nاز منوی اصلی روی دکمه‌ی 🎰 کازینو بزن.';

// ═══════════ متون منوها ═══════════
async function mainMenuText(d, uid) {
  const user = await db.getUser(d, uid);
  const totalXp = Number(user?.total_xp || 0);
  const [level, xpIn, xpNext] = U.calcLevel(totalXp);
  const bar = U.formatProgressBar(xpIn, xpNext, 12);
  return '✨ <b>به دنیای زرکوین!</b> ✨\n━━━━━━━━━━━━━━━━━━\n'
    + `⭐ لول: <b>${level}</b>\n`
    + `✨ ${bar} <b>${U.fmt(xpIn)}/${U.fmt(xpNext)}</b>\n`
    + `💰 موجودی: <b>${U.fmt(user?.balance || 0)}</b>\n\nاز دکمه‌ها انتخاب کن 👇`;
}

function bankMenuText(user, vip, lockRem) {
  const bal = Number(user?.balance || 0), bank = Number(user?.bank_balance || 0);
  const rate = vip ? C.VIP_BANK_RATE : C.BANK_RATE;
  const interest = Math.floor(bank * rate);
  const card = U.formatCard(user?.card_number);
  const lockLine = lockRem > 0
    ? `\n🔒 قفل برداشت: <b>تا ${U.fmtRemaining(lockRem)} دیگر</b>`
    : '\n🔓 برداشت: <b>آزاد</b> (پس از هر واریز ۵ ساعت قفل می‌شود)';
  const rateLbl = vip ? `${Math.round(rate * 100)}٪ 👑 VIP` : `${Math.round(rate * 100)}٪`;
  return `🏦 <b>بانک زرکوین</b>\n━━━━━━━━━━━━━━━━━━\n💳 <code>${card}</code>\n\n`
    + `💰 کیف پول: <b>${U.fmt(bal)}</b>\n`
    + `🏦 بانک: <b>${U.fmt(bank)}</b>\n`
    + `📈 سود روزانه (${rateLbl}): <b>${U.fmt(interest)}</b>${lockLine}`;
}

async function assetsText(d, uid, assetType) {
  const isProp = assetType === 'property';
  const title = isProp ? 'املاک' : 'کارگرها';
  const emoji = isProp ? '🏠' : '👷';
  const store = isProp ? C.PROPERTIES : C.WORKERS;
  const owned = await db.getAssets(d, uid, assetType);
  const totalDaily = owned.reduce((s, a) => s + Number(a.daily_income || 0), 0);
  const grouped = {};
  for (const a of owned) {
    grouped[a.asset_key] = grouped[a.asset_key] || { count: 0, daily: 0 };
    grouped[a.asset_key].count += 1;
    grouped[a.asset_key].daily += Number(a.daily_income || 0);
  }
  const [vip, lockRem] = await Promise.all([db.isVip(d, uid), db.getBankLockRemaining(d, uid)]);
  const [ai, bi, total] = await db.peekIncome(d, uid, vip, C.VIP_INCOME_BONUS, C.VIP_BANK_RATE);
  const lines = [
    `${emoji} <b>${title}</b>`, '━━━━━━━━━━━━━━━━━━',
    `📊 کل: <b>${owned.length}</b>`,
    `💵 درآمد روزانه: <b>${U.fmt(totalDaily)}</b>`,
    `💸 درآمد قابل برداشت: <b>${U.fmt(total)}</b>\n`,
  ];
  for (const [key, data] of Object.entries(grouped)) {
    const info = store[key] || {};
    lines.push(`${info.emoji || '•'} ${info.name || key}: ${data.count} (${U.fmt(data.daily)}/روز)`);
  }
  if (!Object.keys(grouped).length) lines.push('📭 هنوز چیزی نخریدی.');
  return lines.join('\n');
}

async function missionsText(d, uid) {
  await db.ensureDailyMissions(d, uid);
  const missions = await db.getUserMissions(d, uid);
  const user = await db.getUser(d, uid);
  const totalXp = Number(user?.total_xp || 0);
  const [level, xpIn, xpNext] = U.calcLevel(totalXp);
  const lines = ['🎯 <b>ماموریت‌های امروز</b>', '━━━━━━━━━━━━━━━━━━'];
  let completed = 0;
  missions.forEach((m, i) => {
    const t = C.MISSION_TEMPLATES[m.mission_key] || {};
    const desc = t.desc || m.mission_key;
    const xp = Number(m.xp_reward), p = Number(m.progress), tg = Number(m.target);
    if (m.completed) { completed += 1; lines.push(`✅ ${i + 1}. ${desc} (+${xp} XP)`); }
    else lines.push(`🔄 ${i + 1}. ${desc} (${p}/${tg}) +${xp} XP`);
  });
  lines.push(`\n📊 ${completed}/${C.DAILY_MISSION_COUNT} انجام شد`);
  lines.push(`⭐ لول: ${level} | ✨ ${xpIn}/${xpNext}`);
  return lines.join('\n');
}

// ═══════════ کیبوردها ═══════════
async function mainMenuKb(d) {
  const menuColors = JSON.parse(await db.getSetting(d, 'menu_colors', '{}') || '{}');
  const texts = JSON.parse(await db.getSetting(d, 'bot_texts', '{}') || '{}');
  const mc = (key, def) => {
    const c = menuColors[key] || '';
    const t = (texts[key] && String(texts[key]).trim()) || def;
    return c ? `${c} ${t}` : t;
  };
  return { inline_keyboard: [
    [{ text: mc('btn_bank', '🏦 بانک'), callback_data: 'bank:menu' }, { text: mc('btn_prop', '🏠 ملک‌ها'), callback_data: 'prop:menu' }],
    [{ text: mc('btn_worker', '👷 کارگرها'), callback_data: 'worker:menu' }, miniappButton(mc('btn_casino', '🎰 کازینو'))],
    [{ text: mc('btn_mission', '🎯 ماموریت‌ها'), callback_data: 'mission:menu' }, { text: mc('btn_transfer', '💸 انتقال'), callback_data: 'transfer:start' }],
    [{ text: mc('btn_kabareh', '🎭 کاباره زر'), callback_data: 'kabareh:menu' }, { text: mc('btn_lb', '🏆 لیدربورد'), callback_data: 'lb:menu' }],
    [{ text: mc('btn_bm', '💀 بازار سیاه'), callback_data: 'bm:menu:0' }, { text: mc('btn_shop', '💎 خرید کوین و لول'), callback_data: 'shop:menu' }],
    [{ text: mc('btn_help', '📚 راهنما'), callback_data: 'help:menu' }],
  ] };
}

const BACK_MAIN_KB = { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: 'menu:main' }]] };
const BANK_MENU_KB = { inline_keyboard: [
  [{ text: '💰 واریز', callback_data: 'bank:deposit' }, { text: '🏧 برداشت', callback_data: 'bank:withdraw' }],
  [{ text: '🔙 بازگشت', callback_data: 'menu:main' }],
] };

async function propertiesMenuKb(d, uid) {
  const summary = await db.getAssetsSummary(d, uid);
  const rows = [];
  const sorted = Object.entries(C.PROPERTIES).sort((a, b) => a[1].price - b[1].price);
  for (const [key, prop] of sorted) {
    const count = (summary[key] || { count: 0 }).count;
    const prefix = count >= C.MAX_PER_KEY ? '✅ ' : '';
    rows.push([{ text: `${prefix}${prop.emoji} ${prop.name} (${count}/${C.MAX_PER_KEY})\n💰 ${U.fmt(prop.price)}`, callback_data: `prop:select:${key}` }]);
  }
  rows.push([{ text: '💸 برداشت درآمد انباشته', callback_data: 'prop:withdraw_income' }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

async function workersMenuKb(d, uid) {
  const summary = await db.getAssetsSummary(d, uid);
  const rows = [];
  const sorted = Object.entries(C.WORKERS).sort((a, b) => a[1].price - b[1].price);
  for (const [key, w] of sorted) {
    const count = (summary[key] || { count: 0 }).count;
    const prefix = count >= C.MAX_PER_KEY ? '✅ ' : '';
    rows.push([{ text: `${prefix}${w.emoji} ${w.name} (${count}/${C.MAX_PER_KEY})\n💰 ${U.fmt(w.price)}`, callback_data: `worker:select:${key}` }]);
  }
  rows.push([{ text: '💸 برداشت درآمد انباشته', callback_data: 'worker:withdraw_income' }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

// ═══════════ ماموریت: ثبت + اطلاع ═══════════
async function notifyMission(token, chatId, result) {
  if (!result || !result.completed || !result.completed.length) return;
  let msg = '🎯 <b>ماموریت کامل شد!</b>\n━━━━━━━━━━━━━━━━━━\n';
  for (const m of result.completed) msg += `✅ ${m.desc}\n   <i>+${m.xp} XP</i>\n`;
  msg += `\n✨ مجموع: <b>+${U.fmt(result.total_xp)} XP</b>`;
  if (result.leveled_up) msg += `\n\n🎉 <b>لول آپ!</b>\nبه سطح <b>${result.new_level}</b> رسیدی! 🌟`;
  await U.sendMessage(token, chatId, msg);
}

// ═══════════ دروازه اصلی: بن / خاموشی بات / بخش‌های غیرفعال ═══════════
function detectSection(update) {
  const q = update.callback_query;
  if (q && q.data) {
    const d = q.data;
    if (d.startsWith('bank:')) return 'bank';
    if (d.startsWith('prop:')) return 'properties';
    if (d.startsWith('worker:')) return 'workers';
    if (d.startsWith('mission:')) return 'missions';
    if (d.startsWith('transfer:') || d.startsWith('tr:')) return 'transfer';
    if (d.startsWith('kabareh:')) return 'kabareh';
    if (d.startsWith('lb:')) return 'leaderboard';
    if (d.startsWith('bm:')) return 'blackmarket';
    if (d.startsWith('shop:') && !d.startsWith('shop:ok:') && !d.startsWith('shop:no:')) return 'shop';
    if (d.startsWith('game:') || d.startsWith('casino:')) return 'casino';
    return null;
  }
  const msg = update.message;
  if (msg && msg.text) {
    const t = msg.text.trim();
    if (/^زر$/.test(t)) return 'zar';
    if (/^\s*هدیه\s*زر(\s+\S+)?\s*$/.test(t)) return 'gifts';
    if (/^\s*(کازینو\s*زربات|زر\s*بازی)\s*$/.test(t)) return 'casino';
    if (Object.values(C.BLACKMARKET_ITEMS).some(i => i.type === 'projectile' && i.command === t)) return 'blackmarket';
  }
  return null;
}

// خروجی: true = ادامه بده | false = بلاک شد (پاسخ لازم خودکار داده شد)
async function botGate(env, d, update, token) {
  const user = update.callback_query?.from_user || update.callback_query?.from || update.message?.from || update.pre_checkout_query?.from;
  if (!user) return true;
  const uid = user.id;
  const admins = await db.getAdminIds(d);
  const isAdmin = admins.has(uid);

  // بن
  if (await db.isBanned(d, uid)) {
    try {
      if (update.pre_checkout_query) {
        await U.tg(token, 'answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: false, error_message: '🚫 شما از ربات محروم شده‌اید' });
      } else if (update.callback_query) {
        await U.answerCb(token, update.callback_query.id, '🚫 شما از ربات محروم شده‌اید', true);
      } else if (update.message && update.message.chat.type === 'private') {
        await U.sendMessage(token, uid, '🚫 شما از ربات محروم شده‌اید.');
      }
    } catch (_) {}
    return false;
  }

  // خاموشی کل بات
  const botOff = (await db.getSetting(d, 'bot_off', '')) === '1';
  if (botOff && !isAdmin) {
    const offMsg = await db.getSetting(d, 'text_bot_off', '');
    if (offMsg) {
      try {
        if (update.callback_query) await U.answerCb(token, update.callback_query.id, offMsg.slice(0, 190), true);
        else if (update.message && update.message.chat.type === 'private') await U.sendMessage(token, update.message.chat.id, offMsg);
      } catch (_) {}
    }
    return false;
  }

  // بخش‌های غیرفعال
  if (!isAdmin) {
    const controls = JSON.parse(await db.getSetting(d, 'bot_controls', '{}') || '{}');
    const disabled = controls.disabled_sections || [];
    if (disabled.length) {
      const sec = detectSection(update);
      if (sec && disabled.includes(sec)) {
        const msg = await db.getSetting(d, 'text_section_off', '⛔ این بخش موقتاً توسط مدیریت غیرفعال شده است.');
        try {
          if (update.callback_query) await U.answerCb(token, update.callback_query.id, String(msg).slice(0, 190), true);
          else if (update.message) await U.sendMessage(token, update.message.chat.id, String(msg));
        } catch (_) {}
        return false;
      }
    }
  }
  return true;
}

// ═══════════ وب‌هوک اصلی ═══════════
export async function handleUpdate(env, ctx, update) {
  const token = C.env.BOT_TOKEN;
  const d = env.DB;
  const kv = env.STATE;
  if (!token || !d) return;

  try {
    if (!await botGate(env, d, update, token)) return;

    if (update.callback_query) {
      await handleCallback(env, d, kv, token, update.callback_query);
      return;
    }
    if (update.pre_checkout_query) {
      await handlePreCheckout(d, token, update.pre_checkout_query);
      return;
    }
    if (update.message) {
      const msg = update.message;
      if (msg.successful_payment) { await handleSuccessfulPayment(env, d, token, msg); return; }
      if (msg.photo && msg.chat.type === 'private') { await handleReceiptPhoto(env, d, token, msg); return; }
      if (msg.new_chat_members) return;
      if (msg.my_chat_member) return;
      if (msg.text) { await handleText(env, d, kv, token, update, msg); return; }
      return;
    }
    if (update.my_chat_member) {
      const cm = update.my_chat_member;
      if (cm.chat && (cm.chat.type === 'group' || cm.chat.type === 'supergroup')
        && ['member', 'administrator'].includes(cm.new_chat_member?.status)
        && ['left', 'kicked'].includes(cm.old_chat_member?.status)) {
        await U.sendMessage(token, cm.chat.id, '✨ زرکوین بات فعال شد!\n💡 زربات | زر بازی | زر');
      }
      return;
    }
  } catch (e) {
    console.error('handleUpdate error:', e);
  }
}

// ═══════════ پیام‌های متنی ═══════════
async function handleText(env, d, kv, token, update, msg) {
  const user = msg.from;
  if (!user) return;
  const uid = user.id;
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;

  // دستورات
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    if (parts[1] === 'shop' && msg.chat.type === 'private') {
      const vm = await verifyMembership(token, uid);
      if (vm !== true) { await U.sendMessage(token, chatId, joinText(vm.missing), { reply_markup: joinKeyboard() }); return; }
      await db.ensureUser(d, user);
      await showShopMenu(env, d, token, chatId, uid);
      return;
    }
    await showMainMenu(env, d, kv, token, update, msg);
    return;
  }
  if (text.startsWith('/menu')) { await showMainMenu(env, d, kv, token, update, msg); return; }

  // ترigers متنی
  if (/^زربات$/.test(text) || /^\s*کازینو\s*زربات\s*$/.test(text) || /^\s*زر\s*بازی\s*$/.test(text)) {
    const vm = await verifyMembership(token, uid);
    if (vm !== true) { await U.sendMessage(token, chatId, joinText(vm.missing), { reply_markup: joinKeyboard() }); return; }
    const m = await U.sendMessage(token, chatId, casinoText(d), { reply_markup: miniappKeyboard(text.includes('کازینو') ? '🎰 ورود به کازینو' : '🎰 ورود به کازینو') });
    if (m) await U.rememberOwner(kv, m, uid);
    return;
  }

  if (/^زر$/.test(text)) { await cmdZar(env, d, kv, token, update, msg); return; }

  if (/^\s*هدیه\s*زر(\s+\S+)?\s*$/.test(text)) {
    const m = text.match(/^\s*هدیه\s*زر\s+(\S+)\s*$/);
    if (!m) { await U.sendMessage(token, chatId, '🎁 برای استفاده از کد هدیه بنویس:\n<code>هدیه زر کد</code>'); return; }
    const vm = await verifyMembership(token, uid);
    if (vm !== true) { await U.sendMessage(token, chatId, joinText(vm.missing), { reply_markup: joinKeyboard() }); return; }
    await db.ensureUser(d, user);
    const [ok, txt] = await db.redeemGift(d, uid, m[1], token);
    await U.sendMessage(token, chatId, txt);
    return;
  }

  // شلیک سلاح
  const attackKey = Object.entries(C.BLACKMARKET_ITEMS).find(([, it]) => it.type === 'projectile' && it.command === text)?.[0];
  if (attackKey) { await handleAttack(env, d, token, update, msg, attackKey); return; }

  // هدیه مالک (انتقال زرکوین N در ریپلای)
  if (/^انتقال زرکوین\s+[\d۰-۹,،]+\s*$/.test(text) && msg.reply_to_message?.from) {
    if (uid !== C.env.OWNER_ID) return;
    const m = text.match(/^انتقال زرکوین\s+([\d۰-۹,،]+)\s*$/);
    const amount = U.parseAmount(m[1]);
    if (!amount) { await U.sendMessage(token, chatId, '❌ نامعتبر'); return; }
    const target = msg.reply_to_message.from;
    if (target.is_bot) { await U.sendMessage(token, chatId, '❌ بات!'); return; }
    await db.ensureUser(d, target);
    await db.addBalance(d, target.id, amount);
    await U.sendMessage(token, chatId, `✅ ${U.fmt(amount)} به ${U.esc(target.first_name)}`);
    return;
  }

  // لغو
  if (text === 'لغو' && msg.reply_to_message) { await handleCancel(kv, d, token, uid, chatId); return; }

  // حالت‌های فعال (بانک/انتقال)
  const state = await getState(kv, uid);
  if (!state) return;
  const action = state.action;

  if (action === 'bank_deposit' || action === 'bank_withdraw') {
    const amount = U.parseAmount(text);
    if (!amount) { await U.sendMessage(token, chatId, '❌ مبلغ نامعتبر'); return; }
    await db.ensureUser(d, user);
    let ok;
    if (action === 'bank_deposit') {
      ok = await db.bankDeposit(d, uid, amount);
      if (ok) {
        // قفل ۵ ساعته برداشت
        await db.run(d, 'INSERT INTO bank_locks (user_id, unlock_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET unlock_at = excluded.unlock_at',
          [uid, Date.now() / 1000 + C.BANK_LOCK_SECS]);
      }
    } else {
      ok = await db.bankWithdraw(d, uid, amount);
    }
    await clearState(kv, uid);
    if (ok) {
      await U.sendMessage(token, chatId,
        `✅ ${U.fmt(amount)} ${action === 'bank_deposit' ? 'واریز' : 'برداشت'} شد.`,
        { reply_markup: await mainMenuKb(d) });
      if (action === 'bank_deposit') {
        const base = Math.min(Math.floor(amount / 10000) * C.BASE_XP_DEPOSIT_10K, 500);
        const result = await db.progressMission(d, uid, 'deposit_bank', amount, base);
        await notifyMission(token, chatId, result);
      }
    } else {
      await U.sendMessage(token, chatId, '❌ موجودی کافی نیست', { reply_markup: await mainMenuKb(d) });
    }
    return;
  }

  if (action === 'transfer_amount') {
    const amount = U.parseAmount(text);
    if (!amount) { await U.sendMessage(token, chatId, '❌ مبلغ نامعتبر'); return; }
    const fee = amount > C.TRANSFER_FEE_MIN ? Math.floor(amount * C.TRANSFER_FEE_RATE) : 0;
    const u = await db.getUser(d, uid);
    if (Number(u?.balance || 0) < amount + fee) {
      await U.sendMessage(token, chatId, `❌ نیاز: ${U.fmt(amount + fee)}`);
      return;
    }
    await setState(kv, uid, { action: 'transfer_card', amount, fee });
    const m = await U.sendMessage(token, chatId, `💸 ${U.fmt(amount)}\n💵 کارمزد: ${U.fmt(fee)}\n\nکارت مقصد:`, { reply_markup: BACK_MAIN_KB });
    if (m) await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'transfer_card') {
    const cleaned = U.faToEn(text).replace(/[- _]/g, '').trim();
    const recipient = await db.findUserByCard(d, cleaned);
    if (!recipient) { await U.sendMessage(token, chatId, '❌ کارت مقصد پیدا نشد. مطمئن شو ۱۶ رقم صحیح وارد کرده‌ای.'); return; }
    if (Number(recipient.user_id) === uid) { await U.sendMessage(token, chatId, '❌ نمی‌تونی به خودت انتقال بزنی!'); return; }
    const { amount, fee } = state;
    await U.kvPutJson(kv, `transfer:${uid}`, {
      recipient_id: Number(recipient.user_id), recipient_name: recipient.first_name || '', amount, fee,
    }, 600);
    await clearState(kv, uid);
    const m = await U.sendMessage(token, chatId,
      `💸 تایید انتقال:\n👤 گیرنده: ${U.esc(recipient.first_name)}\n💰 مبلغ: ${U.fmt(amount)}\n💵 کارمزد: ${U.fmt(fee)}`,
      { reply_markup: { inline_keyboard: [[
        { text: '✅ تأیید', callback_data: `tr:c:${uid}` },
        { text: '❌ انصراف', callback_data: `tr:x:${uid}` },
      ]] } });
    if (m) await U.rememberOwner(kv, m, uid);
    return;
  }
}

async function handleCancel(kv, d, token, uid, chatId) {
  await clearState(kv, uid);
  await kv.delete(`transfer:${uid}`);
  await U.sendMessage(token, chatId, '❌ لغو شد.');
}

async function showMainMenu(env, d, kv, token, update, msg) {
  const user = msg.from;
  if (!user) return;
  const vm = await verifyMembership(token, user.id);
  if (vm !== true) {
    const m = await U.sendMessage(token, msg.chat.id, joinText(vm.missing), { reply_markup: joinKeyboard() });
    if (m) await U.rememberOwner(kv, m, user.id);
    return;
  }
  await db.ensureUser(d, user);
  const m = await U.sendMessage(token, msg.chat.id, await mainMenuText(d, user.id), { reply_markup: await mainMenuKb(d) });
  if (m) await U.rememberOwner(kv, m, user.id);
}

async function cmdZar(env, d, kv, token, update, msg) {
  const user = msg.from;
  const uid = user.id;
  const vm = await verifyMembership(token, uid);
  if (vm !== true) { await U.sendMessage(token, msg.chat.id, joinText(vm.missing), { reply_markup: joinKeyboard() }); return; }
  const userData = await db.ensureUser(d, user);
  const lastZar = userData?.last_zar;
  if (lastZar) {
    const elapsed = U.isoElapsed(lastZar);
    if (elapsed !== null && elapsed < C.ZAR_COOLDOWN_SECONDS) {
      const remaining = Math.floor(C.ZAR_COOLDOWN_SECONDS - elapsed);
      await U.sendMessage(token, msg.chat.id, `⏳ صبر کن! ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`);
      return;
    }
  }
  const totalXp = Number(userData?.total_xp || 0);
  const level = U.calcLevel(totalXp)[0];
  const reward = U.randInt(level * 100, level * 100 + 100);
  await db.addBalance(d, uid, reward);
  await db.setLastZar(d, uid, U.nowTehranIso());
  const result = await db.progressMission(d, uid, 'zar_collect', 1, C.BASE_XP_ZAR);
  await U.sendMessage(token, msg.chat.id, `💰 <b>زر!</b>\n💵 +${U.fmt(reward)}\n⭐ لول ${level}\n⏰ بعدی: 5 دقیقه`);
  await notifyMission(token, msg.chat.id, result);
}

function casinoText(d) {
  const minBet = 1000, maxBet = C.MINIAPP_MAX_BET;
  return `🎰 <b>کازینو زر</b>\n━━━━━━━━━━━━━━━━━━\n`
    + `🎯 8 بازی تک‌نفره | ⚔️ 8 بازی دونفره آنلاین\n`
    + `💰 شرط: از ${U.fmt(minBet)} تا ${U.fmt(maxBet)}\n\n👇 برای ورود به کازینو بزن:`;
}

// ═══════════ Callback ها ═══════════
async function handleCallback(env, d, kv, token, q) {
  const data = q.data || '';
  const uid = q.from.id;
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  const prefix = data.split(':')[0];

  try {
    // ─── دکمه عضو شدم (عمومی) ───
    if (data === 'check_membership') {
      const [ok, missing] = await checkMembership(token, uid);
      if (ok) {
        await db.ensureUser(d, q.from);
        const isOwner = !q.message || await U.isMenuOwner(kv, chatId, messageId, uid);
        if (isOwner) {
          await U.answerCb(token, q.id, '✅ عضویت تأیید شد!', true);
          const m = await U.editMessage(token, chatId, messageId, await mainMenuText(d, uid), await mainMenuKb(d));
          if (m) await U.rememberOwner(kv, m, uid);
        } else {
          await U.answerCb(token, q.id, '✅ عضویت تأیید شد! منوی شما ارسال شد.', true);
          const m = await U.sendMessage(token, uid, await mainMenuText(d, uid), { reply_markup: await mainMenuKb(d) });
          if (m) await U.rememberOwner(kv, m, uid);
        }
      } else {
        await U.answerCb(token, q.id, '❌ هنوز عضو نشدی:\n' + missing.map(m => `• ${m}`).join('\n'), true);
      }
      return;
    }

    // ─── مالکیت منو ───
    if (q.message) {
      const isOwner = await U.isMenuOwner(kv, chatId, messageId, uid);
      if (!isOwner && !['shop:ok', 'shop:no'].some(p => data.startsWith(p))) {
        await U.answerCb(token, q.id, '❌ این منو برای شما نیست!\nبرای منوی خودتان /menu را بفرستید.', true);
        return;
      }
    }

    // ─── جوین اجباری برای بخش‌های اصلی ───
    const needsMembership = data === 'menu:main' || data.startsWith('kabareh') || data.startsWith('lb:') || data.startsWith('bm:')
      || data.startsWith('shop:menu') || data.startsWith('bank:') || data.startsWith('prop:') || data.startsWith('worker:')
      || data.startsWith('mission:') || data.startsWith('transfer:');
    if (needsMembership) {
      const vm = await verifyMembership(token, uid);
      if (vm !== true) {
        await U.answerCb(token, q.id, '❌ هنوز عضو نشدی!', true);
        const m = await U.editMessage(token, chatId, messageId, joinText(vm.missing), joinKeyboard());
        if (m === null) await U.sendMessage(token, uid, joinText(vm.missing), { reply_markup: joinKeyboard() });
        else if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
        return;
      }
    }

    // ─── روت اصلی ───
    if (data === 'menu:main') {
      await U.answerCb(token, q.id);
      await db.ensureUser(d, q.from);
      const m = await U.editMessage(token, chatId, messageId, await mainMenuText(d, uid), await mainMenuKb(d));
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }

    if (data === 'mission:menu') {
      await U.answerCb(token, q.id);
      await db.ensureUser(d, q.from);
      const m = await U.editMessage(token, chatId, messageId, await missionsText(d, uid), BACK_MAIN_KB);
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }

    // ─── بانک ───
    if (data === 'bank:menu') {
      await U.answerCb(token, q.id);
      await db.ensureUser(d, q.from);
      const u = await db.getUser(d, uid);
      const vip = await db.isVip(d, uid);
      const lockRem = await db.getBankLockRemaining(d, uid);
      const m = await U.editMessage(token, chatId, messageId, bankMenuText(u, vip, lockRem), BANK_MENU_KB);
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }
    if (data === 'bank:deposit') {
      await U.answerCb(token, q.id);
      await setState(kv, uid, { action: 'bank_deposit' });
      const m = await U.editMessage(token, chatId, messageId, '💰 مبلغ واریز:', BACK_MAIN_KB);
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }
    if (data === 'bank:withdraw') {
      const rem = await db.getBankLockRemaining(d, uid);
      if (rem > 0) {
        await U.answerCb(token, q.id, `🔒 برداشت از بانک قفل است!\nتا ${U.fmtRemaining(rem)} دیگر نمی‌تونی برداشت کنی (قفل ۵ ساعته پس از واریز).`, true);
        return;
      }
      await U.answerCb(token, q.id);
      await setState(kv, uid, { action: 'bank_withdraw' });
      const m = await U.editMessage(token, chatId, messageId, '🏧 مبلغ برداشت:', BACK_MAIN_KB);
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }

    // ─── ملک‌ها و کارگرها ───
    if (data.startsWith('prop:') || data.startsWith('worker:')) {
      await handleAssetsCallback(env, d, kv, token, q, data, uid, chatId, messageId);
      return;
    }

    // ─── بازی‌های قدیمی → مینی‌اپ ───
    if (data.startsWith('game:') || data.startsWith('casino:') || ['rps', 'ttt', 'quiz', 'pen'].includes(prefix)) {
      await U.answerCb(token, q.id, MOVED_TEXT, true);
      await U.editMessage(token, chatId, messageId, casinoText(d), miniappKeyboard());
      return;
    }

    // ─── کاباره ───
    if (data.startsWith('kabareh:')) {
      await handleKabareh(env, d, kv, token, q, data, uid, chatId, messageId);
      return;
    }

    // ─── لیدربورد ───
    if (data.startsWith('lb:')) {
      await db.ensureUser(d, q.from);
      const [top, rank] = await db.getLeaderboard(d, 15, uid);
      const medals = ['🥇', '🥈', '🥉'];
      let text = '🏆 <b>لیدربورد زرکوین</b>\n━━━━━━━━━━━━━━━━━━\n\n';
      if (!top.length) text += '📭 هنوز کاربری ثبت نشده.';
      top.forEach((u, i) => {
        const medal = i < 3 ? medals[i] : `${i + 1}.`;
        const arrow = Number(u.user_id) === uid ? ' 👈' : '';
        text += `${medal} ${U.esc(u.first_name || 'بی‌نام')}${arrow}\n    💰 ${U.fmt(u.w)} زرکوین\n\n`;
      });
      const me = await db.getUser(d, uid);
      if (me) {
        const myW = Number(me.balance || 0) + Number(me.bank_balance || 0);
        text += '━━━━━━━━━━━━━━━━━━\n';
        if (rank) text += `📊 <b>رتبه شما: ${rank}</b>\n`;
        text += `💰 <b>ثروت شما: ${U.fmt(myW)}</b> زرکوین`;
      }
      await U.answerCb(token, q.id);
      const m = await U.editMessage(token, chatId, messageId, text, {
        inline_keyboard: [[{ text: '🔄 بروزرسانی', callback_data: 'lb:menu' }], [{ text: '🔙 بازگشت', callback_data: 'menu:main' }]],
      });
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }

    // ─── بازار سیاه / انبار ───
    if (data.startsWith('bm:')) {
      await handleBlackmarket(env, d, kv, token, q, data, uid, chatId, messageId);
      return;
    }

    // ─── راهنما ───
    if (data.startsWith('help:')) {
      await handleHelp(env, d, token, q, data, uid, chatId, messageId, kv);
      return;
    }

    // ─── فروشگاه ───
    if (data.startsWith('shop:')) {
      await handleShopCallback(env, d, kv, token, q, data, uid, chatId, messageId);
      return;
    }

    // ─── انتقال ───
    if (data === 'transfer:start') {
      await U.answerCb(token, q.id);
      await setState(kv, uid, { action: 'transfer_amount' });
      const m = await U.editMessage(token, chatId, messageId, '💸 مبلغ انتقال:', BACK_MAIN_KB);
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
      return;
    }
    if (data.startsWith('tr:c:') || data.startsWith('tr:x:')) {
      await handleTransferConfirm(env, d, kv, token, q, data, uid, chatId, messageId);
      return;
    }

    await U.answerCb(token, q.id);
  } catch (e) {
    console.error('callback error:', e, 'data=', data);
    try { await U.answerCb(token, q.id, '❌ خطای غیرمنتظره', true); } catch (_) {}
  }
}

// ─── ملک‌ها و کارگرها ───
async function handleAssetsCallback(env, d, kv, token, q, data, uid, chatId, messageId) {
  const parts = data.split(':');
  const isProp = parts[0] === 'prop';
  const store = isProp ? C.PROPERTIES : C.WORKERS;
  const storeType = isProp ? 'property' : 'worker';
  const action = parts[1];

  if (action === 'menu') {
    await U.answerCb(token, q.id);
    await db.ensureUser(d, q.from);
    const kb = isProp ? await propertiesMenuKb(d, uid) : await workersMenuKb(d, uid);
    const m = await U.editMessage(token, chatId, messageId, (await assetsText(d, uid, storeType)) + '\n\n👇 انتخاب:', kb);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'withdraw_income') {
    const vip = await db.isVip(d, uid);
    const [ai, bi, total] = await db.accrueIncome(d, uid, vip, C.VIP_INCOME_BONUS, C.VIP_BANK_RATE);
    if (total > 0) {
      await U.answerCb(token, q.id, `✅ برداشت شد!\n🏠 درآمد ملک/کارگر: ${U.fmt(ai)}\n🏦 سود بانک: ${U.fmt(bi)}\n💰 مجموع: ${U.fmt(total)}`, true);
      const result = await db.progressMission(d, uid, 'withdraw_income', 1, C.BASE_XP_WITHDRAW_INCOME);
      await notifyMission(token, chatId, result);
    } else {
      await U.answerCb(token, q.id, '❌ درآمد انباشته‌ای برای برداشت نیست! هر ساعت به‌طور خودکار واریز می‌شود.', true);
    }
    const kb = isProp ? await propertiesMenuKb(d, uid) : await workersMenuKb(d, uid);
    const m = await U.editMessage(token, chatId, messageId, (await assetsText(d, uid, storeType)) + '\n\n👇 انتخاب:', kb);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'select') {
    const key = parts[2];
    const item = store[key];
    if (!item) { await U.answerCb(token, q.id); return; }
    const summary = await db.getAssetsSummary(d, uid);
    const count = (summary[key] || { count: 0 }).count;
    if (count >= C.MAX_PER_KEY) { await U.answerCb(token, q.id, `❌ حداکثر ${C.MAX_PER_KEY} عدد مجاز است!`, true); return; }
    const user = await db.getUser(d, uid);
    if (!user || Number(user.balance) < item.price) { await U.answerCb(token, q.id, '❌ موجودی کافی نیست!', true); return; }
    await U.answerCb(token, q.id);
    const newTotal = (count + 1) * item.income;
    const text = `${isProp ? '🏠' : '👷'} <b>${item.name}</b>\n━━━━━━━━━━━━━━━━━━\n`
      + `💰 قیمت: <b>${U.fmt(item.price)}</b>\n`
      + `📈 سود هر واحد: <b>${U.fmt(item.income)}</b> /روز\n`
      + `📊 تعداد فعلی: ${count}/${C.MAX_PER_KEY}\n`
      + `📈 سود بعد از خرید: <b>${U.fmt(newTotal)}</b> /روز\n\nمطمئنی؟`;
    const m = await U.editMessage(token, chatId, messageId, text, { inline_keyboard: [
      [{ text: isProp ? '✅ بخر' : '✅ استخدام', callback_data: `${parts[0]}:confirm:${key}` }],
      [{ text: '🔙 بازگشت', callback_data: `${parts[0]}:menu` }],
    ] });
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'confirm') {
    const key = parts[2];
    const item = store[key];
    if (!item) { await U.answerCb(token, q.id); return; }
    const r = await db.buyAsset(d, uid, storeType, key, item.price, item.income);
    const summary = await db.getAssetsSummary(d, uid);
    const count = (summary[key] || { count: 0 }).count;
    let text, kb;
    if (r === 'ok') {
      await U.answerCb(token, q.id, isProp ? '✅ خریداری شد!' : '✅ استخدام شد!', true);
      const result = await db.progressMission(d, uid, isProp ? 'buy_property' : 'buy_worker', 1, C.BASE_XP_BUY_ASSET);
      await notifyMission(token, chatId, result);
      const user = await db.getUser(d, uid);
      const canBuyMore = count < C.MAX_PER_KEY && user && Number(user.balance) >= item.price;
      if (canBuyMore) {
        text = `✅ ${isProp ? 'خرید' : 'استخدام'} موفق بود!\n━━━━━━━━━━━━━━━━━━\n`
          + `${isProp ? '🏠' : '👷'} <b>${item.name}</b>\n`
          + `📊 تعداد فعلی: ${count}/${C.MAX_PER_KEY}\n`
          + `📈 سود کل فعلی: <b>${U.fmt(count * item.income)}</b> /روز\n`
          + `💰 موجودی شما: <b>${U.fmt(user.balance)}</b>\n\n`
          + `برای ${isProp ? 'خرید' : 'استخدام'} دوباره، دکمه زیر رو بزن:`;
        kb = { inline_keyboard: [
          [{ text: isProp ? '✅ خرید دوباره' : '✅ استخدام دوباره', callback_data: `${parts[0]}:confirm:${key}` }],
          [{ text: '🔙 بازگشت', callback_data: `${parts[0]}:menu` }],
        ] };
      } else {
        const reason = count >= C.MAX_PER_KEY ? 'حداکثر تعداد مجاز' : 'موجودی کافی نیست';
        text = `✅ ${isProp ? 'خرید' : 'استخدام'} موفق بود!\n━━━━━━━━━━━━━━━━━━\n`
          + `${isProp ? '🏠' : '👷'} <b>${item.name}</b>\n`
          + `📊 تعداد فعلی: ${count}/${C.MAX_PER_KEY}\n`
          + `💰 موجودی شما: <b>${U.fmt(user?.balance || 0)}</b>\n\n⚠️ ${reason} — نمی‌تونی بیشتر بخرید`;
        kb = { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: `${parts[0]}:menu` }]] };
      }
    } else if (r === 'limit') {
      await U.answerCb(token, q.id, '❌ محدودیت!', true);
      text = `❌ به محدودیت رسیدی\n━━━━━━━━━━━━━━━━━━\n${isProp ? '🏠' : '👷'} <b>${item.name}</b>\n📊 تعداد فعلی: ${count}/${C.MAX_PER_KEY}\n\nنمی‌تونی بیشتر از ${C.MAX_PER_KEY} تا بخرید`;
      kb = { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: `${parts[0]}:menu` }]] };
    } else if (r === 'balance') {
      const user = await db.getUser(d, uid);
      await U.answerCb(token, q.id, '❌ موجودی کافی نیست!', true);
      text = `❌ موجودی کافی نیست\n━━━━━━━━━━━━━━━━━━\n${isProp ? '🏠' : '👷'} <b>${item.name}</b>\n💰 قیمت: <b>${U.fmt(item.price)}</b>\n💵 موجودی شما: <b>${U.fmt(user?.balance || 0)}</b>`;
      kb = { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: `${parts[0]}:menu` }]] };
    } else {
      await U.answerCb(token, q.id, '❌ خطا', true);
      text = '❌ خطایی رخ داد. دوباره تلاش کن.';
      kb = { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: `${parts[0]}:menu` }]] };
    }
    const m = await U.editMessage(token, chatId, messageId, text, kb);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }
}

// ─── کاباره ───
const GIRL_STORIES = {
  fox: {
    intro: '🦊 <b>{user}</b> با <b>خانم روباه</b> رفت داخل اتاق VIP... 🚪💋',
    lose: 'وای وای وای! 😒\nیهو خانم روباه گفت: «ببخشید، یادم اومد ظرفا رو نشستم!» و از پنجره پرید بیرون! 🪟😂\n\n🔙 فقط <b>{back}</b> از {paid} برگشت\n📉 ضرر: <b>{loss}</b>',
    win: 'دمت گرم رفیق! 😍\nخانم روباه گفت: «ای بابا، تو دیگه کی هستی!» و یه مشت زرکوین ریخت کف دستت! 💸\n\n📈 سود خالص: <b>{profit}</b>',
    baby: 'بابا ایول! 😱\nخانم روباه با چشمای گرد گفت: «عزیزم... یه روباه کوچولو تو راهه!» 🍼🦊\n\n💰 جایزه کل: {gross}\n💸 هزینه سیسمونی: {baby_cost}\n✅ دریافتی: <b>{received}</b>\n📈 سود خالص: <b>{profit}</b>\n✨ +{xp} XP',
  },
  angela: {
    intro: '👱‍♀️ <b>{user}</b> با <b>خانم آنجلا</b> رفت داخل اتاق مخصوص... 🚪🔥',
    lose: 'دلت پاره شد! 😒\nخانم آنجلا یهو گفت: «آخه تو به من نمی‌خوری!» و با ابهت رفت! 🏃‍♀️\n\n🔙 فقط <b>{back}</b> از {paid} برگشت\n📉 ضرر: <b>{loss}</b>',
    win: 'ای جانم! 😍\nخانم آنجلا گفت: «تو بهترین مرد دنیایی!» و <b>{received}</b> بهت داد! 💸\n\n📈 سود خالص: <b>{profit}</b>',
    baby: 'لعنتی چیکار کردی! 😱\nخانم آنجلا گفت: «فکر کنم... حامله شدم!» 🍼👶\n\n💰 جایزه کل: {gross}\n💸 هزینه سیسمونی: {baby_cost}\n✅ دریافتی: <b>{received}</b>\n📈 سود خالص: <b>{profit}</b>\n✨ +{xp} XP',
  },
  lana: {
    intro: '👩 <b>{user}</b> با <b>خانم لانا</b> رفت داخل اتاق لاکچری... 🚪✨',
    lose: 'پوکیدی! 😒\nخانم لانا گفت: «ببخشید، یادم رفت گوشیم رو شارژ کنم!» و رفت! 📱😅\n\n🔙 فقط <b>{back}</b> از {paid} برگشت\n📉 ضرر: <b>{loss}</b>',
    win: 'عشقی! 😍\nخانم لانا گفت: «تو یه جنتلمن واقعی هستی!» و <b>{received}</b> بهت داد! 💸\n\n📈 سود خالص: <b>{profit}</b>',
    baby: 'خدا رحم کرد! 😱\nخانم لانا گفت: «فکر کنم یه بچه تو راهه!» 🍼\n\n💰 جایزه کل: {gross}\n💸 هزینه سیسمونی: {baby_cost}\n✅ دریافتی: <b>{received}</b>\n📈 سود خالص: <b>{profit}</b>\n✨ +{xp} XP',
  },
  alexis: {
    intro: '👩‍🦰 <b>{user}</b> با <b>خانم الکسیس</b> رفت داخل سوئیت ویژه... 🚪💎',
    lose: 'ای بابا! 😒\nخانم الکسیس گفت: «ببخشید، باید برم مانیکورم!» و رفت! 💅😂\n\n🔙 فقط <b>{back}</b> از {paid} برگشت\n📉 ضرر: <b>{loss}</b>',
    win: 'ای ول! 😍\nخانم الکسیس گفت: «تو دیوونه‌ام کردی!» و <b>{received}</b> بهت داد! 💸\n\n📈 سود خالص: <b>{profit}</b>',
    baby: 'یوهو! 😱\nخانم الکسیس گفت: «عزیزم، دوقلو باردارم!» 🍼🍼\n\n💰 جایزه کل: {gross}\n💸 هزینه سیسمونی: {baby_cost}\n✅ دریافتی: <b>{received}</b>\n📈 سود خالص: <b>{profit}</b>\n✨ +{xp} XP',
  },
  eden: {
    intro: '👸 <b>{user}</b> با <b>خانم اِدِن</b> رفت داخل اتاق پادشاهی... 🚪👑',
    lose: 'نچ! 😒\nخانم اِدِن گفت: «تو لیاقت من رو نداری!» و با ابهت رفت! 🚶‍♀️😤\n\n🔙 فقط <b>{back}</b> از {paid} برگشت\n📉 ضرر: <b>{loss}</b>',
    win: 'شاهزاده شدی! 😍\nخانم اِدِن گفت: «تو شایسته یه پادشاهی!» و <b>{received}</b> بهت داد! 💸\n\n📈 سود خالص: <b>{profit}</b>',
    baby: 'ملکه باردار شد! 😱\nخانم اِدِن گفت: «یه ولیعهد تو راهه!» 🍼👶👑\n\n💰 جایزه کل: {gross}\n💸 هزینه سیسمونی: {baby_cost}\n✅ دریافتی: <b>{received}</b>\n📈 سود خالص: <b>{profit}</b>\n✨ +{xp} XP',
  },
};

function kabarehMenuKb(isUnlocked) {
  if (!isUnlocked) {
    return { inline_keyboard: [
      [{ text: `🔓 باز کردن کاباره (${U.fmt(C.KABAREH_UNLOCK_COST)})`, callback_data: 'kabareh:unlock' }],
      [{ text: '🔙 بازگشت', callback_data: 'menu:main' }],
    ] };
  }
  return { inline_keyboard: [
    ...Object.entries(C.KABAREH_GIRLS).map(([key, g]) =>
      [{ text: `${g.emoji} ${g.name} (${U.fmt(g.price)})`.replace('خانم ', ''), callback_data: `kabareh:select:${key}` }]),
    [{ text: '🔙 بازگشت', callback_data: 'menu:main' }],
  ] };
}

function kabarehMenuText(user) {
  const isUnlocked = !!(user && Number(user.kabareh_unlocked || 0));
  if (!isUnlocked) {
    return '🎭 <b>کاباره زر</b>\n━━━━━━━━━━━━━━━━━━\n'
      + `💰 هزینه باز کردن: <b>${U.fmt(C.KABAREH_UNLOCK_COST)}</b>\n\n`
      + '🦊 روباه (2M) | 👱‍♀️ آنجلا (3M) | 👩 لانا (4M)\n👩‍🦰 الکسیس (5M) | 👸 اِدِن (6M)\n\n'
      + '🎲 شانس‌ها:\n• 60% باخت (نصف پول برمی‌گرده)\n• 30% برد (دو برابر پول برمی‌گرده)\n• 10% بچه‌دار (سه برابر منهای 1M + 2000 XP)\n\nبرای باز کردن کلیک کن 👇';
  }
  let base = '🎭 <b>کاباره زر</b>\n━━━━━━━━━━━━━━━━━━\n';
  const onCd = kabarehCooldown(user);
  if (onCd) base += `⏳ <b>صبر کن عزیزم!</b>\nتا کاباره بعدی: <b>${onCd}</b>\n\n`;
  else base += 'با کی می‌خوای حال کنی؟ 😏\n\n';
  base += '🎲 شانس‌ها:\n60% باخت | 30% برد | 10% بچه‌دار';
  return base;
}

function kabarehCooldown(user) {
  if (!user) return null;
  const last = user.last_kabareh;
  if (!last) return null;
  const elapsed = U.isoElapsed(last);
  if (elapsed === null) return null;
  const cooldown = C.KABAREH_COOLDOWN_HOURS * 3600;
  if (elapsed < cooldown) {
    const remaining = Math.floor(cooldown - elapsed);
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    const secs = remaining % 60;
    if (hours > 0) return `${hours} ساعت و ${mins} دقیقه`;
    if (mins > 0) return `${mins} دقیقه و ${secs} ثانیه`;
    return `${secs} ثانیه`;
  }
  return null;
}

async function handleKabareh(env, d, kv, token, q, data, uid, chatId, messageId) {
  const parts = data.split(':');
  const action = parts[1] || 'menu';

  // شرط لول
  const user = await db.getUser(d, uid);
  if (user) {
    const level = U.calcLevel(Number(user.total_xp || 0))[0];
    if (level < C.KABAREH_MIN_LEVEL) {
      await U.answerCb(token, q.id,
        `🎭 برای ورود به کاباره باید به لول ${C.KABAREH_MIN_LEVEL} برسی!\nلول فعلی شما: ${level}\nبا انجام ماموریت‌ها و بازی‌ها XP کسب کن تا لول آپ بشی.`, true);
      return;
    }
  }

  if (action === 'menu') {
    const u = user || await db.ensureUser(d, q.from);
    await U.answerCb(token, q.id);
    const m = await U.editMessage(token, chatId, messageId, kabarehMenuText(u), kabarehMenuKb(!!Number(u?.kabareh_unlocked || 0)));
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'unlock') {
    const u = user;
    if (!u) { await U.answerCb(token, q.id, '❌ خطا', true); return; }
    if (Number(u.kabareh_unlocked || 0)) { await U.answerCb(token, q.id, '✅ قبلاً باز شده!', true); return; }
    if (Number(u.balance) < C.KABAREH_UNLOCK_COST) {
      await U.answerCb(token, q.id, `❌ نیاز: ${U.fmt(C.KABAREH_UNLOCK_COST)}\nموجودی: ${U.fmt(u.balance)}`, true);
      return;
    }
    const ok = await db.unlockKabareh(d, uid);
    if (ok) {
      const nu = await db.getUser(d, uid);
      await U.answerCb(token, q.id, '🎉 کاباره باز شد! حالا می‌تونی بری حال کنی!', true);
      const m = await U.editMessage(token, chatId, messageId, kabarehMenuText(nu), kabarehMenuKb(true));
      if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    } else {
      await U.answerCb(token, q.id, '❌ خطا', true);
    }
    return;
  }

  if (action === 'select') {
    const girlKey = parts[2];
    if (!C.KABAREH_GIRLS[girlKey]) { await U.answerCb(token, q.id, '❌ نامعتبر', true); return; }
    const onCd = kabarehCooldown(user);
    if (onCd) { await U.answerCb(token, q.id, `⏳ صبر کن!\n\nتا کاباره بعدی: ${onCd}`, true); return; }
    const girl = C.KABAREH_GIRLS[girlKey];
    await U.answerCb(token, q.id);
    const text = `🎭 <b>تایید</b>\n━━━━━━━━━━━━━━━━━━\n👩 همراه: ${girl.emoji} <b>${girl.name}</b>\n💰 هزینه: <b>${U.fmt(girl.price)}</b>\n\n`
      + `⚠️ <b>شانس‌ها:</b>\n• 60% باخت (نصف پول برمی‌گرده)\n• 30% برد (دو برابر پول برمی‌گرده)\n• 10% بچه‌دار (سه برابر منهای 1M + 2000 XP)\n\n`
      + `⏰ <i>بعد از این بازی، ۲۴ ساعت باید صبر کنی!</i>\n\nمطمئنی؟ 😏`;
    const m = await U.editMessage(token, chatId, messageId, text, { inline_keyboard: [
      [{ text: '✅ بریم حال کنیم!', callback_data: `kabareh:play:${girlKey}` }],
      [{ text: '❌ انصراف', callback_data: 'kabareh:menu' }],
    ] });
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'play') {
    const girlKey = parts[2];
    const girl = C.KABAREH_GIRLS[girlKey];
    if (!girl) { await U.answerCb(token, q.id, '❌ نامعتبر', true); return; }
    const u = user;
    if (!u) { await U.answerCb(token, q.id, '❌ خطا', true); return; }
    const onCd = kabarehCooldown(u);
    if (onCd) { await U.answerCb(token, q.id, `⏳ صبر کن عزیزم!\n\nتا کاباره بعدی: ${onCd}`, true); return; }
    const price = girl.price;
    if (Number(u.balance) < price) {
      await U.answerCb(token, q.id, `❌ نیاز: ${U.fmt(price)}\nموجودی: ${U.fmt(u.balance)}`, true);
      return;
    }
    if (!(await db.deductBalance(d, uid, price))) { await U.answerCb(token, q.id, '❌ موجودی!', true); return; }

    const roll = Math.random();
    let baby = false;
    const story = GIRL_STORIES[girlKey];
    const userName = U.esc(q.from.first_name || '');
    let body;
    if (roll < 0.60) {
      const back = Math.floor(price * 0.5);
      await db.addBalance(d, uid, back);
      body = story.lose.replace('{back}', U.fmt(back)).replace('{paid}', U.fmt(price)).replace('{loss}', U.fmt(price - back));
    } else if (roll < 0.90) {
      const received = price * 2;
      await db.addBalance(d, uid, received);
      body = story.win.replace('{received}', U.fmt(received)).replace('{profit}', U.fmt(received - price));
    } else {
      baby = true;
      const gross = price * 3;
      const received = Math.max(0, gross - C.KABAREH_BABY_COST);
      await db.addBalance(d, uid, received);
      body = story.baby.replace('{gross}', U.fmt(gross)).replace('{baby_cost}', U.fmt(C.KABAREH_BABY_COST))
        .replace('{received}', U.fmt(received)).replace('{profit}', U.fmt(received - price)).replace('{xp}', U.fmt(C.KABAREH_BABY_XP));
    }
    // کول‌داون بعد از payout موفق
    await db.setLastKabareh(d, uid, U.nowTehranIso());

    const text = `${story.intro.replace('{user}', userName)}\n━━━━━━━━━━━━━━━━━━\n\n${body}\n\n━━━━━━━━━━━━━━━━━━\n⏰ <i>دفعه بعدی: ${C.KABAREH_COOLDOWN_HOURS} ساعت دیگه</i>`;
    await U.answerCb(token, q.id);
    const m = await U.editMessage(token, chatId, messageId, text, kabarehMenuKb(true));
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);

    const result = await db.progressMission(d, uid, 'kabareh', 1, C.BASE_XP_KABAREH);
    await notifyMission(token, chatId, result);
    if (baby) {
      const [, newLevel, leveledUp] = await db.addXp(d, uid, C.KABAREH_BABY_XP);
      if (leveledUp) {
        await U.sendMessage(token, chatId, `🎉 <b>لول آپ!</b>\n\nبه لول <b>${newLevel}</b> رسیدی! 🌟`);
      }
    }
    return;
  }
}

// ─── بازار سیاه + انبار ───
function ammoCap(whLevel, vip) { return Math.max(1, Math.min(C.WAREHOUSE_MAX_LEVEL, whLevel)) * 2 + (vip ? C.VIP_AMMO_BONUS : 0); }
function launcherCap(vip) { return vip ? C.VIP_LAUNCHER_MAX : 3; }
async function itemCapFor(d, uid, key) {
  const t = C.BLACKMARKET_ITEMS[key]?.type;
  const vip = await db.isVip(d, uid);
  if (t === 'defense') return 1;
  if (t === 'launcher') return launcherCap(vip);
  if (t === 'projectile') return ammoCap(await db.getWarehouseLevel(d, uid), vip);
  return 0;
}
function capText(key, cap, vip, whLvl) {
  const t = C.BLACKMARKET_ITEMS[key]?.type;
  if (t === 'defense') return `🛡️ از هر سیستم دفاعی فقط ۱ عدد می‌تونی داشته باشی!`;
  if (t === 'launcher') return `🚀 از هر وسیله شلیک حداکثر ${cap} عدد می‌تونی داشته باشی!` + (vip ? '' : `\n👑 با اشتراک VIP می‌تونی تا ${C.VIP_LAUNCHER_MAX} عدد داشته باشی!`);
  if (t === 'projectile') return `🏭 ظرفیت انبارت برای این مهمات پر شده (${cap} عدد)!\n⬆️ برای ظرفیت بیشتر، «🏭 انبار من» را ارتقا بده` + (vip ? '!' : ' یا اشتراک 👑 VIP بگیر (+۵ ظرفیت)!');
  return '❌ به سقف مجاز رسیدی!';
}

function bmTotalPages() { return Math.max(1, Math.ceil(Object.keys(C.BLACKMARKET_ITEMS).length / C.BLACKMARKET_PER_PAGE)); }
function bmPageItems(page) {
  const items = Object.entries(C.BLACKMARKET_ITEMS);
  return items.slice(page * C.BLACKMARKET_PER_PAGE, (page + 1) * C.BLACKMARKET_PER_PAGE);
}

async function warehouseView(d, uid) {
  const lvl = await db.getWarehouseLevel(d, uid);
  const vip = await db.isVip(d, uid);
  const aCap = ammoCap(lvl, vip);
  const lCap = launcherCap(vip);
  const counts = await db.getInventoryCounts(d, uid);
  const lines = [
    '🏭 <b>انبار من</b>', '━━━━━━━━━━━━━━━━━━',
    `📊 لول انبار: <b>${lvl} / ${C.WAREHOUSE_MAX_LEVEL}</b>` + (vip ? '  ·  👑 VIP فعال' : ''),
    `💥 ظرفیت هر مهمات: <b>${aCap} عدد</b>` + (vip ? ` (شامل +${C.VIP_AMMO_BONUS} 👑 VIP)` : ''),
    `🚀 ظرفیت هر وسیله شلیک: <b>${lCap} عدد</b>`,
    `🛡️ ظرفیت هر پدافند: <b>1 عدد</b>`, '',
  ];
  const cats = [['launcher', '🚀 وسایل شلیک', lCap], ['projectile', '💥 مهمات', aCap], ['defense', '🛡️ سیستم‌های دفاعی', 1]];
  let anyItem = false;
  for (const [ctype, ctitle, ccap] of cats) {
    const found = Object.entries(C.BLACKMARKET_ITEMS).filter(([k, v]) => v.type === ctype && (counts[k] || 0) > 0);
    if (found.length) {
      anyItem = true;
      lines.push(`<b>${ctitle}:</b>`);
      for (const [k, v] of found) lines.push(`  ${v.emoji} ${v.name}: <b>${counts[k]} / ${ccap}</b>`);
      lines.push('');
    }
  }
  if (!anyItem) { lines.push('📭 انبارت فعلاً خالی است.', ''); }
  const btns = [];
  if (lvl < C.WAREHOUSE_MAX_LEVEL) {
    const cost = Math.pow(2, lvl) * C.WAREHOUSE_UPGRADE_BASE;
    const nxtCap = ammoCap(lvl + 1, vip);
    lines.push(`⬆️ <b>ارتقا به لول ${lvl + 1}:</b> ظرفیت هر مهمات به <b>${nxtCap}</b> می‌رسد`);
    lines.push(`💰 هزینه ارتقا: <b>${U.fmt(cost)}</b> زرکوین`);
    btns.push([{ text: `⬆️ ارتقا انبار به لول ${lvl + 1} (💰 ${U.fmt(cost)})`, callback_data: 'bm:wh_upgrade' }]);
  } else {
    lines.push('🏆 انبارت در حداکثر لول (۱۰) است!');
  }
  btns.push([{ text: '🔙 بازگشت به بازار سیاه', callback_data: 'bm:menu:0' }]);
  return [lines.join('\n'), { inline_keyboard: btns }];
}

async function handleBlackmarket(env, d, kv, token, q, data, uid, chatId, messageId) {
  const parts = data.split(':');
  const action = parts[1] || 'menu';

  if (action === 'menu' || action === 'noop') {
    if (action === 'noop') { await U.answerCb(token, q.id); return; }
    let page = parseInt(parts[2] || '0', 10) || 0;
    page = Math.max(0, Math.min(page, bmTotalPages() - 1));
    await db.ensureUser(d, q.from);
    const counts = await db.getInventoryCounts(d, uid);
    const userData = await db.getUser(d, uid);
    const userLevel = U.calcLevel(Number(userData?.total_xp || 0))[0];
    const text = '💀 <b>بازار سیاه</b>\n━━━━━━━━━━━━━━━━━━\n'
      + 'آیتم‌های نظامی برای حمله به کاربران دیگر.\nبرای خرید، روی آیتم مورد نظر بزن.\n\n'
      + `📦 تعداد کل آیتم‌ها: ${Object.keys(C.BLACKMARKET_ITEMS).length}\n📄 صفحه ${page + 1} از ${bmTotalPages()}`;
    const rows = [];
    for (const [key, item] of bmPageItems(page)) {
      const count = counts[key] || 0;
      const countStr = count > 0 ? ` ×${count}` : '';
      const locked = C.LAUNCHER_LEVEL_LOCKED.includes(key) && userLevel < C.LAUNCHER_MIN_LEVEL;
      const lockStr = locked ? ` 🔴 لول ${C.LAUNCHER_MIN_LEVEL}+` : '';
      rows.push([{ text: `${item.emoji} ${item.name}\n💰 ${U.fmt(item.price)}${countStr}${lockStr}`, callback_data: `bm:select:${key}` }]);
    }
    const navRow = [];
    if (page > 0) navRow.push({ text: '⬅️ قبلی', callback_data: `bm:menu:${page - 1}` });
    navRow.push({ text: `📄 ${page + 1}/${bmTotalPages()}`, callback_data: 'bm:noop' });
    if (page < bmTotalPages() - 1) navRow.push({ text: '➡️ بعدی', callback_data: `bm:menu:${page + 1}` });
    rows.push(navRow);
    rows.push([{ text: '🏭 انبار من', callback_data: 'bm:inventory' }]);
    rows.push([{ text: '🔙 بازگشت', callback_data: 'menu:main' }]);
    await U.answerCb(token, q.id);
    const m = await U.editMessage(token, chatId, messageId, text, { inline_keyboard: rows });
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'inventory' || action === 'warehouse' || action === 'wh_upgrade') {
    await db.ensureUser(d, q.from);
    if (action === 'wh_upgrade') {
      const lvl = await db.getWarehouseLevel(d, uid);
      if (lvl >= C.WAREHOUSE_MAX_LEVEL) {
        await U.answerCb(token, q.id, '🏆 انبارت همین الان در حداکثر لول (۱۰) است!', true);
      } else {
        const cost = Math.pow(2, lvl) * C.WAREHOUSE_UPGRADE_BASE;
        if (!(await db.deductBalance(d, uid, cost))) {
          await U.answerCb(token, q.id, `❌ موجودی کافی نیست!\nنیاز به ${U.fmt(cost)} زرکوین داری.`, true);
        } else {
          const newLvl = lvl + 1;
          const vip = await db.isVip(d, uid);
          await db.run(d, 'INSERT INTO user_warehouse (user_id, level, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at',
            [uid, newLvl, Date.now() / 1000]);
          await U.answerCb(token, q.id, `✅ انبار به لول ${newLvl} ارتقا یافت! ظرفیت هر مهمات: ${ammoCap(newLvl, vip)}`, true);
        }
      }
    } else {
      await U.answerCb(token, q.id);
    }
    const [text, kb] = await warehouseView(d, uid);
    const m = await U.editMessage(token, chatId, messageId, text, kb);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'select') {
    const key = parts[2];
    const item = C.BLACKMARKET_ITEMS[key];
    if (!item) { await U.answerCb(token, q.id, '❌ آیتم نامعتبر', true); return; }
    const counts = await db.getInventoryCounts(d, uid);
    const count = counts[key] || 0;
    const userData = await db.getUser(d, uid);
    const userLevel = U.calcLevel(Number(userData?.total_xp || 0))[0];
    const locked = C.LAUNCHER_LEVEL_LOCKED.includes(key) && userLevel < C.LAUNCHER_MIN_LEVEL;
    let text = `${item.emoji} <b>${item.name}</b>\n━━━━━━━━━━━━━━━━━━\n`;
    if (locked) text += `🔒 <b>قفل شده!</b> نیاز به لول ${C.LAUNCHER_MIN_LEVEL}\n⭐ لول فعلی شما: ${userLevel}\n\n`;
    text += `💰 قیمت: <b>${U.fmt(item.price)}</b> زرکوین\n`;
    text += `📋 نوع: ${item.type === 'launcher' ? '🚀 وسیله شلیک — برای شلیک مهمات الزامی است' : item.type === 'projectile' ? '🚀 مهمات — با وسیله شلیک مناسب استفاده می‌شود' : '🛡️ سیستم دفاعی — از شما در برابر حملات محافظت می‌کند'}\n`;
    if (count > 0) text += `🎒 تعداد دارایی: <b>${count}</b>\n`;
    if (item.type === 'projectile') {
      text += `💥 درصد تخریب: <b>${Math.round(item.damage * 100)}%</b>\n🎯 دستور شلیک: <code>${item.command}</code>\n`;
      text += item.defense_type ? '🛡️ قابل دفاع: بله\n' : '🛡️ قابل دفاع: خیر (بمب)\n';
    } else if (item.type === 'launcher' && item.launches?.length) {
      text += '🎯 می‌تونی این مهمات رو شلیک کنی:\n';
      for (const pk of item.launches) {
        const p = C.BLACKMARKET_ITEMS[pk] || {};
        text += `   • ${p.emoji || ''} ${p.name || ''} (${Math.round((p.damage || 0) * 100)}%)\n`;
      }
    } else if (item.type === 'defense') {
      text += `🛡️ احتمال دفاع: <b>${Math.round(item.defense_chance * 100)}%</b>\n`;
    }
    text += locked ? `\n⚠️ برای خرید و استفاده، باید به لول ${C.LAUNCHER_MIN_LEVEL} برسی!` : '\nمطمئنی؟';
    const kb = locked ? { inline_keyboard: [
      [{ text: `🔒 نیاز به لول ${C.LAUNCHER_MIN_LEVEL}`, callback_data: 'bm:noop' }],
      [{ text: '🔙 بازگشت', callback_data: 'bm:menu:0' }],
    ] } : { inline_keyboard: [
      [{ text: '✅ بخر', callback_data: `bm:buy:${key}` }],
      [{ text: '🔙 بازگشت', callback_data: 'bm:menu:0' }],
    ] };
    await U.answerCb(token, q.id);
    const m = await U.editMessage(token, chatId, messageId, text, kb);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (action === 'buy') {
    const key = parts[2];
    const item = C.BLACKMARKET_ITEMS[key];
    if (!item) { await U.answerCb(token, q.id, '❌ آیتم نامعتبر', true); return; }
    const userData = await db.getUser(d, uid);
    const userLevel = U.calcLevel(Number(userData?.total_xp || 0))[0];
    if (C.LAUNCHER_LEVEL_LOCKED.includes(key) && userLevel < C.LAUNCHER_MIN_LEVEL) {
      await U.answerCb(token, q.id, `🔒 برای خرید ${item.name} باید به لول ${C.LAUNCHER_MIN_LEVEL} برسی!\nلول فعلی شما: ${userLevel}`, true);
      return;
    }
    // سقف خرید
    const cap = await itemCapFor(d, uid, key);
    if (cap) {
      const cntRow = await db.get(d, 'SELECT COUNT(*) AS c FROM inventory WHERE user_id = ? AND item_key = ?', [uid, key]);
      const have = Number(cntRow?.c || 0);
      if (have >= cap) {
        const wh = await db.getWarehouseLevel(d, uid);
        await U.answerCb(token, q.id, `${capText(key, cap, await db.isVip(d, uid), wh)}\n(الان ${have}/${cap} داری)`, true);
        return;
      }
    }
    const r = await db.buyInventoryItem(d, uid, key);
    if (r === 'ok') await U.answerCb(token, q.id, `✅ ${item.name} خریداری شد!`, true);
    else if (r === 'balance') await U.answerCb(token, q.id, '❌ موجودی کافی نیست!', true);
    else await U.answerCb(token, q.id, '❌ خطا', true);
    // برگشت به جزئیات
    const counts = await db.getInventoryCounts(d, uid);
    const count = counts[key] || 0;
    const user = await db.getUser(d, uid);
    const canBuyMore = user && Number(user.balance) >= item.price;
    let text = `${item.emoji} <b>${item.name}</b>\n━━━━━━━━━━━━━━━━━━\n💰 قیمت: <b>${U.fmt(item.price)}</b>\n🎒 تعداد دارایی: <b>${count}</b>`;
    let kb;
    if (canBuyMore && r === 'ok') {
      kb = { inline_keyboard: [
        [{ text: '✅ خرید دوباره', callback_data: `bm:buy:${key}` }],
        [{ text: '🔙 بازگشت به بازار سیاه', callback_data: 'bm:menu:0' }],
      ] };
    } else {
      kb = { inline_keyboard: [[{ text: '🔙 بازگشت به بازار سیاه', callback_data: 'bm:menu:0' }]] };
    }
    const m = await U.editMessage(token, chatId, messageId, text, kb);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }
}

// ─── حمله (شلیک سلاح) ───
async function handleAttack(env, d, token, update, msg, itemKey) {
  const chatId = msg.chat.id;
  const attacker = msg.from;
  if (!msg.reply_to_message?.from) {
    await U.sendMessage(token, chatId, '❌ برای شلیک، روی پیام فرد هدف ریپلای کن!');
    return;
  }
  const target = msg.reply_to_message.from;
  if (target.is_bot) { await U.sendMessage(token, chatId, '❌ نمی‌تونی به ربات شلیک کنی!'); return; }
  if (target.id === attacker.id) { await U.sendMessage(token, chatId, '❌ نمی‌تونی به خودت شلیک کنی!'); return; }
  const item = C.BLACKMARKET_ITEMS[itemKey];
  if (!item || item.type !== 'projectile') { await U.sendMessage(token, chatId, '❌ سلاح نامعتبر!'); return; }

  const vm = await verifyMembership(token, attacker.id);
  if (vm !== true) { await U.sendMessage(token, chatId, joinText(vm.missing), { reply_markup: joinKeyboard() }); return; }

  await db.ensureUser(d, attacker);
  await db.ensureUser(d, target);

  if (await db.isBanned(d, target.id)) {
    await U.sendMessage(token, chatId, '🚫 این کاربر از ربات محروم است و نمی‌توان به او حمله کرد.');
    return;
  }

  // وسیله شلیک + کول‌داون
  const launchers = Object.entries(C.BLACKMARKET_ITEMS)
    .filter(([, v]) => v.type === 'launcher' && (v.launches || []).includes(itemKey))
    .map(([k]) => k);
  const ph = launchers.map(() => '?').join(',');
  const rows = await db.all(d, `SELECT id, item_key, last_used FROM inventory WHERE user_id = ? AND item_key IN (${ph})`, [attacker.id, ...launchers]);
  const projRow = await db.get(d, 'SELECT COUNT(*) AS c FROM inventory WHERE user_id = ? AND item_key = ?', [attacker.id, itemKey]);
  const projCount = Number(projRow?.c || 0);
  if (!rows.length || projCount <= 0) {
    // هندلر اصلی پیام میدهد
    if (!rows.length) {
      await U.sendMessage(token, chatId, `❌ برای شلیک ${item.name} باید اول وسیله شلیک مناسب رو بخر!\n💀 به بازار سیاه برو و یکی از لانچرها رو بخر.`);
    } else {
      await U.sendMessage(token, chatId, `❌ شما ${item.name} نداری!\n💀 به بازار سیاه برو و ${item.name} رو بخر.`);
    }
    return;
  }
  const now = Date.now() / 1000;
  const ready = rows.filter(r => !r.last_used || now - Number(r.last_used) >= C.LAUNCH_COOLDOWN);
  if (!ready.length) {
    const wait = Math.min(...rows.map(r => Number(r.last_used) + C.LAUNCH_COOLDOWN)) - now;
    const mins = Math.max(1, Math.ceil(wait / 60));
    const names = launchers.map(k => `${C.BLACKMARKET_ITEMS[k].emoji} ${C.BLACKMARKET_ITEMS[k].name}`).join('، ');
    await U.sendMessage(token, chatId,
      `⏳ <b>وسیله شلیک در حال خنک شدن است</b>\n━━━━━━━━━━━━━━━━━━\n`
      + `🚀 وسایل تو (${rows.length} عدد) همه در ۱ ساعت گذشته شلیک کرده‌اند.\n`
      + `⏰ زمان باقی‌مانده: <b>${mins} دقیقه</b>\n\n`
      + `💡 با خرید یک وسیله دیگر از بازار سیاه می‌تونی همین الان شلیک کنی:\n${names}`);
    return;
  }

  // دفاع هدف
  let defended = false, defenseName = '';
  const defenseType = item.defense_type;
  if (defenseType) {
    for (const [dk, defense] of Object.entries(C.BLACKMARKET_ITEMS)) {
      if (defense.type === 'defense' && defense.defends_against === defenseType) {
        if (await db.hasItem(d, target.id, dk)) {
          if (Math.random() < (defense.defense_chance || 0)) {
            defended = true;
            defenseName = defense.name;
          }
          break;
        }
      }
    }
  }

  // مصرف مهمات
  await db.consumeItem(d, attacker.id, itemKey);

  if (defended) {
    await U.sendMessage(token, chatId,
      `🛡️ <b>دفاع موفق!</b>\n━━━━━━━━━━━━━━━━━━\n`
      + `🎯 مهاجم: ${U.esc(attacker.first_name)}\n🎯 هدف: ${U.esc(target.first_name)}\n`
      + `🚀 سلاح: ${item.emoji} ${item.name}\n🛡️ دفاع: ${defenseName}\n\n`
      + `✅ ${U.esc(target.first_name)} با موفقیت دفاع کرد!\nموشک توسط سیستم پدافند رهگیری و منهدم شد.`);
  } else {
    const dmg = await db.applyDamage(d, target.id, item.damage);
    if (dmg.total <= 0) {
      await U.sendMessage(token, chatId,
        `⚠️ <b>حمله بدون آسیب!</b>\n━━━━━━━━━━━━━━━━━━\n`
        + `🎯 مهاجم: ${U.esc(attacker.first_name)}\n🎯 هدف: ${U.esc(target.first_name)}\n`
        + `🚀 سلاح: ${item.emoji} ${item.name}\n\nهدف هیچ ثروتی نداشت که تخریب بشه!`);
    } else {
      const attackerEmoji = itemKey.includes('missile') ? '🚀' : (itemKey.includes('bomb') ? '💣' : '🛸');
      const targetWealth = await db.getUserTotalWealth(d, target.id);
      let report = `💰 پول: ${U.fmt(dmg.money)}\n`;
      const counts = {};
      for (const [t, k] of dmg.assets) counts[`${t}:${k}`] = (counts[`${t}:${k}`] || 0) + 1;
      for (const [tk, n] of Object.entries(counts)) {
        const [t, k] = tk.split(':');
        report += `${db.kindLabel(t, k)} × ${n}\n`;
      }
      if (!dmg.assets.length) report += '🏠 ملک یا کارگری نابود نشد\n';
      await U.sendMessage(token, chatId,
        `${attackerEmoji} <b>حمله موفق!</b>\n━━━━━━━━━━━━━━━━━━\n`
        + `🎯 مهاجم: ${U.esc(attacker.first_name)}\n🎯 هدف: ${U.esc(target.first_name)}\n`
        + `🚀 سلاح: ${item.emoji} ${item.name}\n`
        + `💥 درصد تخریب: ${Math.round(item.damage * 100)}%\n`
        + `💰 خسارت وارد شده: <b>${U.fmt(dmg.total)}</b> زرکوین\n\n`
        + `🏚 <b>جزئیات خسارت</b>\n━━━━━━━━━━━━━━━━━━\n${report}\n`
        + `📊 ثروت باقی‌مانده ${U.esc(target.first_name)}: <b>${U.fmt(targetWealth)}</b>`);
      try {
        await U.sendMessage(token, target.id,
          `${attackerEmoji} <b>شما مورد حمله قرار گرفتید!</b>\n━━━━━━━━━━━━━━━━━━\n`
          + `🎯 مهاجم: ${U.esc(attacker.first_name)}\n🚀 سلاح: ${item.emoji} ${item.name}\n`
          + `💥 خسارت: <b>${U.fmt(dmg.total)}</b> زرکوین\n`
          + `🏚 موارد از دست رفته:\n${report}\n`
          + `📊 ثروت باقی‌مانده شما: <b>${U.fmt(targetWealth)}</b>`);
      } catch (_) {}
    }
  }
  // ثبت کول‌داون وسیله شلیک (اگر شلیک واقعاً انجام شد)
  await db.run(d, 'UPDATE inventory SET last_used = ? WHERE id = ?', [Date.now() / 1000, ready[0].id]);
}

// ─── راهنمای صفحه‌بندی‌شده ───
function helpPages() {
  const bm = C.BLACKMARKET_ITEMS;
  const items = (t) => {
    const out = [];
    for (const v of Object.values(bm)) {
      if (v.type !== t) continue;
      let extra = '';
      if (t === 'projectile') extra = ` — ${Math.round(v.damage * 100)}٪ تخریب`;
      else if (t === 'defense') extra = ` — ${Math.round(v.defense_chance * 100)}٪ دفاع`;
      out.push(` • ${v.emoji} ${v.name} (${U.fmt(v.price)})${extra}`);
    }
    return out.join('\n') || ' —';
  };
  const cmds = Object.values(bm).filter(v => v.type === 'projectile' && v.command)
    .map(v => ` • <code>${v.command}</code> ← ${v.emoji} ${v.name}`).join('\n');
  return [
    '📚 <b>راهنما — اقتصاد و پیشرفت</b>\n━━━━━━━━━━━━━━━━━━\n'
    + '⭐ <b>لول:</b> هر لول نیاز به 2^level × 1000 XP دارد (برد در بازی‌های کازینو بر اساس مبلغ شرط تا ۲٬۵۰۰ XP می‌دهد)\n'
    + `🎯 <b>ماموریت‌ها:</b> هر روز ${C.DAILY_MISSION_COUNT} ماموریت جدید با جایزه XP\n`
    + '💰 <b>زر:</b> هر ۵ دقیقه بنویس «زر» و زرکوین رایگان بگیر\n'
    + `🏦 <b>بانک:</b> سود روزانه ${Math.round(C.BANK_RATE * 100)}٪ (👑 VIP: ${Math.round(C.VIP_BANK_RATE * 100)}٪) — پس از هر واریز تا ۵ ساعت قفل برداشت دارد\n`
    + `🏠 <b>ملک‌ها</b> و 👷 <b>کارگرها:</b> حداکثر ${C.MAX_PER_KEY} از هر نوع — سود روزانه ۳۵٪ (👑 VIP: +۱۰٪ بیشتر)\n`
    + '💸 <b>برداشت درآمد:</b> از بخش ملک یا کارگر، درآمد انباشته را برداشت کن\n'
    + '💸 <b>انتقال:</b> بالای ۱ میلیون کارمزد ۱٪\n'
    + '🔒 هر کاربر فقط می‌تواند از منوی خودش استفاده کند',
    '🎰 <b>راهنما — کازینو (مینی‌اپ)</b>\n━━━━━━━━━━━━━━━━━━\n'
    + 'از منوی اصلی روی «🎰 کازینو» بزن یا بنویس <b>کازینو زربات</b>\n\n'
    + '🎯 <b>تک‌نفره (۸):</b>\n🎡 چرخ شانس، 🚀 موشک، 💣 مین‌یاب، 🎴 بالا پایین، 🎯 رولت، 🃏 کارت شانس، ⚽ پنالتی، 🪙 شیر یا خط\n\n'
    + '⚔️ <b>دونفره آنلاین (۸):</b>\n♠️ پوکر تگزاس هولدم، 👑 حکم، 🂡 بلک‌جک، 🧠 کوییز، 🔴 چهار در یک ردیف، ✊ سنگ کاغذ قیچی، ⭕ دوز، ⚫ اتللو\n\n'
    + `💰 حداقل شرط: ${U.fmt(C.MINIAPP_MIN_BET)} | حداکثر: ${U.fmt(C.MINIAPP_MAX_BET)} زرکوین\n`
    + `⏳ یافتن حریف: حداکثر ${C.MATCH_TIMEOUT} ثانیه (وگرنه پول برمی‌گردد)\n`
    + `⏰ زمان هر نوبت: ${C.TURN_TIMEOUT} ثانیه\n`
    + `💵 کارمزد برنده‌ی دونفره: ${Math.round(C.COMMISSION_RATE * 100)}٪ — مساوی = برگشت کامل پول`,
    '💎 <b>راهنما — فروشگاه، هدیه و سرگرمی</b>\n━━━━━━━━━━━━━━━━━━\n'
    + '💎 <b>خرید کوین و لول:</b> از منوی اصلی محصول را انتخاب کن و با ⭐ استارز تلگرام یا 💳 کارت به کارت بپرداز. خرید کارت به کارت بعد از تأیید رسید توسط مدیر تحویل می‌شود.\n\n'
    + '🎁 <b>کد هدیه:</b> بنویس <code>هدیه زر کد</code> — از هر کد فقط یک بار\n\n'
    + `🎭 <b>کاباره زر:</b> نیاز به لول ${C.KABAREH_MIN_LEVEL}+ | باز کردن با ${U.fmt(C.KABAREH_UNLOCK_COST)} | روزی یک بار\n\n`
    + '🏆 <b>لیدربورد:</b> رتبه‌بندی بر اساس ثروت (موجودی + بانک)',
    '👑 <b>راهنما — اشتراک VIP</b>\n━━━━━━━━━━━━━━━━━━\n'
    + 'با فعال کردن اشتراک VIP از این امکانات ویژه برخوردار می‌شوی:\n\n'
    + `🚀 <b>وسایل شلیک:</b> خرید تا <b>${C.VIP_LAUNCHER_MAX} عدد</b> از هر وسیله (به‌جای ۳ عدد)\n`
    + `🏭 <b>انبار مهمات:</b> <b>+${C.VIP_AMMO_BONUS} ظرفیت اضافه</b> برای هر نوع مهمات در هر لول انبار\n`
    + `🏠 <b>ملک‌ها و کارگرها:</b> <b>+${Math.round(C.VIP_INCOME_BONUS * 100)}٪ سود بیشتر</b> از درآمد روزانه\n`
    + `🏦 <b>بانک:</b> سود روزانه به <b>${Math.round(C.VIP_BANK_RATE * 100)}٪</b> افزایش می‌یابد (به‌جای ۲٪)\n\n`
    + '💳 <b>پلن‌های ماهانه (از منوی «💎 خرید کوین و لول»):</b>\n'
    + ' • یک‌ماهه: ۸۰٬۰۰۰ تومان\n • سه‌ماهه: ۲۲۰٬۰۰۰ تومان\n • شش‌ماهه: ۴۵۰٬۰۰۰ تومان\n\n'
    + '✅ بلافاصله پس از تأیید رسید توسط مدیر، اشتراک VIP برایت فعال می‌شود.',
    '💀 <b>راهنما — بازار سیاه و انبار</b>\n━━━━━━━━━━━━━━━━━━\n'
    + `🏭 <b>انبار (۱۰ لول):</b> در لول ۱ از هر مهمات فقط ۲ عدد جا می‌گیرد تا لول ۱۰ که ۲۰ عدد می‌شود (👑 VIP: +۵ عدد در هر لول).\n`
    + '💰 هزینه ارتقای انبار: <code>2^لول فعلی × 1,000,000</code>\n\n'
    + `🚀 <b>وسایل شلیک</b> (از هر کدام حداکثر ۳ عدد — 👑 VIP: ${C.VIP_LAUNCHER_MAX} عدد):\n${items('launcher')}\n\n`
    + `💥 <b>مهمات</b> (مصرفی):\n${items('projectile')}\n\n`
    + `🛡️ <b>دفاعی</b> (از هر کدام فقط ۱ عدد):\n${items('defense')}`,
    '🎯 <b>راهنما — حمله و دفاع</b>\n━━━━━━━━━━━━━━━━━━\n'
    + '۱. وسیله شلیک و مهمات را از بازار سیاه بخر\n۲. روی پیام هدف ریپلای کن\n۳. دستور شلیک را بفرست:\n'
    + cmds + '\n\n⚠️ <b>قوانین:</b>\n'
    + ` • هر وسیله شلیک بعد از شلیک ${C.LAUNCH_COOLDOWN / 60} دقیقه خنک می‌شود؛ با چند وسیله می‌توانی پشت‌سرهم شلیک کنی\n`
    + ' • همان درصد تخریب وسیله از پول (کیف + بانک) و تعداد ملک‌ها و کارگرهای هدف کم می‌شود (XP و لول کم نمی‌شود)؛ ملک و کارگرهای نابودشده تصادفی انتخاب می‌شوند\n'
    + ' • به کاربران بن‌شده نمی‌توان حمله کرد یا پول انتقال داد\n'
    + ' • بمب‌ها قابل دفاع نیستند، فقط موشک و پهپاد\n'
    + ' • هر شلیک یک مهمات مصرف می‌کند',
  ];
}

async function handleHelp(env, d, token, q, data, uid, chatId, messageId, kv) {
  const pages = helpPages();
  let page = 0;
  if (data.startsWith('help:p:')) page = Math.max(0, Math.min(parseInt(data.split(':')[2], 10) || 0, pages.length - 1));
  const nav = [];
  if (page > 0) nav.push({ text: '➡️ قبلی', callback_data: `help:p:${page - 1}` });
  nav.push({ text: `📄 ${page + 1}/${pages.length}`, callback_data: `help:p:${page}` });
  if (page < pages.length - 1) nav.push({ text: 'بعدی ⬅️', callback_data: `help:p:${page + 1}` });
  await U.answerCb(token, q.id);
  const m = await U.editMessage(token, chatId, messageId, pages[page], {
    inline_keyboard: [nav, [{ text: '🔙 بازگشت', callback_data: 'menu:main' }]],
  });
  if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
}

// ─── فروشگاه ───
const DEFAULT_VIP_PLANS = [
  ['👑 اشتراک VIP یک‌ماهه', 80000, 30, -30, 'مزایا: ۶ عدد از هر وسیله شلیک | +۵ ظرفیت مهمات در هر لول انبار | +۱۰٪ سود ملک و کارگر | سود روزانه ۵٪ بانک'],
  ['👑 اشتراک VIP سه‌ماهه', 220000, 90, -20, 'مزایا: ۶ عدد از هر وسیله شلیک | +۵ ظرفیت مهمات در هر لول انبار | +۱۰٪ سود ملک و کارگر | سود روزانه ۵٪ بانک'],
  ['👑 اشتراک VIP شش‌ماهه', 450000, 180, -10, 'مزایا: ۶ عدد از هر وسیله شلیک | +۵ ظرفیت مهمات در هر لول انبار | +۱۰٪ سود ملک و کارگر | سود روزانه ۵٪ بانک'],
];

async function seedVipProducts(d) {
  if ((await db.getSetting(d, 'vip_seeded', '')) === '1') return;
  const prods = await db.all(d, 'SELECT rewards FROM shop_products');
  const existingDays = new Set();
  for (const p of prods) {
    try {
      const rw = JSON.parse(p.rewards || '{}');
      if (rw.vip_days) existingDays.add(Number(rw.vip_days));
    } catch (_) {}
  }
  const now = Date.now() / 1000;
  for (const [title, price, days, sort, desc] of DEFAULT_VIP_PLANS) {
    if (existingDays.has(days)) continue;
    await db.run(d,
      'INSERT INTO shop_products (title, description, rewards, price_toman, price_stars, active, sort, created_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?)',
      [title, desc, JSON.stringify({ vip_days: days }), price, sort, now]);
  }
  await db.setSetting(d, 'vip_seeded', '1');
}

function priceLine(p) {
  const parts = [];
  if (Number(p.price_stars || 0)) parts.push(`⭐ ${U.fmt(p.price_stars)} استارز`);
  if (Number(p.price_toman || 0)) parts.push(`💳 ${U.fmt(p.price_toman)} تومان`);
  return parts.join(' | ') || '—';
}

async function shopMenuContent(d) {
  await seedVipProducts(d);
  const prods = await db.all(d, 'SELECT * FROM shop_products WHERE active = 1 ORDER BY sort ASC, id ASC');
  let text, rows;
  if (prods.length) {
    text = '💎 <b>خرید کوین، لول و VIP</b>\n━━━━━━━━━━━━━━━━━━\n'
      + prods.map(p => `• <b>${U.esc(p.title)}</b> — ${priceLine(p)}`).join('\n')
      + '\n\n👇 محصول مورد نظر را انتخاب کن:';
    rows = prods.map(p => [{ text: `💎 ${String(p.title).slice(0, 40)}`, callback_data: `shop:p:${p.id}` }]);
  } else {
    text = '💎 <b>خرید کوین و لول</b>\n━━━━━━━━━━━━━━━━━━\n😔 فعلاً محصولی برای فروش موجود نیست.';
    rows = [];
  }
  rows.push([{ text: '🔙 بازگشت', callback_data: 'menu:main' }]);
  return [text, rows];
}

async function showShopMenu(env, d, token, chatId, uid) {
  const [text, rows] = await shopMenuContent(d);
  const m = await U.sendMessage(token, chatId, text, { reply_markup: { inline_keyboard: rows } });
  return m;
}

async function deliverOrder(d, token, oid, allowed) {
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

async function handleShopCallback(env, d, kv, token, q, data, uid, chatId, messageId) {
  const parts = data.split(':');
  const act = parts[1] || 'menu';
  const arg = parseInt(parts[2] || '0', 10) || 0;
  await seedVipProducts(d);

  // تأیید/رد رسید توسط مدیر
  if (act === 'ok' || act === 'no') {
    const admins = await db.getAdminIds(d);
    if (!admins.has(uid)) { await U.answerCb(token, q.id, '❌ فقط مدیر می‌تواند رسید را بررسی کند', true); return; }
    if (act === 'ok') {
      const [buyer, text] = await deliverOrder(d, token, arg, ['review', 'awaiting_receipt']);
      const note = buyer ? '✅ تأیید و تحویل شد' : '⚠️ ' + text;
      if (buyer) await U.sendMessage(token, buyer, text);
      await U.answerCb(token, q.id, note);
    } else {
      const o = await db.get(d, 'SELECT user_id FROM shop_orders WHERE id = ?', [arg]);
      const r = await db.run(d, "UPDATE shop_orders SET status = 'rejected', updated_at = ? WHERE id = ? AND status IN ('review', 'awaiting_receipt')", [Date.now() / 1000, arg]);
      const note = (r.meta.changes || 0) ? '❌ رد شد' : '⚠️ این سفارش قابل رد نیست';
      if ((r.meta.changes || 0) && o) {
        await U.sendMessage(token, Number(o.user_id), `❌ رسید سفارش #${arg} تأیید نشد. در صورت مشکل با پشتیبانی تماس بگیر.`);
      }
      await U.answerCb(token, q.id, note);
    }
    return;
  }

  // خرید فقط از پیوی
  if (['menu', 'p', 'stars', 'card'].includes(act) && q.message && q.message.chat.type !== 'private') {
    await U.answerCb(token, q.id, '🛒 خرید فقط از پیوی ربات امکان‌پذیر است', true);
    const [text, rows] = await shopMenuContent(d);
    const m = await U.editMessage(token, chatId, messageId,
      '💎 <b>خرید کوین و لول</b>\n━━━━━━━━━━━━━━━━━━\n🔒 برای امنیت پرداخت، خرید فقط از <b>پیوی ربات</b> امکان‌پذیر است.\n👇 روی دکمه زیر بزن:',
      { inline_keyboard: [[{ text: '🛒 ورود به فروشگاه در پیوی ربات', url: `https://t.me/${C.env.BOT_USERNAME || ''}?start=shop` }], [{ text: '🔙 بازگشت', callback_data: 'menu:main' }]] });
    return;
  }

  if (act === 'menu') {
    await U.answerCb(token, q.id);
    const [text, rows] = await shopMenuContent(d);
    const m = await U.editMessage(token, chatId, messageId, text, { inline_keyboard: rows });
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  let p = null;
  if (['p', 'stars', 'card'].includes(act)) {
    p = await db.get(d, 'SELECT * FROM shop_products WHERE id = ? AND active = 1', [arg]);
    if (!p) { await U.answerCb(token, q.id, '❌ این محصول دیگر موجود نیست', true); return; }
  }

  if (act === 'p') {
    const card = await db.getSetting(d, 'card_number', '');
    const desc = p.description ? U.esc(p.description) + '\n\n' : '';
    let rewards = {};
    try { rewards = JSON.parse(p.rewards || '{}'); } catch (_) {}
    let text = `💎 <b>${U.esc(p.title)}</b>\n━━━━━━━━━━━━━━━━━━\n${desc}🎁 <b>شامل:</b>\n${db.rewardsText(db.rewardsList(rewards))}\n\n💰 <b>قیمت:</b> ${priceLine(p)}\n\n👇 روش پرداخت:`;
    const rows = [];
    if (Number(p.price_stars || 0)) rows.push([{ text: `⭐ پرداخت با استارز (${U.fmt(p.price_stars)})`, callback_data: `shop:stars:${p.id}` }]);
    if (Number(p.price_toman || 0) && card) rows.push([{ text: `💳 کارت به کارت (${U.fmt(p.price_toman)} تومان)`, callback_data: `shop:card:${p.id}` }]);
    if (!rows.length) text += '\n⚠️ فعلاً روش پرداختی فعال نیست.';
    rows.push([{ text: '🔙 بازگشت به فروشگاه', callback_data: 'shop:menu' }]);
    await U.answerCb(token, q.id);
    const m = await U.editMessage(token, chatId, messageId, text, { inline_keyboard: rows });
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (act === 'stars') {
    const stars = Number(p.price_stars || 0);
    if (stars <= 0) { await U.answerCb(token, q.id, '❌ پرداخت با استارز برای این محصول فعال نیست', true); return; }
    const now = Date.now() / 1000;
    const r = await db.run(d,
      "INSERT INTO shop_orders (user_id, product_id, title, rewards, method, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'stars', ?, 'pending', ?, ?)",
      [uid, p.id, p.title, p.rewards, stars, now, now]);
    const oid = r.meta.last_row_id;
    let rewards = {};
    try { rewards = JSON.parse(p.rewards || '{}'); } catch (_) {}
    const desc = (p.description || db.rewardsText(db.rewardsList(rewards))).slice(0, 250) || p.title;
    try {
      await U.tg(token, 'sendInvoice', {
        chat_id: uid, title: String(p.title).slice(0, 32), description: desc,
        payload: `zarshop:${oid}`, provider_token: '', currency: 'XTR',
        prices: [{ label: String(p.title).slice(0, 32), amount: stars }],
      });
      await U.answerCb(token, q.id, '🧾 فاکتور پرداخت ارسال شد 👇');
    } catch (e) {
      await db.run(d, "UPDATE shop_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [Date.now() / 1000, oid]);
      await U.answerCb(token, q.id, '❌ ارسال فاکتور ناموفق بود — دوباره تلاش کن', true);
    }
    return;
  }

  if (act === 'card') {
    const card = await db.getSetting(d, 'card_number', '');
    const holder = await db.getSetting(d, 'card_holder', '');
    if (!card || !Number(p.price_toman || 0)) { await U.answerCb(token, q.id, '❌ پرداخت کارت به کارت فعال نیست', true); return; }
    await db.run(d, "UPDATE shop_orders SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'awaiting_receipt'", [Date.now() / 1000, uid]);
    const now = Date.now() / 1000;
    const r = await db.run(d,
      "INSERT INTO shop_orders (user_id, product_id, title, rewards, method, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'card', ?, 'awaiting_receipt', ?, ?)",
      [uid, p.id, p.title, p.rewards, Number(p.price_toman), now, now]);
    const oid = r.meta.last_row_id;
    const text = `💳 <b>پرداخت کارت به کارت</b>\n━━━━━━━━━━━━━━━━━━\n🛒 محصول: <b>${U.esc(p.title)}</b>\n`
      + `💰 مبلغ: <b>${U.fmt(p.price_toman)} تومان</b>\n💳 شماره کارت: <code>${U.esc(card)}</code>\n`
      + (holder ? `👤 به نام: ${U.esc(holder)}\n` : '')
      + `🧾 کد سفارش: <b>#${oid}</b>\n\n📸 بعد از واریز، <b>عکس رسید</b> را در <b>پیوی ربات</b> بفرست.\nسفارش بعد از تأیید مدیر خودکار تحویل می‌شود.`;
    await U.answerCb(token, q.id);
    const m = await U.editMessage(token, chatId, messageId, text, { inline_keyboard: [
      [{ text: '❌ لغو سفارش', callback_data: `shop:cancel:${oid}` }],
      [{ text: '🔙 بازگشت به فروشگاه', callback_data: 'shop:menu' }],
    ] });
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  if (act === 'cancel') {
    const r = await db.run(d,
      "UPDATE shop_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('awaiting_receipt', 'pending')",
      [Date.now() / 1000, arg, uid]);
    await U.answerCb(token, q.id, (r.meta.changes || 0) ? '✅ سفارش لغو شد' : 'این سفارش قابل لغو نیست', true);
    const m = await U.editMessage(token, chatId, messageId, '❌ سفارش لغو شد.', {
      inline_keyboard: [[{ text: '🔙 بازگشت به فروشگاه', callback_data: 'shop:menu' }]],
    });
    return;
  }
}

async function handlePreCheckout(d, token, pq) {
  const payload = pq.invoice_payload || '';
  let ok = false;
  try {
    if (payload.startsWith('zarshop:')) {
      const o = await db.get(d, 'SELECT * FROM shop_orders WHERE id = ?', [parseInt(payload.split(':')[1], 10)]);
      ok = !!(o && o.status === 'pending' && Number(o.user_id) === pq.from.id && Number(o.amount) === pq.total_amount && pq.currency === 'XTR');
    }
  } catch (_) {}
  try {
    if (ok) await U.tg(token, 'answerPreCheckoutQuery', { pre_checkout_query_id: pq.id, ok: true });
    else await U.tg(token, 'answerPreCheckoutQuery', { pre_checkout_query_id: pq.id, ok: false, error_message: 'این سفارش معتبر نیست یا قبلاً پرداخت شده.' });
  } catch (_) {}
}

async function handleSuccessfulPayment(env, d, token, msg) {
  const sp = msg.successful_payment;
  if (!sp || !(sp.invoice_payload || '').startsWith('zarshop:')) return;
  const oid = parseInt(sp.invoice_payload.split(':')[1], 10);
  const [buyer, text] = await deliverOrder(d, token, oid, ['pending', 'cancelled']);
  if (buyer) await U.sendMessage(token, msg.chat.id, text);
  else await U.sendMessage(token, msg.chat.id, '⚠️ پرداخت انجام شد ولی تحویل خودکار ناموفق بود — به پشتیبانی پیام بده. کد سفارش: #' + oid);
  const admins = await db.getAdminIds(d);
  for (const adminId of admins) {
    await U.sendMessage(token, adminId,
      `💎 <b>خرید با استارز</b>\n👤 ${U.esc(msg.from?.first_name || '')} (${msg.from?.id})\n🧾 سفارش #${oid} — ⭐ ${sp.total_amount}\n${buyer ? '✅ تحویل شد' : '⚠️ ' + U.esc(text)}`);
  }
}

async function handleReceiptPhoto(env, d, token, msg) {
  const uid = msg.from.id;
  const o = await db.get(d,
    "SELECT * FROM shop_orders WHERE user_id = ? AND status = 'awaiting_receipt' AND created_at > ? ORDER BY id DESC LIMIT 1",
    [uid, Date.now() / 1000 - 86400]);
  if (!o) return; // عکس مربوط به فروشگاه نیست
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  await db.run(d, "UPDATE shop_orders SET status = 'review', receipt_file_id = ?, updated_at = ? WHERE id = ?", [fileId, Date.now() / 1000, o.id]);
  const caption = `🧾 رسید جدید — سفارش #${o.id}\n👤 ${msg.from.first_name} (${uid})\n🛒 ${o.title}\n💰 ${U.fmt(o.amount)} تومان`;
  const kb = { inline_keyboard: [[
    { text: '✅ تأیید و تحویل', callback_data: `shop:ok:${o.id}` },
    { text: '❌ رد', callback_data: `shop:no:${o.id}` },
  ]] };
  let sent = false;
  const admins = await db.getAdminIds(d);
  for (const adminId of admins) {
    try {
      await U.tg(token, 'sendPhoto', { chat_id: adminId, photo: fileId, caption, reply_markup: kb });
      sent = true;
    } catch (_) {}
  }
  await U.sendMessage(token, msg.chat.id,
    `✅ رسید سفارش #${o.id} ثبت شد و برای بررسی ارسال شد.\nبعد از تأیید، خرید خودکار تحویل می‌شود.` + (sent ? '' : '\n(مدیر می‌تواند از پنل مدیریت هم بررسی کند)'));
}

// ─── انتقال: تأیید/لغو ───
async function handleTransferConfirm(env, d, kv, token, q, data, uid, chatId, messageId) {
  const parts = data.split(':');
  const ownerId = parseInt(parts[2], 10);
  if (uid !== ownerId) { await U.answerCb(token, q.id, '❌ دکمه برای تو نیست', true); return; }

  if (data.startsWith('tr:x:')) {
    await U.answerCb(token, q.id);
    await kv.delete(`transfer:${ownerId}`);
    const m = await U.editMessage(token, chatId, messageId, '❌ لغو شد.', BACK_MAIN_KB);
    if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
    return;
  }

  const pending = await U.kvJson(kv, `transfer:${ownerId}`, null);
  if (!pending) { await U.answerCb(token, q.id, '❌ منقضی', true); return; }
  await kv.delete(`transfer:${ownerId}`);
  if (await db.isBanned(d, pending.recipient_id) || await db.isBanned(d, ownerId)) {
    await U.answerCb(token, q.id, '❌ این انتقال امکان‌پذیر نیست', true);
    return;
  }
  const ok = await db.transferCoins(d, ownerId, pending.recipient_id, pending.amount, pending.fee);
  if (!ok) {
    await U.answerCb(token, q.id, '❌ موجودی!', true);
    await U.editMessage(token, chatId, messageId, '❌ انجام نشد.', BACK_MAIN_KB);
    return;
  }
  await U.answerCb(token, q.id);
  const m = await U.editMessage(token, chatId, messageId,
    `✅ انتقال شد!\n👤 ${U.esc(pending.recipient_name)}\n💰 ${U.fmt(pending.amount)}`, BACK_MAIN_KB);
  if (m && m !== 'not_modified') await U.rememberOwner(kv, m, uid);
  try {
    await U.sendMessage(token, pending.recipient_id, `🎁 ${U.fmt(pending.amount)} زرکوین از ${U.esc(q.from.first_name)}`);
  } catch (_) {}
  const result = await db.progressMission(d, ownerId, 'transfer', 1, C.BASE_XP_TRANSFER);
  await notifyMission(token, chatId, result);
}
