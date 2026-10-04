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
const allowed = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    cb(null, true);
  },
  credentials: true,
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const VTON_MODEL = 'fal-ai/flux-2-lora-gallery/virtual-tryon';
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function sendMessage(chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = keyboard;
  return tgApi('sendMessage', payload);
}

async function editMessage(chatId, messageId, text, keyboard = null) {
  const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = keyboard;
  return tgApi('editMessageText', payload);
}

async function answerCallback(callbackId, text = '') {
  return tgApi('answerCallbackQuery', { callback_query_id: callbackId, text });
}

async function isAdmin(tgId) {
  try {
    const r = await pool.query('SELECT is_admin FROM users WHERE tg_id = $1', [tgId]);
    return r.rows[0]?.is_admin === true;
  } catch { return false; }
}

function basketFor(id) {
  const vol = Math.floor(id / 100000);
  if (vol <= 143) return '01';
  if (vol <= 287) return '02';
  if (vol <= 431) return '03';
  if (vol <= 719) return '04';
  if (vol <= 1007) return '05';
  if (vol <= 1061) return '06';
  if (vol <= 1115) return '07';
  if (vol <= 1169) return '08';
  if (vol <= 1313) return '09';
  if (vol <= 1601) return '10';
  if (vol <= 1655) return '11';
  if (vol <= 1919) return '12';
  if (vol <= 2045) return '13';
  if (vol <= 2189) return '14';
  if (vol <= 2405) return '15';
  if (vol <= 2621) return '16';
  if (vol <= 2837) return '17';
  return '18';
}

function primaryImageUrl(id) {
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://spb-basket-cdn-03.geobasket.ru/vol${vol}/part${part}/${id}/images/hq/1.webp`;
}

function fallbackImageUrl(id) {
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://basket-${basketFor(id)}.wbbasket.ru/vol${vol}/part${part}/${id}/images/big/1.webp`;
}

// Извлечение артикулов WB из текста
function extractWbIds(text) {
  const ids = new Set();
  // 1. Ссылки вида /catalog/12345678/detail.aspx
  const re1 = /\/catalog\/(\d{6,})/g;
  let m;
  while ((m = re1.exec(text)) !== null) ids.add(Number(m[1]));
  // 2. Голые артикулы (6+ цифр подряд)
  const re2 = /\b(\d{6,})\b/g;
  while ((m = re2.exec(text)) !== null) ids.add(Number(m[1]));
  return Array.from(ids);
}

// Получение инфы о товаре с WB через прокси
async function fetchWBProductInfo(wbId) {
  const url = 'https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=' + wbId;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0',
        'Accept': 'application/json',
      },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const products = data?.data?.products || data?.products || [];
    if (!products.length) return null;
    const p = products[0];
    return {
      wb_id: wbId,
      name: p.name || 'Товар WB',
      price: p.salePriceU ? `${Math.round(p.salePriceU / 100).toLocaleString('ru-RU')} ₽` : null,
    };
  } catch { return null; }
}

// ============================================================
// 1. AUTH
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
        `INSERT INTO users (tg_id, username, first_name, photo_url, balance, own_tries, sub_active, ref_by)
         VALUES ($1,$2,$3,$4,3,0,FALSE,$5) RETURNING *`,
        [tgId, username || null, first_name || null, photo_url || null, inviterId]
      );
      return res.json({ success: true, user: ins.rows[0] });
    }

    const upd = await pool.query(
      `UPDATE users SET first_name=$1, username=$2, photo_url=$3, last_active=NOW()
       WHERE tg_id=$4 RETURNING *`,
      [first_name || null, username || null, photo_url || null, tgId]
    );
    res.json({ success: true, user: upd.rows[0] });
  } catch (e) {
    console.error('[auth]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// 2. IMG PROXY
// ============================================================
app.get('/api/img', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Bad url');
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('Bad url'); }
  const host = parsed.hostname;
  const okHosts = [
    /\.wbbasket\.ru$/, /\.wbstatic\.net$/, /\.geobasket\.ru$/,
    /^lh3\.googleusercontent\.com$/, /^drive\.google\.com$/, /^drive\.usercontent\.google\.com$/,
  ];
  if (!okHosts.some(rx => rx.test(host))) return res.status(400).send('Bad host');
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Referer': 'https://www.wildberries.ru/',
      },
    });
    if (!r.ok) return res.status(404).send('Not found');
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(buf);
  } catch (e) { res.status(500).send('Proxy error'); }
});

