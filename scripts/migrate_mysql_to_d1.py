#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🔄 مهاجرت داده‌ها از MySQL (نسخه Railway/VPS) به Cloudflare D1

این اسکریپت:
1. از MySQL موجود (Railway یا VPS) dump می‌گیرد (mysqldump لازم نیست — از pymysql استفاده می‌کند)
2. داده‌ها را به فرمت SQLite/D1 تبدیل می‌کند
3. خروجی:zar-bot-d1.sqlite (قابل آپلود با wrangler d1 import یا execute)

استفاده:
  pip install pymysql
  python scripts/migrate_mysql_to_d1.py \
    --host <mysql-host> --port 3306 --user <user> --password <pass> --database zarbot \
    --out zar-bot-d1.sqlite

اگر pymysql ندارید و mysql CLI دارید، از --use-cli استفاده کنید (خروجی mysql --batch می‌خواند).

بعد از ساخت فایل sqlite:
  # روش ۱ — import مستقیم (سریع‌ترین):
  npx wrangler d1 import zar-bot --remote --file=zar-bot-d1.sqlite
  # روش ۲ — خروجی SQL:
  sqlite3 zar-bot-d1.sqlite .dump > data.sql
  npx wrangler d1 execute zar-bot --remote --file=data.sql
"""
import argparse
import json
import os
import sqlite3
import sys

try:
    import pymysql
except ImportError:
    pymysql = None

TABLES = [
    # (نام جدول, کلید اصلی)
    ("users", "user_id"),
    ("assets", "id"),
    ("user_missions", "id"),
    ("inventory", "id"),
    ("gift_codes", "code"),
    ("gift_redemptions", "id"),
    ("shop_products", "id"),
    ("shop_orders", "id"),
    ("zar_settings", "k"),
    ("banned_users", "user_id"),
    ("bot_admins", "user_id"),
    ("game_items", None),  # کلید مرکب
    ("vip_users", "user_id"),
    ("user_warehouse", "user_id"),
    ("bank_locks", "user_id"),
]

SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "..", "migrations", "0001_init.sql")


def fetch_mysql(args):
    """اتصال به MySQL و خواندن همه جداول"""
    if args.use_cli:
        return fetch_mysql_cli(args)
    if pymysql is None:
        print("❌ pymysql نصب نیست: pip install pymysql  (یا از --use-cli استفاده کنید)")
        sys.exit(1)
    conn = pymysql.connect(
        host=args.host, port=args.port, user=args.user,
        password=args.password, database=args.database, charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )
    data = {}
    with conn:
        with conn.cursor() as cur:
            for table, _ in TABLES:
                try:
                    cur.execute(f"SELECT * FROM `{table}`")
                    rows = cur.fetchall()
                    data[table] = rows
                    print(f"  ✅ {table}: {len(rows)} ردیف")
                except Exception as e:
                    print(f"  ⚠️ {table}: رد شد ({e})")
                    data[table] = []
    return data


def fetch_mysql_cli(args):
    """خواندن با mysql --batch (TSV)"""
    import csv
    import subprocess
    data = {}
    for table, _ in TABLES:
        cmd = [
            "mysql", f"-h{args.host}", f"-P{args.port}", f"-u{args.user}",
            f"-p{args.password}", args.database, "-e", f"SELECT * FROM `{table}`",
            "--batch", "--raw",
        ]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if out.returncode != 0:
                print(f"  ⚠️ {table}: رد شد ({out.stderr.strip()[:100]})")
                data[table] = []
                continue
            lines = out.stdout.strip().split("\n")
            if len(lines) < 2:
                data[table] = []
                continue
            reader = csv.DictReader(lines, delimiter="\t", quoting=csv.QUOTE_NONE)
            rows = list(reader)
            data[table] = rows
            print(f"  ✅ {table}: {len(rows)} ردیف")
        except FileNotFoundError:
            print("❌ mysql client نصب نیست. از pymysql استفاده کنید (بدون --use-cli)")
            sys.exit(1)
    return data


def norm_value(v):
    """تبدیل مقادیر MySQL به SQLite"""
    if v is None:
        return None
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace")
    return v


def build_sqlite(data, out_path):
    """ساخت فایل SQLite از داده‌های MySQL"""
    schema_path = os.path.abspath(SCHEMA_FILE)
    if os.path.exists(out_path):
        os.remove(out_path)
    lite = sqlite3.connect(out_path)
    lite.execute("PRAGMA journal_mode=OFF")
    lite.execute("PRAGMA synchronous=OFF")
    with open(schema_path, encoding="utf-8") as f:
        lite.executescript(f.read())
    lite.commit()

    for table, pk in TABLES:
        rows = data.get(table, [])
        if not rows:
            continue
        cols = list(rows[0].keys())
        # نام ستون‌ها ممکن است در batch mode با TSV فرق کند — یکسان‌سازی
        ph = ",".join(["?"] * len(cols))
        col_sql = ",".join(f"`{c}`" for c in cols)
        sql = f"INSERT OR REPLACE INTO `{table}` ({col_sql}) VALUES ({ph})"
        batch = []
        for r in rows:
            batch.append(tuple(norm_value(r.get(c)) for c in cols))
        lite.executemany(sql, batch)
        print(f"  ✅ {table}: {len(rows)} ردیف درج شد")
    lite.commit()
    lite.close()
    print(f"\n🎉 فایل آماده شد: {out_path}")
    print("برای ایمپورت در D1:")
    print(f"  npx wrangler d1 import zar-bot --remote --file={out_path}")


def main():
    ap = argparse.ArgumentParser(description="مهاجرت MySQL → Cloudflare D1")
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=3306)
    ap.add_argument("--user", default="root")
    ap.add_argument("--password", default="")
    ap.add_argument("--database", default="zarbot")
    ap.add_argument("--out", default="zar-bot-d1.sqlite")
    ap.add_argument("--use-cli", action="store_true", help="استفاده از mysql client به جای pymysql")
    args = ap.parse_args()

    print("📥 خواندن از MySQL...")
    data = fetch_mysql(args)
    print("\n📦 ساخت SQLite...")
    build_sqlite(data, args.out)


if __name__ == "__main__":
    main()
