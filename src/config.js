// ═══════════ تنظیمات ربات زرکوین (نسخه Cloudflare Workers) ═══════════
// مقادیر حساس (BOT_TOKEN, OWNER_ID, ...) از متغیرهای محیطی وورکر خوانده می‌شوند.
// تنظیمات جوین اجباری هم از env خوانده می‌شود تا بدون دیپلوی مجدد قابل تغییر باشند.

export const env = {};

export function loadEnv(e) {
  // روی هر request یک‌بار صدا زده می‌شود (env وورکر immutable است)
  env.BOT_TOKEN = (e.BOT_TOKEN || '').trim();
  env.OWNER_ID = parseInt(e.OWNER_ID || '0', 10) || 0;
  env.START_BALANCE = parseInt(e.START_BALANCE || '0', 10) || 0;
  env.WEBAPP_URL = (e.WEBAPP_URL || '').trim().replace(/\/+$/, ''); // URL عمومی وورکر (مثل https://zar-bot.workers.dev)
  env.WEBAPP_DEEP_LINK = (e.WEBAPP_DEEP_LINK || '').trim(); // مثل https://t.me/your_bot/app
  env.ADMIN_PASSWORD = (e.ADMIN_PASSWORD || '').trim();
  env.SHOP_ADMIN_IDS = (e.SHOP_ADMIN_IDS || '');
  env.MEMBERSHIP_REQUIRED = (e.MEMBERSHIP_REQUIRED || 'false') === 'true';

  // جوین اجباری — JSON: {"channels":[{"name":"کانال","id":"@channel","url":"https://t.me/channel"}],"group":{"name":"گروه","id":-100...,"url":"https://t.me/..."}}
  let ch = [], gr = null;
  try {
    const raw = JSON.parse(e.REQUIRED_CHANNELS_JSON || '[]');
    if (Array.isArray(raw)) ch = raw.filter(c => c && c.name && c.id && c.url);
  } catch (_) {}
  try {
    const raw = JSON.parse(e.REQUIRED_GROUP_JSON || 'null');
    if (raw && raw.name && raw.id && raw.url) gr = raw;
  } catch (_) {}
  env.REQUIRED_CHANNELS = ch;
  env.REQUIRED_GROUP = gr;

  // ادمین‌های فروشگاه/رسید
  const ids = new Set();
  if (env.OWNER_ID) ids.add(env.OWNER_ID);
  for (const x of (env.SHOP_ADMIN_IDS || '').split(',')) {
    const n = parseInt(x.trim(), 10);
    if (n > 0) ids.add(n);
  }
  env.ADMIN_IDS = ids;
  return env;
}

export function ownerIds(db) { /* async در db.js مدیریت می‌شود */ }

// ═══════════ اقتصاد ═══════════
export const BANK_RATE = 0.02;            // سود روزانه ۲٪
export const MAX_PER_KEY = 5;             // حداکثر ملک/کارگر از هر نوع
export const TRANSFER_FEE_RATE = 0.01;     // کارمزد انتقال ۱٪
export const TRANSFER_FEE_MIN = 1_000_000; // بالای ۱M کارمزد دارد
export const HOURLY_PAYOUT_MAX_CATCHUP = 86400; // حداکثر جبران درآمد معوق: ۱ روز
export const ZAR_COOLDOWN_SECONDS = 300;   // کول‌داون دستور «زر»: ۵ دقیقه

// ═══════════ کاباره زر ═══════════
export const KABAREH_UNLOCK_COST = 25_000_000;
export const KABAREH_COOLDOWN_HOURS = 24;
export const KABAREH_MIN_LEVEL = 4;
export const KABAREH_GIRLS = {
  fox:    { name: 'خانم روباه',  emoji: '🦊', price: 2_000_000 },
  angela: { name: 'خانم آنجلا',  emoji: '👱‍♀️', price: 3_000_000 },
  lana:   { name: 'خانم لانا',   emoji: '👩', price: 4_000_000 },
  alexis: { name: 'خانم الکسیس', emoji: '👩‍🦰', price: 5_000_000 },
  eden:   { name: 'خانم اِدِن',   emoji: '👸', price: 6_000_000 },
};
export const KABAREH_BABY_COST = 1_000_000;
export const KABAREH_BABY_XP = 2000;

