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

const SUBSCRIPTIONS = {
  sub_pro:    { title: 'Подписка PRО',    stars: 599, tries: 50, own: 20 },
  sub_medium: { title: 'Подписка MEDIUM', stars: 299, tries: 30, own: 10 },
  sub_start:  { title: 'Подписка START',  stars: 65,  tries: 10, own: 0  },
};

// ============================================================
// ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ
// ============================================================
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS error_log (
        id SERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        message TEXT,
        detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('maintenance', 'false') ON CONFLICT (key) DO NOTHING;`);
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('maintenance_text', 'Ведутся технические работы. Заходите чуть позже ✨') ON CONFLICT (key) DO NOTHING;`);
    console.log('[init] таблицы готовы');
  } catch (e) { console.error('[init]', e.message); }
})();

async function logError(source, message, detail = null) {
  console.error(`[ERROR][${source}] ${message}`, detail || '');
  try {
    await pool.query(
      `INSERT INTO error_log (source, message, detail) VALUES ($1, $2, $3)`,
      [source, String(message || '').slice(0, 500), detail ? String(detail).slice(0, 2000) : null]
    );
  } catch (e) { console.error('[logError]', e.message); }
}

// ============================================================
// HELPERS
// ============================================================
function verifyTelegramInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    p.delete('hash');
    const str = [...p.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const ok = crypto.createHmac('sha256', key).update(str).digest('hex') === hash;
    return ok ? JSON.parse(p.get('user')) : null;
  } catch { return null; }
}
async function tgApi(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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

async function getSetting(key, defaultValue = null) {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rows[0]?.value ?? defaultValue;
  } catch { return defaultValue; }
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}
async function isMaintenanceMode() {
  return (await getSetting('maintenance', 'false')) === 'true';
}

function basketFor(id) {
  const vol = Math.floor(id / 100000);
  if (vol <= 143) return '01'; if (vol <= 287) return '02'; if (vol <= 431) return '03';
  if (vol <= 719) return '04'; if (vol <= 1007) return '05'; if (vol <= 1061) return '06';
  if (vol <= 1115) return '07'; if (vol <= 1169) return '08'; if (vol <= 1313) return '09';
  if (vol <= 1601) return '10'; if (vol <= 1655) return '11'; if (vol <= 1919) return '12';
  if (vol <= 2045) return '13'; if (vol <= 2189) return '14'; if (vol <= 2405) return '15';
  if (vol <= 2621) return '16'; if (vol <= 2837) return '17'; return '18';
}
function primaryImageUrl(id) {
  return `https://spb-basket-cdn-03.geobasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/hq/1.webp`;
}
function fallbackImageUrl(id) {
  return `https://basket-${basketFor(id)}.wbbasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/big/1.webp`;
}
function extractWbIds(text) {
  const ids = new Set(); let m;
  const re1 = /\/catalog\/(\d{6,})/g; while ((m = re1.exec(text)) !== null) ids.add(Number(m[1]));
  const re2 = /\b(\d{6,})\b/g;      while ((m = re2.exec(text)) !== null) ids.add(Number(m[1]));
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
    `https://u-card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${wbId}`,
    `https://basket-${basketFor(wbId)}.wbbasket.ru/vol${Math.floor(wbId/100000)}/part${Math.floor(wbId/1000)}/${wbId}/info/ru/card.json`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) continue;
      const data = await r.json();
      const p1 = data?.data?.products?.[0];
      if (p1?.name) {
        return {
          wb_id: wbId, name: p1.name,
          price: p1.salePriceU ? `${Math.round(p1.salePriceU/100).toLocaleString('ru-RU')} ₽` : null,
          description: p1.name,
        };
      }
      const name2 = data?.imt_name || data?.subj_name;
      if (name2) {
        const price2 = data?.sizes?.[0]?.price?.total ? `${Math.round(data.sizes[0].price.total/100).toLocaleString('ru-RU')} ₽` : null;
        const descr = data?.description || data?.imt_name || name2;
        return { wb_id: wbId, name: name2, price: price2, description: descr };
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
  if (/(брюк|джинс|штан|лосины|леггинс|шорт|карго)/.test(n)) return 'bottom';
  return 'top';
}

// ============================================================
// PUBLIC: SETTINGS (техобслуживание)
// ============================================================
app.get('/api/settings', async (_req, res) => {
  try {
    const maintenance = await isMaintenanceMode();
    const text = await getSetting('maintenance_text', 'Ведутся технические работы');
    res.json({ success: true, maintenance, maintenance_text: text });
  } catch {
    res.json({ success: true, maintenance: false, maintenance_text: '' });
  }
});

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth', async (req, res) => {
  const { initData, refCode } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) { logError('auth', 'Unauthorized initData'); return res.status(401).json({ error: 'Unauthorized' }); }
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
        [tgId, username || null, first_name || null, photo_url || null, inviterId]
      );
      return res.json({ success: true, user: ins.rows[0] });
    }
    const upd = await pool.query(
      `UPDATE users SET first_name=$1, username=$2, photo_url=$3, last_active=NOW() WHERE tg_id=$4 RETURNING *`,
      [first_name || null, username || null, photo_url || null, tgId]
    );
    res.json({ success: true, user: upd.rows[0] });
  } catch (e) { logError('auth', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// CATALOG
// ============================================================
app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 300, offset = 0 } = req.query;
    const params = [];
    let where = "WHERE is_active = TRUE AND category != 'accessory'";
    if (category && category !== 'all' && category !== 'accessory') {
      params.push(category); where += ` AND category = $${params.length}`;
    }
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
// FAL helpers
// ============================================================
async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms)),
  ]);
}
function logFalError(label, e) {
  console.warn(`[tryon] FAIL ${label}: ${e.message || '(пустая)'}`);
  try {
    const detail = JSON.stringify({ name: e.name, message: e.message, code: e.code, status: e.status, cause: e.cause?.message || null });
    console.warn(`[tryon] DETAIL:`, detail);
    logError(`tryon:${label}`, e.message || '(пустая ошибка)', detail);
  } catch {}
}

