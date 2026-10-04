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
    let saved = 0;
    let skippedDup = 0;
    for (const it of items) {
      if (!it.wb_id || !it.image_url || !it.category) continue;

      // Проверка на дубль по названию
      const nameCheck = await pool.query(
        `SELECT id FROM products WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
        [it.name]
      );
      if (nameCheck.rows.length > 0) {
        skippedDup++;
        continue;
      }

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
    console.log(`[sync] saved ${saved}, skipped dups ${skippedDup}`);
    res.json({ success: true, saved, skipped: skippedDup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 4. CATALOG — с ЧЕРЕДОВАНИЕМ категорий
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

    // ✅ ROW_NUMBER() — нумерует товары внутри каждой категории.
    // Order by rn ASC = товары идут вперемешку: dress-1, top-1, bottom-1, dress-2, top-2, ...
    const q = `
      WITH ranked AS (
        SELECT
          id, wb_id, name, price, category, image_url, fallback_url, is_pinned,
          ROW_NUMBER() OVER (
            PARTITION BY category
            ORDER BY updated_at DESC, id DESC
          ) AS rn
        FROM products ${where}
      )
      SELECT id, wb_id, name, price, category, image_url, fallback_url
      FROM ranked
      ORDER BY
        is_pinned DESC NULLS LAST,
        rn ASC,
        MD5(category || id::text) ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const r = await pool.query(q, params);
    res.json({ success: true, items: r.rows });
  } catch (e) {
    console.error('[catalog]', e);
    res.status(500).json({ error: 'Server error' });
  }
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
      console.warn('[tryon] fal failed, mock:', e.message);
      resultUrl = garmentUrl;
      isMock = true;
    }

    await pool.query(
      `INSERT INTO tryon_history (user_id, product_id, result_url, is_mock, category) VALUES ($1,$2,$3,$4,$5)`,
      [tgId, itemId ? Number(itemId) : null, resultUrl, isMock, category || null]
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
    } catch (e) { console.error('[push]', e.message); }

    if (user.ref_by && !user.ref_rewarded && !isMock) {
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + 3 WHERE tg_id = $1', [user.ref_by]);
      sendMessage(user.ref_by, '🎉 Ваша подруга сделала первую примерку! +3 попытки ✨').catch(() => {});
    }

    res.json({ success: true, resultUrl, isMock });
  } catch (e) {
    console.error('[tryon]', e);
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
      `SELECT th.id, th.result_url, th.is_mock, th.created_at, th.category,
              p.name AS product_name, p.wb_id AS product_wb_id
       FROM tryon_history th
       LEFT JOIN products p ON p.id = th.product_id
       WHERE th.user_id = $1
       ORDER BY th.created_at DESC LIMIT 50`,
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
  } else if (productType === 'pass24h') {
    title = 'Суточный безлимит (24 ч)'; amount = 250;
    payload = `pass24h:${tgId}:${Date.now()}`;
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
// 10. CLEANUP — ручной запуск
// ============================================================
app.post('/api/cleanup', async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'GF_ROOM_2024_SECRET') return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
    res.json({ success: true, deleted: r.rows[0].deleted_count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 11. АДМИН-ПАНЕЛЬ
// ============================================================
function adminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }, { text: '👥 Юзеры', callback_data: 'adm_users' }],
      [{ text: '🎁 Создать промокод', callback_data: 'adm_promo_create' }],
      [{ text: '📋 Список промокодов', callback_data: 'adm_promo_list' }, { text: '❌ Удалить промокод', callback_data: 'adm_promo_delete' }],
      [{ text: '📌 Модерация каталога', callback_data: 'adm_moderate' }],
      [{ text: '🧹 Очистить старые', callback_data: 'adm_cleanup' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
    ],
  };
}

function promoTypesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '+2 попытки', callback_data: 'adm_create_2' }, { text: '+5 попыток', callback_data: 'adm_create_5' }],
      [{ text: '+10 попыток', callback_data: 'adm_create_10' }, { text: '+20 попыток', callback_data: 'adm_create_20' }],
      [{ text: '💎 Безлимит 24ч', callback_data: 'adm_create_unlimited' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

function randomCode(prefix = 'WELCOME') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${suffix}`;
}

const awaitingBroadcast = new Set();
const awaitingModeration = new Map();

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const isAdm = await isAdmin(msg.from.id);
  if (isAdm) {
    await sendMessage(chatId, '👑 <b>Админ-панель</b>\n\nВыбери действие:', adminKeyboard());
  } else {
    await sendMessage(chatId, '✨ Добро пожаловать в Style Room!\n\nНажми кнопку ниже, чтобы открыть приложение.');
  }
}

async function handleAdminMenu(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(msg.from.id))) return sendMessage(chatId, '⛔ Нет доступа.');
  await sendMessage(chatId, '👑 <b>Админ-панель</b>\n\nВыбери действие:', adminKeyboard());
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;

  if (!(await isAdmin(userId))) return answerCallback(cb.id, '⛔ Нет доступа');
  await answerCallback(cb.id);

  if (data === 'adm_back') {
    return editMessage(chatId, messageId, '👑 <b>Админ-панель</b>\n\nВыбери действие:', adminKeyboard());
  }

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
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] }
    );
  }

  if (data === 'adm_users') {
    const r = await pool.query(`SELECT first_name, username, balance FROM users ORDER BY created_at DESC LIMIT 15`);
    let m = '👥 <b>Последние юзеры:</b>\n';
    for (const u of r.rows) m += `\n• ${u.first_name || '—'} · @${u.username || '—'} · ✨${u.balance}`;
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
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
        `INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active) VALUES ($1, $2, $3, 1000, TRUE)`,
        [code, tries, unlimited]
      );
      const reward = unlimited ? '💎 Безлимит 24 часа' : `🎁 +${tries} попыток`;
      return editMessage(chatId, messageId,
        `✅ <b>Промокод создан</b>\n\n🔑 Код: <code>${code}</code>\n${reward}\n📊 Лимит: 1000 активаций`,
        {
          inline_keyboard: [
            [{ text: '🎁 Создать ещё', callback_data: 'adm_promo_create' }],
            [{ text: '← Назад', callback_data: 'adm_back' }],
          ],
        }
      );
    } catch (e) {
      return editMessage(chatId, messageId, '❌ Ошибка: ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    }
  }

  if (data === 'adm_promo_list') {
    const r = await pool.query(
      `SELECT code, tries, unlimited, used_count, max_uses, is_active FROM promo_codes ORDER BY created_at DESC LIMIT 20`
    );
    if (!r.rows.length) return editMessage(chatId, messageId, '📋 Промокодов нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    let m = '📋 <b>Промокоды:</b>\n';
    for (const p of r.rows) {
      m += `\n<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' · ⛔'}`;
    }
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
  }

  if (data === 'adm_promo_delete') {
    const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`);
    if (!r.rows.length) return editMessage(chatId, messageId, '❌ Активных нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    const buttons = r.rows.map(p => ([{ text: '❌ ' + p.code, callback_data: 'adm_del_' + p.code }]));
    buttons.push([{ text: '← Назад', callback_data: 'adm_back' }]);
    return editMessage(chatId, messageId, 'Выбери промокод для удаления:', { inline_keyboard: buttons });
  }

  if (data.startsWith('adm_del_')) {
    const code = data.replace('adm_del_', '');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    return editMessage(chatId, messageId, `✅ Промокод <code>${code}</code> деактивирован`,
      {
        inline_keyboard: [
          [{ text: '❌ Удалить ещё', callback_data: 'adm_promo_delete' }],
          [{ text: '← Назад', callback_data: 'adm_back' }],
        ],
      });
  }

  if (data === 'adm_moderate') {
    return editMessage(chatId, messageId, '📌 <b>Модерация каталога</b>', {
      inline_keyboard: [
        [{ text: '📌 Закрепить', callback_data: 'adm_pin' }, { text: '✂️ Открепить', callback_data: 'adm_unpin' }],
        [{ text: '🙈 Скрыть', callback_data: 'adm_hide' }, { text: '👁 Вернуть', callback_data: 'adm_unhide' }],
        [{ text: '← Назад', callback_data: 'adm_back' }],
      ],
    });
  }

  if (['adm_pin', 'adm_unpin', 'adm_hide', 'adm_unhide'].includes(data)) {
    const action = data.replace('adm_', '');
    awaitingModeration.set(userId, action);
    const prompts = {
      pin: '📌 Напиши <b>wb_id</b> товара для закрепления:',
      unpin: '✂️ Напиши <b>wb_id</b> товара для открепления:',
      hide: '🙈 Напиши <b>wb_id</b> товара, чтобы скрыть:',
      unhide: '👁 Напиши <b>wb_id</b> товара, чтобы вернуть:',
    };
    return editMessage(chatId, messageId, prompts[action],
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_moderate' }]] });
  }

  if (data === 'adm_cleanup') {
    try {
      const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
      const cnt = r.rows[0].deleted_count;
      return editMessage(chatId, messageId,
        `🧹 <b>Очистка выполнена</b>\n\nУдалено товаров старше 5 дней: <b>${cnt}</b>`,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    } catch (e) {
      return editMessage(chatId, messageId, '❌ Ошибка: ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    }
  }

  if (data === 'adm_broadcast') {
    awaitingBroadcast.add(userId);
    return editMessage(chatId, messageId,
      '📢 <b>Рассылка</b>\n\nНапиши текст сообщения.',
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }
}

async function handleBroadcastText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingBroadcast.has(userId)) return false;
  awaitingBroadcast.delete(userId);
  const text = msg.text;
  const r = await pool.query('SELECT tg_id FROM users');
  let sent = 0, fail = 0;
  for (const u of r.rows) {
    try {
      await sendMessage(u.tg_id, text);
      sent++;
      if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000));
    } catch { fail++; }
  }
  await sendMessage(chatId, `✅ Отправлено: <b>${sent}</b>, ошибок: <b>${fail}</b>`, adminKeyboard());
  return true;
}

