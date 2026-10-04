import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { fal } from '@fal-ai/client';
import { pool } from './db.js';
import { refreshCatalog } from './wbParser.js';

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const FRONT_URL = process.env.FRONT_URL || 'https://gf-front.vercel.app';
fal.config({ credentials: process.env.FAL_KEY });

const MODEL_COSTS = { 'image-apps-v2': 0.04, 'fashn-v1.6': 0.075, 'fashn-v1.5': 0.039 };
const STAR_TO_USD = 0.013; // ~1 звезда = $0.013

const SUBSCRIPTIONS = {
  sub_pro:    { title: 'Подписка PRО',    stars: 599, tries: 50, own: 20 },
  sub_medium: { title: 'Подписка MEDIUM', stars: 299, tries: 30, own: 10 },
  sub_start:  { title: 'Подписка START',  stars: 65,  tries: 10, own: 0  },
};

// ============================================================
// INIT
// ============================================================
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS error_log (id SERIAL PRIMARY KEY, source TEXT NOT NULL, message TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);`);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('maintenance', 'false') ON CONFLICT (key) DO NOTHING;`);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('maintenance_text', 'Ведутся технические работы. Заходите чуть позже ✨') ON CONFLICT (key) DO NOTHING;`);
    await pool.query(`CREATE TABLE IF NOT EXISTS generations (id SERIAL PRIMARY KEY, tg_id BIGINT, model TEXT, cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0, success BOOLEAN NOT NULL DEFAULT TRUE, item_id BIGINT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE INDEX IF NOT EXISTS generations_time_idx ON generations (created_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS generations_user_idx ON generations (tg_id, created_at DESC);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_notes (id SERIAL PRIMARY KEY, tg_id BIGINT NOT NULL, note TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;`);
    console.log('[init] ok');
  } catch (e) { console.error('[init]', e.message); }
})();

async function logError(source, message, detail = null) {
  console.error(`[ERROR][${source}] ${message}`, detail || '');
  try {
    await pool.query(`INSERT INTO error_log (source, message, detail) VALUES ($1, $2, $3)`,
      [source, String(message || '').slice(0, 500), detail ? String(detail).slice(0, 2000) : null]);
  } catch {}
}
async function logGeneration(tgId, model, success, itemId = null) {
  try {
    const cost = success ? (MODEL_COSTS[model] || 0) : 0;
    await pool.query(`INSERT INTO generations (tg_id, model, cost_usd, success, item_id) VALUES ($1,$2,$3,$4,$5)`,
      [tgId, model || 'unknown', cost, success, itemId]);
  } catch (e) { console.error('[logGen]', e.message); }
}

// ============================================================
// HELPERS
// ============================================================
function verifyTelegramInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash'); p.delete('hash');
    const str = [...p.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const ok = crypto.createHmac('sha256', key).update(str).digest('hex') === hash;
    return ok ? JSON.parse(p.get('user')) : null;
  } catch { return null; }
}
async function tgApi(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}
const sendMessage = (chatId, text, keyboard = null) =>
  tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const sendPhoto = (chatId, photo, caption = '', keyboard = null) =>
  tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const editMessage = (chatId, messageId, text, keyboard = null) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const answerCallback = (id, text = '') => tgApi('answerCallbackQuery', { callback_query_id: id, text });

async function isAdmin(tgId) {
  try { const r = await pool.query('SELECT is_admin FROM users WHERE tg_id = $1', [tgId]); return r.rows[0]?.is_admin === true; }
  catch { return false; }
}
async function getSetting(key, def = null) {
  try { const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]); return r.rows[0]?.value ?? def; }
  catch { return def; }
}
async function setSetting(key, value) {
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}
async function isMaintenanceMode() { return (await getSetting('maintenance', 'false')) === 'true'; }

function basketFor(id) {
  const vol = Math.floor(id / 100000);
  if (vol <= 143) return '01'; if (vol <= 287) return '02'; if (vol <= 431) return '03';
  if (vol <= 719) return '04'; if (vol <= 1007) return '05'; if (vol <= 1061) return '06';
  if (vol <= 1115) return '07'; if (vol <= 1169) return '08'; if (vol <= 1313) return '09';
  if (vol <= 1601) return '10'; if (vol <= 1655) return '11'; if (vol <= 1919) return '12';
  if (vol <= 2045) return '13'; if (vol <= 2189) return '14'; if (vol <= 2405) return '15';
  if (vol <= 2621) return '16'; if (vol <= 2837) return '17'; return '18';
}
function primaryImageUrl(id) { return `https://spb-basket-cdn-03.geobasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/hq/1.webp`; }
function fallbackImageUrl(id) { return `https://basket-${basketFor(id)}.wbbasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/big/1.webp`; }

function extractWbIds(text) {
  const ids = new Set();
  if (!text) return [];
  let m;
  const re1 = /wildberries\.ru\/catalog\/(\d{6,})/gi;
  const re2 = /wb\.ru\/catalog\/(\d{6,})/gi;
  const re3 = /catalog\/(\d{6,})/gi;
  const re4 = /\b(\d{6,15})\b/g;
  while ((m = re1.exec(text)) !== null) ids.add(Number(m[1]));
  while ((m = re2.exec(text)) !== null) ids.add(Number(m[1]));
  while ((m = re3.exec(text)) !== null) ids.add(Number(m[1]));
  while ((m = re4.exec(text)) !== null) ids.add(Number(m[1]));
  return Array.from(ids);
}

async function fetchWBProductInfo(wbId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'ru-RU,ru;q=0.9',
    'Origin': 'https://www.wildberries.ru', 'Referer': 'https://www.wildberries.ru/',
  };
  const urls = [
    `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${wbId}`,
    `https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${wbId}`,
    `https://basket-${basketFor(wbId)}.wbbasket.ru/vol${Math.floor(wbId/100000)}/part${Math.floor(wbId/1000)}/${wbId}/info/ru/card.json`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const data = await r.json();
      const p1 = data?.data?.products?.[0];
      if (p1?.name) return { wb_id: wbId, name: p1.name, price: p1.salePriceU ? `${Math.round(p1.salePriceU/100).toLocaleString('ru-RU')} ₽` : null, description: p1.name };
      const name2 = data?.imt_name || data?.subj_name;
      if (name2) {
        const price2 = data?.sizes?.[0]?.price?.total ? `${Math.round(data.sizes[0].price.total/100).toLocaleString('ru-RU')} ₽` : null;
        return { wb_id: wbId, name: name2, price: price2, description: data?.description || name2 };
      }
      if (data?.name) return { wb_id: wbId, name: data.name, price: null, description: data.name };
    } catch {}
  }
  return null;
}

function guessCategory(name) {
  const n = (name || '').toLowerCase();
  if (/(осенн|демисезон|пальто|тренч|пуховик|дубленка|кожанк|бомбер|ветровка)/.test(n)) return 'autumn';
  if (/(пальто|тренч|пуховик|шуба|плащ|ветровка|бомбер|дубленка|кожанк|куртк|жилет)/.test(n)) return 'outerwear';
  if (/(костюм|комплект)/.test(n)) return 'suit';
  if (/(платье|сарафан|юбка)/.test(n)) return 'dress';
  if (/(блузка|рубашк|топ|майка|футболка|боди|корсет|водолазк|поло|лонгслив|кроп|бандо|худи|свитер|кардиган|джемпер|кофт)/.test(n)) return 'top';
  if (/(брюк|джинс|штан|лосины|леггинсы|шорт|карго)/.test(n)) return 'bottom';
  return 'top';
}

// ============================================================
// PUBLIC API
// ============================================================
app.get('/api/settings', async (_req, res) => {
  try {
    const maintenance = await isMaintenanceMode();
    const text = await getSetting('maintenance_text', 'Ведутся технические работы');
    res.json({ success: true, maintenance, maintenance_text: text });
  } catch { res.json({ success: true, maintenance: false, maintenance_text: '' }); }
});

app.post('/api/auth', async (req, res) => {
  const { initData, refCode } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) { logError('auth', 'Unauthorized'); return res.status(401).json({ error: 'Unauthorized' }); }
  const { id: tgId, first_name, username, photo_url } = tgUser;
  try {
    const existing = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (existing.rows.length === 0) {
      let inviterId = null;
      if (refCode?.startsWith('ref_')) {
        const parsed = Number(refCode.replace('ref_', ''));
        if (parsed && parsed !== tgId) {
          const inv = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [parsed]);
          if (inv.rows.length) inviterId = parsed;
        }
      }
      const ins = await pool.query(
        `INSERT INTO users (tg_id, username, first_name, photo_url, balance, own_tries, sub_active, ref_by, last_active)
         VALUES ($1,$2,$3,$4,3,0,FALSE,$5,NOW()) RETURNING *`,
        [tgId, username || null, first_name || null, photo_url || null, inviterId]);
      return res.json({ success: true, user: ins.rows[0] });
    }
    if (existing.rows[0].is_banned) return res.status(403).json({ error: 'Banned', reason: existing.rows[0].ban_reason || 'Нарушение правил' });
    const upd = await pool.query(
      `UPDATE users SET first_name=$1, username=$2, photo_url=$3, last_active=NOW() WHERE tg_id=$4 RETURNING *`,
      [first_name || null, username || null, photo_url || null, tgId]);
    res.json({ success: true, user: upd.rows[0] });
  } catch (e) { logError('auth', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 300, offset = 0 } = req.query;
    const params = [];
    let where = "WHERE is_active = TRUE AND category != 'accessory'";
    if (category && category !== 'all' && category !== 'accessory') { params.push(category); where += ` AND category = $${params.length}`; }
    params.push(Number(limit), Number(offset));
    const q = `
      WITH ranked AS (
        SELECT id, wb_id, name, price, category, image_url, fallback_url, description, is_pinned,
          ROW_NUMBER() OVER (PARTITION BY category ORDER BY updated_at DESC, id DESC) AS rn
        FROM products ${where}
      )
      SELECT id, wb_id, name, price, category, image_url, fallback_url, description
      FROM ranked
      ORDER BY is_pinned DESC NULLS LAST, rn ASC, MD5(category || id::text) ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    res.json({ success: true, items: r.rows });
  } catch (e) { logError('catalog', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// FAL
// ============================================================
async function withTimeout(promise, ms, label, abortController = null) {
  let timeoutId;
  const timeoutPromise = new Promise((_, rej) => {
    timeoutId = setTimeout(() => { if (abortController) abortController.abort(); rej(new Error(`${label}: timeout ${ms}ms`)); }, ms);
  });
  try { return await Promise.race([promise, timeoutPromise]); } finally { clearTimeout(timeoutId); }
}
function logFalError(label, e) {
  console.warn(`[tryon] FAIL ${label}: ${e.message || '(пустая)'}`);
  try { logError(`tryon:${label}`, e.message || '(пустая ошибка)', JSON.stringify({ name: e.name, status: e.status })); } catch {}
}
async function fetchImageAsBase64(url) {
  try {
    const r = await fetch(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://www.wildberries.ru/', 'Accept': 'image/*,*/*;q=0.8',
    }});
    if (!r.ok) return null;
    const buf = await r.buffer();
    const ct = r.headers.get('content-type') || 'image/webp';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function runFalTryon({ humanImg, garmentUrl }) {
  let cleanGarmentUrl = garmentUrl;
  if (typeof cleanGarmentUrl === 'string') {
    const m = cleanGarmentUrl.match(/^(.*\/images\/[a-z0-9]+)(\/(\d+\.[a-z]+))?$/i);
    if (m && !m[3]) cleanGarmentUrl = `${m[1]}/1.webp`;
  }
  let garmentData = cleanGarmentUrl;
  if (cleanGarmentUrl && cleanGarmentUrl.startsWith('http') && !cleanGarmentUrl.startsWith('data:')) {
    const b64 = await fetchImageAsBase64(cleanGarmentUrl);
    if (b64) garmentData = b64;
    else {
      const wbMatch = cleanGarmentUrl.match(/\/(\d{6,})\//);
      if (wbMatch) {
        const wbId = Number(wbMatch[1]);
        for (const size of ['big', 'c516x688', 'c246x328']) {
          const alt = `https://basket-${basketFor(wbId)}.wbbasket.ru/vol${Math.floor(wbId/100000)}/part${Math.floor(wbId/1000)}/${wbId}/images/${size}/1.webp`;
          const altB64 = await fetchImageAsBase64(alt);
          if (altB64) { garmentData = altB64; break; }
        }
      }
    }
  }

  const t0 = Date.now();
  console.log('[tryon] Image Apps V2 (30s, $0.04)');
  const controller = new AbortController();
  try {
    const url = await withTimeout(
      fal.subscribe('fal-ai/image-apps-v2/virtual-try-on', {
        input: { person_image_url: humanImg, clothing_image_url: garmentData },
        logs: false, abortSignal: controller.signal,
      }).then(r => r?.data?.image?.url || r?.data?.images?.[0]?.url || null),
      30000, 'image-apps-v2', controller);
    if (url) { console.log(`[tryon] OK ${Date.now() - t0}ms`); return { url, model: 'image-apps-v2' }; }
  } catch (e) { logFalError('image-apps-v2', e); }
  return { url: null, model: null };
}