// ═══════════ لول و ماموریت ═══════════
export const DAILY_MISSION_COUNT = 6;
export const BASE_XP_ZAR = 10;
export const BASE_XP_KABAREH = 20;
export const BASE_XP_TRANSFER = 20;
export const BASE_XP_BUY_ASSET = 40;
export const BASE_XP_DEPOSIT_10K = 10;
export const BASE_XP_WITHDRAW_INCOME = 15;

export const MISSION_TEMPLATES = {
  play_rps_1:      { desc: '۱ بازی سنگ کاغذ قیچی انجام بده', type: 'play_rps', target: 1, xp: 100 },
  play_rps_3:      { desc: '۳ بازی سنگ کاغذ قیچی انجام بده', type: 'play_rps', target: 3, xp: 300 },
  play_rps_5:      { desc: '۵ بازی سنگ کاغذ قیچی انجام بده', type: 'play_rps', target: 5, xp: 450 },
  win_rps_1:       { desc: '۱ بازی سنگ کاغذ قیچی ببر', type: 'win_rps', target: 1, xp: 200 },
  win_rps_3:       { desc: '۳ بازی سنگ کاغذ قیچی ببر', type: 'win_rps', target: 3, xp: 500 },
  play_ttt_1:      { desc: '۱ بازی دوز انجام بده', type: 'play_ttt', target: 1, xp: 100 },
  play_ttt_3:      { desc: '۳ بازی دوز انجام بده', type: 'play_ttt', target: 3, xp: 300 },
  play_ttt_5:      { desc: '۵ بازی دوز انجام بده', type: 'play_ttt', target: 5, xp: 450 },
  win_ttt_1:       { desc: '۱ بازی دوز ببر', type: 'win_ttt', target: 1, xp: 250 },
  win_ttt_3:       { desc: '۳ بازی دوز ببر', type: 'win_ttt', target: 3, xp: 600 },
  play_quiz_1:     { desc: '۱ کوییز بازی کن', type: 'play_quiz', target: 1, xp: 100 },
  play_quiz_3:     { desc: '۳ کوییز بازی کن', type: 'play_quiz', target: 3, xp: 300 },
  win_quiz_1:      { desc: '۱ کوییز ببر', type: 'win_quiz', target: 1, xp: 300 },
  win_quiz_3:      { desc: '۳ کوییز ببر', type: 'win_quiz', target: 3, xp: 700 },
  play_penalty_1:  { desc: '۱ پنالتی بزن', type: 'play_penalty', target: 1, xp: 100 },
  play_penalty_3:  { desc: '۳ پنالتی بزن', type: 'play_penalty', target: 3, xp: 300 },
  win_penalty_1:   { desc: '۱ پنالتی گل کن', type: 'win_penalty', target: 1, xp: 200 },
  win_penalty_3:   { desc: '۳ پنالتی گل کن', type: 'win_penalty', target: 3, xp: 500 },
  play_casino_1:   { desc: '۱ بازی کازینو انجام بده', type: 'play_casino', target: 1, xp: 100 },
  play_casino_3:   { desc: '۳ بازی کازینو انجام بده', type: 'play_casino', target: 3, xp: 300 },
  play_casino_5:   { desc: '۵ بازی کازینو انجام بده', type: 'play_casino', target: 5, xp: 450 },
  play_casino_10:  { desc: '۱۰ بازی کازینو انجام بده', type: 'play_casino', target: 10, xp: 600 },
  play_casino_15:  { desc: '۱۵ بازی کازینو انجام بده', type: 'play_casino', target: 15, xp: 800 },
  win_casino_3:    { desc: '۳ بازی کازینو ببر', type: 'win_casino', target: 3, xp: 500 },
  win_casino_5:    { desc: '۵ بازی کازینو ببر', type: 'win_casino', target: 5, xp: 800 },
  play_games_5:    { desc: '۵ بازی (هر نوعی) انجام بده', type: 'play_any_game', target: 5, xp: 400 },
  play_games_10:   { desc: '۱۰ بازی (هر نوعی) انجام بده', type: 'play_any_game', target: 10, xp: 500 },
  play_games_15:   { desc: '۱۵ بازی (هر نوعی) انجام بده', type: 'play_any_game', target: 15, xp: 700 },
  win_games_3:     { desc: '۳ بازی (هر نوعی) ببر', type: 'win_any_game', target: 3, xp: 500 },
  win_games_5:     { desc: '۵ بازی (هر نوعی) ببر', type: 'win_any_game', target: 5, xp: 800 },
  buy_property_1:  { desc: '۱ ملک بخر', type: 'buy_property', target: 1, xp: 250 },
  buy_property_3:  { desc: '۳ ملک بخر', type: 'buy_property', target: 3, xp: 500 },
  buy_worker_1:    { desc: '۱ کارگر استخدام کن', type: 'buy_worker', target: 1, xp: 250 },
  buy_worker_3:    { desc: '۳ کارگر استخدام کن', type: 'buy_worker', target: 3, xp: 500 },
  deposit_100k:    { desc: '۱۰۰٬۰۰۰ زرکوین به بانک واریز کن', type: 'deposit_bank', target: 100000, xp: 150 },
  deposit_500k:    { desc: '۵۰۰٬۰۰۰ زرکوین به بانک واریز کن', type: 'deposit_bank', target: 500000, xp: 400 },
  deposit_1m:      { desc: '۱٬۰۰۰٬۰۰۰ زرکوین به بانک واریز کن', type: 'deposit_bank', target: 1000000, xp: 600 },
  transfer_1:      { desc: '۱ انتقال زرکوین انجام بده', type: 'transfer', target: 1, xp: 200 },
  transfer_3:      { desc: '۳ انتقال زرکوین انجام بده', type: 'transfer', target: 3, xp: 400 },
  zar_collect_3:   { desc: '۳ بار کلمه زر رو بفرست', type: 'zar_collect', target: 3, xp: 250 },
  zar_collect_5:   { desc: '۵ بار کلمه زر رو بفرست', type: 'zar_collect', target: 5, xp: 400 },
  zar_collect_10:  { desc: '۱۰ بار کلمه زر رو بفرست', type: 'zar_collect', target: 10, xp: 600 },
  kabareh_1:       { desc: '۱ بار به کاباره برو', type: 'kabareh', target: 1, xp: 300 },
  withdraw_income_1: { desc: '۱ بار درآمد ملک/کارگر رو برداشت کن', type: 'withdraw_income', target: 1, xp: 200 },
  withdraw_income_3: { desc: '۳ بار درآمد ملک/کارگر رو برداشت کن', type: 'withdraw_income', target: 3, xp: 400 },
};