// ============================================================
// 3. SYNC-CATALOG
// ============================================================
app.post('/api/sync-catalog', async (req, res) => {
  const { items, secret } = req.body;
  if (secret !== 'GF_ROOM_2024_SECRET') return res.status(403).json({ error: 'Forbidden' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Empty items' });
  try {
    let saved = 0, skippedDup = 0;
    for (const it of items) {
      if (!it.wb_id || !it.image_url || !it.category) continue;

      const nameCheck = await pool.query(
        `SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
        [it.name]
      );
      if (nameCheck.rows.length > 0) { skippedDup++; continue; }

      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',NOW(),NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name = EXCLUDED.name, price = EXCLUDED.price, category = EXCLUDED.category,
           image_url = EXCLUDED.image_url, fallback_url = EXCLUDED.fallback_url,
           is_active = TRUE, updated_at = NOW()`,
        [it.wb_id, it.name, it.price, it.category, it.image_url, it.fallback_url]
      );
      saved++;
    }
    res.json({ success: true, saved, skipped: skippedDup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 4. CATALOG
// ============================================================
app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 300, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE is_active = TRUE';
    if (category && category !== 'all') {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    params.push(Number(limit), Number(offset));

    const q = `
      WITH ranked AS (
        SELECT id, wb_id, name, price, category, image_url, fallback_url, is_pinned,
          ROW_NUMBER() OVER (PARTITION BY category ORDER BY updated_at DESC, id DESC) AS rn
        FROM products ${where}
      )
      SELECT id, wb_id, name, price, category, image_url, fallback_url
      FROM ranked
      ORDER BY is_pinned DESC NULLS LAST, rn ASC, MD5(category || id::text) ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    res.json({ success: true, items: r.rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 5. TRYON
// ============================================================
app.post('/api/tryon', async (req, res) => {
  const { initData, humanImg, garmentUrl, itemId, isOwnProduct, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited) {
      if (isOwnProduct === true) {
        if ((user.own_tries || 0) <= 0) return res.status(402).json({ error: 'Нет попыток для своих товаров' });
        await pool.query('UPDATE users SET own_tries = own_tries - 1 WHERE tg_id = $1', [tgId]);
      } else {
        if (user.balance <= 0) return res.status(402).json({ error: 'No tries left' });
        await pool.query('UPDATE users SET balance = balance - 1 WHERE tg_id = $1', [tgId]);
      }
    }

    let resultUrl = null, isMock = false;
    try {
      const r = await fal.subscribe(VTON_MODEL, {
        input: {
          image_urls: [humanImg, garmentUrl, garmentUrl],
          prompt: 'TRYON a full-body photo of a person. Replace the outfit with the top and bottom as shown in the reference images. The final image is a full body shot.',
          num_inference_steps: 40,
          guidance_scale: 2.5,
          lora_scale: 1.2,
          acceleration: 'regular',
          num_images: 1,
          output_format: 'jpeg',
        },
        logs: false,
      });
      resultUrl = r?.data?.images?.[0]?.url || null;
      if (!resultUrl) throw new Error('empty fal response');
    } catch (e) {
      resultUrl = garmentUrl;
      isMock = true;
    }

    const productSnap = itemId
      ? await pool.query('SELECT wb_id, name, image_url FROM products WHERE id = $1', [itemId])
      : { rows: [] };
    const snap = productSnap.rows[0] || {};

    await pool.query(
      `INSERT INTO tryon_history
         (user_id, product_id, product_wb_id, product_name, product_image, result_url, is_mock, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tgId, itemId ? Number(itemId) : null,
       snap.wb_id || null, snap.name || null, snap.image_url || null,
       resultUrl, isMock, category || null]
    );

    try {
      const caption = isMock
        ? '✨ Примерка готова (демо). Открой приложение.'
        : '✨ Твоя примерка готова! Открой приложение, чтобы посмотреть.';
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgId, photo: resultUrl, caption }),
      });
    } catch (e) {}

    if (user.ref_by && !user.ref_rewarded && !isMock) {
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + 3 WHERE tg_id = $1', [user.ref_by]);
      sendMessage(user.ref_by, '🎉 Ваша подруга сделала первую примерку! +3 попытки ✨').catch(() => {});
    }

    res.json({ success: true, resultUrl, isMock });
  } catch (e) {
    res.json({ success: true, resultUrl: garmentUrl || '', isMock: true });
  }
});

