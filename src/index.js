// ═══════════ zar-bot on Cloudflare Workers — نقطه ورود ═══════════
// - POST /webhook/<secret>  → آپدیت‌های تلگرام
// - GET/POST /*             → مینی‌اپ و پنل مدیریت
// - Cron (hourly)           → پرداخت ساعتی درآمد + پاکسازی صف‌های منقضی
import * as C from './config.js';
import * as db from './db.js';
import * as U from './utils.js';
import { handleUpdate } from './bot.js';
import { handleApi } from './webapp.js';

export default {
  async fetch(request, env, ctx) {
    C.loadEnv(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── Webhook تلگرام ───
    if (request.method === 'POST' && path.startsWith('/webhook/')) {
      const secret = path.split('/')[2] || '';
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch (_) { return new Response('Bad Request', { status: 400 }); }
      // پردازش async — بلافاصله 200 برمی‌گردانیم تا تلگرام retry نکند
      ctx.waitUntil(handleUpdate(env, ctx, update).catch(e => console.error('update error', e)));
      return new Response('OK');
    }

    // ─── ست کردن webhook (فقط یک‌بار بعد از دیپلوی) ───
    if (request.method === 'GET' && path === '/setup') {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.WEBAPP_URL) {
        return new Response('BOT_TOKEN / WEBHOOK_SECRET / WEBAPP_URL تنظیم نشده', { status: 500 });
      }
      const hookUrl = `${env.WEBAPP_URL}/webhook/${env.WEBHOOK_SECRET}`;
      const r = await U.tg(env.BOT_TOKEN, 'setWebhook', {
        url: hookUrl,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member'],
        drop_pending_updates: false,
      });
      return new Response(JSON.stringify({ ok: true, webhook: hookUrl, result: r }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─── مینی‌اپ و پنل ───
    return handleApi(request, env, ctx, path);
  },

  // ─── Cron Trigger: هر ساعت — پرداخت درآمد + پاکسازی صف‌ها ───
  async scheduled(event, env, ctx) {
    C.loadEnv(env);
    const d = env.DB;
    const kv = env.STATE;
    ctx.waitUntil((async () => {
      try {
        const paid = await db.hourlyPayout(d);
        console.log(`hourly payout: ${paid} users paid`);
      } catch (e) {
        console.error('hourly payout error', e);
      }
      // پاکسازی صف‌های منقضی + برگرداندن پول
      try {
        const list = await kv.list({ prefix: 'waiting:' });
        const now = Date.now() / 1000;
        for (const k of list.keys) {
          const w = await U.kvJson(kv, k.name, null);
          if (w && now - w.joined_at >= C.MATCH_TIMEOUT + 15) {
            await kv.delete(k.name);
            await kv.delete(`queue:${w.game}:${w.bet}`);
            await db.addBalance(d, Number(k.name.split(':')[1]), w.bet);
          }
        }
      } catch (e) {
        console.error('queue sweep error', e);
      }
      // پاکسازی بازی‌های تمام‌شده قدیمی (TTL خودکار KV انجام می‌دهد — فقط user_game‌های یتیم)
      try {
        const list = await kv.list({ prefix: 'user_game:' });
        for (const k of list.keys) {
          const gid = await kv.get(k.name);
          if (!gid) { await kv.delete(k.name); continue; }
          const g = await U.kvJson(kv, `game:${gid}`, null);
          if (!g || g.finished) await kv.delete(k.name);
        }
      } catch (e) {
        console.error('game sweep error', e);
      }
    })());
  },
};