// ═══════════ ملک‌ها ═══════════
export const PROPERTIES = {
  supermarket: { name: 'سوپرمارکت', price: 500_000, income: 175_000, emoji: '🛒' },
  fruit:       { name: 'میوه‌فروشی', price: 800_000, income: 280_000, emoji: '🍎' },
  butcher:     { name: 'قصابی', price: 1_000_000, income: 350_000, emoji: '🥩' },
  pharmacy:    { name: 'داروخانه', price: 1_800_000, income: 630_000, emoji: '💊' },
  barber:      { name: 'آرایشگاه', price: 2_200_000, income: 770_000, emoji: '💈' },
  clothing:    { name: 'فروشگاه پوشاک', price: 3_000_000, income: 1_050_000, emoji: '👕' },
  bookstore:   { name: 'کتاب‌فروشی', price: 3_500_000, income: 1_225_000, emoji: '📚' },
  mobile:      { name: 'موبایل‌فروشی', price: 4_000_000, income: 1_400_000, emoji: '📱' },
  electronics: { name: 'فروشگاه لوازم الکترونیکی', price: 4_850_000, income: 1_697_500, emoji: '📺' },
  jewelry:     { name: 'جواهرفروشی', price: 5_700_000, income: 1_995_000, emoji: '💍' },
  car_dealer:  { name: 'نمایشگاه ماشین', price: 6_550_000, income: 2_292_500, emoji: '🚗' },
  restaurant:  { name: 'رستوران', price: 7_400_000, income: 2_590_000, emoji: '🍽️' },
  hotel:       { name: 'هتل', price: 8_250_000, income: 2_887_500, emoji: '🏨' },
  mall:        { name: 'مجتمع تجاری', price: 9_100_000, income: 3_185_000, emoji: '🏬' },
};

