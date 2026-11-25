// قالب‌های HTML مینی‌اپ و پنل ادمین
// Wrangler (esbuild) import *.html را به‌صورت text module پشتیبانی می‌کند.
// برای اجرای تست در Node (بدون باندلر)، از dynamic import با fallback استفاده می‌کنیم.
let miniappHtml = '';
let adminHtml = '';

try {
  // در Wrangler — ایمپورت استاتیک text module
  const m = await import('../templates/miniapp.html', { with: { type: 'text' } });
  miniappHtml = m.default;
} catch (_) {
  // در Node (تست) — خواندن مستقیم فایل با fs (فقط برای تست محلی)
  try {
    const { readFileSync } = await import('node:fs');
    miniappHtml = readFileSync(new URL('../templates/miniapp.html', import.meta.url), 'utf-8');
  } catch (_) { /* در وورکر fs وجود ندارد — خالی می‌ماند */ }
}

try {
  const m = await import('../templates/admin.html', { with: { type: 'text' } });
  adminHtml = m.default;
} catch (_) {
  try {
    const { readFileSync } = await import('node:fs');
    adminHtml = readFileSync(new URL('../templates/admin.html', import.meta.url), 'utf-8');
  } catch (_) { /* ignore */ }
}

export const ASSETS = {
  'miniapp.html': miniappHtml,
  'admin.html': adminHtml,
};