async function fetchImageAsBase64(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.wildberries.ru/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!r.ok) {
      console.warn(`[img] fetch ${url.slice(0, 80)} → HTTP ${r.status}`);
      return null;
    }
    const buf = await r.buffer();
    const ct = r.headers.get('content-type') || 'image/webp';
    console.log(`[img] ${url.slice(0, 50)} → ${buf.length}b (${ct})`);
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn(`[img] ошибка: ${e.message}`);
    return null;
  }
}

// ============================================================
// TRYON — дешёвая модель первой (15с), дорогая резервом (20с)
// ============================================================
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
        for (const size of ['big', 'c516x688']) {
          const alt = `https://basket-${basketFor(wbId)}.wbbasket.ru/vol${Math.floor(wbId/100000)}/part${Math.floor(wbId/1000)}/${wbId}/images/${size}/1.webp`;
          const altB64 = await fetchImageAsBase64(alt);
          if (altB64) { garmentData = altB64; break; }
        }
      }
    }
  }

  const t0 = Date.now();

  // ШАГ 1: дешёвая image-apps-v2
  console.log('[tryon] шаг 1: image-apps-v2 (15s, $0.04)');
  try {
    const url = await withTimeout(
      fal.subscribe('fal-ai/image-apps-v2/virtual-try-on', {
        input: { person_image_url: humanImg, clothing_image_url: garmentData },
        logs: false,
      }).then(r => r?.data?.image?.url || r?.data?.images?.[0]?.url || null),
      15000, 'image-apps-v2'
    );
    if (url) {
      console.log(`[tryon] ✅ image-apps-v2 OK за ${Date.now() - t0}ms`);
      return { url, model: 'image-apps-v2' };
    }
  } catch (e) { logFalError('image-apps-v2', e); }

  // ШАГ 2: дорогая fashn-v1.6
  console.log('[tryon] шаг 2: fashn-v1.6 (20s, $0.075, резерв)');
  try {
    const url = await withTimeout(
      fal.subscribe('fal-ai/fashn/tryon/v1.6', {
        input: { model_image: humanImg, garment_image: garmentData, category: 'auto', mode: 'performance', acceleration: 'high' },
        logs: false,
      }).then(r => r?.data?.image?.url || r?.data?.images?.[0]?.url || null),
      20000, 'fashn-v1.6'
    );
    if (url) {
      console.log(`[tryon] ✅ fashn-v1.6 OK за ${Date.now() - t0}ms (был резерв)`);
      return { url, model: 'fashn-v1.6' };
    }
  } catch (e) { logFalError('fashn-v1.6', e); }

  console.warn(`[tryon] все упали за ${Date.now() - t0}ms — НЕ списано`);
  return { url: null, model: null };
}

// ============================================================
// TRYON endpoints
// ============================================================
app.post('/api/tryon', async (req, res) => {
  const t0 = Date.now();
  const { initData, humanImg, garmentUrl, itemId, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!humanImg || !garmentUrl) return res.status(400).json({ error: 'Нет фото или товара' });
  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && user.balance <= 0) return res.status(402).json({ error: 'Нет попыток' });

    const { url: resultUrl, model } = await runFalTryon({ humanImg, garmentUrl });
    if (!resultUrl) {
      logError('tryon', 'Все модели упали', `itemId=${itemId}`);
      return res.json({ success: false, error: 'Не удалось сгенерировать. Попытки не списаны.' });
    }
    if (!hasUnlimited) await pool.query('UPDATE users SET balance = balance - 1 WHERE tg_id = $1', [tgId]);
    const snap = itemId ? (await pool.query('SELECT wb_id, name, image_url FROM products WHERE id = $1', [itemId])).rows[0] || {} : {};
    await pool.query(
      `INSERT INTO tryon_history (user_id, product_id, product_wb_id, product_name, product_image, result_url, is_mock, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tgId, itemId ? Number(itemId) : null, snap.wb_id || null, snap.name || null, snap.image_url || null, resultUrl, false, category || null]
    );
    if (user.ref_by && !user.ref_rewarded) {
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + 3 WHERE tg_id = $1', [user.ref_by]);
      sendMessage(user.ref_by, '🎉 Твоя подруга сделала первую примерку! +3 попытки ✨').catch(() => {});
    }
    console.log(`[tryon] готово за ${Date.now() - t0}ms (${model})`);
    res.json({ success: true, resultUrl, model, took: Date.now() - t0 });
  } catch (e) {
    logError('tryon', e.message);
    res.json({ success: false, error: 'Ошибка. Попытки не списаны.' });
  }
});

app.post('/api/tryon-by-link', async (req, res) => {
  const t0 = Date.now();
  const { initData, humanImg, wbLink } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!humanImg || !wbLink) return res.status(400).json({ error: 'Нужно фото и ссылка' });
  const ids = extractWbIds(wbLink);
  if (!ids.length) return res.status(400).json({ error: 'Не нашёл артикул в ссылке' });
  const wbId = ids[0];
  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && (user.own_tries || 0) <= 0) return res.status(402).json({ error: 'Нет попыток' });
    const info = await fetchWBProductInfo(wbId);
    const garmentUrl = primaryImageUrl(wbId);
    const productName = info?.name || `Товар ${wbId}`;
    const { url: resultUrl } = await runFalTryon({ humanImg, garmentUrl });
    if (!resultUrl) return res.json({ success: false, error: 'Не удалось. Попытки не списаны.' });
    if (!hasUnlimited) await pool.query('UPDATE users SET own_tries = own_tries - 1 WHERE tg_id = $1', [tgId]);
    await pool.query(
      `INSERT INTO tryon_history (user_id, product_wb_id, product_name, product_image, result_url, is_mock)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tgId, wbId, productName, garmentUrl, resultUrl, false]
    );
    try { await sendPhoto(tgId, resultUrl, '✨ Твоя примерка готова!'); } catch {}
    res.json({ success: true, resultUrl, productName, took: Date.now() - t0 });
  } catch (e) { logError('tryon-by-link', e.message); res.json({ success: false, error: 'Ошибка.' }); }
});

