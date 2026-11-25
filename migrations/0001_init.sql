-- ═══════════ اسکیمای D1 (SQLite) ربات زرکوین ═══════════
-- پورت کامل ساختار MySQL پروژه اصلی + جداول سیستم (فروشگاه/VIP/انبار/بن/ادمین/...)
-- اجرا: wrangler d1 execute zar-bot --remote --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  bank_balance INTEGER NOT NULL DEFAULT 0,
  card_number TEXT UNIQUE,
  last_daily TEXT,
  created_at TEXT NOT NULL,
  total_xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  kabareh_unlocked INTEGER NOT NULL DEFAULT 0,
  last_kabareh TEXT,
  last_zar TEXT,
  last_mission_date TEXT,
  last_payout TEXT
);
CREATE INDEX IF NOT EXISTS idx_card ON users(card_number);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  asset_type TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  purchase_price INTEGER NOT NULL,
  daily_income INTEGER NOT NULL,
  purchased_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_asset ON assets(user_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_user_key ON assets(user_id, asset_key);

CREATE TABLE IF NOT EXISTS user_missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  mission_key TEXT NOT NULL,
  mission_date TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  target INTEGER NOT NULL,
  xp_reward INTEGER NOT NULL,
  completed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_date ON user_missions(user_id, mission_date);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  last_used REAL
);
CREATE INDEX IF NOT EXISTS idx_user_item ON inventory(user_id, item_key);

-- ─── جداول سیستم (از webapp.py) ───
CREATE TABLE IF NOT EXISTS gift_codes (
  code TEXT PRIMARY KEY,
  rewards TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  min_level INTEGER NOT NULL DEFAULT 0,
  expires_at REAL,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redeemed_at REAL NOT NULL,
  UNIQUE (code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gift_user ON gift_redemptions(user_id);

CREATE TABLE IF NOT EXISTS shop_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  rewards TEXT NOT NULL,
  price_toman INTEGER NOT NULL DEFAULT 0,
  price_stars INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  rewards TEXT NOT NULL,
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  receipt_file_id TEXT,
  charge_id TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_user_status ON shop_orders(user_id, status);

CREATE TABLE IF NOT EXISTS zar_settings (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS banned_users (
  user_id INTEGER PRIMARY KEY,
  reason TEXT,
  banned_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_admins (
  user_id INTEGER PRIMARY KEY,
  note TEXT,
  added_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS game_items (
  category TEXT NOT NULL,
  item_key TEXT NOT NULL,
  data TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category, item_key)
);

CREATE TABLE IF NOT EXISTS vip_users (
  user_id INTEGER PRIMARY KEY,
  expires_at REAL NOT NULL,
  note TEXT,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS user_warehouse (
  user_id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 1,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_locks (
  user_id INTEGER PRIMARY KEY,
  unlock_at REAL NOT NULL
);

-- ─── seed اولیه: آیتم‌های بازی از config.js (در اولین اجرا هم انجام می‌شود) ───
-- game_items و محصولات VIP به‌صورت خودکار در اولین باز شدن فروشگاه seed می‌شوند.