// ═══════════ کارگرها ═══════════
export const WORKERS = {
  teacher:   { name: 'معلم', price: 300_000, income: 105_000, emoji: '👨‍🏫' },
  doctor:    { name: 'پزشک', price: 500_000, income: 175_000, emoji: '👨‍⚕️' },
  driver:    { name: 'راننده', price: 800_000, income: 280_000, emoji: '🚕' },
  developer: { name: 'برنامه‌نویس', price: 1_200_000, income: 420_000, emoji: '👨‍💻' },
  ai_expert: { name: 'متخصص هوش مصنوعی', price: 2_000_000, income: 700_000, emoji: '🤖' },
  pilot:     { name: 'خلبان', price: 2_600_000, income: 910_000, emoji: '✈️' },
  surgeon:   { name: 'جراح', price: 3_000_000, income: 1_050_000, emoji: '🩺' },
  ceo:       { name: 'مدیرعامل', price: 3_500_000, income: 1_225_000, emoji: '💼' },
  chef:      { name: 'سرپرست آشپزخانه', price: 4_100_000, income: 1_435_000, emoji: '👨‍🍳' },
  architect: { name: 'معمار', price: 4_700_000, income: 1_645_000, emoji: '📐' },
  scientist: { name: 'دانشمند', price: 5_300_000, income: 1_855_000, emoji: '🔬' },
  astronaut: { name: 'فضانورد', price: 5_900_000, income: 2_065_000, emoji: '🚀' },
};