app.post('/api/tryon-multi', async (req, res) => {
  const t0 = Date.now();
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
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    const need = items.length;
    if (!hasUnlimited && user.balance < need) return res.status(402).json({ error: `Нужно ${need} попыток` });
    const results = []; let prevImg = humanImg; let success = 0;
    for (const item of items) {
      const { url } = await runFalTryon({ humanImg: prevImg, garmentUrl: item.image_url });
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
    res.json({ success: true, results, charged: success, took: Date.now() - t0 });
  } catch (e) { logError('tryon-multi', e.message); res.json({ success: false, error: 'Ошибка.' }); }
});

// ============================================================
// HISTORY / PROMO / IDEA / ONBOARDED / INVOICE
// ============================================================
app.post('/api/history', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(
      `SELECT id, result_url, is_mock, created_at, category,
              COALESCE(product_name, 'Товар') AS product_name, product_wb_id, product_image
       FROM tryon_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [tgUser.id]
    );
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
    if (!promo.rows.length) return res.status(404).json({ error: 'Промокод не найден' });
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
  } catch (e) { logError('promo', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/idea', async (req, res) => {
  const { initData, text } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return res.status(400).json({ error: 'Пусто' });
  try {
    await pool.query(
      `INSERT INTO ideas (tg_id, first_name, username, text) VALUES ($1,$2,$3,$4)`,
      [tgUser.id, tgUser.first_name || null, tgUser.username || null, clean]
    );
    const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
    const from = `${tgUser.first_name || '—'} @${tgUser.username || '—'} · <code>${tgUser.id}</code>`;
    for (const a of admins.rows) sendMessage(a.tg_id, `💡 <b>Новая идея</b>\n\n👤 От: ${from}\n\n📝 ${clean.replace(/</g, '&lt;')}`).catch(() => {});
    res.json({ success: true });
  } catch (e) { logError('idea', e.message); res.status(500).json({ error: 'Server error' }); }
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
  let title = '10 примерок', amount = 50;
  let payload = `pack10:${tgId}:${Date.now()}`;
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
  } catch (e) { logError('invoice', e.message); res.status(500).json({ error: e.message }); }
});

// ============================================================
// ПРОВЕРКА БИТЫХ ТОВАРОВ
// ============================================================
async function checkBrokenProducts() {
  const t0 = Date.now();
  console.log('[cleanup] старт…');
  try {
    const r = await pool.query(`SELECT id, wb_id, name FROM products WHERE is_active = TRUE`);
    const rows = r.rows;
    console.log(`[cleanup] товаров: ${rows.length}`);
    let checked = 0, broken = 0;
    const brokenList = [];
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (row) => {
        checked++;
        try {
          const imgUrl = primaryImageUrl(row.wb_id);
          let res = await fetch(imgUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
          if (!res.ok) {
            const altUrl = fallbackImageUrl(row.wb_id);
            res = await fetch(altUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
            if (!res.ok) {
              await pool.query(`UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [row.id]);
              broken++;
              brokenList.push(`${row.wb_id} — ${(row.name || '').slice(0, 40)}`);
            }
          }
        } catch (e) { console.warn(`[cleanup] ${row.wb_id}: ${e.message}`); }
      }));
    }
    console.log(`[cleanup] готово ${Date.now() - t0}ms. Проверено: ${checked}, скрыто: ${broken}`);
    const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
    if (broken > 0) {
      await logError('cleanup', `Скрыто битых: ${broken}`, brokenList.slice(0, 30).join('\n'));
      const msg = `🧹 <b>Автопроверка</b>\n\nПроверено: <b>${checked}</b>\nСкрыто: <b>${broken}</b>\n\n` +
        brokenList.slice(0, 20).map(t => `• <code>${t}</code>`).join('\n');
      for (const a of admins.rows) sendMessage(a.tg_id, msg).catch(() => {});
    } else {
      const msg = `🧹 Проверено: <b>${checked}</b>, битых: <b>0</b> ✅`;
      for (const a of admins.rows) sendMessage(a.tg_id, msg).catch(() => {});
    }
  } catch (e) { logError('cleanup', e.message); }
}