// ============================================================
// 6. HISTORY
// ============================================================
app.post('/api/history', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(
      `SELECT id, result_url, is_mock, created_at, category,
              COALESCE(product_name, 'Товар') AS product_name,
              product_wb_id, product_image
       FROM tryon_history WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [tgUser.id]
    );
    res.json({ success: true, items: r.rows });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 7. REDEEM PROMO
// ============================================================
app.post('/api/redeem-promo', async (req, res) => {
  const { initData, code } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return res.status(400).json({ error: 'Введите промокод' });

  try {
    const promo = await pool.query(
      `SELECT * FROM promo_codes WHERE code = $1 AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [cleanCode]
    );
    if (!promo.rows.length) return res.status(404).json({ error: 'Промокод не найден' });
    const p = promo.rows[0];
    if (p.used_count >= p.max_uses) return res.status(400).json({ error: 'Промокод больше не действует' });
    const used = await pool.query('SELECT 1 FROM promo_uses WHERE code = $1 AND tg_id = $2', [cleanCode, tgId]);
    if (used.rows.length) return res.status(400).json({ error: 'Вы уже использовали этот промокод' });

    await pool.query('INSERT INTO promo_uses (code, tg_id) VALUES ($1, $2)', [cleanCode, tgId]);
    await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1', [cleanCode]);

    if (p.unlimited) {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [until, tgId]);
      return res.json({ success: true, tries: 0, unlimited: true });
    } else {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [p.tries, tgId]);
      return res.json({ success: true, tries: p.tries, unlimited: false });
    }
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 8. ONBOARDED
// ============================================================
app.post('/api/onboarded', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('UPDATE users SET onboarded = TRUE WHERE tg_id = $1', [tgUser.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 9. INVOICE
// ============================================================
app.post('/api/create-invoice', async (req, res) => {
  const { tgId, productType, tries } = req.body;
  let title = '10 примерок одежды', amount = 1;
  let payload = `pack10:${tgId}:${Date.now()}`;
  if (SUBSCRIPTIONS[productType]) {
    const sub = SUBSCRIPTIONS[productType];
    title = sub.title; amount = sub.stars;
    payload = `${productType}:${tgId}:${Date.now()}`;
  } else if (productType === 'custom_tries') {
    const n = Math.max(1, Math.min(500, Number(tries) || 1));
    amount = n * 5; title = `${n} примерок`;
    payload = `custom_tries:${tgId}:${n}:${Date.now()}`;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, description: 'Оплата цифровых услуг в мини-приложении',
        payload, currency: 'XTR', prices: [{ label: title, amount }],
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoiceLink: data.result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 10. CLEANUP
// ============================================================
app.post('/api/cleanup', async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'GF_ROOM_2024_SECRET') return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
    res.json({ success: true, deleted: r.rows[0].deleted_count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 11. АДМИН-ПАНЕЛЬ — ПОЛНАЯ ПЕРЕРАБОТКА
// ============================================================

// Главное меню админки
function mainAdminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '👥 Пользователи', callback_data: 'adm_users' }],
      [{ text: '🔍 Поиск юзера', callback_data: 'adm_find' }],
      [{ text: '🎁 Промокоды', callback_data: 'adm_promo_menu' }],
      [{ text: '📌 Каталог: модерация', callback_data: 'adm_moderate' }],
      [{ text: '➕ Добавить товары по ссылкам', callback_data: 'adm_add_links' }],
      [{ text: '🧹 Очистить старые', callback_data: 'adm_cleanup' }],
      [{ text: '📢 Рассылка всем', callback_data: 'adm_broadcast' }],
      [{ text: '❓ Помощь', callback_data: 'adm_help' }],
    ],
  };
}

// Меню «Пользователи»
function usersMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📋 Последние 20', callback_data: 'adm_users_last' }],
      [{ text: '💰 Топ по балансу', callback_data: 'adm_users_top' }],
      [{ text: '🆕 Новые за сутки', callback_data: 'adm_users_new' }],
      [{ text: '🔍 Найти по ID / @username / имени', callback_data: 'adm_find' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

// Карточка юзера — кнопки действий
function userActionsKeyboard(tgId) {
  return {
    inline_keyboard: [
      [{ text: '➕ +5 попыток', callback_data: `usr_add_5_${tgId}` }, { text: '➕ +10', callback_data: `usr_add_10_${tgId}` }],
      [{ text: '➕ +25', callback_data: `usr_add_25_${tgId}` }, { text: '➕ +50', callback_data: `usr_add_50_${tgId}` }],
      [{ text: '➕ Своё число', callback_data: `usr_add_custom_${tgId}` }],
      [{ text: '🔄 Обнулить баланс', callback_data: `usr_reset_${tgId}` }],
      [{ text: '♾ Дать безлимит 24ч', callback_data: `usr_unlimit_${tgId}` }, { text: '❌ Снять безлимит', callback_data: `usr_unlimit_off_${tgId}` }],
      [{ text: '🗑 Удалить юзера', callback_data: `usr_delete_${tgId}` }],
      [{ text: '← К списку юзеров', callback_data: 'adm_users' }],
    ],
  };
}

// Промокоды
function promoMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Создать промокод', callback_data: 'adm_promo_create' }],
      [{ text: '📋 Список промокодов', callback_data: 'adm_promo_list' }],
      [{ text: '❌ Деактивировать', callback_data: 'adm_promo_delete' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

function promoTypesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '+2 попытки', callback_data: 'adm_create_2' }, { text: '+5 попыток', callback_data: 'adm_create_5' }],
      [{ text: '+10 попыток', callback_data: 'adm_create_10' }, { text: '+20 попыток', callback_data: 'adm_create_20' }],
      [{ text: '💎 Безлимит 24ч', callback_data: 'adm_create_unlimited' }],
      [{ text: '← Назад', callback_data: 'adm_promo_menu' }],
    ],
  };
}

// Модерация каталога
function catalogMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📌 Закрепить товар', callback_data: 'adm_pin' }],
      [{ text: '✂️ Открепить товар', callback_data: 'adm_unpin' }],
      [{ text: '🙈 Скрыть товар', callback_data: 'adm_hide' }],
      [{ text: '👁 Вернуть товар', callback_data: 'adm_unhide' }],
      [{ text: '➕ Добавить товары по ссылкам', callback_data: 'adm_add_links' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

// ==== СОСТОЯНИЯ ====
const awaitingBroadcast = new Set();
const awaitingModeration = new Map();
const awaitingUserSearch = new Set();
const awaitingAddCustom = new Map(); // userId → targetTgId (для «+Своё число»)
const awaitingLinks = new Set();     // userId (для «Добавить по ссылкам»)

function randomCode(prefix = 'WELCOME') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const isAdm = await isAdmin(msg.from.id);
  if (isAdm) {
    await sendMessage(chatId,
      `👑 <b>Админ-панель Style Room</b>\n\n` +
      `Выбери раздел из меню ниже.\n\n` +
      `💡 Если не знаешь, что делать — нажми «❓ Помощь».`,
      mainAdminKeyboard());
  } else {
    await sendMessage(chatId, '✨ Добро пожаловать в Style Room!\n\nНажми кнопку ниже, чтобы открыть приложение.');
  }
}

async function handleAdminMenu(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(msg.from.id))) return sendMessage(chatId, '⛔ Нет доступа.');
  await sendMessage(chatId, '👑 <b>Админ-панель</b>\n\nВыбери раздел:', mainAdminKeyboard());
}

// Показать карточку юзера
async function showUserCard(chatId, messageId, tgId, toast = null) {
  try {
    const r = await pool.query(
      `SELECT tg_id, first_name, username, balance, own_tries, sub_active,
              unlimited_until, created_at, last_active,
              (SELECT COUNT(*)::int FROM tryon_history WHERE user_id = users.tg_id) AS total_tryons,
              (SELECT COUNT(*)::int FROM payments WHERE tg_id = users.tg_id) AS payments
       FROM users WHERE tg_id = $1`,
      [tgId]
    );
    if (!r.rows.length) {
      const txt = `❌ Юзер <code>${tgId}</code> не найден.`;
      return messageId
        ? editMessage(chatId, messageId, txt, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] })
        : sendMessage(chatId, txt, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    }
    const u = r.rows[0];

    const unlimText = u.unlimited_until && new Date(u.unlimited_until) > new Date()
      ? `♾ до ${new Date(u.unlimited_until).toLocaleString('ru-RU')}`
      : 'нет';

    const text =
      `${toast ? '✅ ' + toast + '\n\n' : ''}` +
      `👤 <b>${u.first_name || 'Без имени'}</b>\n` +
      `🔗 @${u.username || '—'}\n` +
      `🆔 <code>${u.tg_id}</code>\n\n` +
      `✨ <b>Обычных примерок:</b> ${u.balance}\n` +
      `📦 <b>Своих товаров:</b> ${u.own_tries}\n` +
      `🎨 <b>Всего примерок:</b> ${u.total_tryons}\n` +
      `💳 <b>Платежей:</b> ${u.payments}\n\n` +
      `💎 Подписка: ${u.sub_active ? 'да' : 'нет'}\n` +
      `♾ Безлимит: ${unlimText}\n` +
      `📅 Создан: ${new Date(u.created_at).toLocaleDateString('ru-RU')}\n` +
      `🕐 Был в сети: ${u.last_active ? new Date(u.last_active).toLocaleString('ru-RU') : '—'}`;

    const kb = userActionsKeyboard(tgId);
    return messageId
      ? editMessage(chatId, messageId, text, kb)
      : sendMessage(chatId, text, kb);
  } catch (e) {
    const txt = '❌ Ошибка: ' + e.message;
    return messageId ? editMessage(chatId, messageId, txt) : sendMessage(chatId, txt);
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;

  if (!(await isAdmin(userId))) return answerCallback(cb.id, '⛔ Нет доступа');
  await answerCallback(cb.id);

  // ==== Назад в главное ====
  if (data === 'adm_back') {
    return editMessage(chatId, messageId, '👑 <b>Админ-панель</b>\n\nВыбери раздел:', mainAdminKeyboard());
  }

  // ==== Помощь ====
  if (data === 'adm_help') {
    return editMessage(chatId, messageId,
      `❓ <b>Помощь по админке</b>\n\n` +
      `<b>📊 Статистика</b> — сколько юзеров, примерок, товаров, платежей.\n\n` +
      `<b>👥 Пользователи</b> — список последних юзеров. Нажми на юзера, чтобы открыть карточку. Там можно начислить примерки, обнулить баланс, дать безлимит.\n\n` +
      `<b>🔍 Поиск юзера</b> — введи tg_id (цифры), @username или часть имени.\n\n` +
      `<b>🎁 Промокоды</b> — создавай коды на +5/+10/+20 попыток или безлимит 24ч. Юзеры вводят их в профиле приложения.\n\n` +
      `<b>📌 Каталог</b> — закрепить товар наверху раздела, скрыть, вернуть. Введи wb_id (число — артикул Wildberries).\n\n` +
      `<b>➕ Добавить товары по ссылкам</b> — отправь пачку ссылок WB одним сообщением, разделяя переносами или пробелами. Бот сам достанет артикулы и добавит товары.\n\n` +
      `<b>🧹 Очистить старые</b> — удалить товары старше 5 дней.\n\n` +
      `<b>📢 Рассылка</b> — отправить сообщение всем юзерам.\n\n` +
      `💡 <b>Пример ссылок для добавления:</b>\n` +
      `<code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>\n` +
      `<code>183581368</code> (просто артикул тоже сработает)`,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
  }

  // ==== Статистика ====
  if (data === 'adm_stats') {
    const users = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const tryons = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history');
    const products = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = TRUE');
    const payments = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments');
    const today = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at > NOW() - INTERVAL '1 day'`);
    return editMessage(chatId, messageId,
      `📊 <b>Статистика</b>\n\n` +
      `👥 Всего юзеров: <b>${users.rows[0].c}</b>\n` +
      `🆕 За сутки: <b>${today.rows[0].c}</b>\n` +
      `✨ Примерок: <b>${tryons.rows[0].c}</b>\n` +
      `👗 Товаров: <b>${products.rows[0].c}</b>\n` +
      `💳 Платежей: <b>${payments.rows[0].c}</b> · ⭐ <b>${payments.rows[0].s}</b>`,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
  }

  // ==== Меню юзеров ====
  if (data === 'adm_users') {
    return editMessage(chatId, messageId, '👥 <b>Пользователи</b>\n\nВыбери, что показать:', usersMenuKeyboard());
  }

  if (data === 'adm_users_last') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '👥 Юзеров пока нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    const btns = r.rows.map(u => ([{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '👥 <b>Последние 20:</b>\n\nНажми на юзера:', { inline_keyboard: btns });
  }

  if (data === 'adm_users_top') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 20`);
    const btns = r.rows.map(u => ([{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '💰 <b>Топ по балансу:</b>', { inline_keyboard: btns });
  }

  if (data === 'adm_users_new') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '🆕 Новых за сутки нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    const btns = r.rows.map(u => ([{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '🆕 <b>Новые за сутки:</b>', { inline_keyboard: btns });
  }

  // ==== Найти юзера ====
  if (data === 'adm_find') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId,
      `🔍 <b>Поиск юзера</b>\n\nОтправь одним сообщением:\n` +
      `• tg_id — <code>1068105255</code>\n` +
      `• @username — <code>@ivan</code>\n` +
      `• имя — <code>Иван</code>`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  // ==== Карточка юзера ====
  if (data.startsWith('usr_show_')) {
    const tgId = Number(data.replace('usr_show_', ''));
    return showUserCard(chatId, messageId, tgId);
  }

  // ==== Начислить примерки ====
  if (data.startsWith('usr_add_custom_')) {
    const tgId = Number(data.replace('usr_add_custom_', ''));
    awaitingAddCustom.set(userId, tgId);
    return editMessage(chatId, messageId,
      `➕ <b>Своё число примерок</b>\n\nОтправь числом, сколько начислить (например <code>100</code>). Можно со знаком минус, чтобы списать: <code>-5</code>.`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: `usr_show_${tgId}` }]] });
  }

  if (/^usr_add_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const count = Number(parts[2]);
    const tgId = Number(parts[3]);
    try {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [count, tgId]);
      return showUserCard(chatId, messageId, tgId, `Начислено +${count}`);
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message);
    }
  }

  if (data.startsWith('usr_reset_')) {
    const tgId = Number(data.replace('usr_reset_', ''));
    await pool.query('UPDATE users SET balance = 0 WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Баланс обнулён');
  }

  if (data.startsWith('usr_unlimit_off_')) {
    const tgId = Number(data.replace('usr_unlimit_off_', ''));
    await pool.query('UPDATE users SET unlimited_until = NULL WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Безлимит снят');
  }

  if (data.startsWith('usr_unlimit_')) {
    const tgId = Number(data.replace('usr_unlimit_', ''));
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [until, tgId]);
    return showUserCard(chatId, messageId, tgId, 'Безлимит на 24ч выдан');
  }

  if (data.startsWith('usr_delete_')) {
    const tgId = Number(data.replace('usr_delete_', ''));
    await pool.query('DELETE FROM users WHERE tg_id = $1', [tgId]);
    return editMessage(chatId, messageId, `🗑 Юзер <code>${tgId}</code> удалён.`,
      { inline_keyboard: [[{ text: '← К юзерам', callback_data: 'adm_users' }]] });
  }

  // ==== Промокоды ====
  if (data === 'adm_promo_menu') {
    return editMessage(chatId, messageId, '🎁 <b>Промокоды</b>', promoMenuKeyboard());
  }

  if (data === 'adm_promo_create') {
    return editMessage(chatId, messageId, '🎁 <b>Создание промокода</b>\n\nВыбери номинал:', promoTypesKeyboard());
  }

  if (data.startsWith('adm_create_')) {
    const type = data.replace('adm_create_', '');
    let tries = 2, unlimited = false;
    if (type === 'unlimited') unlimited = true;
    else tries = Number(type) || 2;
    const code = randomCode();
    try {
      await pool.query(
        `INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active)
         VALUES ($1, $2, $3, 1000, TRUE)`,
        [code, tries, unlimited]
      );
      const reward = unlimited ? '💎 Безлимит 24 часа' : `🎁 +${tries} попыток`;
      return editMessage(chatId, messageId,
        `✅ <b>Промокод создан</b>\n\n🔑 Код: <code>${code}</code>\n${reward}\n📊 Лимит: 1000 активаций`,
        {
          inline_keyboard: [
            [{ text: '➕ Создать ещё', callback_data: 'adm_promo_create' }],
            [{ text: '← Назад', callback_data: 'adm_promo_menu' }],
          ],
        });
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
    }
  }

  if (data === 'adm_promo_list') {
    const r = await pool.query(
      `SELECT code, tries, unlimited, used_count, max_uses, is_active
       FROM promo_codes ORDER BY created_at DESC LIMIT 20`
    );
    if (!r.rows.length) return editMessage(chatId, messageId, '📋 Промокодов нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
    let m = '📋 <b>Промокоды:</b>\n\n';
    for (const p of r.rows) {
      m += `<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' · ⛔'}\n`;
    }
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
  }

  if (data === 'adm_promo_delete') {
    const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`);
    if (!r.rows.length) return editMessage(chatId, messageId, '❌ Активных нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
    const btns = r.rows.map(p => ([{ text: '❌ ' + p.code, callback_data: 'adm_del_' + p.code }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_promo_menu' }]);
    return editMessage(chatId, messageId, 'Выбери промокод для деактивации:', { inline_keyboard: btns });
  }

  if (data.startsWith('adm_del_')) {
    const code = data.replace('adm_del_', '');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    return editMessage(chatId, messageId, `✅ Промокод <code>${code}</code> деактивирован`,
      {
        inline_keyboard: [
          [{ text: '❌ Ещё', callback_data: 'adm_promo_delete' }],
          [{ text: '← Назад', callback_data: 'adm_promo_menu' }],
        ],
      });
  }

  // ==== Модерация каталога ====
  if (data === 'adm_moderate') {
    return editMessage(chatId, messageId,
      '📌 <b>Каталог: модерация</b>\n\nЧто сделать с товаром?',
      catalogMenuKeyboard());
  }

  if (['adm_pin', 'adm_unpin', 'adm_hide', 'adm_unhide'].includes(data)) {
    const action = data.replace('adm_', '');
    awaitingModeration.set(userId, action);
    const prompts = {
      pin: '📌 Отправь <b>wb_id</b> товара для закрепления:',
      unpin: '✂️ Отправь <b>wb_id</b> товара для открепления:',
      hide: '🙈 Отправь <b>wb_id</b> товара, чтобы скрыть:',
      unhide: '👁 Отправь <b>wb_id</b> товара, чтобы вернуть:',
    };
    return editMessage(chatId, messageId, prompts[action],
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_moderate' }]] });
  }

  // ==== Добавить товары по ссылкам ====
  if (data === 'adm_add_links') {
    awaitingLinks.add(userId);
    return editMessage(chatId, messageId,
      `➕ <b>Добавить товары по ссылкам</b>\n\n` +
      `Отправь <b>одним сообщением</b> одну или несколько ссылок WB. Можно:\n\n` +
      `• Полные ссылки: <code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>\n` +
      `• Просто артикулы: <code>183581368</code>\n\n` +
      `Можно миксовать и разделять пробелами, запятыми или переносами строк. Я вытащу все артикулы и добавлю их в каталог.`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  // ==== Очистка ====
  if (data === 'adm_cleanup') {
    try {
      const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
      return editMessage(chatId, messageId,
        `🧹 Очистка выполнена.\nУдалено товаров старше 5 дней: <b>${r.rows[0].deleted_count}</b>`,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    }
  }

  // ==== Рассылка ====
  if (data === 'adm_broadcast') {
    awaitingBroadcast.add(userId);
    return editMessage(chatId, messageId,
      '📢 <b>Рассылка</b>\n\nНапиши текст сообщения — он уйдёт всем юзерам.',
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }
}

// ==== Обработка ввода: рассылка ====
async function handleBroadcastText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingBroadcast.has(userId)) return false;
  awaitingBroadcast.delete(userId);
  const r = await pool.query('SELECT tg_id FROM users');
  let sent = 0, fail = 0;
  for (const u of r.rows) {
    try {
      await sendMessage(u.tg_id, msg.text);
      sent++;
      if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000));
    } catch { fail++; }
  }
  await sendMessage(chatId, `✅ Отправлено: <b>${sent}</b>, ошибок: <b>${fail}</b>`, mainAdminKeyboard());
  return true;
}

// ==== Обработка ввода: модерация ====
async function handleModerationText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const action = awaitingModeration.get(userId);
  if (!action) return false;

  const wbId = Number(msg.text.trim());
  if (!wbId) { await sendMessage(chatId, '❌ Введи числовой wb_id'); return true; }

  awaitingModeration.delete(userId);
  try {
    const exists = await pool.query('SELECT id, name FROM products WHERE wb_id = $1', [wbId]);
    if (!exists.rows.length) {
      await sendMessage(chatId, `❌ Товар ${wbId} не найден`, mainAdminKeyboard());
      return true;
    }
    const name = exists.rows[0].name;
    if (action === 'pin') await pool.query('UPDATE products SET is_pinned = TRUE WHERE wb_id = $1', [wbId]);
    if (action === 'unpin') await pool.query('UPDATE products SET is_pinned = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'hide') await pool.query('UPDATE products SET is_active = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'unhide') await pool.query('UPDATE products SET is_active = TRUE WHERE wb_id = $1', [wbId]);
    await sendMessage(chatId, `✅ Готово: <b>${name}</b>`, mainAdminKeyboard());
    return true;
  } catch (e) {
    await sendMessage(chatId, '❌ ' + e.message, mainAdminKeyboard());
    return true;
  }
}

// ==== Обработка ввода: поиск юзера ====
async function handleUserSearch(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingUserSearch.has(userId)) return false;
  awaitingUserSearch.delete(userId);

  const q = msg.text.trim();
  try {
    let r;
    if (/^\d+$/.test(q)) {
      r = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [Number(q)]);
    } else if (q.startsWith('@')) {
      r = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [q.slice(1)]);
    } else {
      r = await pool.query('SELECT tg_id FROM users WHERE LOWER(first_name) LIKE LOWER($1) LIMIT 20', [`%${q}%`]);
    }

    if (!r.rows.length) {
      await sendMessage(chatId, `❌ Никого не найдено по <code>${q}</code>`, mainAdminKeyboard());
      return true;
    }

    if (r.rows.length === 1) {
      return showUserCard(chatId, null, r.rows[0].tg_id, `Найден по "${q}"`);
    }

    const btns = r.rows.map(u => ([{ text: `ID ${u.tg_id}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    await sendMessage(chatId, `🔍 Найдено ${r.rows.length}:`, { inline_keyboard: btns });
    return true;
  } catch (e) {
    await sendMessage(chatId, '❌ ' + e.message, mainAdminKeyboard());
    return true;
  }
}