// ═══════════ بازار سیاه ═══════════
export const LAUNCHER_MIN_LEVEL = 20;
export const LAUNCHER_LEVEL_LOCKED = ['missile_launcher', 'b2_bomber', 'mc130_transport', 'drone_launcher', 'f35_fighter'];
export const BLACKMARKET_ITEMS = {
  missile_launcher: { name: 'لانچر موشک', emoji: '🚀', price: 40_000_000, type: 'launcher', launches: ['cruise_missile', 'ballistic_missile', 'hypersonic_missile'] },
  b2_bomber:        { name: 'بمب افکن B-2', emoji: '✈️', price: 50_000_000, type: 'launcher', launches: ['nuclear_bomb'] },
  mc130_transport:  { name: 'هواپیمای ترابری MC-130', emoji: '🛩️', price: 60_000_000, type: 'launcher', launches: ['gbu43_bomb'] },
  f35_fighter:      { name: 'هواپیمای F-35', emoji: '✈️', price: 30_000_000, type: 'launcher', launches: ['gbu12_bomb'] },
  drone_launcher:   { name: 'لانچر پهباد', emoji: '🛸', price: 12_000_000, type: 'launcher', launches: ['shahed131_drone', 'mq9_drone'] },
  cruise_missile:      { name: 'موشک کروز', emoji: '🚀', price: 20_000_000, type: 'projectile', damage: 0.20, command: 'شلیک موشک کروز', defense_type: 'missile_defense' },
  ballistic_missile:   { name: 'موشک بالستیک', emoji: '🚀', price: 30_000_000, type: 'projectile', damage: 0.30, command: 'شلیک موشک بالستیک', defense_type: 'missile_defense' },
  hypersonic_missile:  { name: 'موشک هایپرسونیک', emoji: '🚀', price: 40_000_000, type: 'projectile', damage: 0.40, command: 'شلیک موشک هایپرسونیک', defense_type: 'missile_defense' },
  gbu43_bomb:          { name: 'بمب GBU-43/B', emoji: '💣', price: 35_000_000, type: 'projectile', damage: 0.50, command: 'مادر همه بمب ها', defense_type: null },
  nuclear_bomb:        { name: 'بمب هسته ای B61-12', emoji: '☢️', price: 50_000_000, type: 'projectile', damage: 0.60, command: 'بمب هسته ای', defense_type: null },
  gbu12_bomb:          { name: 'بمب GBU-12', emoji: '💣', price: 15_000_000, type: 'projectile', damage: 0.15, command: 'کمی بکنش', defense_type: null },
  shahed131_drone:     { name: 'پهباد شاهد-131', emoji: '🛸', price: 8_000_000, type: 'projectile', damage: 0.10, command: 'پهباد شاهد', defense_type: 'drone_defense' },
  mq9_drone:           { name: 'پهباد MQ-9', emoji: '🛸', price: 10_000_000, type: 'projectile', damage: 0.15, command: 'شلیک پهباد MQ', defense_type: 'drone_defense' },
  missile_defense: { name: 'پدافند موشکی', emoji: '🛡️', price: 40_000_000, type: 'defense', defense_chance: 0.35, defends_against: 'missile_defense' },
  drone_defense:   { name: 'سامانه ضدپهباد', emoji: '🛡️', price: 45_000_000, type: 'defense', defense_chance: 0.35, defends_against: 'drone_defense' },
};
export const BLACKMARKET_PER_PAGE = 6;

// ═══════════ مینی‌اپ (قمارخانه) ═══════════
export const MATCH_TIMEOUT = 60;          // ثانیه برای یافتن حریف
export const TURN_TIMEOUT = 45;           // ثانیه برای هر نوبت
export const COMMISSION_RATE = 0.05;      // کارمزد برنده دونفره ۵٪
export const MINIAPP_MIN_BET = 1000;
export const MINIAPP_MAX_BET = 30_000_000;
export const GAME_TTL = 1800;             // نگه‌داری بازی در KV (ثانیه)
export const QUEUE_TTL = 120;             // نگه‌داری صف در KV
export const FINISHED_GAME_TTL = 300;
export const SOLO_SESSION_TTL = 3600;
export const BANK_LOCK_SECS = 5 * 3600;   // قفل ۵ ساعته برداشت بانک
export const LAUNCH_COOLDOWN = 3600;      // خنک شدن هر وسیله شلیک: ۱ ساعت
export const WAREHOUSE_MAX_LEVEL = 10;
export const WAREHOUSE_UPGRADE_BASE = 1_000_000;
export const VIP_LAUNCHER_MAX = 6;
export const VIP_AMMO_BONUS = 5;
export const VIP_INCOME_BONUS = 0.10;
export const VIP_BANK_RATE = 0.05;
export const MAX_LEVEL = 50;
export const MIN_WIN_XP = 15;
export const MAX_WIN_XP = 2500;
export const GRANT_KINDS = ['coins', 'bank', 'xp', 'levels', 'vip_days', 'property', 'worker', 'item'];