// ============================================================
// АДМИНКА
// ============================================================
function mainAdminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '👥 Пользователи', callback_data: 'adm_users' }],
      [{ text: '🎁 Выдать попытки', callback_data: 'adm_give_tries' }],
      [{ text: '🎟 Промокоды', callback_data: 'adm_promo' }],
      [{ text: '🛍 Каталог', callback_data: 'adm_catalog' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
      [{ text: '🔔 Ошибки', callback_data: 'adm_errors' }],
      [{ text: '🚧 Техобслуживание', callback_data: 'adm_maintenance' }],
      [{ text: '❓ Помощь', callback_data: 'adm_help' }],
    ],
  };
}
function catalogMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Добавить по ссылке WB', callback_data: 'adm_add_link' }],
      [{ text: '🧹 Проверить товары', callback_data: 'adm_check_products' }],
      [{ text: '🗑 Удалить нерабочие', callback_data: 'adm_delete_broken' }],
      [{ text: '📌 Закрепить', callback_data: 'adm_pin' }],
      [{ text: '🙈 Скрыть', callback_data: 'adm_hide' }],
      [{ text: '👁 Вернуть', callback_data: 'adm_unhide' }],
      [{ text: '🗑 Удалить', callback_data: 'adm_delete' }],
      [{ text: '🔄 Обновить названия', callback_data: 'adm_backfill' }],
      [{ text: '🧹 Очистить старые', callback_data: 'adm_cleanup' }],
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
      [{ text: '🆕 Новые за сутки', callback_data: 'adm_users_new' }],
      [{ text: '🔍 Найти', callback_data: 'adm_find' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}
function userActionsKeyboard(tgId) {
  return {
    inline_keyboard: [
      [{ text: '🎁 +5', callback_data: `usr_add_5_${tgId}` }, { text: '🎁 +10', callback_data: `usr_add_10_${tgId}` }],
      [{ text: '🎁 +25', callback_data: `usr_add_25_${tgId}` }, { text: '🎁 +50', callback_data: `usr_add_50_${tgId}` }],
      [{ text: '✏️ Своё число', callback_data: `usr_add_custom_${tgId}` }],
      [{ text: '📦 +5 своих', callback_data: `usr_addown_5_${tgId}` }, { text: '📦 +10 своих', callback_data: `usr_addown_10_${tgId}` }],
      [{ text: '🔄 Обнулить', callback_data: `usr_reset_${tgId}` }],
      [{ text: '♾ 24ч', callback_data: `usr_unlimit_${tgId}` }, { text: '❌ Снять', callback_data: `usr_unlimit_off_${tgId}` }],
      [{ text: '💎 Админом', callback_data: `usr_admin_on_${tgId}` }, { text: '❌ Снять', callback_data: `usr_admin_off_${tgId}` }],
      [{ text: '📩 Написать', callback_data: `usr_dm_${tgId}` }],
      [{ text: '🗑 Удалить', callback_data: `usr_delete_${tgId}` }],
      [{ text: '← К юзерам', callback_data: 'adm_users' }],
    ],
  };
}
function maintenanceKeyboard(isOn) {
  return {
    inline_keyboard: [
      [{
        text: isOn ? '✅ Включить приложение' : '🚧 Включить техобслуживание',
        callback_data: isOn ? 'adm_maint_off' : 'adm_maint_on',
      }],
      [{ text: '✏️ Изменить текст', callback_data: 'adm_maint_text' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

const awaitingBroadcast = new Set();
const awaitingBroadcastPhoto = new Map();
const awaitingUserSearch = new Set();
const awaitingAddCustom = new Map();
const awaitingLinkForAdd = new Set();
const awaitingPromoCustom = new Map();
const awaitingProductAction = new Map();
const awaitingDM = new Map();
const awaitingMaintText = new Set();

function randomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const admin = await isAdmin(msg.from.id);
  if (admin) await sendMessage(chatId, '👑 <b>Админ-панель</b>', mainAdminKeyboard());
  else await sendMessage(chatId,
    '✨ <b>Style Room</b>\n\nИИ-примерочная прямо в Telegram.',
    { inline_keyboard: [[{ text: '🛍 Открыть', web_app: { url: FRONT_URL } }]] }
  );
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;
  if (!(await isAdmin(userId))) return answerCallback(cb.id, '⛔ Нет доступа');
  await answerCallback(cb.id);

  const back = () => editMessage(chatId, messageId, '👑 <b>Админ-панель</b>', mainAdminKeyboard());
  const backKb = { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] };

  if (data === 'adm_back') return back();
  if (data === 'adm_help') return editMessage(chatId, messageId, '❓ Всё делается по кнопкам.', backKb);

  // === ТЕХОБСЛУЖИВАНИЕ ===
  if (data === 'adm_maintenance') {
    const on = await isMaintenanceMode();
    const text = await getSetting('maintenance_text', '');
    return editMessage(chatId, messageId,
      `🚧 <b>Режим техобслуживания</b>\n\n` +
      `Статус: ${on ? '🔴 <b>ВКЛЮЧЕНО</b> — юзеры видят заглушку' : '🟢 <b>ВЫКЛЮЧЕНО</b> — приложение работает'}\n\n` +
      `Текст для юзеров:\n<i>${text}</i>`,
      maintenanceKeyboard(on));
  }
  if (data === 'adm_maint_on') {
    await setSetting('maintenance', 'true');
    return editMessage(chatId, messageId,
      `🚧 <b>Техобслуживание ВКЛЮЧЕНО</b>\n\nЮзеры видят заглушку вместо приложения.`,
      maintenanceKeyboard(true));
  }
  if (data === 'adm_maint_off') {
    await setSetting('maintenance', 'false');
    return editMessage(chatId, messageId,
      `✅ <b>Приложение снова работает</b>`,
      maintenanceKeyboard(false));
  }
  if (data === 'adm_maint_text') {
    awaitingMaintText.add(userId);
    return editMessage(chatId, messageId,
      `✏️ Пришли новый текст для юзеров.\n\nТекущий:\n<i>${await getSetting('maintenance_text', '')}</i>`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_maintenance' }]] });
  }

  if (data === 'adm_stats') {
    try {
      const u = await pool.query('SELECT COUNT(*)::int AS c FROM users');
      const t = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history');
      const p = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = TRUE');
      const ph = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = FALSE');
      const pay = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments');
      const errAll = await pool.query('SELECT COUNT(*)::int AS c FROM error_log');
      const err24 = await pool.query(`SELECT COUNT(*)::int AS c FROM error_log WHERE created_at > NOW() - INTERVAL '1 day'`);
      return editMessage(chatId, messageId,
        `📊 <b>Статистика</b>\n\n` +
        `👥 Юзеров: <b>${u.rows[0].c}</b>\n` +
        `✨ Примерок: <b>${t.rows[0].c}</b>\n` +
        `🛍 Активных: <b>${p.rows[0].c}</b>\n` +
        `🙈 Скрытых: <b>${ph.rows[0].c}</b>\n` +
        `💳 Платежей: <b>${pay.rows[0].c}</b>\n` +
        `⭐️ Звёзд: <b>${pay.rows[0].s}</b>\n\n` +
        `📕 Ошибок: <b>${errAll.rows[0].c}</b>\nЗа сутки: <b>${err24.rows[0].c}</b>`,
        { inline_keyboard: [[{ text: '📕 Все ошибки', callback_data: 'adm_err_history' }], backKb.inline_keyboard[0]] });
    } catch (e) { logError('adm_stats', e.message); return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  if (data === 'adm_errors') {
    const last5 = await pool.query(`SELECT source, message, created_at FROM error_log ORDER BY created_at DESC LIMIT 5`);
    let m = `🔔 <b>Последние 5 ошибок</b>\n\n`;
    if (last5.rows.length) {
      for (const e of last5.rows) {
        m += `• [${new Date(e.created_at).toLocaleTimeString('ru-RU')}] <code>${e.source}</code>: ${(e.message || '').slice(0, 80)}\n`;
      }
    } else m += `Пока пусто ✅`;
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '📕 История', callback_data: 'adm_err_history' }], backKb.inline_keyboard[0]] });
  }
  if (data === 'adm_err_history') {
    const r = await pool.query(`SELECT source, message, created_at FROM error_log ORDER BY created_at DESC LIMIT 30`);
    if (!r.rows.length) return editMessage(chatId, messageId, '📕 Журнал пуст.', backKb);
    let m = `📕 <b>Журнал (последние 30)</b>\n\n`;
    for (const e of r.rows) {
      const t = new Date(e.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      m += `<b>${t}</b> <code>${e.source}</code>\n${(e.message || '').slice(0, 150)}\n\n`;
    }
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '🗑 Очистить', callback_data: 'adm_err_clear' }], backKb.inline_keyboard[0]] });
  }
  if (data === 'adm_err_clear') {
    await pool.query('DELETE FROM error_log');
    return editMessage(chatId, messageId, '🗑 Журнал очищен.', backKb);
  }

  if (data === 'adm_give_tries') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId, `🎁 Пришли <b>@username</b> или <b>ID</b>:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] });
  }

  if (data === 'adm_users') return editMessage(chatId, messageId, '👥 <b>Пользователи</b>', usersMenuKeyboard());
  if (data === 'adm_users_last') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY created_at DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '👥 Последние:', { inline_keyboard: btns });
  }
  if (data === 'adm_users_top') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '💰 Топ:', { inline_keyboard: btns });
  }
  if (data === 'adm_users_new') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '🆕 Новые:', { inline_keyboard: btns });
  }
  if (data === 'adm_find') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId, '🔍 Пришли <b>@username</b> или <b>ID</b>:', { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] });
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
  if (data.startsWith('usr_reset_')) {
    const tgId = Number(data.replace('usr_reset_', ''));
    await pool.query('UPDATE users SET balance = 0 WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Обнулено');
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
  if (data.startsWith('usr_admin_off_')) {
    const tgId = Number(data.replace('usr_admin_off_', ''));
    await pool.query('UPDATE users SET is_admin = FALSE WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Снят');
  }
  if (data.startsWith('usr_dm_')) {
    const tgId = Number(data.replace('usr_dm_', ''));
    awaitingDM.set(userId, tgId);
    return editMessage(chatId, messageId, `📩 Текст для <code>${tgId}</code>:`, { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] });
  }
  if (data.startsWith('usr_delete_')) {
    const tgId = Number(data.replace('usr_delete_', ''));
    await pool.query('DELETE FROM users WHERE tg_id = $1', [tgId]);
    return editMessage(chatId, messageId, '🗑 Удалён.', { inline_keyboard: [[{ text: '←', callback_data: 'adm_users' }]] });
  }

  if (data === 'adm_catalog') return editMessage(chatId, messageId, '🛍 <b>Каталог</b>', catalogMenuKeyboard());
  if (data === 'adm_add_link') {
    awaitingLinkForAdd.add(userId);
    return editMessage(chatId, messageId, `➕ Пришли <b>ссылку WB</b>:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_catalog' }]] });
  }
  if (data === 'adm_check_products') {
    editMessage(chatId, messageId, '🧹 Проверка запущена в фоне.\n\nРезультат придёт уведомлением.', backKb).catch(() => {});
    setImmediate(() => { checkBrokenProducts().catch(e => logError('cleanup-bg', e.message)); });
    return;
  }
  if (data === 'adm_delete_broken') {
    editMessage(chatId, messageId, '🗑 Удаляю нерабочие в фоне.\n\nРезультат придёт уведомлением.', backKb).catch(() => {});
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
              const imgUrl = primaryImageUrl(row.wb_id);
              let res = await fetch(imgUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
              if (!res.ok) {
                const altUrl = fallbackImageUrl(row.wb_id);
                res = await fetch(altUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' }, timeout: 5000 });
                if (!res.ok) {
                  await pool.query('DELETE FROM products WHERE id = $1', [row.id]);
                  deleted++;
                  deletedList.push(`${row.wb_id} — ${(row.name || '').slice(0, 30)}`);
                }
              }
            } catch {}
          }));
        }
        const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
        const msg = `🗑 <b>Удалено нерабочих: ${deleted}</b>\n\n` + deletedList.slice(0, 20).map(t => `• <code>${t}</code>`).join('\n');
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
    await editMessage(chatId, messageId, '🔄 Обновляю…', backKb);
    try {
      const r = await pool.query(`SELECT id, wb_id FROM products WHERE name LIKE 'Товар WB%' OR name IS NULL OR TRIM(name) = '' ORDER BY id DESC LIMIT 300`);
      if (!r.rows.length) {
        await sendMessage(chatId, `ℹ️ Нет товаров с заглушками.`, backKb);
        return;
      }
      let updated = 0, failed = 0;
      const fails = [];
      for (const row of r.rows) {
        const info = await fetchWBProductInfo(row.wb_id);
        if (info?.name && !info.name.startsWith('Товар')) {
          await pool.query(`UPDATE products SET name=$1, price=COALESCE($2, price), description=COALESCE(description, $3), updated_at=NOW() WHERE id=$4`,
            [info.name, info.price, info.description || info.name, row.id]);
          updated++;
        } else { failed++; fails.push(row.wb_id); }
        await new Promise(rs => setTimeout(rs, 250));
      }
      await sendMessage(chatId,
        `✅ <b>Обновлено:</b> ${updated}\n❌ <b>Не удалось:</b> ${failed}\n\n` +
        (fails.length ? `Не найденные ID: ${fails.slice(0, 10).join(', ')}` : ''),
        backKb);
    } catch (e) { logError('backfill', e.message); await sendMessage(chatId, '❌ ' + e.message, backKb); }
    return;
  }
  if (data === 'adm_cleanup') {
    try {
      const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
      return editMessage(chatId, messageId, `🧹 Удалено: ${r.rows[0].deleted_count}`, backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  if (data === 'adm_promo') return editMessage(chatId, messageId, '🎟 <b>Промокоды</b>', promoMenuKeyboard());
  if (data === 'adm_promo_custom') {
    awaitingPromoCustom.set(userId, { step: 'code' });
    return editMessage(chatId, messageId, '🎟 Шаг 1/3: код:', { inline_keyboard: [[{ text: '❌', callback_data: 'adm_promo' }]] });
  }
  if (data.startsWith('adm_promo_quick_')) {
    const type = data.replace('adm_promo_quick_', '');
    const code = randomCode();
    let tries = 0, unlimited = false;
    if (type === 'unlimited') unlimited = true; else tries = Number(type);
    await pool.query(`INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1, $2, $3, 1000, TRUE, $4)`,
      [code, tries, unlimited, unlimited ? 'Безлимит 24ч' : `+${tries}`]);
    return editMessage(chatId, messageId, `✅ Код: <code>${code}</code>`, { inline_keyboard: [[{ text: '🎟', callback_data: 'adm_promo' }]] });
  }
  if (data === 'adm_promo_list') {
    const r = await pool.query(`SELECT code, tries, unlimited, used_count, max_uses, is_active FROM promo_codes ORDER BY created_at DESC LIMIT 20`);
    let m = '🎟 <b>Промокоды:</b>\n\n';
    for (const p of r.rows) m += `<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' · ⛔'}\n`;
    return editMessage(chatId, messageId, m || 'Пусто', { inline_keyboard: [[{ text: '←', callback_data: 'adm_promo' }]] });
  }
  if (data === 'adm_promo_delete') {
    const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`);
    const btns = r.rows.map(p => [{ text: '❌ ' + p.code, callback_data: 'adm_promodel_' + p.code }]);
    btns.push([{ text: '←', callback_data: 'adm_promo' }]);
    return editMessage(chatId, messageId, 'Выбери:', { inline_keyboard: btns });
  }
  if (data.startsWith('adm_promodel_')) {
    const code = data.replace('adm_promodel_', '');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    return editMessage(chatId, messageId, `✅`, { inline_keyboard: [[{ text: '←', callback_data: 'adm_promo' }]] });
  }

  if (data === 'adm_broadcast') {
    awaitingBroadcast.add(userId);
    awaitingBroadcastPhoto.delete(userId);
    return editMessage(chatId, messageId,
      `📢 <b>Рассылка</b>\n\nПришли текст. Можно фото.`,
      { inline_keyboard: [
        [{ text: '📷 С фото', callback_data: 'adm_broadcast_photo' }],
        [{ text: '❌', callback_data: 'adm_back' }],
      ]});
  }
  if (data === 'adm_broadcast_photo') {
    awaitingBroadcastPhoto.set(userId, { text: null });
    return editMessage(chatId, messageId, `📷 Текст, потом фото:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] });
  }
}