// ==== Обработка ввода: своё число примерок ====
async function handleAddCustomText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingAddCustom.has(userId)) return false;
  const targetTgId = awaitingAddCustom.get(userId);
  awaitingAddCustom.delete(userId);

  const n = Number(msg.text.trim());
  if (!Number.isFinite(n) || n === 0) {
    await sendMessage(chatId, '❌ Введи число (например 100 или -5)');
    return true;
  }

  await pool.query('UPDATE users SET balance = GREATEST(0, balance + $1) WHERE tg_id = $2', [n, targetTgId]);
  await showUserCard(chatId, null, targetTgId, `${n > 0 ? 'Начислено +' : 'Списано '}${n}`);
  return true;
}

// ==== Обработка ввода: пачка ссылок ====
async function handleLinksText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingLinks.has(userId)) return false;
  awaitingLinks.delete(userId);

  const ids = extractWbIds(msg.text);
  if (!ids.length) {
    await sendMessage(chatId,
      `❌ Не нашёл ни одного артикула.\n\nПример:\n<code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>\nили просто <code>183581368</code>`,
      mainAdminKeyboard());
    return true;
  }

  await sendMessage(chatId, `⏳ Обрабатываю ${ids.length} товаров…`);

  let added = 0, failed = 0;
  const results = [];

  for (const wbId of ids) {
    try {
      const info = await fetchWBProductInfo(wbId);
      const name = info?.name || `Товар WB ${wbId}`;
      const price = info?.price || null;
      const category = guessCategory(name);
      const imageUrl = primaryImageUrl(wbId);
      const fallbackUrl = fallbackImageUrl(wbId);

      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',NOW(),NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name = EXCLUDED.name, price = EXCLUDED.price, category = EXCLUDED.category,
           image_url = EXCLUDED.image_url, fallback_url = EXCLUDED.fallback_url,
           is_active = TRUE, updated_at = NOW()`,
        [wbId, name, price, category, imageUrl, fallbackUrl]
      );
      added++;
      results.push(`✅ <code>${wbId}</code> — ${name.slice(0, 40)}`);
    } catch (e) {
      failed++;
      results.push(`❌ <code>${wbId}</code> — ${e.message}`);
    }
  }

  await sendMessage(chatId,
    `📦 <b>Готово</b>\n\n✅ Добавлено: <b>${added}</b>\n❌ Ошибок: <b>${failed}</b>\n\n` +
    results.slice(0, 30).join('\n') +
    (results.length > 30 ? `\n…и ещё ${results.length - 30}` : ''),
    mainAdminKeyboard());
  return true;
}

function guessCategory(name) {
  const n = (name || '').toLowerCase();
  if (/(очки|оправа|повязк|ободок|заколк|шарф|бандана|сумк)/.test(n)) return 'accessory';
  if (/(пальто|тренч|пуховик|шуба|плащ|ветровка|бомбер|дубленка|кожанк|куртк|жилет)/.test(n)) return 'outerwear';
  if (/(костюм|комплект)/.test(n)) return 'suit';
  if (/(платье|сарафан|юбка)/.test(n)) return 'dress';
  if (/(блузка|рубашк|топ|майка|футболка|боди|корсет|водолазк|поло|лонгслив|кроп|бандо|худи|свитер|кардиган|джемпер|кофт)/.test(n)) return 'top';
  if (/(брюк|джинс|штан|лосины|леггинс|шорт|карго)/.test(n)) return 'bottom';
  return 'top';
}

// ============================================================
// 12. WEBHOOK
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
    try { await handleCallback(update.callback_query); } catch (e) { console.error('[cb]', e); }
    return res.sendStatus(200);
  }

  if (update.message?.text) {
    const text = update.message.text.trim();

    // Сначала пробуем состояния
    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleModerationText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleUserSearch(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleLinksText(update.message).catch(() => false)) return res.sendStatus(200);

    // Потом команды
    if (text === '/start') { await handleStart(update.message); return res.sendStatus(200); }
    if (text === '/admin' || text === '/menu') { await handleAdminMenu(update.message); return res.sendStatus(200); }
    return res.sendStatus(200);
  }

  if (update.message?.successful_payment) {
    const pay = update.message.successful_payment;
    const parts = (pay.invoice_payload || '').split(':');
    const productType = parts[0];
    const tgId = Number(parts[1]);
    const chargeId = pay.telegram_payment_charge_id;
    try {
      const dup = await pool.query('SELECT 1 FROM payments WHERE charge_id = $1', [chargeId]);
      if (!dup.rows.length) {
        await pool.query(
          'INSERT INTO payments (charge_id, tg_id, product, stars) VALUES ($1,$2,$3,$4)',
          [chargeId, tgId, productType, pay.total_amount]
        );
        if (productType === 'pack10') {
          await pool.query('UPDATE users SET balance = balance + 10 WHERE tg_id = $1', [tgId]);
        } else if (productType === 'custom_tries') {
          const n = Number(parts[2]) || 1;
          await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [n, tgId]);
        } else if (SUBSCRIPTIONS[productType]) {
          const sub = SUBSCRIPTIONS[productType];
          await pool.query(
            `UPDATE users SET balance = balance + $1, own_tries = own_tries + $2, sub_active = TRUE WHERE tg_id = $3`,
            [sub.tries, sub.own || 0, tgId]
          );
        }
      }
    } catch (e) { console.error('[webhook]', e); }
  }
  res.sendStatus(200);
});

// ============================================================
// 13. HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });

cron.schedule('0 3 * * *', async () => {
  try {
    const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
    console.log(`[cron] cleanup: удалено ${r.rows[0].deleted_count}`);
  } catch (e) { console.error('[cron] cleanup error:', e); }
});

pool.query('SELECT COUNT(*)::int AS c FROM products')
  .then(r => { if (r.rows[0].c === 0) refreshCatalog(); })
  .catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
