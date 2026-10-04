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
const sendMessage = (chatId, text, keyboard = null) =>
  tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const editMessage = (chatId, messageId, text, keyboard = null) =>
  tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const answerCallback = (callbackId, text = '') =>
  tgApi('answerCallbackQuery', { callback_query_id: callbackId, text });

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

function extractWbIds(text) {
  const ids = new Set();
  let m;
  const re1 = /\/catalog\/(\d{6,})/g;
  while ((m = re1.exec(text)) !== null) ids.add(Number(m[1]));
  const re2 = /\b(\d{6,})\b/g;
  while ((m = re2.exec(text)) !== null) ids.add(Number(m[1]));
  return Array.from(ids);
}

async function fetchWBProductInfo(wbId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Origin': 'https://www.wildberries.ru',
    'Referer': 'https://www.wildberries.ru/',
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
      if (p1?.name) return { wb_id: wbId, name: p1.name, price: p1.salePriceU ? `${Math.round(p1.salePriceU/100).toLocaleString('ru-RU')} ₽` : null };
      const name2 = data?.imt_name || data?.subj_name;
      if (name2) {
        const price2 = data?.sizes?.[0]?.price?.total ? `${Math.round(data.sizes[0].price.total/100).toLocaleString('ru-RU')} ₽` : null;
        return { wb_id: wbId, name: name2, price: price2 };
      }
      if (data?.name) return { wb_id: wbId, name: data.name, price: null };
    } catch {}
  }
  return null;
}

function guessCategory(name) {
  const n = (name || '').toLowerCase();
  if (/(очки|оправа|повязк|ободок|заколк|шарф|бандана|сумк|ремень|браслет|серьг|цепочк)/.test(n)) return 'accessory';
  if (/(пальто|тренч|пуховик|шуба|плащ|ветровка|бомбер|дубленка|кожанк|куртк|жилет)/.test(n)) return 'outerwear';
  if (/(костюм|комплект)/.test(n)) return 'suit';
  if (/(платье|сарафан|юбка)/.test(n)) return 'dress';
  if (/(блузка|рубашк|топ|майка|футболка|боди|корсет|водолазк|поло|лонгслив|кроп|бандо|худи|свитер|кардиган|джемпер|кофт)/.test(n)) return 'top';
  if (/(брюк|джинс|штан|лосины|леггинс|шорт|карго)/.test(n)) return 'bottom';
  return 'top';
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
        `INSERT INTO users (tg_id, username, first_name, photo_url, balance, own_tries, sub_active, ref_by, last_active)
         VALUES ($1,$2,$3,$4,3,0,FALSE,$5,NOW()) RETURNING *`,
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
    console.error('[auth]', e.message);
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
  const okHosts = [/\.wbbasket\.ru$/, /\.wbstatic\.net$/, /\.geobasket\.ru$/, /^lh3\.googleusercontent\.com$/, /^drive\.google\.com$/];
  if (!okHosts.some(rx => rx.test(parsed.hostname))) return res.status(400).send('Bad host');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.wildberries.ru/' } });
    if (!r.ok) return res.status(404).send('Not found');
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(buf);
  } catch { res.status(500).send('Proxy error'); }
});