async function showUserCard(chatId, messageId, tgId, toast = null) {
  try {
    const r = await pool.query(
      `SELECT tg_id, first_name, username, balance, own_tries, is_admin,
              (SELECT COUNT(*)::int FROM tryon_history WHERE user_id = users.tg_id) AS total_tryons
       FROM users WHERE tg_id = $1`, [tgId]);
    if (!r.rows.length) return messageId ? editMessage(chatId, messageId, '❌ Не найден') : sendMessage(chatId, '❌ Не найден');
    const u = r.rows[0];
    const text = `${toast ? '✅ ' + toast + '\n\n' : ''}` +
      `👤 <b>${u.first_name || '—'}</b>${u.username ? ' @' + u.username : ''}\n` +
      `🆔 <code>${u.tg_id}</code>${u.is_admin ? '\n👑 админ' : ''}\n\n` +
      `✨ Обычных: <b>${u.balance}</b>\n📦 Своих: <b>${u.own_tries}</b>\n🎨 Всего: <b>${u.total_tryons}</b>`;
    const kb = userActionsKeyboard(tgId);
    return messageId ? editMessage(chatId, messageId, text, kb) : sendMessage(chatId, text, kb);
  } catch (e) { return messageId ? editMessage(chatId, messageId, '❌ ' + e.message) : sendMessage(chatId, '❌ ' + e.message); }
}