// ============================================================
// TRYON endpoints
// ============================================================
app.post('/api/tryon', async (req, res) => {
  const { initData, humanImg, garmentUrl, itemId, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!humanImg || !garmentUrl) return res.status(400).json({ error: 'Нет фото или товара' });
  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Вы заблокированы' });
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && user.balance <= 0) return res.status(402).json({ error: 'Нет попыток' });
    const { url: resultUrl, model } = await runFalTryon({ humanImg, garmentUrl });
    await logGeneration(tgId, model, !!resultUrl, itemId);
    if (!resultUrl) return res.json({ success: false, error: 'Не удалось. Попытки не списаны.' });
    if (!hasUnlimited) await pool.query('UPDATE users SET balance = balance - 1 WHERE tg_id = $1', [tgId]);
    const snap = itemId ? (await pool.query('SELECT wb_id, name, image_url FROM products WHERE id = $1', [itemId])).rows[0] || {} : {};
    await pool.query(
      `INSERT INTO tryon_history (user_id, product_id, product_wb_id, product_name, product_image, result_url, is_mock, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tgId, itemId ? Number(itemId) : null, snap.wb_id || null, snap.name || null, snap.image_url || null, resultUrl, false, category || null]);
    if (user.ref_by && !user.ref_rewarded) {
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + 3 WHERE tg_id = $1', [user.ref_by]);
      sendMessage(user.ref_by, '🎉 Твоя подруга сделала первую примерку! +3 попытки ✨').catch(() => {});
    }
    res.json({ success: true, resultUrl, model });
  } catch (e) { logError('tryon', e.message); res.json({ success: false, error: 'Ошибка.' }); }
});

app.post('/api/tryon-by-link', async (req, res) => {
  const { initData, humanImg, wbLink } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!humanImg || !wbLink) return res.status(400).json({ error: 'Нужно фото и ссылка' });
  const ids = extractWbIds(wbLink);
  if (!ids.length) return res.status(400).json({ error: 'Не нашёл артикул' });
  const wbId = ids[0];
  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Вы заблокированы' });
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && (user.own_tries || 0) <= 0) return res.status(402).json({ error: 'Нет попыток' });
    const info = await fetchWBProductInfo(wbId);
    const garmentUrl = primaryImageUrl(wbId);
    const productName = info?.name || `Товар ${wbId}`;
    const { url: resultUrl, model } = await runFalTryon({ humanImg, garmentUrl });
    await logGeneration(tgId, model, !!resultUrl, null);
    if (!resultUrl) return res.json({ success: false, error: 'Не удалось.' });
    if (!hasUnlimited) await pool.query('UPDATE users SET own_tries = own_tries - 1 WHERE tg_id = $1', [tgId]);
    await pool.query(
      `INSERT INTO tryon_history (user_id, product_wb_id, product_name, product_image, result_url, is_mock)
       VALUES ($1,$2,$3,$4,$5,$6)`, [tgId, wbId, productName, garmentUrl, resultUrl, false]);
    try { await sendPhoto(tgId, resultUrl, '✨ Твоя примерка готова!'); } catch {}
    res.json({ success: true, resultUrl, productName });
  } catch (e) { logError('tryon-by-link', e.message); res.json({ success: false, error: 'Ошибка.' }); }
});

app.post('/api/tryon-multi', async (req, res) => {
  const { initData, humanImg, items } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!Array.isArray(items) || items.length < 2 || items.length > 3) return res.status(400).json({ error: 'Нужно 2–3 вещи' });
  const cats = items.map(i => i.category);
  if (new Set(cats).size !== cats.length) return res.status(400).json({ error: 'Разные категории' });
  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Заблокированы' });
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    const need = items.length;
    if (!hasUnlimited && user.balance < need) return res.status(402).json({ error: `Нужно ${need} попыток` });
    const results = []; let prevImg = humanImg; let success = 0;
    for (const item of items) {
      const { url, model } = await runFalTryon({ humanImg: prevImg, garmentUrl: item.image_url });
      await logGeneration(tgId, model, !!url, item.id);
      if (url) { results.push({ itemId: item.id, name: item.name, url }); prevImg = url; success++; }
      else results.push({ itemId: item.id, name: item.name, url: null });
    }
    if (!hasUnlimited && success > 0) await pool.query('UPDATE users SET balance = GREATEST(0, balance - $1) WHERE tg_id = $2', [success, tgId]);
    for (const r of results) {
      if (r.url) await pool.query(
        `INSERT INTO tryon_history (user_id, product_id, product_name, result_url, is_mock)
         VALUES ($1,$2,$3,$4,$5)`, [tgId, r.itemId || null, r.name || null, r.url, false]);
    }
    if (success === 0) return res.json({ success: false, error: 'Не удалось.' });
    res.json({ success: true, results, charged: success });
  } catch (e) { logError('tryon-multi', e.message); res.json({ success: false, error: 'Ошибка.' }); }
});

app.post('/api/history', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(
      `SELECT id, result_url, is_mock, created_at, category, COALESCE(product_name, 'Товар') AS product_name, product_wb_id, product_image
       FROM tryon_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [tgUser.id]);
    res.json({ success: true, items: r.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/redeem-promo', async (req, res) => {
  const { initData, code } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return res.status(400).json({ error: 'Введите промокод' });
  try {
    const promo = await pool.query(`SELECT * FROM promo_codes WHERE code = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())`, [cleanCode]);
    if (!promo.rows.length) return res.status(404).json({ error: 'Не найден' });
    const p = promo.rows[0];
    if (p.used_count >= p.max_uses) return res.status(400).json({ error: 'Не действует' });
    const used = await pool.query('SELECT 1 FROM promo_uses WHERE code = $1 AND tg_id = $2', [cleanCode, tgId]);
    if (used.rows.length) return res.status(400).json({ error: 'Уже использовали' });
    await pool.query('INSERT INTO promo_uses (code, tg_id) VALUES ($1, $2)', [cleanCode, tgId]);
    await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1', [cleanCode]);
    if (p.unlimited) {
      await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [new Date(Date.now() + 86400000), tgId]);
      return res.json({ success: true, tries: 0, unlimited: true });
    }
    await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [p.tries, tgId]);
    res.json({ success: true, tries: p.tries, unlimited: false });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/idea', async (req, res) => {
  const { initData, text } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return res.status(400).json({ error: 'Пусто' });
  try {
    await pool.query(`INSERT INTO ideas (tg_id, first_name, username, text) VALUES ($1,$2,$3,$4)`,
      [tgUser.id, tgUser.first_name || null, tgUser.username || null, clean]);
    const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
    const from = `${tgUser.first_name || '—'} @${tgUser.username || '—'} · <code>${tgUser.id}</code>`;
    for (const a of admins.rows) sendMessage(a.tg_id, `💡 <b>Идея</b>\n\n👤 ${from}\n\n${clean.replace(/</g, '&lt;')}`).catch(() => {});
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/onboarded', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try { await pool.query('UPDATE users SET onboarded = TRUE WHERE tg_id = $1', [tgUser.id]); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/create-invoice', async (req, res) => {
  const { tgId, productType, tries, ownTries } = req.body;
  let title = '10 примерок', amount = 50, payload = `pack10:${tgId}:${Date.now()}`;
  if (SUBSCRIPTIONS[productType]) {
    const sub = SUBSCRIPTIONS[productType]; title = sub.title; amount = sub.stars;
    payload = `${productType}:${tgId}:${Date.now()}`;
  } else if (productType === 'custom_tries') {
    const n = Math.max(1, Math.min(500, Number(tries) || 1));
    amount = n * 5; title = `${n} примерок`; payload = `custom_tries:${tgId}:${n}:${Date.now()}`;
  } else if (productType === 'custom_own_tries') {
    const n = Math.max(1, Math.min(500, Number(ownTries) || 1));
    amount = n * 10; title = `${n} своих примерок`; payload = `custom_own_tries:${tgId}:${n}:${Date.now()}`;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: 'Оплата', payload, currency: 'XTR', prices: [{ label: title, amount }] }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoiceLink: data.result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ПРОВЕРКА БИТЫХ
// ============================================================
async function checkBrokenProducts() {
  const t0 = Date.now();
  try {
    const r = await pool.query(`SELECT id, wb_id, name FROM products WHERE is_active = TRUE`);
    let checked = 0, broken = 0;
    const brokenList = [];
    const CONCURRENCY = 10;
    for (let i = 0; i < r.rows.length; i += CONCURRENCY) {
      const chunk = r.rows.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (row) => {
        checked++;
        try {
          let res = await fetch(primaryImageUrl(row.wb_id), { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
          if (!res.ok) {
            res = await fetch(fallbackImageUrl(row.wb_id), { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
            if (!res.ok) {
              await pool.query(`UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [row.id]);
              broken++;
              brokenList.push(`${row.wb_id} — ${(row.name || '').slice(0, 40)}`);
            }
          }
        } catch {}
      }));
    }
    console.log(`[cleanup] ${Date.now() - t0}ms. Проверено: ${checked}, скрыто: ${broken}`);
    const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
    if (broken > 0) {
      const msg = `🧹 <b>Автопроверка</b>\n\nПроверено: ${checked}\nСкрыто битых: <b>${broken}</b>\n\n` +
        brokenList.slice(0, 15).map(t => `• <code>${t}</code>`).join('\n');
      for (const a of admins.rows) sendMessage(a.tg_id, msg).catch(() => {});
    } else {
      for (const a of admins.rows) sendMessage(a.tg_id, `🧹 Проверено <b>${checked}</b>, битых 0 ✅`).catch(() => {});
    }
  } catch (e) { logError('cleanup', e.message); }
}

// ============================================================
// АДМИНКА — сухое, по делу
// ============================================================
function mainAdminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '💵 Расходы и доходы', callback_data: 'adm_expenses' }],
      [{ text: '📈 Аналитика', callback_data: 'adm_analytics' }],
      [{ text: '🔄 Пополнить каталог', callback_data: 'adm_refresh_catalog' }],
      [{ text: '👥 Юзеры', callback_data: 'adm_users' }, { text: '🎁 Выдать', callback_data: 'adm_give_tries' }],
      [{ text: '🛍 Каталог', callback_data: 'adm_catalog' }],
      [{ text: '🎟 Промокоды', callback_data: 'adm_promo' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
      [{ text: '🔔 Ошибки', callback_data: 'adm_errors' }, { text: '🚧 Тех.работы', callback_data: 'adm_maintenance' }],
    ],
  };
}
function catalogMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Добавить по ссылкам', callback_data: 'adm_add_link' }],
      [{ text: '🗑 Удалить по ссылкам', callback_data: 'adm_remove_links' }],
      [{ text: '🔄 Пополнить из WB', callback_data: 'adm_refresh_catalog' }],
      [{ text: '🔍 Проверить на битые', callback_data: 'adm_check_products' }],
      [{ text: '🗑 Удалить битые', callback_data: 'adm_delete_broken' }],
      [{ text: '📌 Закрепить', callback_data: 'adm_pin' }, { text: '🙈 Скрыть', callback_data: 'adm_hide' }],
      [{ text: '👁 Вернуть', callback_data: 'adm_unhide' }, { text: '🗑 Удалить один', callback_data: 'adm_delete' }],
      [{ text: '🔄 Обновить названия', callback_data: 'adm_backfill' }],
      [{ text: '🧹 Убрать старше 5 дней', callback_data: 'adm_cleanup' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}
function promoMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Свой промокод', callback_data: 'adm_promo_custom' }],
      [{ text: '⚡ +2', callback_data: 'adm_promo_quick_2' }, { text: '⚡ +5', callback_data: 'adm_promo_quick_5' }],
      [{ text: '⚡ +10', callback_data: 'adm_promo_quick_10' }, { text: '⚡ +20', callback_data: 'adm_promo_quick_20' }],
      [{ text: '♾ Безлимит 24ч', callback_data: 'adm_promo_quick_unlimited' }],
      [{ text: '📋 Список', callback_data: 'adm_promo_list' }],
      [{ text: '🗑 Удалить', callback_data: 'adm_promo_delete' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}
function usersMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📋 Последние 20', callback_data: 'adm_users_last' }],
      [{ text: '💰 Топ по балансу', callback_data: 'adm_users_top' }],
      [{ text: '🆕 За сутки', callback_data: 'adm_users_new' }],
      [{ text: '🔍 Найти', callback_data: 'adm_find' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}
function userActionsKeyboard(tgId, isBanned = false) {
  return {
    inline_keyboard: [
      [{ text: '🎁 +5', callback_data: `usr_add_5_${tgId}` }, { text: '🎁 +10', callback_data: `usr_add_10_${tgId}` }],
      [{ text: '🎁 +25', callback_data: `usr_add_25_${tgId}` }, { text: '🎁 +50', callback_data: `usr_add_50_${tgId}` }],
      [{ text: '✏️ Своё число', callback_data: `usr_add_custom_${tgId}` }],
      [{ text: '📦 +5 своих', callback_data: `usr_addown_5_${tgId}` }, { text: '📦 +10 своих', callback_data: `usr_addown_10_${tgId}` }],
      [{ text: '♾ 24ч', callback_data: `usr_unlimit_${tgId}` }, { text: '❌ Снять', callback_data: `usr_unlimit_off_${tgId}` }],
      [{ text: '📝 Заметки', callback_data: `usr_notes_${tgId}` }],
      [{ text: isBanned ? '✅ Разбанить' : '🚫 Забанить', callback_data: `usr_${isBanned ? 'unban' : 'ban'}_${tgId}` }],
      [{ text: '💎 Сделать админом', callback_data: `usr_admin_on_${tgId}` }],
      [{ text: '💬 Сообщение', callback_data: `usr_dm_${tgId}` }],
      [{ text: '🗑 Удалить', callback_data: `usr_delete_${tgId}` }],
      [{ text: '← К юзерам', callback_data: 'adm_users' }],
    ],
  };
}
function maintenanceKeyboard(isOn) {
  return {
    inline_keyboard: [
      [{ text: isOn ? '✅ Включить' : '🚧 Включить тех.работы', callback_data: isOn ? 'adm_maint_off' : 'adm_maint_on' }],
      [{ text: '✏️ Текст для юзеров', callback_data: 'adm_maint_text' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

// Состояния
const awaitingBroadcast = new Set();
const awaitingBroadcastPhoto = new Map();
const awaitingUserSearch = new Set();
const awaitingAddCustom = new Map();
const awaitingLinkForAdd = new Set();
const awaitingLinkForRemove = new Set();
const awaitingPromoCustom = new Map();
const awaitingProductAction = new Map();
const awaitingDM = new Map();
const awaitingMaintText = new Set();
const awaitingBanReason = new Map();
const awaitingNote = new Map();

function randomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  if (await isAdmin(msg.from.id)) await sendMessage(chatId, '👑 <b>Админ-панель</b>', mainAdminKeyboard());
  else await sendMessage(chatId,
    '✨ <b>Style Room</b> — ИИ-примерочная в Telegram.',
    { inline_keyboard: [[{ text: '🛍 Открыть', web_app: { url: FRONT_URL } }]] });
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;
  if (!(await isAdmin(userId))) return answerCallback(cb.id, '⛔ Нет доступа');
  await answerCallback(cb.id);

  const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
  const back = () => editMessage(chatId, messageId, '👑 <b>Админ-панель</b>', mainAdminKeyboard());
  const backKb = { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] };

  if (data === 'adm_back') return back();

  // === ПОПОЛНИТЬ КАТАЛОГ ===
  if (data === 'adm_refresh_catalog') {
    editMessage(chatId, messageId, `🔄 <b>Пополнение запущено</b>\n\nТяну товары из Wildberries…\nРезультат придёт отдельным сообщением.`, backKb).catch(() => {});
    setImmediate(async () => {
      try {
        const result = await refreshCatalog();
        const msg = `✅ <b>Каталог пополнен</b>\n\n➕ Новых: <b>${result.added}</b>\n🔄 Обновлено: <b>${result.updated}</b>\n❌ Ошибок: <b>${result.failed}</b>`;
        for (const a of admins.rows) sendMessage(a.tg_id, msg).catch(() => {});
      } catch (e) { logError('refresh-catalog', e.message); }
    });
    return;
  }

  // === СТАТИСТИКА ===
  if (data === 'adm_stats') {
    try {
      const u = await pool.query('SELECT COUNT(*)::int AS c FROM users');
      const t = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history');
      const p = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = TRUE');
      const ph = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = FALSE');
      const pay = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments');
      const err24 = await pool.query(`SELECT COUNT(*)::int AS c FROM error_log WHERE created_at > NOW() - INTERVAL '1 day'`);
      const banned = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE is_banned = TRUE');
      const active7 = await pool.query(`SELECT COUNT(DISTINCT user_id)::int AS c FROM tryon_history WHERE created_at > NOW() - INTERVAL '7 days'`);
      return editMessage(chatId, messageId,
        `📊 <b>Статистика</b>\n\n` +
        `👥 Юзеров: <b>${u.rows[0].c}</b> (бан: ${banned.rows[0].c})\n` +
        `🔥 Активных за 7 дней: <b>${active7.rows[0].c}</b>\n` +
        `✨ Примерок: <b>${t.rows[0].c}</b>\n` +
        `🛍 Товаров: <b>${p.rows[0].c}</b> (скрыто: ${ph.rows[0].c})\n` +
        `💳 Платежей: <b>${pay.rows[0].c}</b> · ⭐️ <b>${pay.rows[0].s}</b>\n` +
        `🔔 Ошибок за сутки: <b>${err24.rows[0].c}</b>`,
        { inline_keyboard: [[{ text: '📕 Все ошибки', callback_data: 'adm_err_history' }], backKb.inline_keyboard[0]] });
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  // === РАСХОДЫ И ДОХОДЫ ===
  if (data === 'adm_expenses') {
    try {
      const all = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE`);
      const today = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE AND created_at > NOW() - INTERVAL '1 day'`);
      const week = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE AND created_at > NOW() - INTERVAL '7 days'`);
      const month = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE AND created_at > NOW() - INTERVAL '30 days'`);
      const failed = await pool.query(`SELECT COUNT(*)::int AS c FROM generations WHERE success = FALSE`);

      // Доходы
      const incAll = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments`);
      const inc30 = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments WHERE created_at > NOW() - INTERVAL '30 days'`);
      const inc7 = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments WHERE created_at > NOW() - INTERVAL '7 days'`);
      const incToday = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments WHERE created_at > NOW() - INTERVAL '1 day'`);

      const usdAll = Number(incAll.rows[0].s) * STAR_TO_USD;
      const usd30 = Number(inc30.rows[0].s) * STAR_TO_USD;
      const usd7 = Number(inc7.rows[0].s) * STAR_TO_USD;
      const usdToday = Number(incToday.rows[0].s) * STAR_TO_USD;

      const costAll = Number(all.rows[0].sum);
      const cost30 = Number(month.rows[0].sum);
      const cost7 = Number(week.rows[0].sum);
      const costToday = Number(today.rows[0].sum);

      const profitAll = usdAll - costAll;
      const profit30 = usd30 - cost30;
      const profit7 = usd7 - cost7;
      const profitToday = usdToday - costToday;

      // Прогноз на 30 дней — по темпу за последние 7 дней
      const days7 = 7;
      const forecastIncome30 = (usd7 / days7) * 30;
      const forecastCost30 = (cost7 / days7) * 30;
      const forecastProfit30 = forecastIncome30 - forecastCost30;

      const sign = (n) => n >= 0 ? '+' : '';
      const fmt = (n) => `$${Number(n).toFixed(2)}`;

      const byModel = await pool.query(`SELECT model, COUNT(*)::int AS c, COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE GROUP BY model ORDER BY sum DESC`);
      let modelsText = '';
      for (const m of byModel.rows) modelsText += `• <b>${m.model}</b>: ${m.c} · ${fmt(m.sum)}\n`;

      return editMessage(chatId, messageId,
        `💵 <b>Финансы</b>\n\n` +
        `<b>Доходы</b> (Stars → USD):\n` +
        `📅 Сегодня: ${incToday.rows[0].c} платежей · ${fmt(usdToday)}\n` +
        `📅 7 дней: ${inc7.rows[0].c} · ${fmt(usd7)}\n` +
        `📅 30 дней: ${inc30.rows[0].c} · ${fmt(usd30)}\n` +
        `💎 Всего: ${incAll.rows[0].c} · ${fmt(usdAll)}\n\n` +
        `<b>Расходы</b> (FAL):\n` +
        `📅 Сегодня: ${fmt(costToday)}\n` +
        `📅 7 дней: ${fmt(cost7)}\n` +
        `📅 30 дней: ${fmt(cost30)}\n` +
        `💸 Всего: ${fmt(costAll)}\n` +
        `❌ Неудачных: ${failed.rows[0].c} (не списано)\n\n` +
        `<b>Прибыль</b>:\n` +
        `📅 Сегодня: ${sign(profitToday)}<b>${fmt(profitToday)}</b>\n` +
        `📅 7 дней: ${sign(profit7)}<b>${fmt(profit7)}</b>\n` +
        `📅 30 дней: ${sign(profit30)}<b>${fmt(profit30)}</b>\n` +
        `💎 Всего: ${sign(profitAll)}<b>${fmt(profitAll)}</b>\n\n` +
        `<b>🔮 Прогноз на 30 дней</b> (по темпу недели):\n` +
        `Доход: <b>${fmt(forecastIncome30)}</b>\n` +
        `Расход: <b>${fmt(forecastCost30)}</b>\n` +
        `Прибыль: ${sign(forecastProfit30)}<b>${fmt(forecastProfit30)}</b>\n\n` +
        `<b>По моделям:</b>\n${modelsText || '—'}`,
        backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  // === АНАЛИТИКА ===
  if (data === 'adm_analytics') {
    try {
      const days = await pool.query(`
        SELECT DATE(created_at)::text AS d, COUNT(*)::int AS c
        FROM tryon_history WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at) ORDER BY d ASC`);
      let chart = '';
      const maxC = Math.max(1, ...days.rows.map(r => r.c));
      for (const row of days.rows) {
        const bars = '█'.repeat(Math.round((row.c / maxC) * 10));
        chart += `${row.d.slice(5)}  ${bars}  ${row.c}\n`;
      }
      const topProducts = await pool.query(`
        SELECT COALESCE(product_name, 'Товар') AS name, COUNT(*)::int AS c
        FROM tryon_history WHERE created_at > NOW() - INTERVAL '30 days' AND product_name IS NOT NULL
        GROUP BY product_name ORDER BY c DESC LIMIT 5`);
      let topText = '';
      for (const p of topProducts.rows) topText += `• ${p.name.slice(0, 40)} — ${p.c}\n`;

      const funnel = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM users) AS u,
          (SELECT COUNT(DISTINCT user_id)::int FROM tryon_history) AS t,
          (SELECT COUNT(DISTINCT tg_id)::int FROM payments) AS p`);
      const f = funnel.rows[0];
      const conv1 = f.u > 0 ? Math.round((f.t / f.u) * 100) : 0;
      const conv2 = f.t > 0 ? Math.round((f.p / f.t) * 100) : 0;

      return editMessage(chatId, messageId,
        `📈 <b>Аналитика</b>\n\n` +
        `<b>Примерки за 7 дней:</b>\n<pre>${chart || '—'}</pre>\n` +
        `<b>Топ товаров (30 дней):</b>\n${topText || '—'}\n` +
        `<b>Воронка:</b>\n` +
        `1. Зарегались: ${f.u}\n` +
        `2. Сделали примерку: ${f.t} (${conv1}%)\n` +
        `3. Купили: ${f.p} (${conv2}% от сделавших)`,
        backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  // === ТЕХ.РАБОТЫ ===
  if (data === 'adm_maintenance') {
    const on = await isMaintenanceMode();
    const text = await getSetting('maintenance_text', '');
    return editMessage(chatId, messageId,
      `🚧 <b>Тех.работы</b>\n\nСтатус: ${on ? '🔴 ВКЛ' : '🟢 ВЫКЛ'}\n\nТекст: <i>${text}</i>`,
      maintenanceKeyboard(on));
  }
  if (data === 'adm_maint_on') {
    await setSetting('maintenance', 'true');
    return editMessage(chatId, messageId, `🔴 <b>Тех.работы включены</b>`, maintenanceKeyboard(true));
  }
  if (data === 'adm_maint_off') {
    await setSetting('maintenance', 'false');
    return editMessage(chatId, messageId, `🟢 <b>Всё работает</b>`, maintenanceKeyboard(false));
  }
  if (data === 'adm_maint_text') {
    awaitingMaintText.add(userId);
    return editMessage(chatId, messageId, `✏️ Пришли текст для юзеров.\nСейчас: <i>${await getSetting('maintenance_text', '')}</i>`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_maintenance' }]] });
  }

  // === ОШИБКИ ===
  if (data === 'adm_errors') {
    const last5 = await pool.query(`SELECT source, message, created_at FROM error_log ORDER BY created_at DESC LIMIT 5`);
    let m = `🔔 <b>Последние 5 ошибок</b>\n\n`;
    if (last5.rows.length) {
      for (const e of last5.rows) {
        m += `${new Date(e.created_at).toLocaleTimeString('ru-RU')} · <code>${e.source}</code>\n${(e.message || '').slice(0, 100)}\n\n`;
      }
    } else m += `Чисто ✅`;
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '📕 Все ошибки', callback_data: 'adm_err_history' }], backKb.inline_keyboard[0]] });
  }
  if (data === 'adm_err_history') {
    const r = await pool.query(`SELECT source, message, created_at FROM error_log ORDER BY created_at DESC LIMIT 30`);
    if (!r.rows.length) return editMessage(chatId, messageId, '📕 Журнал пуст ✅', backKb);
    let m = `📕 <b>Журнал (30 последних)</b>\n\n`;
    for (const e of r.rows) {
      const t = new Date(e.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      m += `<b>${t}</b> · <code>${e.source}</code>\n${(e.message || '').slice(0, 150)}\n\n`;
    }
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '🗑 Очистить', callback_data: 'adm_err_clear' }], backKb.inline_keyboard[0]] });
  }
  if (data === 'adm_err_clear') {
    await pool.query('DELETE FROM error_log');
    return editMessage(chatId, messageId, '🗑 Очищено', backKb);
  }

  // === ВЫДАТЬ ПОПЫТКИ ===
  if (data === 'adm_give_tries') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId, `🎁 Пришли <b>@username</b> или <b>ID</b>:`,
      { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] });
  }

  // === ЮЗЕРЫ ===
  if (data === 'adm_users') return editMessage(chatId, messageId, '👥 <b>Юзеры</b>', usersMenuKeyboard());
  if (data === 'adm_users_last') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY created_at DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '←', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '👥 Последние:', { inline_keyboard: btns });
  }
  if (data === 'adm_users_top') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '←', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '💰 Топ:', { inline_keyboard: btns });
  }
  if (data === 'adm_users_new') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '←', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '🆕 Новые:', { inline_keyboard: btns });
  }
  if (data === 'adm_find') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId, '🔍 @username или ID:', { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] });
  }
  if (data.startsWith('usr_show_')) return showUserCard(chatId, messageId, Number(data.replace('usr_show_', '')));
  if (data.startsWith('usr_add_custom_')) {
    const tgId = Number(data.replace('usr_add_custom_', ''));
    awaitingAddCustom.set(userId, tgId);
    return editMessage(chatId, messageId, '✏️ Сколько попыток?', { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] });
  }
  if (/^usr_add_\d+_\d+$/.test(data)) {
    const [, , count, tgId] = data.split('_');
    await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [Number(count), Number(tgId)]);
    return showUserCard(chatId, messageId, Number(tgId), `+${count}`);
  }
  if (/^usr_addown_\d+_\d+$/.test(data)) {
    const [, , count, tgId] = data.split('_');
    await pool.query('UPDATE users SET own_tries = own_tries + $1 WHERE tg_id = $2', [Number(count), Number(tgId)]);
    return showUserCard(chatId, messageId, Number(tgId), `+${count} своих`);
  }
  if (data.startsWith('usr_unlimit_off_')) {
    const tgId = Number(data.replace('usr_unlimit_off_', ''));
    await pool.query('UPDATE users SET unlimited_until = NULL WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Снят');
  }
  if (data.startsWith('usr_unlimit_')) {
    const tgId = Number(data.replace('usr_unlimit_', ''));
    await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [new Date(Date.now() + 86400000), tgId]);
    return showUserCard(chatId, messageId, tgId, '24ч');
  }
  if (data.startsWith('usr_admin_on_')) {
    const tgId = Number(data.replace('usr_admin_on_', ''));
    await pool.query('UPDATE users SET is_admin = TRUE WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, '👑');
  }
  if (data.startsWith('usr_ban_')) {
    const tgId = Number(data.replace('usr_ban_', ''));
    awaitingBanReason.set(userId, tgId);
    return editMessage(chatId, messageId, `🚫 Причина бана:`, { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] });
  }
  if (data.startsWith('usr_unban_')) {
    const tgId = Number(data.replace('usr_unban_', ''));
    await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = NULL WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, '✅ Разбанен');
  }
  if (data.startsWith('usr_notes_')) {
    const tgId = Number(data.replace('usr_notes_', ''));
    const r = await pool.query('SELECT note, created_at FROM user_notes WHERE tg_id = $1 ORDER BY created_at DESC LIMIT 10', [tgId]);
    let m = `📝 <b>Заметки</b>\n\n`;
    if (r.rows.length) {
      for (const n of r.rows) {
        const t = new Date(n.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        m += `${t}\n${n.note}\n\n`;
      }
    } else m += `Заметок нет.\n\nОтправь текст — сохраню как заметку.`;
    awaitingNote.set(userId, tgId);
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '← К юзеру', callback_data: `usr_show_${tgId}` }]] });
  }
  if (data.startsWith('usr_dm_')) {
    const tgId = Number(data.replace('usr_dm_', ''));
    awaitingDM.set(userId, tgId);
    return editMessage(chatId, messageId, `💬 Сообщение для <code>${tgId}</code>:`, { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] });
  }
  if (data.startsWith('usr_delete_')) {
    const tgId = Number(data.replace('usr_delete_', ''));
    await pool.query('DELETE FROM users WHERE tg_id = $1', [tgId]);
    return editMessage(chatId, messageId, '🗑 Удалён', { inline_keyboard: [[{ text: '←', callback_data: 'adm_users' }]] });
  }

  // === КАТАЛОГ ===
  if (data === 'adm_catalog') return editMessage(chatId, messageId, '🛍 <b>Каталог</b>', catalogMenuKeyboard());
  if (data === 'adm_add_link') {
    awaitingLinkForAdd.add(userId);
    return editMessage(chatId, messageId,
      `➕ <b>Добавить товары</b>\n\nПришли ссылки (каждую с новой строки) или артикулы.`,
      { inline_keyboard: [[{ text: '❌', callback_data: 'adm_catalog' }]] });
  }
  if (data === 'adm_remove_links') {
    awaitingLinkForRemove.add(userId);
    return editMessage(chatId, messageId,
      `🗑 <b>Удалить товары</b>\n\nПришли ссылки (каждую с новой строки) или артикулы.\nВсе найденные товары удалю.`,
      { inline_keyboard: [[{ text: '❌', callback_data: 'adm_catalog' }]] });
  }
  if (data === 'adm_check_products') {
    editMessage(chatId, messageId, `🧹 <b>Запустил проверку в фоне</b>`, backKb).catch(() => {});
    setImmediate(() => { checkBrokenProducts().catch(e => logError('cleanup-bg', e.message)); });
    return;
  }
  if (data === 'adm_delete_broken') {
    editMessage(chatId, messageId, `🗑 <b>Удаляю битые в фоне</b>`, backKb).catch(() => {});
    setImmediate(async () => {
      try {
        const r = await pool.query(`SELECT id, wb_id, name FROM products WHERE is_active = TRUE`);
        let deleted = 0;
        const deletedList = [];
        const CONCURRENCY = 10;
        for (let i = 0; i < r.rows.length; i += CONCURRENCY) {
          const chunk = r.rows.slice(i, i + CONCURRENCY);
          await Promise.all(chunk.map(async (row) => {
            try {
              let res = await fetch(primaryImageUrl(row.wb_id), { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
              if (!res.ok) {
                res = await fetch(fallbackImageUrl(row.wb_id), { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
                if (!res.ok) {
                  await pool.query('DELETE FROM products WHERE id = $1', [row.id]);
                  deleted++;
                  deletedList.push(`${row.wb_id} — ${(row.name || '').slice(0, 30)}`);
                }
              }
            } catch {}
          }));
        }
        const msg = `🗑 Удалено битых: <b>${deleted}</b>\n\n` + deletedList.slice(0, 15).map(t => `• <code>${t}</code>`).join('\n');
        for (const a of admins.rows) sendMessage(a.tg_id, msg).catch(() => {});
      } catch (e) { logError('delete-broken', e.message); }
    });
    return;
  }
  if (['adm_pin', 'adm_hide', 'adm_unhide', 'adm_delete'].includes(data)) {
    const action = data.replace('adm_', '');
    awaitingProductAction.set(userId, action);
    const prompts = { pin: '📌 Ссылка:', hide: '🙈 Ссылка:', unhide: '👁 Ссылка:', delete: '🗑 Ссылка:' };
    return editMessage(chatId, messageId, prompts[action], { inline_keyboard: [[{ text: '❌', callback_data: 'adm_catalog' }]] });
  }
  if (data === 'adm_backfill') {
    await editMessage(chatId, messageId, `🔄 Обновляю…`, backKb);
    try {
      const r = await pool.query(`SELECT id, wb_id FROM products WHERE name LIKE 'Товар WB%' OR name IS NULL OR TRIM(name) = '' ORDER BY id DESC LIMIT 300`);
      if (!r.rows.length) { await sendMessage(chatId, `ℹ️ Все названия нормальные`, backKb); return; }
      let updated = 0, failed = 0;
      for (const row of r.rows) {
        const info = await fetchWBProductInfo(row.wb_id);
        if (info?.name && !info.name.startsWith('Товар')) {
          await pool.query(`UPDATE products SET name=$1, price=COALESCE($2, price), description=COALESCE(description, $3), updated_at=NOW() WHERE id=$4`,
            [info.name, info.price, info.description || info.name, row.id]);
          updated++;
        } else failed++;
        await new Promise(rs => setTimeout(rs, 200));
      }
      await sendMessage(chatId, `✅ Обновлено: <b>${updated}</b> · Не удалось: <b>${failed}</b>`, backKb);
    } catch (e) { await sendMessage(chatId, '❌ ' + e.message, backKb); }
    return;
  }
  if (data === 'adm_cleanup') {
    try {
      const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
      return editMessage(chatId, messageId, `🧹 Удалено: <b>${r.rows[0].deleted_count}</b>`, backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  // === ПРОМОКОДЫ ===
  if (data === 'adm_promo') return editMessage(chatId, messageId, '🎟 <b>Промокоды</b>', promoMenuKeyboard());
  if (data === 'adm_promo_custom') {
    awaitingPromoCustom.set(userId, { step: 'code' });
    return editMessage(chatId, messageId, '🎟 Код (латиница+цифры):', { inline_keyboard: [[{ text: '❌', callback_data: 'adm_promo' }]] });
  }
  if (data.startsWith('adm_promo_quick_')) {
    const type = data.replace('adm_promo_quick_', '');
    const code = randomCode();
    let tries = 0, unlimited = false;
    if (type === 'unlimited') unlimited = true; else tries = Number(type);
    await pool.query(`INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1,$2,$3,1000,TRUE,$4)`,
      [code, tries, unlimited, unlimited ? 'Безлимит' : `+${tries}`]);
    return editMessage(chatId, messageId, `✅ <code>${code}</code>`, { inline_keyboard: [[{ text: '🎟', callback_data: 'adm_promo' }]] });
  }
  if (data === 'adm_promo_list') {
    const r = await pool.query(`SELECT code, tries, unlimited, used_count, max_uses, is_active FROM promo_codes ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, 'Пусто', backKb);
    let m = `🎟 <b>Промокоды</b>\n\n`;
    for (const p of r.rows) m += `<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' ⛔'}\n`;
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '←', callback_data: 'adm_promo' }]] });
  }
  if (data === 'adm_promo_delete') {
    const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`);
    if (!r.rows.length) return editMessage(chatId, messageId, 'Активных нет', backKb);
    const btns = r.rows.map(p => [{ text: '❌ ' + p.code, callback_data: 'adm_promodel_' + p.code }]);
    btns.push([{ text: '←', callback_data: 'adm_promo' }]);
    return editMessage(chatId, messageId, 'Удалить:', { inline_keyboard: btns });
  }
  if (data.startsWith('adm_promodel_')) {
    const code = data.replace('adm_promodel_', '');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    return editMessage(chatId, messageId, `✅ Деактивирован`, { inline_keyboard: [[{ text: '←', callback_data: 'adm_promo' }]] });
  }

  // === РАССЫЛКА ===
  if (data === 'adm_broadcast') {
    awaitingBroadcast.add(userId);
    awaitingBroadcastPhoto.delete(userId);
    return editMessage(chatId, messageId,
      `📢 <b>Рассылка</b>\n\nПришли текст. Фото — по желанию.`,
      { inline_keyboard: [[{ text: '📷 С фото', callback_data: 'adm_broadcast_photo' }], [{ text: '❌', callback_data: 'adm_back' }]] });
  }
  if (data === 'adm_broadcast_photo') {
    awaitingBroadcastPhoto.set(userId, { text: null });
    return editMessage(chatId, messageId, `📷 Сначала текст, потом фото:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] });
  }
}

async function showUserCard(chatId, messageId, tgId, toast = null) {
  try {
    const r = await pool.query(
      `SELECT tg_id, first_name, username, balance, own_tries, is_admin, is_banned, ban_reason, created_at, last_active,
              (SELECT COUNT(*)::int FROM tryon_history WHERE user_id = users.tg_id) AS total_tryons,
              (SELECT COALESCE(SUM(cost_usd),0)::numeric FROM generations WHERE tg_id = users.tg_id AND success = TRUE) AS spent_usd,
              (SELECT COALESCE(SUM(stars),0)::int FROM payments WHERE tg_id = users.tg_id) AS stars_paid
       FROM users WHERE tg_id = $1`, [tgId]);
    if (!r.rows.length) return messageId ? editMessage(chatId, messageId, '❌ Не найден') : sendMessage(chatId, '❌ Не найден');
    const u = r.rows[0];
    let text = toast ? `✅ <b>${toast}</b>\n\n` : '';
    text += `👤 <b>${u.first_name || '—'}</b>`;
    if (u.username) text += ` @${u.username}`;
    text += `\n🆔 <code>${u.tg_id}</code>`;
    if (u.is_admin) text += ` 👑`;
    if (u.is_banned) text += `\n🚫 Забанен: ${u.ban_reason || '—'}`;
    text += `\n\n✨ Обычных: <b>${u.balance}</b>\n📦 Своих: <b>${u.own_tries}</b>\n🎨 Примерок: <b>${u.total_tryons}</b>\n`;
    text += `💰 Потратил: <b>$${Number(u.spent_usd).toFixed(2)}</b>\n`;
    text += `💎 Оплатил: <b>${u.stars_paid}</b>⭐️`;
    const kb = userActionsKeyboard(tgId, u.is_banned);
    return messageId ? editMessage(chatId, messageId, text, kb) : sendMessage(chatId, text, kb);
  } catch (e) { return messageId ? editMessage(chatId, messageId, '❌ ' + e.message) : sendMessage(chatId, '❌ ' + e.message); }
}

// ============================================================
// TEXT HANDLERS
// ============================================================
async function handleMaintText(msg) {
  if (!awaitingMaintText.has(msg.from.id)) return false;
  awaitingMaintText.delete(msg.from.id);
  const text = msg.text.trim().slice(0, 500);
  if (!text) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; }
  await setSetting('maintenance_text', text);
  const on = await isMaintenanceMode();
  await sendMessage(msg.chat.id, `✅ Текст: <i>${text}</i>`, maintenanceKeyboard(on));
  return true;
}
async function handleBanReason(msg) {
  if (!awaitingBanReason.has(msg.from.id)) return false;
  const tgId = awaitingBanReason.get(msg.from.id);
  awaitingBanReason.delete(msg.from.id);
  const reason = msg.text.trim().slice(0, 200);
  await pool.query('UPDATE users SET is_banned = TRUE, ban_reason = $1 WHERE tg_id = $2', [reason, tgId]);
  await showUserCard(msg.chat.id, null, tgId, '🚫 Забанен');
  return true;
}
async function handleNote(msg) {
  if (!awaitingNote.has(msg.from.id)) return false;
  const tgId = awaitingNote.get(msg.from.id);
  awaitingNote.delete(msg.from.id);
  const note = msg.text.trim().slice(0, 500);
  if (!note) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; }
  await pool.query('INSERT INTO user_notes (tg_id, note) VALUES ($1, $2)', [tgId, note]);
  await sendMessage(msg.chat.id, `✅ Заметка сохранена`, { inline_keyboard: [[{ text: '← К юзеру', callback_data: `usr_show_${tgId}` }]] });
  return true;
}
async function handleBroadcastText(msg) {
  if (awaitingBroadcast.has(msg.from.id)) {
    awaitingBroadcast.delete(msg.from.id);
    const r = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE');
    let sent = 0, fail = 0;
    await sendMessage(msg.chat.id, `📤 Рассылка на ${r.rows.length} юзеров…`);
    for (const u of r.rows) {
      try { await sendMessage(u.tg_id, msg.text); sent++; if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000)); } catch { fail++; }
    }
    await sendMessage(msg.chat.id, `✅ Доставлено: <b>${sent}</b>, ошибок: <b>${fail}</b>`, mainAdminKeyboard());
    return true;
  }
  if (awaitingBroadcastPhoto.has(msg.from.id) && !awaitingBroadcastPhoto.get(msg.from.id).text) {
    awaitingBroadcastPhoto.set(msg.from.id, { text: msg.text });
    await sendMessage(msg.chat.id, '📷 Теперь фото:');
    return true;
  }
  if (awaitingBroadcastPhoto.has(msg.from.id) && awaitingBroadcastPhoto.get(msg.from.id).text) {
    if (msg.text.trim().toLowerCase() === 'нет' || msg.text.trim() === '-') {
      const st = awaitingBroadcastPhoto.get(msg.from.id);
      awaitingBroadcastPhoto.delete(msg.from.id);
      const r = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE');
      let sent = 0, fail = 0;
      for (const u of r.rows) {
        try { await sendMessage(u.tg_id, st.text); sent++; if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000)); } catch { fail++; }
      }
      await sendMessage(msg.chat.id, `✅ Доставлено: ${sent} · Ошибок: ${fail}`, mainAdminKeyboard());
      return true;
    }
  }
  return false;
}
async function handleBroadcastPhoto(msg) {
  if (!awaitingBroadcastPhoto.has(msg.from.id)) return false;
  const st = awaitingBroadcastPhoto.get(msg.from.id);
  if (!st.text) { await sendMessage(msg.chat.id, '❌ Сначала текст'); return true; }
  const photos = msg.photo;
  if (!photos?.length) return false;
  const fileId = photos[photos.length - 1].file_id;
  awaitingBroadcastPhoto.delete(msg.from.id);
  const r = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE');
  let sent = 0, fail = 0;
  await sendMessage(msg.chat.id, `📤 Рассылка с фото на ${r.rows.length}…`);
  for (const u of r.rows) {
    try { await sendPhoto(u.tg_id, fileId, st.text); sent++; if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1500)); } catch { fail++; }
  }
  await sendMessage(msg.chat.id, `✅ Доставлено: <b>${sent}</b>, ошибок: <b>${fail}</b>`, mainAdminKeyboard());
  return true;
}
async function handleUserSearch(msg) {
  if (!awaitingUserSearch.has(msg.from.id)) return false;
  awaitingUserSearch.delete(msg.from.id);
  const q = msg.text.trim().replace(/^@/, '');
  let r;
  if (/^\d+$/.test(q)) r = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [Number(q)]);
  else r = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [q]);
  if (!r.rows.length) { await sendMessage(msg.chat.id, `❌ Не найден`, mainAdminKeyboard()); return true; }
  await showUserCard(msg.chat.id, null, r.rows[0].tg_id);
  return true;
}
async function handleAddCustomText(msg) {
  if (!awaitingAddCustom.has(msg.from.id)) return false;
  const target = awaitingAddCustom.get(msg.from.id);
  awaitingAddCustom.delete(msg.from.id);
  const n = Number(msg.text.trim());
  if (!Number.isFinite(n) || n === 0) { await sendMessage(msg.chat.id, '❌ Число'); return true; }
  await pool.query('UPDATE users SET balance = GREATEST(0, balance + $1) WHERE tg_id = $2', [n, target]);
  await showUserCard(msg.chat.id, null, target, `${n > 0 ? '+' : ''}${n}`);
  return true;
}
async function handleDM(msg) {
  if (!awaitingDM.has(msg.from.id)) return false;
  const target = awaitingDM.get(msg.from.id);
  awaitingDM.delete(msg.from.id);
  try { await sendMessage(target, `💬 <b>Сообщение:</b>\n\n${msg.text}`); await sendMessage(msg.chat.id, '✅', mainAdminKeyboard()); }
  catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); }
  return true;
}
async function handleAddLinkText(msg) {
  if (!awaitingLinkForAdd.has(msg.from.id)) return false;
  awaitingLinkForAdd.delete(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Артикулов не найдено', mainAdminKeyboard()); return true; }
  await sendMessage(msg.chat.id, `⏳ Нашёл ${ids.length}, добавляю…`);
  const results = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const chunkRes = await Promise.all(chunk.map(async (wbId) => {
      try {
        let img = primaryImageUrl(wbId);
        let res = await fetch(img, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' } });
        if (!res.ok) {
          const altUrl = fallbackImageUrl(wbId);
          const res2 = await fetch(altUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' } });
          if (!res2.ok) return { wbId, status: 'broken' };
        }
        const info = await fetchWBProductInfo(wbId);
        const name = info?.name || `Товар ${wbId}`;
        const price = info?.price || null;
        const category = guessCategory(name);
        await pool.query(
          `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,NOW(),NOW())
           ON CONFLICT (wb_id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category,
             image_url=EXCLUDED.image_url, fallback_url=EXCLUDED.fallback_url, is_active=TRUE, description=EXCLUDED.description, updated_at=NOW()`,
          [wbId, name, price, category, img, fallbackImageUrl(wbId), info?.description || name]);
        return { wbId, status: 'ok', name, price, category };
      } catch (e) { return { wbId, status: 'error', error: e.message }; }
    }));
    results.push(...chunkRes);
  }
  const ok = results.filter(r => r.status === 'ok');
  const broken = results.filter(r => r.status === 'broken');
  const errors = results.filter(r => r.status === 'error');
  let m = `<b>📦 Готово</b>\n\n✅ Добавлено: <b>${ok.length}</b>\n`;
  if (broken.length) m += `⛔ Удалены с WB: <b>${broken.length}</b>\n`;
  if (errors.length) m += `❌ Ошибок: <b>${errors.length}</b>\n`;
  m += `\n`;
  for (const r of ok.slice(0, 10)) m += `• <b>${r.name.slice(0, 45)}</b> · ${r.price || '—'} · ${r.category}\n`;
  if (ok.length > 10) m += `…и ещё ${ok.length - 10}\n`;
  await sendMessage(msg.chat.id, m, mainAdminKeyboard());
  return true;
}
async function handleRemoveLinksText(msg) {
  if (!awaitingLinkForRemove.has(msg.from.id)) return false;
  awaitingLinkForRemove.delete(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Артикулов не найдено', mainAdminKeyboard()); return true; }
  let deleted = 0, notFound = 0;
  const deletedList = [];
  for (const wbId of ids) {
    try {
      const r = await pool.query('DELETE FROM products WHERE wb_id = $1 RETURNING name', [wbId]);
      if (r.rows.length) { deleted++; deletedList.push(`${wbId} — ${r.rows[0].name.slice(0, 30)}`); }
      else notFound++;
    } catch {}
  }
  let m = `🗑 <b>Удаление завершено</b>\n\n`;
  m += `✅ Удалено: <b>${deleted}</b>\n`;
  if (notFound) m += `ℹ️ Не найдено в базе: <b>${notFound}</b>\n`;
  m += `\n`;
  for (const t of deletedList.slice(0, 15)) m += `• <code>${t}</code>\n`;
  if (deletedList.length > 15) m += `…и ещё ${deletedList.length - 15}\n`;
  await sendMessage(msg.chat.id, m, mainAdminKeyboard());
  return true;
}
async function handleProductAction(msg) {
  if (!awaitingProductAction.has(msg.from.id)) return false;
  const action = awaitingProductAction.get(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Ссылка?'); return true; }
  awaitingProductAction.delete(msg.from.id);
  const wbId = ids[0];
  const exists = await pool.query('SELECT name FROM products WHERE wb_id = $1', [wbId]);
  if (!exists.rows.length) { await sendMessage(msg.chat.id, `❌ Не найден`, mainAdminKeyboard()); return true; }
  if (action === 'pin') await pool.query('UPDATE products SET is_pinned = TRUE WHERE wb_id = $1', [wbId]);
  if (action === 'hide') await pool.query('UPDATE products SET is_active = FALSE WHERE wb_id = $1', [wbId]);
  if (action === 'unhide') await pool.query('UPDATE products SET is_active = TRUE, is_pinned = FALSE WHERE wb_id = $1', [wbId]);
  if (action === 'delete') await pool.query('DELETE FROM products WHERE wb_id = $1', [wbId]);
  await sendMessage(msg.chat.id, `✅ Готово: <b>${exists.rows[0].name}</b>`, mainAdminKeyboard());
  return true;
}
async function handlePromoCustom(msg) {
  if (!awaitingPromoCustom.has(msg.from.id)) return false;
  const state = awaitingPromoCustom.get(msg.from.id);
  const text = msg.text.trim();
  if (state.step === 'code') {
    const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    if (!code) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; }
    const dup = await pool.query('SELECT 1 FROM promo_codes WHERE code = $1', [code]);
    if (dup.rows.length) { await sendMessage(msg.chat.id, '❌ Занят'); return true; }
    state.code = code; state.step = 'tries';
    awaitingPromoCustom.set(msg.from.id, state);
    await sendMessage(msg.chat.id, 'Сколько попыток? (или <code>unlimited</code>):');
    return true;
  }
  if (state.step === 'tries') {
    let tries = 0, unlimited = false;
    if (text.toLowerCase() === 'unlimited') unlimited = true;
    else { tries = Number(text); if (!Number.isFinite(tries) || tries <= 0) { await sendMessage(msg.chat.id, '❌ Число > 0'); return true; } }
    state.tries = tries; state.unlimited = unlimited; state.step = 'max_uses';
    awaitingPromoCustom.set(msg.from.id, state);
    await sendMessage(msg.chat.id, 'Лимит активаций (0 = ∞):');
    return true;
  }
  if (state.step === 'max_uses') {
    const maxUses = Number(text);
    if (!Number.isFinite(maxUses) || maxUses < 0) { await sendMessage(msg.chat.id, '❌ ≥ 0'); return true; }
    await pool.query(`INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1,$2,$3,$4,TRUE,$5)`,
      [state.code, state.tries, state.unlimited, maxUses === 0 ? 999999 : maxUses, state.unlimited ? 'Безлимит' : `+${state.tries}`]);
    awaitingPromoCustom.delete(msg.from.id);
    await sendMessage(msg.chat.id, `✅ <code>${state.code}</code>`, { inline_keyboard: [[{ text: '🎟', callback_data: 'adm_promo' }]] });
    return true;
  }
}

// ============================================================
// WEBHOOK
// ============================================================
app.post('/api/webhook/telegram', async (req, res) => {
  const update = req.body;
  if (update.pre_checkout_query) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
    });
    return res.sendStatus(200);
  }
  if (update.callback_query) {
    try { await handleCallback(update.callback_query); } catch (e) { logError('callback', e.message); }
    return res.sendStatus(200);
  }
  if (update.message?.photo) {
    try { await handleBroadcastPhoto(update.message); } catch (e) { logError('broadcast-photo', e.message); }
    return res.sendStatus(200);
  }
  if (update.message?.text) {
    const text = update.message.text.trim();
    if (await handleMaintText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleBanReason(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleNote(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleUserSearch(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleDM(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddLinkText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleRemoveLinksText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleProductAction(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handlePromoCustom(update.message).catch(() => false)) return res.sendStatus(200);

    if (text === '/admin' || text === '/start' || text === '/menu') { await handleStart(update.message); return res.sendStatus(200); }
    if (text === '/privacy') {
      await sendMessage(update.message.chat.id,
        `📄 <b>Политика конфиденциальности</b>\n\nСобираем: Telegram ID, имя, @username, фото для примерки (не сохраняются).\nПередаём: только fal.ai для генерации.\nУдаление: напиши администратору.`);
      return res.sendStatus(200);
    }
    return res.sendStatus(200);
  }
  if (update.message?.successful_payment) {
    const pay = update.message.successful_payment;
    const parts = (pay.invoice_payload || '').split(':');
    const productType = parts[0]; const tgId = Number(parts[1]);
    const chargeId = pay.telegram_payment_charge_id;
    try {
      const dup = await pool.query('SELECT 1 FROM payments WHERE charge_id = $1', [chargeId]);
      if (!dup.rows.length) {
        await pool.query('INSERT INTO payments (charge_id, tg_id, product, stars) VALUES ($1,$2,$3,$4)', [chargeId, tgId, productType, pay.total_amount]);
        if (productType === 'pack10') await pool.query('UPDATE users SET balance = balance + 10 WHERE tg_id = $1', [tgId]);
        else if (productType === 'custom_tries') await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [Number(parts[2]) || 1, tgId]);
        else if (productType === 'custom_own_tries') await pool.query('UPDATE users SET own_tries = own_tries + $1 WHERE tg_id = $2', [Number(parts[2]) || 1, tgId]);
        else if (SUBSCRIPTIONS[productType]) {
          const sub = SUBSCRIPTIONS[productType];
          await pool.query(`UPDATE users SET balance = balance + $1, own_tries = own_tries + $2, sub_active = TRUE WHERE tg_id = $3`, [sub.tries, sub.own || 0, tgId]);
        }
      }
    } catch (e) { logError('payment', e.message); }
  }
  res.sendStatus(200);
});

// ============================================================
// HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });
cron.schedule('0 */5 * * *', () => { checkBrokenProducts(); });
pool.query('SELECT COUNT(*)::int AS c FROM products').then(r => { if (r.rows[0].c === 0) refreshCatalog(); }).catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
