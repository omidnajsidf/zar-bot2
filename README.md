# 🤖 ربات زرکوین (بات زر) — نسخه Cloudflare Workers

ربات بازی فان تلگرامی با کوین «زرکوین» — بازنویسی کامل پروژه [zar-bot](https://github.com/omid-najafi/zar-bot) برای اجرای **سرورلس و رایگان** روی **Cloudflare Workers**.

> **مهاجرت کامل از Python/Railway به JavaScript/Cloudflare:**
> - **Webhook** جای long-polling (ورکرها اتصال دائمی ندارند)
> - **Cloudflare D1** (SQLite) جای MySQL
> - **Cloudflare KV** جای Redis و حافظه درون‌پروسه (صف مچ‌میکینگ + state بازی‌های دونفره از ری‌استارت جان سالم می‌برند)
> - **Cron Trigger** جای job-queue برای پرداخت ساعتی درآمد
>
> ✅ تمام امکانات نسخه اصلی حفظ شده: بانک، ملک، کارگر، ماموریت، کاباره، کازینو (۱۶ بازی)، بازار سیاه و شلیک، انبار ۱۰ لولی، VIP، فروشگاه (استارز + کارت به کارت)، کد هدیه، پنل مدیریت کامل.

---

## 📋 فهرست

- [امکانات](#-امکانات)
- [معماری](#-معماری)
- [پیش‌نیازها](#-پیش‌نیازها)
- [مراحل دیپلوی (قدم‌به‌قدم)](#-مراحل-دیپلوی-قدم-به-قدم)
- [مهاجرت کاربران و داده‌ها از نسخه قبلی](#-مهاجرت-کاربران-و-دادهها-از-نسخه-قبلی)
- [متغیرهای محیطی](#-متغیرهای-محیطی)
- [ساختار پروژه](#-ساختار-پروژه)
- [تست‌ها](#-تستها)
- [مدیریت پس از دیپلوی](#-مدیریت-پس-از-دیپلوی)
- [تفاوت‌های مهم با نسخه Python](#-تفاوتهای-مهم-با-نسخه-python)
- [سوالات متداول](#-سوالات-متداول)

---

## 🎮 امکانات

### 💰 اقتصادی
- 🏦 **بانک** با سود ۲٪ روزانه (پرداخت ساعتی خودکار با Cron) — VIP: ۵٪
- 🏠 **۱۴ نوع ملک** و 👷 **۱۲ نوع کارگر** (حداکثر ۵ از هر نوع)
- 💸 برداشت دستی درآمد انباشته + پرداخت خودکار هر ساعت
- 💸 انتقال زرکوین با شماره کارت (کارمزد ۱٪ بالای ۱M)
- 🎭 کاباره زر با ۵ شخصیت (نیاز به لول ۴+)

### 🎰 کازینو مینی‌اپ (Telegram WebApp)
- **۸ بازی تک‌نفره:** چرخ شانس، موشک (کرش)، مین‌یاب، بالا پایین، رولت، کارت شانس، پنالتی، شیر یا خط
- **۸ بازی دونفره آنلاین با مچ‌میکینگ:** پوکر تگزاس هولدم، حکم، بلک‌جک، کوییز (۱۹۰+ سوال)، چهار در یک ردیف، سنگ کاغذ قیچی، دوز، اتللو
- کارمزد ۵٪ برنده دونفره | تایم‌اوت نوبت ۴۵ ثانیه | تایم‌اوت مچ ۶۰ ثانیه (با برگشت خودکار پول)

### 💀 بازار سیاه و حمله
- ۵ وسیله شلیک، ۸ نوع مهمات، ۲ سیستم دفاعی
- شلیک با ریپلای روی پیام هدف + دستور شلیک
- تخریب درصدی از پول **و ملک/کارگر** هدف + سیستم دفاع احتمالاتی
- انبار ۱۰ لولی (ظرفیت مهمات) + خنک شدن ۱ ساعته هر وسیله

### 🎯 سایر
- ماموریت‌های روزانه (۴۵ قالب، ۶ ماموریت در روز با فیلتر هوشمند)
- سیستم لول (2^level × 1000 XP) و XP از بازی/ماموریت
- لیدربورد ثروت، راهنمای ۶ صفحه‌ای، جوین اجباری کانال/گروه
- 🎁 کد هدیه + 💎 فروشگاه (پرداخت با ⭐ استارز تلگرام یا 💳 کارت به کارت با تأیید رسید)
- 👑 اشتراک VIP (سقف لانچر ۶، +۵ ظرفیت انبار، +۱۰٪ سود دارایی، بانک ۵٪)
- 🛠 پنل مدیریت تحت وب کامل (کاربران، پول/XP/ملک، بن، VIP، فروشگاه، کنترل بازی‌ها، دیزاین، …)

---

## 🏗 معماری

```
┌─────────────┐     webhook      ┌──────────────────────────────┐
│  Telegram    │ ───────────────▶ │   Cloudflare Worker           │
│  (Bot API)   │ ◀─────────────── │   src/index.js                │
└─────────────┘   sendMessage    │                               │
                                 │  ├── bot.js     → ربات تلگرام  │
┌─────────────┐     HTTPS        │  ├── webapp.js  → مینی‌اپ API  │
│  مینی‌اپ /    │ ───────────────▶ │  │    + پنل ادمین             │
│  پنل ادمین   │ ◀─────────────── │  ├── games.js   → منطق بازی‌ها│
└─────────────┘   JSON API       │  ├── db.js      → لایه D1     │
                                 │  ├── utils.js   → ابزار/تلگرام │
      Cron (هر ساعت) ──────────▶  │  └── config.js  → تنظیمات     │
      پرداخت درآمد + پاکسازی      └──────┬───────────────┬───────┘
                                            │               │
                                     ┌──────▼─────┐  ┌─────▼──────┐
                                     │ D1 (SQLite) │  │ KV         │
                                     │ کاربران/پول │  │ صف/بازی‌ها/ │
                                     │ دارایی/فروش │  │ state منوها │
                                     └────────────┘  └────────────┘
```

| نیاز | نسخه Python | نسخه Workers |
|------|-------------|--------------|
| اجرای ربات | long-polling (پروسه دائمی) | **Webhook** (سرورلس) |
| دیتابیس | MySQL (Railway/VPS) | **D1** (SQLite رایگان) |
| صف مچ‌میکینگ / state بازی | Redis + حافظه | **KV** (پایدار، با TTL) |
| پرداخت ساعتی | job-queue | **Cron Trigger** |
| مینی‌اپ و پنل | aiohttp سرور داخلی | همان Worker (روت‌های `/` و `/admin`) |
| هزینه | Railway/VPS ماهانه | **رایگان** (سقف پلن Free بالا) |

---

## 🧰 پیش‌نیازها

1. اکانت [Cloudflare](https://dash.cloudflare.com/sign-up) (پلن رایگان کافی است)
2. Node.js نسخه ۱۸ به بالا
3. توکن ربات از [@BotFather](https://t.me/BotFather)
4. آیدی عددی خودتان از [@userinfobot](https://t.me/userinfobot)
5. (اختیاری — برای مینی‌اپ) ثبت Web App در BotFather با `/newapp`

---

## 🚀 مراحل دیپلوی (قدم‌به‌قدم)

### ۱. آماده‌سازی پروژه

```bash
# کلون یا آپلود پروژه
git clone <repo-address> zar-bot-workers
cd zar-bot-workers

# نصب wrangler
npm install
```

### ۲. ورود به Cloudflare

```bash
npx wrangler login
```
مرورگر باز می‌شود و لاگین می‌کنید.

### ۳. ساخت D1 دیتابیس

```bash
npx wrangler d1 create zar-bot
```
خروجی شامل `database_id` است — آن را در `wrangler.toml` جای‌گذاری کنید:

```toml
[[d1_databases]]
binding = "DB"
database_name = "zar-bot"
database_id = "اینجا-آیدی-را-بگذارید"   # ← از خروجی دستور بالا
```

### ۴. ساخت KV namespace

```bash
npx wrangler kv namespace create ZAR_STATE
```
خروجی شامل `id` است — در `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "اینجا-آیدی-kv-را-بگذارید"        # ← از خروجی دستور بالا
```

### ۵. ساخت جداول دیتابیس

```bash
npm run db:init
# معادل: wrangler d1 execute zar-bot --remote --file=migrations/0001_init.sql
```

### ۶. تنظیم متغیرهای محیطی (Secrets)

```bash
# توکن ربات (اجباری)
npx wrangler secret put BOT_TOKEN

# آیدی عددی مالک (اجباری)
npx wrangler secret put OWNER_ID

# رمز پنل مدیریت (اجباری — قوی انتخاب کنید)
npx wrangler secret put ADMIN_PASSWORD

# رمز مسیر webhook (اجباری — یک رشته تصادفی طولانی بسازید)
# مثال: openssl rand -hex 24
npx wrangler secret put WEBHOOK_SECRET
```

متغیرهای اختیاری (با `--config` یا در پنل Workers → Settings → Variables):
```bash
npx wrangler secret put WEBAPP_URL          # بعد از دیپلوی پر می‌شود (گام ۸)
npx wrangler secret put WEBAPP_DEEP_LINK    # https://t.me/<bot>/<app> از BotFather
npx wrangler secret put START_BALANCE       # هدیه شروع کاربران جدید
npx wrangler secret put SHOP_ADMIN_IDS      # ادمین‌های اضافه: 111,222
npx wrangler secret put MEMBERSHIP_REQUIRED # true برای فعال‌سازی جوین اجباری
npx wrangler secret put REQUIRED_CHANNELS_JSON
npx wrangler secret put REQUIRED_GROUP_JSON
```

### ۷. دیپلوی

```bash
npm run deploy
# یا: npx wrangler deploy
```
آدرس وورکر را از خروجی بردارید، مثل:
`https://zar-bot.<your-name>.workers.dev`

### ۸. اتصال Webhook و تنظیم URL

```bash
# WEBAPP_URL را روی آدرس وورکر ست کنید
npx wrangler secret put WEBAPP_URL
# مقدار: https://zar-bot.<your-name>.workers.dev

# دیپلوی دوباره (بعد از تغییر secret لازم نیست، ولی برای اطمینان)
npx wrangler deploy
```

سپس در مرورگر باز کنید (webhook ست می‌شود):
```
https://zar-bot.<your-name>.workers.dev/setup
```
پاسخ باید شبیه این باشد:
```json
{ "ok": true, "webhook": "https://zar-bot.xxx.workers.dev/webhook/<secret>", "result": {...} }
```

### ۹. راه‌اندازی مینی‌اپ (اختیاری ولی توصیه‌شده)

1. در [@BotFather](https://t.me/BotFather) دستور `/newapp` را بزنید، ربات را انتخاب کنید و یک نام (مثل `Zar1`) بدهید.
2. BotFather آدرس وب‌اپ می‌خواهد — بدهید: `https://zar-bot.<your-name>.workers.dev/`
3. لینک کوتاهی مثل `https://t.me/YourBot/Zar1` می‌گیرید:
```bash
npx wrangler secret put WEBAPP_DEEP_LINK
# مقدار: https://t.me/YourBot/Zar1
npx wrangler deploy
```
> با این کار دکمه «🎰 کازینو» در گروه‌ها هم کار می‌کند (لینک عمیق). اگر تنظیم نکنید، دکمه فقط در پیوی با web_app کار می‌کند.

### ۱۰. تست نهایی

- در تلگرام به ربات `/start` بدهید → منوی اصلی باید بیاید
- دستور `زر` → زرکوین رایگان
- دکمه «🎰 کازینو» → مینی‌اپ باز شود
- پنل مدیریت: `https://zar-bot.<your-name>.workers.dev/admin` (یوزرنیم: `admin`، رمز: مقدار `ADMIN_PASSWORD`)

### 🔄 آپدیت نسخه‌های بعدی

```bash
git pull
npm run deploy
```
دیتابیس و KV دست‌نخورده می‌مانند. برای تغییرات اسکیما، فایل migration جدید بسازید:
```bash
npx wrangler d1 execute zar-bot --remote --file=migrations/0002_your_change.sql
```

---

## 🔄 مهاجرت کاربران و داده‌ها از نسخه قبلی

اگر ربات را قبلاً روی Railway/VPS با MySQL اجرا می‌کردید، همه کاربران (موجودی، بانک، XP، ملک، کارگر، انبار، VIP، بن‌ها، کدهای هدیه، سفارش‌ها) را با یک اسکریپت منتقل کنید:

### روش ۱ — با pymysql (توصیه‌شده)

```bash
pip install pymysql

python scripts/migrate_mysql_to_d1.py \
  --host <mysql-host> \
  --port 3306 \
  --user <mysql-user> \
  --password <mysql-pass> \
  --database zarbot \
  --out zar-bot-d1.sqlite
```

### روش ۲ — با mysql client

```bash
python scripts/migrate_mysql_to_d1.py --use-cli \
  --host <mysql-host> --user <user> --password <pass> \
  --database zarbot --out zar-bot-d1.sqlite
```

### ایمپورت در D1

```bash
npx wrangler d1 import zar-bot --remote --file=zar-bot-d1.sqlite
```

> ⚠️ **نکته‌ها:**
> - اسکریپت ساختار جداول را از `migrations/0001_init.sql` می‌سازد؛ نیازی به اجرای جداگانه گام ۵ نیست.
> - اگر `wrangler d1 import` در دسترس نبود: `sqlite3 zar-bot-d1.sqlite .dump > data.sql` سپس `npx wrangler d1 execute zar-bot --remote --file=data.sql`
> - اطلاعات اتصال Railway MySQL: در پنل Railway → سرویس MySQL → تب Variables.
> - **ترتیب توصیه‌شده:** اول ربات جدید را دیپلوی کنید، دیتا را import کنید، تست کنید همه چیز سالم است، بعد ربات قدیمی را خاموش کنید (که آپدیت‌های همزمان ننویسند).

### بدون مهاجرت (شروع از صفر)

گام ۵ را اجرا کنید و تمام — ربات با دیتابیس خالی شروع می‌شود.

---

## ⚙️ متغیرهای محیطی

| متغیر | اجباری | توضیح |
|-------|--------|-------|
| `BOT_TOKEN` | ✅ | توکن ربات از BotFather |
| `OWNER_ID` | ✅ | آیدی عددی مالک (ادمین کل) |
| `ADMIN_PASSWORD` | ✅ | رمز پنل مدیریت (`/admin`) |
| `WEBHOOK_SECRET` | ✅ | رمز مسیر `/webhook/<secret>` — رشته تصادفی طولانی |
| `WEBAPP_URL` | ✅ | آدرس عمومی وورکر (بعد از اولین دیپلوی) |
| `WEBAPP_DEEP_LINK` | ➖ | لینک کوتاه مینی‌اپ مثل `https://t.me/Bot/Zar1` |
| `START_BALANCE` | ➖ | موجودی هدیه کاربران جدید (پیش‌فرض ۰) |
| `SHOP_ADMIN_IDS` | ➖ | ادمین‌های اضافه (رسید فروشگاه) — با کاما: `111,222` |
| `MEMBERSHIP_REQUIRED` | ➖ | `true` = جوین اجباری فعال |
| `REQUIRED_CHANNELS_JSON` | ➖ | کانال‌های جوین اجباری — JSON |
| `REQUIRED_GROUP_JSON` | ➖ | گروه جوین اجباری — JSON |

**فرمت JSON جوین اجباری:**
```json
// REQUIRED_CHANNELS_JSON
[
  {"name": "کانال ربات زر", "id": "@zarbotchanel", "url": "https://t.me/zarbotchanel"}
]

// REQUIRED_GROUP_JSON
{"name": "گروه پشتیبانی زر", "id": -1004403374673, "url": "https://t.me/+PZ6RRCYv5TtjMjRk"}
```
> 💡 روی پلن رایگان Cloudflare، متغیرهای متنی را می‌توانید به‌جای secret از پنل (Workers → Settings → Variables) به‌صورت Plain text ست کنید تا بدون دیپلوی قابل تغییر باشند. `BOT_TOKEN` و `ADMIN_PASSWORD` حتماً secret بمانند.

---

## 📁 ساختار پروژه

```
zar-bot-workers/
├── src/
│   ├── index.js        # نقطه ورود: روتینگ webhook/API/cron + ست کردن webhook
│   ├── bot.js          # ربات تلگرام: همه منوها، بانک، ملک/کارگر، کاباره،
│   │                   #   بازار سیاه، حمله، فروشگاه، راهنما، انتقال
│   ├── webapp.js       # API مینی‌اپ (مچ‌میکینگ KV + بازی‌های دونفره) + پنل ادمین
│   ├── games.js        # منطق خالص ۱۶ بازی (پورت دقیق games/*.py)
│   ├── db.js           # لایه دیتابیس D1 — کاربران، دارایی، درآمد، XP،
│   │                   #   ماموریت، کد هدیه، grant/revoke
│   ├── utils.js        # تلگرام API، فرمت فارسی، لول، initData، توکن مرورگر، KV
│   ├── config.js       # همه تنظیمات بازی (ملک/کارگر/بازار سیاه/ماموریت/VIP)
│   └── assets.js       # قالب‌های HTML (import ماژول)
├── templates/
│   ├── miniapp.html    # فرانت‌اند مینی‌اپ (بدون تغییر از نسخه اصلی)
│   └── admin.html      # فرانت‌اند پنل مدیریت (بدون تغییر)
├── migrations/
│   └── 0001_init.sql   # اسکیمای کامل D1 (۱۵ جدول)
├── scripts/
│   ├── migrate_mysql_to_d1.py  # مهاجرت دیتای MySQL → D1
│   ├── test_logic.mjs          # تست منطق بازی‌ها و ابزارها (۷۳ تست)
│   ├── test_sql.mjs            # تست لایه دیتابیس روی SQLite واقعی (۶۶ تست)
│   └── test_e2e.mjs            # تست شبیه‌سازی کامل وورکر (۶۲ تست)
├── wrangler.toml       # تنظیمات وورکر (D1 + KV + Cron)
├── package.json
└── README.md
```

---

## 🧪 تست‌ها

سه مجموعه تست نوشته شده که کل سیستم را پوشش می‌دهد (**۲۰۱ تست، همه پاس**):

```bash
# ۱. منطق بازی‌ها و ابزارها (پوکر/حکم/بلک‌جک/دوز/اتللو/کوییز/مین‌یاب/...)
node scripts/test_logic.mjs

# ۲. لایه دیتابیس روی SQLite واقعی (همان موتور D1)
node scripts/test_sql.mjs

# ۳. شبیه‌سازی کامل وورکر: webhook تلگرام + API مینی‌اپ + پنل ادمین + cron
node scripts/test_e2e.mjs
```

تست E2E شامل: منوی اصلی، بانک و قفل ۵ ساعته، خرید ملک، دستور زر و کول‌داون، مالکیت منو، انتقال، بازار سیاه و انبار، راهنما، کاباره، کد هدیه، مچ‌میکینگ دو کاربر، یک بازی کامل ttt تا پایان با پرداخت، ترک بازی، شرط‌بندی‌های تک‌نفره، امنیت (نشتی نداشتن مین‌ها، رد توکن غلط، ۴۰۳ وب‌هوک)، و همه APIهای پنل ادمین.

---

## 🛠 مدیریت پس از دیپلوی

### پنل مدیریت
- آدرس: `https://<worker>/admin`
- ورود: یوزرنیم `admin` + رمز `ADMIN_PASSWORD`
- امکانات: جستجوی کاربر، کم/زیاد کردن پول/بانک/XP/لول/ملک/کارگر/آیتم، بن/رفع بن، VIP، ساخت کد هدیه، مدیریت فروشگاه و سفارش‌ها و رسیدها، تنظیم شماره کارت پرداخت، روشن/خاموش کردن کل ربات یا هر بازی/بخش، ویرایش متن دکمه‌ها و رنگ‌ها، ویرایش قیمت/درآمد آیتم‌ها و تنظیمات بازی (حد شرط/سود بانک/پایه انبار)

### لاگ زنده
```bash
npm run tail
# یا: npx wrangler tail
```

### کوئری مستقیم دیتابیس
```bash
# مشاهده کاربران
npx wrangler d1 execute zar-bot --remote --command "SELECT user_id, first_name, balance, bank_balance FROM users LIMIT 20"

# تغییر موجودی کاربر
npx wrangler d1 execute zar-bot --remote --command "UPDATE users SET balance = 1000000 WHERE user_id = 123456789"

# بکاپ کامل (خروجی SQL)
npx wrangler d1 export zar-bot --remote --output=backup.sql
```

### دستورات ربات (در گروه/پیوی)
| دستور | کار |
|-------|-----|
| `/start` یا `/menu` یا `زربات` | منوی اصلی |
| `زر` | زرکوین رایگان (هر ۵ دقیقه) |
| `زر بازی` یا `کازینو زربات` | ورود به کازینو |
| `هدیه زر کد` | فعال‌سازی کد هدیه |
| `شلیک موشک کروز` و… | حمله (با ریپلای روی پیام هدف) |
| `انتقال زرکوین N` (ریپلای) | هدیه مالک (فقط OWNER_ID) |

---

## 🔀 تفاوت‌های مهم با نسخه Python

| موضوع | نسخه Python | نسخه Workers |
|-------|-------------|--------------|
| اجرا | `python bot.py` (پروسه دائمی) | Webhook سرورلس — همیشه آنلاین، بدون مدیریت سرور |
| **اتصال دیتابیس** | pool دائمی aiomysql | هر request اتصال D1 (بدون هدربرای — مدیریت خودکار) |
| **قفل‌های همزمانی** | `asyncio.Lock` + `SELECT ... FOR UPDATE` | کوئری‌های اتمیک `UPDATE ... WHERE balance >= ?` (بدون قفل دوفاز) |
| **state بازی‌های دونفره** | حافظه پروسه + Redis | KV با TTL (هر اکشن یک read-modify-write) |
| پرداخت درآمد | job-queue هر ساعت + روزانه ۰۰:۰۰ | Cron Trigger هر ساعت (درآمد از `last_payout` هر کاربر محاسبه می‌شود — دقیق‌تر از هر دو) |
| مالکیت منوها | TTLCache در حافظه | KV با TTL ۲۴ ساعت |
| تنظیمات کانال‌های جوین | `config.py` (نیاز به ری‌دیلوی) | متغیر محیطی JSON — قابل تغییر بدون دیپلوی |
| قفل بانک/VIP | کش حافظه + دیتابیس | مستقیم دیتابیس (bank_locks / vip_users) |

### محدودیت‌های شناخته‌شده در پلن رایگان
- **D1:** ۵ گیگابایت storage و ۵ میلیون خواندن ردیف در روز — برای ربات‌های تا ده‌ها هزار کاربر کافی است
- **KV:** ۱۰۰ هزار خواندن در روز — مینی‌اپ polling هر ۱.۲ ثانیه دارد؛ با کاربران خیلی زیاد همزمان ممکن است به پلن پولی ($5/mo Workers Paid) نیاز شود
- **CPU:** ۱۰ms در هر request (پلن Free) — محاسبات این ربات سبک است و مشکلی ایجاد نمی‌کند
- بازی‌های دونفره با polling کار می‌کنند (مثل نسخه اصلی)؛ اگر روزی WebSockets/Durable Objects خواستید، ساختار KV آماده ارتقا به DO است

---

## ❓ سوالات متداول

### ربات جواب نمی‌دهد
1. `npx wrangler tail` را باز کنید و در تلگرام `/start` بدهید — خطا را می‌بینید
2. `/setup` را دوباره باز کنید تا webhook ست شود (اگر `WEBAPP_URL` را عوض کرده‌اید)
3. متغیرها را چک کنید: `npx wrangler secret list`

### مینی‌اپ باز نمی‌شود
- `WEBAPP_URL` باید دقیقاً آدرس وورکر با `https://` باشد
- برای گروه‌ها: `WEBAPP_DEEP_LINK` را از BotFather (`/newapp`) بگیرید و ست کنید
- تست: `https://<worker>/` باید صفحه قمارخانه را نشان دهد

### «ردیف‌های خواندن D1 تمام شد» (با ترافیک بالا)
- پنل Cloudflare → Workers & Pages → zar-bot → Settings → Plans → Workers Paid ($5/ماه)

### چطور سود بانک یا قیمت‌ها را تغییر دهم؟
از پنل ادمین → تب «تنظیمات بازی» (بدون دیپلوی) یا ویرایش `src/config.js` + `npm run deploy`

### کد هدیه چطور بسازم؟
پنل ادمین → تب «کد هدیه» → ساخت کد (پول/بانک/XP/لول/VIP/ملک/کارگر/آیتم) → کاربران با `هدیه زر کد` فعال می‌کنند

### پول کاربران بعد از مهاجرت درست است؟
بله — اسکریپت مهاجرت همه جداول را ۱:۱ منتقل می‌کند. بعد از import چند کاربر را در پنل ادمین چک کنید.

---

## 📄 لایسنس

این پروژه بر پایه [zar-bot](https://github.com/omid-najafi/zar-bot) بازنویسی شده است.

---

## 🤖 ساخته‌شده با هوش مصنوعی

نسخه Cloudflare Workers این پروژه نیز به‌طور کامل با کمک هوش مصنوعی port و تست شده است. 🤖