// ============================================================
// 3. CATALOG
// ============================================================
app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 300, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE is_active = TRUE';
    if (category && category !== 'all') { params.push(category); where += ` AND category = $${params.length}`; }
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
// 4. TRYON (3 модели по очереди)
// ============================================================
const TRYON_MODELS = [
  {
    name: 'fashn/v1.6',
    id: 'fal-ai/fashn/tryon/v1.6',
    build: ({ humanImg, garmentUrl, category }) => ({
      model_image: humanImg,
      garment_image: garmentUrl,
      category: category === 'accessory' ? 'accessories' : 'auto',
    }),
    extract: (r) => r?.data?.image?.url || r?.data?.images?.[0]?.url || null,
  },
  {
    name: 'image-apps/v2',
    id: 'fal-ai/image-apps-v2/virtual-try-on',
    build: ({ humanImg, garmentUrl }) => ({
      person_image_url: humanImg,
      clothing_image_url: garmentUrl,
    }),
    extract: (r) => r?.data?.image?.url || r?.data?.images?.[0]?.url || null,
  },
  {
    name: 'kling/kolors',
    id: 'fal-ai/kling/v1-5/kolors-virtual-try-on',
    build: ({ humanImg, garmentUrl }) => ({
      human_image_url: humanImg,
      garment_image_url: garmentUrl,
    }),
    extract: (r) => r?.data?.image?.url || r?.data?.images?.[0]?.url || null,
  },
];

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
        if (user.balance <= 0) return res.status(402).json({ error: 'Нет попыток' });
        await pool.query('UPDATE users SET balance = balance - 1 WHERE tg_id = $1', [tgId]);
      }
    }

    let resultUrl = null, isMock = false, usedModel = null;
    for (const m of TRYON_MODELS) {
      try {
        console.log(`[tryon] trying ${m.name}...`);
        const r = await fal.subscribe(m.id, { input: m.build({ humanImg, garmentUrl, category }), logs: false });
        const url = m.extract(r);
        if (url) {
          resultUrl = url;
          usedModel = m.name;
          console.log(`[tryon] ✅ ${m.name} success`);
          break;
        } else {
          console.warn(`[tryon] ${m.name} returned no url`);
        }
      } catch (e) {
        console.warn(`[tryon] ❌ ${m.name} failed: ${e.message}`);
      }
    }

    if (!resultUrl) {
      resultUrl = garmentUrl;
      isMock = true;
      console.warn('[tryon] all models failed → mock');
    }

    const productSnap = itemId
      ? await pool.query('SELECT wb_id, name, image_url FROM products WHERE id = $1', [itemId])
      : { rows: [] };
    const snap = productSnap.rows[0] || {};

    await pool.query(
      `INSERT INTO tryon_history
         (user_id, product_id, product_wb_id, product_name, product_image, result_url, is_mock, category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tgId, itemId ? Number(itemId) : null, snap.wb_id || null, snap.name || null, snap.image_url || null, resultUrl, isMock, category || null]
    );

    if (!isMock && resultUrl) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tgId, photo: resultUrl, caption: '✨ Твоя примерка готова!' }),
        });
      } catch {}
    }

    if (user.ref_by && !user.ref_rewarded && !isMock) {
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + 3 WHERE tg_id = $1', [user.ref_by]);
      sendMessage(user.ref_by, '🎉 Ваша подруга сделала первую примерку! +3 попытки ✨').catch(() => {});
    }

    res.json({ success: true, resultUrl, isMock, usedModel });
  } catch (e) {
    console.error('[tryon]', e.message);
    res.json({ success: false, error: 'Ошибка генерации' });
  }
});

// ============================================================
// 5. HISTORY
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
       FROM tryon_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [tgUser.id]
    );
    res.json({ success: true, items: r.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 6. REDEEM PROMO
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
      `SELECT * FROM promo_codes WHERE code = $1 AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())`,
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
    }
    await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [p.tries, tgId]);
    res.json({ success: true, tries: p.tries, unlimited: false });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 7. ONBOARDED
// ============================================================
app.post('/api/onboarded', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('UPDATE users SET onboarded = TRUE WHERE tg_id = $1', [tgUser.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// 8. INVOICE
// ============================================================
app.post('/api/create-invoice', async (req, res) => {
  const { tgId, productType, tries } = req.body;
  let title = '10 примерок одежды', amount = 50;
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
      body: JSON.stringify({ title, description: 'Оплата цифровых услуг', payload, currency: 'XTR', prices: [{ label: title, amount }] }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoiceLink: data.result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 9. АДМИН-ПАНЕЛЬ — полностью переработана
// ============================================================
function mainAdminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '👥 Пользователи', callback_data: 'adm_users' }],
      [{ text: '🔍 Найти пользователя', callback_data: 'adm_find' }],
      [{ text: '🎁 Промокоды', callback_data: 'adm_promo' }],
      [{ text: '🛍 Товары', callback_data: 'adm_products' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
      [{ text: '⚙️ Настройки', callback_data: 'adm_settings' }],
      [{ text: '❓ Помощь', callback_data: 'adm_help' }],
    ],
  };
}

function productsMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Добавить по ссылкам WB', callback_data: 'adm_add_links' }],
      [{ text: '✏️ Добавить вручную', callback_data: 'adm_add_manual' }],
      [{ text: '📌 Закрепить товар', callback_data: 'adm_pin' }],
      [{ text: '🙈 Скрыть товар', callback_data: 'adm_hide' }],
      [{ text: '👁 Вернуть товар', callback_data: 'adm_unhide' }],
      [{ text: '🗑 Удалить товар', callback_data: 'adm_delete' }],
      [{ text: '🔄 Обновить названия', callback_data: 'adm_backfill' }],
      [{ text: '🧹 Удалить товары старше 5 дней', callback_data: 'adm_cleanup' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

function promoMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Создать свой промокод', callback_data: 'adm_promo_custom' }],
      [{ text: '⚡ Быстрый: +2 попытки', callback_data: 'adm_promo_quick_2' }],
      [{ text: '⚡ Быстрый: +5 попыток', callback_data: 'adm_promo_quick_5' }],
      [{ text: '⚡ Быстрый: +10 попыток', callback_data: 'adm_promo_quick_10' }],
      [{ text: '⚡ Быстрый: +20 попыток', callback_data: 'adm_promo_quick_20' }],
      [{ text: '♾ Быстрый: безлимит 24 часа', callback_data: 'adm_promo_quick_unlimited' }],
      [{ text: '📋 Список промокодов', callback_data: 'adm_promo_list' }],
      [{ text: '🗑 Удалить промокод', callback_data: 'adm_promo_delete' }],
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
      [{ text: '🔍 Найти по имени / @username / ID', callback_data: 'adm_find' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

function userActionsKeyboard(tgId) {
  return {
    inline_keyboard: [
      [{ text: '➕ +5 попыток', callback_data: `usr_add_5_${tgId}` }, { text: '➕ +10', callback_data: `usr_add_10_${tgId}` }],
      [{ text: '➕ +25', callback_data: `usr_add_25_${tgId}` }, { text: '➕ +50', callback_data: `usr_add_50_${tgId}` }],
      [{ text: '➕ Своё число', callback_data: `usr_add_custom_${tgId}` }],
      [{ text: '🔄 Обнулить баланс', callback_data: `usr_reset_${tgId}` }],
      [{ text: '♾ Безлимит 24ч', callback_data: `usr_unlimit_${tgId}` }, { text: '❌ Снять', callback_data: `usr_unlimit_off_${tgId}` }],
      [{ text: '💎 Сделать админом', callback_data: `usr_admin_on_${tgId}` }, { text: '❌ Снять админа', callback_data: `usr_admin_off_${tgId}` }],
      [{ text: '📩 Написать юзеру', callback_data: `usr_dm_${tgId}` }],
      [{ text: '🗑 Удалить', callback_data: `usr_delete_${tgId}` }],
      [{ text: '← К юзерам', callback_data: 'adm_users' }],
    ],
  };
}

const awaitingBroadcast = new Set();
const awaitingUserSearch = new Set();
const awaitingAddCustom = new Map();
const awaitingLinks = new Set();
const awaitingLinksDesc = new Map();
const awaitingManualProduct = new Map();
const awaitingPromoCustom = new Map(); // userId → { step, code, tries, max_uses }
const awaitingProductAction = new Map(); // userId → action ('pin'|'hide'|'unhide'|'delete')
const awaitingDM = new Map(); // userId → targetTgId

function randomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  if (await isAdmin(msg.from.id)) {
    await sendMessage(chatId, '👑 <b>Админ-панель Style Room</b>\n\nВыбери раздел:', mainAdminKeyboard());
  } else {
    await sendMessage(chatId, '✨ Добро пожаловать в Style Room!\n\nНажми кнопку ниже, чтобы открыть приложение.');
  }
}

async function handleAdminMenu(msg) {
  if (!(await isAdmin(msg.from.id))) return sendMessage(msg.chat.id, '⛔ Нет доступа.');
  await sendMessage(msg.chat.id, '👑 <b>Админ-панель</b>\n\nВыбери раздел:', mainAdminKeyboard());
}

// ============================================================
// КНОПКИ
// ============================================================
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;

  if (!(await isAdmin(userId))) return answerCallback(cb.id, '⛔ Нет доступа');
  await answerCallback(cb.id);

  const back = () => editMessage(chatId, messageId, '👑 <b>Админ-панель</b>\n\nВыбери раздел:', mainAdminKeyboard());
  const backKb = { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] };

  if (data === 'adm_back') return back();

  if (data === 'adm_help') {
    return editMessage(chatId, messageId,
      `❓ <b>Помощь</b>\n\n` +
      `<b>📊 Статистика</b> — юзеры, примерки, платежи.\n\n` +
      `<b>👥 Пользователи</b> — список, карточка юзера с действиями.\n\n` +
      `<b>🔍 Найти</b> — по имени, @username или ID.\n\n` +
      `<b>🎁 Промокоды</b> — быстрые (+2/+5/+10/+20/безлимит) или свой код с любым текстом.\n\n` +
      `<b>🛍 Товары</b> — добавлять по ссылке WB (просто пришли ссылку), закрепить/скрыть/удалить.\n\n` +
      `<b>📢 Рассылка</b> — отправить сообщение всем.\n\n` +
      `<b>⚙️ Настройки</b> — выдать/снять админа.\n\n` +
      `💡 Везде, где раньше нужен был артикул, теперь можно просто прислать <b>ссылку Wildberries</b> — я сам вытащу всё нужное.`,
      backKb);
  }

  // ---------- СТАТИСТИКА ----------
  if (data === 'adm_stats') {
    const users = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(balance),0)::int AS b FROM users');
    const today = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at > NOW() - INTERVAL '1 day'`);
    const tryons = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history');
    const products = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = TRUE');
    const payments = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments');
    return editMessage(chatId, messageId,
      `📊 <b>Статистика</b>\n\n` +
      `👥 Юзеров: <b>${users.rows[0].c}</b>\n` +
      `🆕 За сутки: <b>${today.rows[0].c}</b>\n` +
      `✨ Примерок: <b>${tryons.rows[0].c}</b>\n` +
      `🛍 Товаров: <b>${products.rows[0].c}</b>\n` +
      `💳 Платежей: <b>${payments.rows[0].c}</b>\n` +
      `⭐️ Всего звёзд: <b>${payments.rows[0].s}</b>\n` +
      `💎 Сумма балансов: <b>${users.rows[0].b}</b>`,
      backKb);
  }

  // ---------- ЮЗЕРЫ ----------
  if (data === 'adm_users') return editMessage(chatId, messageId, '👥 <b>Пользователи</b>', usersMenuKeyboard());

  if (data === 'adm_users_last') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '👥 Пусто.', { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '👥 <b>Последние 20:</b>', { inline_keyboard: btns });
  }
  if (data === 'adm_users_top') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 20`);
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '💰 <b>Топ по балансу:</b>', { inline_keyboard: btns });
  }
  if (data === 'adm_users_new') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '🆕 Новых нет.', { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '🆕 <b>Новые за сутки:</b>', { inline_keyboard: btns });
  }
  if (data === 'adm_find') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId, '🔍 <b>Поиск</b>\n\nПришли имя, @username или ID одним сообщением.', { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  // ---------- КАРТОЧКА ЮЗЕРА ----------
  if (data.startsWith('usr_show_')) return showUserCard(chatId, messageId, Number(data.replace('usr_show_', '')));

  if (data.startsWith('usr_add_custom_')) {
    const tgId = Number(data.replace('usr_add_custom_', ''));
    awaitingAddCustom.set(userId, tgId);
    return editMessage(chatId, messageId, '➕ Введи число примерок (можно отрицательное):', { inline_keyboard: [[{ text: '❌ Отмена', callback_data: `usr_show_${tgId}` }]] });
  }
  if (/^usr_add_\d+_\d+$/.test(data)) {
    const [, , count, tgId] = data.split('_');
    await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [Number(count), Number(tgId)]);
    return showUserCard(chatId, messageId, Number(tgId), `Начислено +${count}`);
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
    await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [new Date(Date.now() + 86400000), tgId]);
    return showUserCard(chatId, messageId, tgId, 'Безлимит 24ч выдан');
  }
  if (data.startsWith('usr_admin_on_')) {
    const tgId = Number(data.replace('usr_admin_on_', ''));
    await pool.query('UPDATE users SET is_admin = TRUE WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, '👑 Теперь админ');
  }
  if (data.startsWith('usr_admin_off_')) {
    const tgId = Number(data.replace('usr_admin_off_', ''));
    await pool.query('UPDATE users SET is_admin = FALSE WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Больше не админ');
  }
  if (data.startsWith('usr_dm_')) {
    const tgId = Number(data.replace('usr_dm_', ''));
    awaitingDM.set(userId, tgId);
    return editMessage(chatId, messageId, `📩 <b>Сообщение юзеру</b> <code>${tgId}</code>\n\nОтправь текст:`, { inline_keyboard: [[{ text: '❌ Отмена', callback_data: `usr_show_${tgId}` }]] });
  }
  if (data.startsWith('usr_delete_')) {
    const tgId = Number(data.replace('usr_delete_', ''));
    await pool.query('DELETE FROM users WHERE tg_id = $1', [tgId]);
    return editMessage(chatId, messageId, `🗑 Юзер удалён.`, { inline_keyboard: [[{ text: '← К юзерам', callback_data: 'adm_users' }]] });
  }

  // ---------- ТОВАРЫ ----------
  if (data === 'adm_products') {
    return editMessage(chatId, messageId, '🛍 <b>Товары</b>\n\nВыбери действие:', productsMenuKeyboard());
  }
  if (data === 'adm_add_links') {
    awaitingLinks.add(userId);
    return editMessage(chatId, messageId,
      '➕ <b>Добавить товары по ссылкам WB</b>\n\n' +
      'Пришли <b>одним сообщением</b> одну или несколько ссылок Wildberries (или просто артикулы).\n\n' +
      'Пример:\n<code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>\n<code>183581368</code>',
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_products' }]] });
  }
  if (data === 'adm_add_manual') {
    awaitingManualProduct.set(userId, { step: 'wb_id' });
    return editMessage(chatId, messageId, '✏️ <b>Добавить вручную</b>\n\nШаг 1/5: пришли <b>ссылку WB</b> на товар.', { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_products' }]] });
  }
  if (['adm_pin', 'adm_hide', 'adm_unhide', 'adm_delete'].includes(data)) {
    const action = data.replace('adm_', '');
    awaitingProductAction.set(userId, action);
    const prompts = {
      pin: '📌 Пришли <b>ссылку WB</b> товара для закрепления наверху:',
      hide: '🙈 Пришли <b>ссылку WB</b> товара, чтобы скрыть:',
      unhide: '👁 Пришли <b>ссылку WB</b> товара, чтобы вернуть:',
      delete: '🗑 Пришли <b>ссылку WB</b> товара для удаления:',
    };
    return editMessage(chatId, messageId, prompts[action], { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_products' }]] });
  }
  if (data === 'adm_backfill') {
    return editMessage(chatId, messageId, '🔄 Обновляю названия товаров… Это может занять до минуты.', backKb).then(async () => {
      try {
        const r = await pool.query(`SELECT id, wb_id FROM products WHERE name LIKE 'Товар WB%' OR name IS NULL OR name = '' ORDER BY id DESC LIMIT 200`);
        let updated = 0, failed = 0;
        for (const row of r.rows) {
          const info = await fetchWBProductInfo(row.wb_id);
          if (info?.name && !info.name.startsWith('Товар WB')) {
            await pool.query(`UPDATE products SET name=$1, price=COALESCE($2, price), updated_at=NOW() WHERE id=$3`, [info.name, info.price, row.id]);
            updated++;
          } else failed++;
          await new Promise(rs => setTimeout(rs, 250));
        }
        await sendMessage(chatId, `✅ Обновлено: <b>${updated}</b>\nНе удалось: <b>${failed}</b>`, backKb);
      } catch (e) { await sendMessage(chatId, '❌ ' + e.message, backKb); }
    });
  }
  if (data === 'adm_cleanup') {
    try {
      const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
      return editMessage(chatId, messageId, `🧹 Удалено товаров старше 5 дней: <b>${r.rows[0].deleted_count}</b>`, backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  // ---------- ПРОМОКОДЫ ----------
  if (data === 'adm_promo') {
    return editMessage(chatId, messageId, '🎁 <b>Промокоды</b>\n\nВыбери действие:', promoMenuKeyboard());
  }
  if (data === 'adm_promo_custom') {
    awaitingPromoCustom.set(userId, { step: 'code' });
    return editMessage(chatId, messageId, '🎁 <b>Свой промокод</b>\n\nШаг 1/3: введи <b>код</b> (латиница/цифры, до 20 символов).\n\nНапример: <code>SALE10</code>', { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_promo' }]] });
  }
  if (data.startsWith('adm_promo_quick_')) {
    const type = data.replace('adm_promo_quick_', '');
    const code = randomCode();
    let tries = 0, unlimited = false;
    if (type === 'unlimited') unlimited = true; else tries = Number(type);
    await pool.query(
      `INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label)
       VALUES ($1, $2, $3, 1000, TRUE, $4)`,
      [code, tries, unlimited, unlimited ? 'Безлимит 24ч' : `+${tries} попыток`]
    );
    return editMessage(chatId, messageId,
      `✅ <b>Промокод создан</b>\n\n🔑 Код: <code>${code}</code>\n🎁 ${unlimited ? 'Безлимит 24 часа' : `+${tries} попыток`}\n📊 Лимит: 1000 активаций`,
      { inline_keyboard: [[{ text: '🎁 Промокоды', callback_data: 'adm_promo' }]] });
  }
  if (data === 'adm_promo_list') {
    const r = await pool.query(`SELECT code, tries, unlimited, used_count, max_uses, is_active, label FROM promo_codes ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '📋 Промокодов пока нет.', { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo' }]] });
    let m = '📋 <b>Промокоды:</b>\n\n';
    for (const p of r.rows) {
      m += `<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' · ⛔'}\n`;
    }
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo' }]] });
  }
  if (data === 'adm_promo_delete') {
    const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`);
    if (!r.rows.length) return editMessage(chatId, messageId, '❌ Активных нет.', { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo' }]] });
    const btns = r.rows.map(p => [{ text: '❌ ' + p.code, callback_data: 'adm_promodel_' + p.code }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_promo' }]);
    return editMessage(chatId, messageId, 'Выбери промокод для деактивации:', { inline_keyboard: btns });
  }
  if (data.startsWith('adm_promodel_')) {
    const code = data.replace('adm_promodel_', '');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    return editMessage(chatId, messageId, `✅ Промокод <code>${code}</code> деактивирован.`, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo' }]] });
  }

  // ---------- РАССЫЛКА ----------
  if (data === 'adm_broadcast') {
    awaitingBroadcast.add(userId);
    return editMessage(chatId, messageId, '📢 <b>Рассылка</b>\n\nНапиши текст — уйдёт всем юзерам.', { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  // ---------- НАСТРОЙКИ ----------
  if (data === 'adm_settings') {
    const admins = await pool.query(`SELECT tg_id, first_name, username FROM users WHERE is_admin = TRUE ORDER BY created_at`);
    let m = '⚙️ <b>Настройки</b>\n\n👑 <b>Администраторы:</b>\n';
    for (const a of admins.rows) m += `• ${a.first_name || '—'} @${a.username || '—'} · <code>${a.tg_id}</code>\n`;
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '👥 Управлять админами', callback_data: 'adm_users' }], [{ text: '← Назад', callback_data: 'adm_back' }]] });
  }
}

async function showUserCard(chatId, messageId, tgId, toast = null) {
  try {
    const r = await pool.query(
      `SELECT tg_id, first_name, username, balance, own_tries, sub_active, unlimited_until, is_admin, created_at, last_active,
              (SELECT COUNT(*)::int FROM tryon_history WHERE user_id = users.tg_id) AS total_tryons,
              (SELECT COUNT(*)::int FROM payments WHERE tg_id = users.tg_id) AS payments
       FROM users WHERE tg_id = $1`,
      [tgId]
    );
    if (!r.rows.length) {
      const txt = `❌ Юзер <code>${tgId}</code> не найден.`;
      return messageId ? editMessage(chatId, messageId, txt, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] })
                       : sendMessage(chatId, txt, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    }
    const u = r.rows[0];
    const unlimText = u.unlimited_until && new Date(u.unlimited_until) > new Date()
      ? `♾ до ${new Date(u.unlimited_until).toLocaleString('ru-RU')}` : 'нет';

    const text =
      `${toast ? '✅ ' + toast + '\n\n' : ''}` +
      `👤 <b>${u.first_name || 'Без имени'}</b>\n🔗 @${u.username || '—'}\n🆔 <code>${u.tg_id}</code>${u.is_admin ? '\n👑 админ' : ''}\n\n` +
      `✨ Обычных: <b>${u.balance}</b>\n📦 Своих: <b>${u.own_tries}</b>\n🎨 Примерок: <b>${u.total_tryons}</b>\n💳 Платежей: <b>${u.payments}</b>\n\n` +
      `💎 Подписка: ${u.sub_active ? 'да' : 'нет'}\n♾ Безлимит: ${unlimText}\n` +
      `📅 Создан: ${new Date(u.created_at).toLocaleDateString('ru-RU')}\n🕐 Был: ${u.last_active ? new Date(u.last_active).toLocaleString('ru-RU') : '—'}`;

    const kb = userActionsKeyboard(tgId);
    return messageId ? editMessage(chatId, messageId, text, kb) : sendMessage(chatId, text, kb);
  } catch (e) {
    const txt = '❌ Ошибка: ' + e.message;
    return messageId ? editMessage(chatId, messageId, txt) : sendMessage(chatId, txt);
  }
}

// ============================================================
// TEXT HANDLERS
// ============================================================
async function handleBroadcastText(msg) {
  if (!awaitingBroadcast.has(msg.from.id)) return false;
  awaitingBroadcast.delete(msg.from.id);
  const r = await pool.query('SELECT tg_id FROM users');
  let sent = 0, fail = 0;
  for (const u of r.rows) {
    try {
      await sendMessage(u.tg_id, msg.text);
      sent++;
      if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000));
    } catch { fail++; }
  }
  await sendMessage(msg.chat.id, `✅ Отправлено: <b>${sent}</b>, ошибок: <b>${fail}</b>`, mainAdminKeyboard());
  return true;
}

async function handleUserSearch(msg) {
  if (!awaitingUserSearch.has(msg.from.id)) return false;
  awaitingUserSearch.delete(msg.from.id);
  const q = msg.text.trim();
  try {
    let r;
    if (/^\d+$/.test(q)) r = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [Number(q)]);
    else if (q.startsWith('@')) r = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [q.slice(1)]);
    else r = await pool.query('SELECT tg_id FROM users WHERE LOWER(first_name) LIKE LOWER($1) OR LOWER(username) LIKE LOWER($1) LIMIT 20', [`%${q}%`]);

    if (!r.rows.length) return sendMessage(msg.chat.id, `❌ Никого не найдено по «${q}»`, mainAdminKeyboard());
    if (r.rows.length === 1) return showUserCard(msg.chat.id, null, r.rows[0].tg_id, `Найден по «${q}»`);

    const btns = r.rows.map(u => [{ text: `ID ${u.tg_id}`, callback_data: `usr_show_${u.tg_id}` }]);
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    await sendMessage(msg.chat.id, `🔍 Найдено ${r.rows.length}:`, { inline_keyboard: btns });
    return true;
  } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); return true; }
}

async function handleAddCustomText(msg) {
  if (!awaitingAddCustom.has(msg.from.id)) return false;
  const targetTgId = awaitingAddCustom.get(msg.from.id);
  awaitingAddCustom.delete(msg.from.id);
  const n = Number(msg.text.trim());
  if (!Number.isFinite(n) || n === 0) return sendMessage(msg.chat.id, '❌ Введи число.') && true;
  await pool.query('UPDATE users SET balance = GREATEST(0, balance + $1) WHERE tg_id = $2', [n, targetTgId]);
  await showUserCard(msg.chat.id, null, targetTgId, `${n > 0 ? 'Начислено +' : 'Списано '}${n}`);
  return true;
}

async function handleDM(msg) {
  if (!awaitingDM.has(msg.from.id)) return false;
  const targetTgId = awaitingDM.get(msg.from.id);
  awaitingDM.delete(msg.from.id);
  try {
    await sendMessage(targetTgId, `📩 <b>Сообщение от админа:</b>\n\n${msg.text}`);
    await sendMessage(msg.chat.id, '✅ Доставлено.', mainAdminKeyboard());
  } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); }
  return true;
}

// --- ссылки на товары ---
async function handleLinksText(msg) {
  if (!awaitingLinks.has(msg.from.id)) return false;
  awaitingLinks.delete(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) {
    await sendMessage(msg.chat.id, '❌ Не нашёл ссылок/артикулов. Пример: <code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>', mainAdminKeyboard());
    return true;
  }
  awaitingLinksDesc.set(msg.from.id, ids);
  await sendMessage(msg.chat.id, `📝 Введи <b>описание</b> для ${ids.length} товаров (или <code>-</code>, чтобы оставить как на WB).`, { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_products' }]] });
  return true;
}

async function handleLinksDescText(msg) {
  if (!awaitingLinksDesc.has(msg.from.id)) return false;
  const ids = awaitingLinksDesc.get(msg.from.id);
  awaitingLinksDesc.delete(msg.from.id);
  const description = msg.text.trim() === '-' ? null : msg.text.trim();

  await sendMessage(msg.chat.id, `⏳ Обрабатываю ${ids.length} товаров…`);
  let added = 0, failed = 0;
  for (const wbId of ids) {
    try {
      const info = await fetchWBProductInfo(wbId);
      const name = info?.name || `Товар ${wbId}`;
      const price = info?.price || null;
      const category = guessCategory(name);
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,NOW(),NOW())
         ON CONFLICT (wb_id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category,
           image_url=EXCLUDED.image_url, fallback_url=EXCLUDED.fallback_url, is_active=TRUE, description=EXCLUDED.description, updated_at=NOW()`,
        [wbId, name, price, category, primaryImageUrl(wbId), fallbackImageUrl(wbId), description]
      );
      added++;
    } catch { failed++; }
  }
  await sendMessage(msg.chat.id, `✅ Добавлено: <b>${added}</b>\n❌ Ошибок: <b>${failed}</b>`, mainAdminKeyboard());
  return true;
}

