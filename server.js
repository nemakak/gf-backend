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
fal.config({ credentials: process.env.FAL_KEY });

const SUBSCRIPTIONS = {
  sub_pro:    { title: 'Подписка PRО',    stars: 599, tries: 50, own: 20 },
  sub_medium: { title: 'Подписка MEDIUM', stars: 299, tries: 30, own: 10 },
  sub_start:  { title: 'Подписка START',  stars: 65,  tries: 10, own: 0  },
};

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
const editMessage = (chatId, messageId, text, keyboard = null) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const answerCallback = (id, text = '') => tgApi('answerCallbackQuery', { callback_query_id: id, text });

async function isAdmin(tgId) {
  try { const r = await pool.query('SELECT is_admin FROM users WHERE tg_id = $1', [tgId]); return r.rows[0]?.is_admin === true; }
  catch { return false; }
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
      const r = await fetch(url, { headers }); if (!r.ok) continue;
      const data = await r.json();
      const p1 = data?.data?.products?.[0];
      if (p1?.name) return { wb_id: wbId, name: p1.name, price: p1.salePriceU ? `${Math.round(p1.salePriceU/100).toLocaleString('ru-RU')} ₽` : null };
      const name2 = data?.imt_name || data?.subj_name;
      if (name2) return { wb_id: wbId, name: name2, price: data?.sizes?.[0]?.price?.total ? `${Math.round(data.sizes[0].price.total/100).toLocaleString('ru-RU')} ₽` : null };
      if (data?.name) return { wb_id: wbId, name: data.name, price: null };
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
// AUTH
// ============================================================
app.post('/api/auth', async (req, res) => {
  const { initData, refCode } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
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
  } catch (e) { console.error('[auth]', e.message); res.status(500).json({ error: 'Server error' }); }
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
  } catch (e) { console.error('[catalog]', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// FAL — 3 модели, никогда не бросает
// ============================================================
async function tryFashnV16(h, g) {
  const r = await fal.subscribe('fal-ai/fashn/tryon/v1.6', {
    input: { model_image: h, garment_image: g, category: 'auto', mode: 'performance', acceleration: 'high' }, logs: false });
  return r?.data?.image?.url || r?.data?.images?.[0]?.url || null;
}
async function tryFashnV15(h, g) {
  const r = await fal.subscribe('fal-ai/fashn/tryon/v1.5', {
    input: { model_image: h, garment_image: g }, logs: false });
  return r?.data?.image?.url || r?.data?.images?.[0]?.url || null;
}
async function tryImageApps(h, g) {
  const r = await fal.subscribe('fal-ai/image-apps-v2/virtual-try-on', {
    input: { person_image_url: h, clothing_image_url: g }, logs: false });
  return r?.data?.image?.url || r?.data?.images?.[0]?.url || null;
}
async function runFalTryon({ humanImg, garmentUrl }) {
  const attempts = [
    { name: 'fashn-v1.6',    fn: () => tryFashnV16(humanImg, garmentUrl) },
    { name: 'fashn-v1.5',    fn: () => tryFashnV15(humanImg, garmentUrl) },
    { name: 'image-apps-v2', fn: () => tryImageApps(humanImg, garmentUrl) },
  ];
  for (const a of attempts) {
    try {
      const url = await a.fn();
      if (url) { console.log(`[tryon] OK ${a.name}`); return { url, model: a.name }; }
      console.warn(`[tryon] ${a.name} empty`);
    } catch (e) { console.warn(`[tryon] FAIL ${a.name}: ${e.message}`); }
  }
  return { url: null, model: null };
}

// ============================================================
// TRYON
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
      console.warn(`[tryon] all failed (${Date.now() - t0}ms) — НЕ списано`);
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
    console.log(`[tryon] OK ${model} (${Date.now() - t0}ms)`);
    res.json({ success: true, resultUrl, model, took: Date.now() - t0 });
  } catch (e) {
    console.error('[tryon]', e.message);
    res.json({ success: false, error: 'Ошибка. Попытки не списаны.' });
  }
});

// ============================================================
// TRYON BY LINK
// ============================================================
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
    if (!hasUnlimited && (user.own_tries || 0) <= 0) return res.status(402).json({ error: 'Нет попыток для своих товаров' });

    const info = await fetchWBProductInfo(wbId);
    const garmentUrl = primaryImageUrl(wbId);
    const productName = info?.name || `Товар ${wbId}`;
    const { url: resultUrl } = await runFalTryon({ humanImg, garmentUrl });
    if (!resultUrl) {
      console.warn(`[tryon-by-link] failed (${Date.now() - t0}ms)`);
      return res.json({ success: false, error: 'Не удалось сгенерировать. Попытки не списаны.' });
    }
    if (!hasUnlimited) await pool.query('UPDATE users SET own_tries = own_tries - 1 WHERE tg_id = $1', [tgId]);
    await pool.query(
      `INSERT INTO tryon_history (user_id, product_wb_id, product_name, product_image, result_url, is_mock)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tgId, wbId, productName, garmentUrl, resultUrl, false]
    );
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgId, photo: resultUrl, caption: '✨ Твоя примерка готова!' }),
      });
    } catch {}
    res.json({ success: true, resultUrl, productName, took: Date.now() - t0 });
  } catch (e) {
    console.error('[tryon-by-link]', e.message);
    res.json({ success: false, error: 'Ошибка. Попытки не списаны.' });
  }
});

// ============================================================
// MULTI 2–3 разных категорий
// ============================================================
app.post('/api/tryon-multi', async (req, res) => {
  const t0 = Date.now();
  const { initData, humanImg, items } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!Array.isArray(items) || items.length < 2 || items.length > 3) return res.status(400).json({ error: 'Нужно 2–3 вещи' });
  const cats = items.map(i => i.category);
  if (new Set(cats).size !== cats.length) return res.status(400).json({ error: 'Выберите вещи из разных категорий' });
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
    if (success === 0) return res.json({ success: false, error: 'Не удалось. Попытки не списаны.' });
    res.json({ success: true, results, charged: success, took: Date.now() - t0 });
  } catch (e) { console.error('[tryon-multi]', e.message); res.json({ success: false, error: 'Ошибка. Попытки не списаны.' }); }
});

// ============================================================
// HISTORY
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

// ============================================================
// PROMO
// ============================================================
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
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// IDEA
// ============================================================
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
    for (const a of admins.rows) {
      sendMessage(a.tg_id,
        `💡 <b>Новая идея</b>\n\n👤 От: ${from}\n\n📝 ${clean.replace(/</g, '&lt;')}`
      ).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { console.error('[idea]', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/onboarded', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try { await pool.query('UPDATE users SET onboarded = TRUE WHERE tg_id = $1', [tgUser.id]); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// INVOICE
// ============================================================
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
      body: JSON.stringify({ title, description: 'Оплата цифровых услуг', payload, currency: 'XTR', prices: [{ label: title, amount }] }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoiceLink: data.result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    } catch (e) { console.error('[webhook]', e.message); }
  }
  res.sendStatus(200);
});

// ============================================================
// HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });
pool.query('SELECT COUNT(*)::int AS c FROM products').then(r => { if (r.rows[0].c === 0) refreshCatalog(); }).catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