export const MENU_COLORS = ['', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪'];
export const MENU_BUTTONS = [
  ['btn_bank', '🏦 بانک'], ['btn_prop', '🏠 ملک‌ها'], ['btn_worker', '👷 کارگرها'],
  ['btn_casino', '🎰 کازینو'], ['btn_mission', '🎯 ماموریت‌ها'], ['btn_transfer', '💸 انتقال'],
  ['btn_kabareh', '🎭 کاباره زر'], ['btn_lb', '🏆 لیدربورد'], ['btn_bm', '💀 بازار سیاه'],
  ['btn_shop', '💎 خرید کوین و لول'], ['btn_help', '📚 راهنما'],
];
export const BOT_SECTIONS = {
  casino: '🎰 کازینو (مینی‌اپ)', bank: '🏦 بانک', properties: '🏠 ملک‌ها', workers: '👷 کارگرها',
  missions: '🎯 ماموریت‌ها', transfer: '💸 انتقال زرکوین', kabareh: '🎭 کاباره زر',
  leaderboard: '🏆 لیدربورد', blackmarket: '💀 بازار سیاه و شلیک', shop: '💎 فروشگاه (کوین، لول و VIP)',
  zar: '💰 دستور «زر»', gifts: '🎁 کد هدیه',
};
export const DEFAULT_DESIGN = {
  btn_primary: '#e11d48', btn_gold: '#f5c451', btn_green: '#10b981', btn_blue: '#38bdf8',
  btn_gold_text: '#1b1200', bg_color: '#07070c',
};

// ═══════════ بازی‌های مینی‌اپ ═══════════
export function buildGames(minBet, maxBet) {
  const g = {
    wheel:    { name: 'چرخ شانس', emoji: '🎡', type: '1p', desc: 'چرخ را بچرخان — تا ۵ برابر جایزه' },
    crash:    { name: 'موشک', emoji: '🚀', type: '1p', desc: 'ضریب هدف را انتخاب کن؛ قبل از انفجار برس' },
    mines:    { name: 'مین‌یاب', emoji: '💣', type: '1p', desc: 'خانه‌های امن را باز کن و به‌موقع برداشت کن' },
    hilo:     { name: 'بالا پایین', emoji: '🎴', type: '1p', desc: 'کارت بعدی بالاتر است یا پایین‌تر؟' },
    roulette: { name: 'رولت', emoji: '🎯', type: '1p', desc: 'رنگ، زوج/فرد، دسته یا عدد — تا ۳۶ برابر' },
    card:     { name: 'کارت شانس', emoji: '🃏', type: '1p', desc: 'رنگ (×۱٫۹) یا خال (×۳٫۸) کارت را حدس بزن' },
    penalty:  { name: 'پنالتی', emoji: '⚽', type: '1p', desc: 'یک گوشه را انتخاب کن و دروازه‌بان را فریب بده' },
    coin:     { name: 'شیر یا خط', emoji: '🪙', type: '1p', desc: '۵۰/۵۰ — برد ۱٫۹ برابر' },
    holdem:   { name: 'پوکر تگزاس هولدم', emoji: '♠️', type: '2p', desc: 'هدز‌آپ با رِیز آزاد و آل‌این' },
    hokm:     { name: 'حکم', emoji: '👑', type: '2p', desc: 'حکم دونفره — هر کس ۷ دست ببرد' },
    blackjack:{ name: 'بلک‌جک', emoji: '🂡', type: '2p', desc: 'نزدیک‌تر به ۲۱ بدون سوختن' },
    quiz:     { name: 'کوییز', emoji: '🧠', type: '2p', desc: '۵ سوال هم‌زمان — جواب درست بیشتر برنده' },
    connect4: { name: 'چهار در یک ردیف', emoji: '🔴', type: '2p', desc: 'اولین نفری که ۴ مهره پشت‌سرهم بچیند' },
    rps:      { name: 'سنگ کاغذ قیچی', emoji: '✊', type: '2p', desc: 'سه دست — هر کس ۲ دست ببرد' },
    ttt:      { name: 'دوز', emoji: '⭕', type: '2p', desc: 'سه در یک خط — کلاسیک دونفره' },
    othello:  { name: 'اتللو', emoji: '⚫', type: '2p', desc: 'مهره‌های حریف را محاصره و برعکس کن' },
  };
  for (const k of Object.keys(g)) { g[k].min_bet = minBet; g[k].max_bet = Math.max(maxBet, minBet); }
  return g;
}

export const MISSION_KEYS = { rps: 'rps', ttt: 'ttt', quiz: 'quiz', penalty: 'penalty' };