// --- ручное добавление ---
async function handleManualProductText(msg) {
  if (!awaitingManualProduct.has(msg.from.id)) return false;
  const state = awaitingManualProduct.get(msg.from.id);
  const text = msg.text.trim();

  if (state.step === 'wb_id') {
    const ids = extractWbIds(text);
    if (!ids.length) { await sendMessage(msg.chat.id, '❌ Не нашёл ссылку или артикул.'); return true; }
    state.wb_id = ids[0]; state.step = 'name';
    awaitingManualProduct.set(msg.from.id, state);
    await sendMessage(msg.chat.id, 'Шаг 2/5: введи <b>название</b> товара.');
    return true;
  }
  if (state.step === 'name') { state.name = text; state.step = 'price'; awaitingManualProduct.set(msg.from.id, state); await sendMessage(msg.chat.id, 'Шаг 3/5: введи <b>цену</b> (например <code>3 490 ₽</code>).'); return true; }
  if (state.step === 'price') { state.price = text; state.step = 'category'; awaitingManualProduct.set(msg.from.id, state); await sendMessage(msg.chat.id, 'Шаг 4/5: введи <b>категорию</b>:\n\n<code>top</code> верх\n<code>bottom</code> низ\n<code>outerwear</code> верхняя одежда\n<code>suit</code> костюмы\n<code>dress</code> платья\n<code>accessory</code> аксессуары'); return true; }
  if (state.step === 'category') {
    const allowed = ['top', 'bottom', 'outerwear', 'suit', 'dress', 'accessory'];
    const cat = text.toLowerCase().trim();
    if (!allowed.includes(cat)) { await sendMessage(msg.chat.id, `❌ Неверно. Допустимо: ${allowed.join(', ')}`); return true; }
    state.category = cat; state.step = 'description';
    awaitingManualProduct.set(msg.from.id, state);
    await sendMessage(msg.chat.id, 'Шаг 5/5: введи <b>описание</b> (или <code>-</code>).');
    return true;
  }
  if (state.step === 'description') {
    state.description = text === '-' ? null : text;
    awaitingManualProduct.delete(msg.from.id);
    try {
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,NOW(),NOW())
         ON CONFLICT (wb_id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category,
           image_url=EXCLUDED.image_url, fallback_url=EXCLUDED.fallback_url, is_active=TRUE, description=EXCLUDED.description, updated_at=NOW()`,
        [state.wb_id, state.name, state.price, state.category, primaryImageUrl(state.wb_id), fallbackImageUrl(state.wb_id), state.description]
      );
      await sendMessage(msg.chat.id, `✅ Товар добавлен!\n\n📝 ${state.name}\n💰 ${state.price || '—'}\n📂 ${state.category}\n📄 ${state.description || '—'}`, mainAdminKeyboard());
    } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); }
    return true;
  }
}

// --- действия с товарами по ссылке ---
async function handleProductAction(msg) {
  if (!awaitingProductAction.has(msg.from.id)) return false;
  const action = awaitingProductAction.get(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Не нашёл ссылку или артикул.'); return true; }
  awaitingProductAction.delete(msg.from.id);
  const wbId = ids[0];
  try {
    const exists = await pool.query('SELECT name FROM products WHERE wb_id = $1', [wbId]);
    if (!exists.rows.length) { await sendMessage(msg.chat.id, `❌ Товар <code>${wbId}</code> не найден.`, mainAdminKeyboard()); return true; }
    if (action === 'pin') await pool.query('UPDATE products SET is_pinned = TRUE WHERE wb_id = $1', [wbId]);
    if (action === 'hide') await pool.query('UPDATE products SET is_active = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'unhide') await pool.query('UPDATE products SET is_active = TRUE, is_pinned = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'delete') await pool.query('DELETE FROM products WHERE wb_id = $1', [wbId]);
    await sendMessage(msg.chat.id, `✅ ${action === 'delete' ? 'Удалён' : 'Готово'}: <b>${exists.rows[0].name}</b>`, mainAdminKeyboard());
    return true;
  } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); return true; }
}

// --- свой промокод ---
async function handlePromoCustom(msg) {
  if (!awaitingPromoCustom.has(msg.from.id)) return false;
  const state = awaitingPromoCustom.get(msg.from.id);
  const text = msg.text.trim();

  if (state.step === 'code') {
    const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    if (!code) { await sendMessage(msg.chat.id, '❌ Код пустой. Введи латиницу/цифры.'); return true; }
    const dup = await pool.query('SELECT 1 FROM promo_codes WHERE code = $1', [code]);
    if (dup.rows.length) { await sendMessage(msg.chat.id, '❌ Такой код уже существует. Введи другой.'); return true; }
    state.code = code; state.step = 'tries';
    awaitingPromoCustom.set(msg.from.id, state);
    await sendMessage(msg.chat.id, `Шаг 2/3: введи <b>количество попыток</b> (число), или напиши <code>unlimited</code> для безлимита 24ч.`);
    return true;
  }
  if (state.step === 'tries') {
    let tries = 0, unlimited = false;
    if (text.toLowerCase() === 'unlimited') unlimited = true;
    else { tries = Number(text); if (!Number.isFinite(tries) || tries <= 0) { await sendMessage(msg.chat.id, '❌ Введи число > 0.'); return true; } }
    state.tries = tries; state.unlimited = unlimited; state.step = 'max_uses';
    awaitingPromoCustom.set(msg.from.id, state);
    await sendMessage(msg.chat.id, `Шаг 3/3: введи <b>лимит активаций</b> (сколько раз можно применить код), или <code>0</code> для безлимита.`);
    return true;
  }
  if (state.step === 'max_uses') {
    const maxUses = Number(text);
    if (!Number.isFinite(maxUses) || maxUses < 0) { await sendMessage(msg.chat.id, '❌ Введи число ≥ 0.'); return true; }
    try {
      await pool.query(
        `INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1, $2, $3, $4, TRUE, $5)`,
        [state.code, state.tries, state.unlimited, maxUses === 0 ? 999999 : maxUses, state.unlimited ? 'Безлимит 24ч' : `+${state.tries} попыток`]
      );
      awaitingPromoCustom.delete(msg.from.id);
      await sendMessage(msg.chat.id,
        `✅ <b>Промокод создан</b>\n\n🔑 Код: <code>${state.code}</code>\n🎁 ${state.unlimited ? 'Безлимит 24ч' : `+${state.tries} попыток`}\n📊 Лимит: ${maxUses === 0 ? '∞' : maxUses}`,
        { inline_keyboard: [[{ text: '🎁 К промокодам', callback_data: 'adm_promo' }]] });
    } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); }
    return true;
  }
}

// ============================================================
// 10. WEBHOOK
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
    try { await handleCallback(update.callback_query); } catch (e) { console.error('[cb]', e.message); }
    return res.sendStatus(200);
  }

  if (update.message?.text) {
    const text = update.message.text.trim();
    // text handlers по приоритету
    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleUserSearch(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleDM(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleLinksDescText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleLinksText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleManualProductText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleProductAction(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handlePromoCustom(update.message).catch(() => false)) return res.sendStatus(200);

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
        await pool.query('INSERT INTO payments (charge_id, tg_id, product, stars) VALUES ($1,$2,$3,$4)', [chargeId, tgId, productType, pay.total_amount]);
        if (productType === 'pack10') await pool.query('UPDATE users SET balance = balance + 10 WHERE tg_id = $1', [tgId]);
        else if (productType === 'custom_tries') await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [Number(parts[2]) || 1, tgId]);
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
// 11. HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });
cron.schedule('0 3 * * *', async () => {
  try { await pool.query('SELECT deleted_count FROM cleanup_old_products()'); } catch {}
});

pool.query('SELECT COUNT(*)::int AS c FROM products')
  .then(r => { if (r.rows[0].c === 0) refreshCatalog(); })
  .catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