async function handleModerationText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const action = awaitingModeration.get(userId);
  if (!action) return false;

  const wbId = Number(msg.text.trim());
  if (!wbId) {
    await sendMessage(chatId, '❌ Введи числовой wb_id');
    return true;
  }

  awaitingModeration.delete(userId);

  try {
    const exists = await pool.query('SELECT id, name FROM products WHERE wb_id = $1', [wbId]);
    if (!exists.rows.length) {
      await sendMessage(chatId, `❌ Товар ${wbId} не найден`, adminKeyboard());
      return true;
    }
    const name = exists.rows[0].name;
    if (action === 'pin') await pool.query('UPDATE products SET is_pinned = TRUE WHERE wb_id = $1', [wbId]);
    if (action === 'unpin') await pool.query('UPDATE products SET is_pinned = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'hide') await pool.query('UPDATE products SET is_active = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'unhide') await pool.query('UPDATE products SET is_active = TRUE WHERE wb_id = $1', [wbId]);
    await sendMessage(chatId, `✅ Готово: <b>${name}</b>`, adminKeyboard());
    return true;
  } catch (e) {
    await sendMessage(chatId, '❌ ' + e.message, adminKeyboard());
    return true;
  }
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

    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleModerationText(update.message).catch(() => false)) return res.sendStatus(200);

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
        } else if (productType === 'pass24h') {
          const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [until, tgId]);
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

// Обновление WB-каталога — каждые 12 часов (00:00 и 12:00)
cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });

// Автоочистка старых товаров — каждый день в 3:00
cron.schedule('0 3 * * *', async () => {
  try {
    console.log('[cron] cleanup: удаление товаров старше 5 дней');
    const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
    console.log(`[cron] cleanup: удалено ${r.rows[0].deleted_count} товаров`);
  } catch (e) {
    console.error('[cron] cleanup error:', e);
  }
});

pool.query('SELECT COUNT(*)::int AS c FROM products')
  .then(r => { if (r.rows[0].c === 0) refreshCatalog(); })
  .catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