// ============================================================
// TEXT/PHOTO HANDLERS
// ============================================================
async function handleMaintText(msg) {
  if (!awaitingMaintText.has(msg.from.id)) return false;
  awaitingMaintText.delete(msg.from.id);
  const text = msg.text.trim().slice(0, 500);
  if (!text) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; }
  await setSetting('maintenance_text', text);
  const on = await isMaintenanceMode();
  await sendMessage(msg.chat.id, `✅ Текст обновлён:\n\n<i>${text}</i>`, maintenanceKeyboard(on));
  return true;
}

async function handleBroadcastText(msg) {
  if (awaitingBroadcast.has(msg.from.id)) {
    awaitingBroadcast.delete(msg.from.id);
    const r = await pool.query('SELECT tg_id FROM users');
    let sent = 0, fail = 0;
    for (const u of r.rows) {
      try { await sendMessage(u.tg_id, msg.text); sent++; if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000)); } catch { fail++; }
    }
    await sendMessage(msg.chat.id, `✅ Отправлено: ${sent}, ошибок: ${fail}`, mainAdminKeyboard());
    return true;
  }
  if (awaitingBroadcastPhoto.has(msg.from.id) && !awaitingBroadcastPhoto.get(msg.from.id).text) {
    awaitingBroadcastPhoto.set(msg.from.id, { text: msg.text });
    await sendMessage(msg.chat.id, '📷 Фото (или «нет»):');
    return true;
  }
  if (awaitingBroadcastPhoto.has(msg.from.id) && awaitingBroadcastPhoto.get(msg.from.id).text) {
    if (msg.text.trim().toLowerCase() === 'нет' || msg.text.trim() === '-') {
      const st = awaitingBroadcastPhoto.get(msg.from.id);
      awaitingBroadcastPhoto.delete(msg.from.id);
      const r = await pool.query('SELECT tg_id FROM users');
      let sent = 0, fail = 0;
      for (const u of r.rows) {
        try { await sendMessage(u.tg_id, st.text); sent++; if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000)); } catch { fail++; }
      }
      await sendMessage(msg.chat.id, `✅ Отправлено: ${sent}, ошибок: ${fail}`, mainAdminKeyboard());
      return true;
    }
  }
  return false;
}

