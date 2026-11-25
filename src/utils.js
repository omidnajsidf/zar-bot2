// ═══════════ ابزارهای مشترک — تلگرام API، فرمت، احراز هویت، KV ═══════════
import * as C from './config.js';

export const TG_API = 'https://api.telegram.org/bot';

// ─── فرمت اعداد و ارقام فارسی ───
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function faToEn(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)));
}
export function fmt(n) { return Math.floor(Number(n) || 0).toLocaleString('en-US'); }
export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function parseAmount(text) {
  const cleaned = faToEn(text).replace(/,/g, '').replace(/،/g, '').replace(/_/g, '').trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const v = parseInt(cleaned, 10);
  return v > 0 ? v : null;
}
export function toInt(v, def = null) {
  if (typeof v === 'boolean') return def;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : def;
  if (typeof v === 'string') {
    const s = faToEn(v).replace(/[,،_]/g, '').trim();
    if (/^-?\d{1,16}$/.test(s)) return parseInt(s, 10);
  }
  return def;
}

// ─── زمان تهران ───
export function nowTehranIso() {
  // ISO با آفست تهران (+03:30) — مثل datetime.now(TEHRAN).isoformat() در پایتون
  const now = new Date();
  const tehran = new Date(now.getTime() + (3.5 * 3600 * 1000));
  const iso = tehran.toISOString();
  return iso.replace('Z', '').replace('T', ' ').slice(0, 19) + '+03:30';
}
export function todayStr() {
  const tehran = new Date(Date.now() + 3.5 * 3600 * 1000);
  return tehran.toISOString().slice(0, 10);
}
export function isoElapsed(iso) {
  if (!iso) return null;
  // پایتون isoformat ممکن است +03:30 داشته باشد — به ISO استاندارد تبدیل کن
  let s = String(iso).replace(' ', 'T');
  if (/([+-]\d{2}:\d{2})$/.test(s)) {
    const m = s.match(/([+-])(\d{2}):(\d{2})$/);
    const sign = m[1] === '-' ? '-' : '+';
    s = s.replace(/([+-]\d{2}:\d{2})$/, sign + m[2] + m[3]);
  } else if (!/Z$/.test(s)) {
    s += '+03:30';
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : (Date.now() - d.getTime()) / 1000;
}

// ─── لول ───
export function calcLevel(totalXp) {
  let level = 1, cum = 0;
  totalXp = Number(totalXp) || 0;
  while (true) {
    const cost = Math.pow(2, level) * 1000;
    if (totalXp >= cum + cost) { cum += cost; level += 1; } else break;
  }
  return [level, totalXp - cum, Math.pow(2, level) * 1000];
}
export function xpForLevel(level) {
  let sum = 0;
  for (let lv = 1; lv < Math.max(1, level); lv++) sum += Math.pow(2, lv) * 1000;
  return sum;
}
export function formatProgressBar(current, total, length = 10) {
  if (total <= 0) return '░'.repeat(length);
  const filled = Math.min(length, Math.floor(current * length / total));
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}

// ─── کارت ───
export function cardNumberFor(uid) { return '6037' + String(uid).padStart(12, '0').slice(-12); }
export function formatCard(card) {
  if (!card || card.length !== 16) return card || '-';
  return `${card.slice(0, 4)}-${card.slice(4, 8)}-${card.slice(8, 12)}-${card.slice(12, 16)}`;
}

// ─── تصادفی امن ───
export function randInt(min, max) { // [min, max]
  const a = Math.ceil(min), b = Math.floor(max);
  return a + Math.floor(Math.random() * (b - a + 1));
}
export function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function randomToken(len = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
export function randomId(len = 9) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=';
  let out = '';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

// ═══════════ Telegram Bot API ═══════════
export async function tg(token, method, params = {}) {
  const r = await fetch(TG_API + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || method + ' failed');
  return data.result;
}

export async function sendMessage(token, chatId, text, extra = {}) {
  try {
    return await tg(token, 'sendMessage', Object.assign({
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    }, extra));
  } catch (_) { return null; }
}
export async function answerCb(token, cbId, text, showAlert = false) {
  try {
    await tg(token, 'answerCallbackQuery', { callback_query_id: cbId, text: text || undefined, show_alert: !!showAlert });
  } catch (_) {}
}
export async function editMessage(token, chatId, messageId, text, replyMarkup = null) {
  try {
    return await tg(token, 'editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: replyMarkup || undefined,
    });
  } catch (e) {
    if (String(e.message || '').includes('message is not modified')) return 'not_modified';
    return null;
  }
}
export async function getChatMember(token, chatId, userId) {
  return await tg(token, 'getChatMember', { chat_id: chatId, user_id: userId });
}

// ─── مالکیت منو: در KV با کلید chat:message → owner_id ═══════════
// (در وورکر حافظه پایدار نداریم؛ پیام‌های منو مالک خودشان را در KV دارند)
export async function rememberOwner(kv, message, userId) {
  if (!message || !kv) return;
  await kv.put(`owner:${message.chat.id}:${message.message_id}`, String(userId), { expirationTtl: 86400 });
}
export async function addOwner(kv, message, userId) {
  if (!message || !kv) return;
  const key = `owner:${message.chat.id}:${message.message_id}`;
  const cur = await kv.get(key);
  if (!cur) { await kv.put(key, String(userId), { expirationTtl: 86400 }); return; }
  // چند مالک (بازی دونفره) — لیست با کاما
  if (!cur.split(',').includes(String(userId))) {
    await kv.put(key, cur + ',' + userId, { expirationTtl: 86400 });
  }
}
export async function isMenuOwner(kv, chatId, messageId, userId) {
  if (!kv) return true;
  const cur = await kv.get(`owner:${chatId}:${messageId}`);
  if (cur === null) return true; // پیام قدیمی بدون مالک → اجازه بده
  return cur.split(',').includes(String(userId));
}

// ═══════════ احراز هویت مینی‌اپ (Telegram initData) ═══════════
function hmacSha256(keyBytes, data) {
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then(k => crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function validateInitData(raw, botToken) {
  if (!raw || !botToken) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [...params.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secretKey = new Uint8Array(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(botToken)));
    const computed = hex(await hmacSha256(secretKey, pairs));
    if (computed !== hash) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (authDate && Date.now() / 1000 - authDate > 7 * 86400) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user && typeof user === 'object' ? user : null;
  } catch (_) {
    return null;
  }
}

// ─── توکن مرورگر (برای باز شدن مینی‌اپ خارج از تلگرام) ───
export async function makeBrowserToken(botToken, uid, ttl = 30 * 86400) {
  if (!botToken) return '';
  const payload = JSON.stringify({ uid: Number(uid), exp: Math.floor(Date.now() / 1000) + ttl });
  const sig = hex(await hmacSha256(new TextEncoder().encode(botToken), payload));
  return btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.' + sig;
}
export async function validateBrowserToken(token, botToken) {
  if (!token || !botToken || !token.includes('.')) return null;
  try {
    const [rawB64, sig] = token.split('.');
    const raw = atob(rawB64.replace(/-/g, '+').replace(/_/g, '/'));
    const expected = hex(await hmacSha256(new TextEncoder().encode(botToken), raw));
    if (expected !== sig) return null;
    const payload = JSON.parse(raw);
    if (payload.exp < Date.now() / 1000) return null;
    return Number(payload.uid) || null;
  } catch (_) {
    return null;
  }
}

// ═══════════ KV: state های مینی‌اپ ═══════════
// بازی‌های دونفره و سشن‌های تک‌نفره در KV نگه‌داری می‌شوند تا از بین isolates جان سالم ببرند.
export async function kvJson(kv, key, def = null) {
  const raw = await kv.get(key);
  if (raw === null) return def;
  try { return JSON.parse(raw); } catch (_) { return def; }
}
export async function kvPutJson(kv, key, value, ttlSeconds) {
  await kv.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
}

// ─── پاسخ JSON استاندارد API ───
export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }, extraHeaders),
  });
}
export function errJson(msg, status = 400, code = 'error', extra = {}) {
  return json(Object.assign({ ok: false, error: msg, code }, extra), status);
}

// ─── متن‌های کمکی ───
export function fmtRemaining(secs) {
  const s = Math.max(1, Math.floor(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h} ساعت و ${m} دقیقه`;
  if (h) return `${h} ساعت`;
  return `${Math.max(1, m)} دقیقه`;
}