async function handleBroadcastPhoto(msg) {
  if (!awaitingBroadcastPhoto.has(msg.from.id)) return false;
  const st = awaitingBroadcastPhoto.get(msg.from.id);
  if (!st.text) { await sendMessage(msg.chat.id, '❌ Сначала текст.'); return true; }
  const photos = msg.photo;
  if (!photos?.length) return false;
  const fileId = photos[photos.length - 1].file_id;
  awaitingBroadcastPhoto.delete(msg.from.id);
  const r = await pool.query('SELECT tg_id FROM users');
  let sent = 0, fail = 0;
  for (const u of r.rows) {
    try { await sendPhoto(u.tg_id, fileId, st.text); sent++; if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1500)); } catch { fail++; }
  }
  await sendMessage(msg.chat.id, `✅ Отправлено с фото: ${sent}, ошибок: ${fail}`, mainAdminKeyboard());
  return true;
}

async function handleUserSearch(msg) {
  if (!awaitingUserSearch.has(msg.from.id)) return false;
  awaitingUserSearch.delete(msg.from.id);
  const q = msg.text.trim().replace(/^@/, '');
  let r;
  if (/^\d+$/.test(q)) r = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [Number(q)]);
  else r = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [q]);
  if (!r.rows.length) { await sendMessage(msg.chat.id, '❌ Не найдено', mainAdminKeyboard()); return true; }
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
  try { await sendMessage(target, `📩 <b>Сообщение:</b>\n\n${msg.text}`); await sendMessage(msg.chat.id, '✅', mainAdminKeyboard()); }
  catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); }
  return true;
}
async function handleAddLinkText(msg) {
  if (!awaitingLinkForAdd.has(msg.from.id)) return false;
  awaitingLinkForAdd.delete(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Нет ссылки', mainAdminKeyboard()); return true; }
  await sendMessage(msg.chat.id, `⏳ Добавляю ${ids.length}…`);
  let added = 0, failed = 0;
  const lines = [];
  for (const wbId of ids) {
    try {
      const img = primaryImageUrl(wbId);
      const r = await fetch(img, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' } });
      if (!r.ok) {
        const altUrl = fallbackImageUrl(wbId);
        const r2 = await fetch(altUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' } });
        if (!r2.ok) { failed++; lines.push(`⛔ <code>${wbId}</code> — удалён с WB`); continue; }
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
      added++;
      lines.push(`✅ <b>${name}</b>\n   ${price || '—'} · ${category}`);
    } catch (e) { failed++; lines.push(`❌ <code>${wbId}</code>`); }
  }
  await sendMessage(msg.chat.id, `📦 Готово\n✅ ${added} / ❌ ${failed}\n\n` + lines.slice(0, 10).join('\n'), mainAdminKeyboard());
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
  await sendMessage(msg.chat.id, `✅ Готово`, mainAdminKeyboard());
  return true;
}
async function handlePromoCustom(msg) {
  if (!awaitingPromoCustom.has(msg.from.id)) return false;
  const state = awaitingPromoCustom.get(msg.from.id);
  const text = msg.text.trim();
  if (state.step === 'code') {
    const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    if (!code) { await sendMessage(msg.chat.id, '❌ Пустой'); return true; }
    const dup = await pool.query('SELECT 1 FROM promo_codes WHERE code = $1', [code]);
    if (dup.rows.length) { await sendMessage(msg.chat.id, '❌ Занят'); return true; }
    state.code = code; state.step = 'tries';
    awaitingPromoCustom.set(msg.from.id, state);
    await sendMessage(msg.chat.id, 'Шаг 2/3: попыток (или «unlimited»):');
    return true;
  }
  if (state.step === 'tries') {
    let tries = 0, unlimited = false;
    if (text.toLowerCase() === 'unlimited') unlimited = true;
    else { tries = Number(text); if (!Number.isFinite(tries) || tries <= 0) { await sendMessage(msg.chat.id, '❌ > 0'); return true; } }
    state.tries = tries; state.unlimited = unlimited; state.step = 'max_uses';
    awaitingPromoCustom.set(msg.from.id, state);
    await sendMessage(msg.chat.id, 'Шаг 3/3: лимит (0=∞):');
    return true;
  }
  if (state.step === 'max_uses') {
    const maxUses = Number(text);
    if (!Number.isFinite(maxUses) || maxUses < 0) { await sendMessage(msg.chat.id, '❌ ≥ 0'); return true; }
    await pool.query(`INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1, $2, $3, $4, TRUE, $5)`,
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
    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleUserSearch(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleDM(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddLinkText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleProductAction(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handlePromoCustom(update.message).catch(() => false)) return res.sendStatus(200);

    if (text === '/admin' || text === '/start' || text === '/menu') { await handleStart(update.message); return res.sendStatus(200); }
    if (text === '/privacy') {
      await sendMessage(update.message.chat.id,
        `📄 <b>Политика конфиденциальности</b>\n\n<b>Что собираем:</b>\n• Telegram ID, имя, @username\n• Фото для примерки (не сохраняются)\n\n<b>Кому передаём:</b>\n• Только fal.ai — для генерации\n\n<b>Удаление:</b> напиши администратору.`);
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
