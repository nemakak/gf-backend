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

// ===== ПОДПИСКИ =====
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
      `UPDATE users SET first_name=$1, username=$2, photo_url=$3
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
// 2. ПРОКСИ КАРТИНОК
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
    for (const it of items) {
      if (!it.wb_id || !it.image_url || !it.category) continue;
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name = EXCLUDED.name, price = EXCLUDED.price, category = EXCLUDED.category,
           image_url = EXCLUDED.image_url, fallback_url = EXCLUDED.fallback_url,
           is_active = TRUE, updated_at = NOW()`,
        [it.wb_id, it.name, it.price, it.category, it.image_url, it.fallback_url]
      );
      saved++;
    }
    console.log(`[sync] saved ${saved}`);
    res.json({ success: true, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 3.5. FIX-DRIVE-URLS
// ============================================================
app.post('/api/fix-drive-urls', async (req, res) => {
  const { items, secret } = req.body;
  if (secret !== 'GF_ROOM_2024_SECRET') return res.status(403).json({ error: 'Forbidden' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Empty items' });
  try {
    let updated = 0;
    for (const it of items) {
      if (!it.wb_id || !it.image_url) continue;
      const r = await pool.query(
        `UPDATE products SET image_url = $1, fallback_url = $2, updated_at = NOW() WHERE wb_id = $3`,
        [it.image_url, it.fallback_url || it.image_url, it.wb_id]
      );
      if (r.rowCount > 0) updated++;
    }
    res.json({ success: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 4. CATALOG
// ============================================================
app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 100, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE is_active = TRUE';
    if (category && category !== 'all') {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    params.push(Number(limit), Number(offset));
    const q = `
      SELECT id, wb_id, name, price, category, image_url, fallback_url
      FROM products ${where}
      ORDER BY
        CASE category
          WHEN 'dress' THEN 1 WHEN 'top' THEN 2 WHEN 'outerwear' THEN 3
          WHEN 'suit' THEN 4 WHEN 'bottom' THEN 5 WHEN 'shoes' THEN 6
          WHEN 'accessory' THEN 99 ELSE 50
        END,
        updated_at DESC, id DESC
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
      console.warn('[tryon] fal failed, mock:', e.message);
      resultUrl = garmentUrl;
      isMock = true;
    }

    await pool.query(
      `INSERT INTO tryon_history (user_id, product_id, result_url, is_mock, category) VALUES ($1,$2,$3,$4,$5)`,
      [tgId, itemId ? Number(itemId) : null, resultUrl, isMock, category || null]
    );

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
// 5.5. HISTORY
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
// 5.6. REDEEM PROMO
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

    if (p.used_count >= p.max_uses) {
      return res.status(400).json({ error: 'Промокод больше не действует' });
    }

    const used = await pool.query(
      'SELECT 1 FROM promo_uses WHERE code = $1 AND tg_id = $2',
      [cleanCode, tgId]
    );
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
  } catch (e) {
    console.error('[redeem-promo]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// 6. ONBOARDED
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
// 7. INVOICE
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
    amount = n * 5;
    title = `${n} примерок`;
    payload = `custom_tries:${tgId}:${n}:${Date.now()}`;
  } else if (productType === 'pass24h') {
    title = 'Суточный безлимит (24 ч)'; amount = 250;
    payload = `pass24h:${tgId}:${Date.now()}`;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, description: 'Оплата цифровых услуг в мини-приложении',
        payload, currency: 'XTR',
        prices: [{ label: title, amount }],
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoiceLink: data.result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 8. HELPERS
// ============================================================
async function sendMessage(chatId, text) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function isAdmin(tgId) {
  try {
    const r = await pool.query('SELECT is_admin FROM users WHERE tg_id = $1', [tgId]);
    return r.rows[0]?.is_admin === true;
  } catch { return false; }
}

// ============================================================
// 9. АДМИН-КОМАНДЫ В БОТЕ
// ============================================================
async function handleAdminCommand(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const [cmd, ...args] = text.split(' ');

  // /start — приветствие
  if (cmd === '/start') {
    await sendMessage(chatId, '✨ Добро пожаловать в Style Room!\n\nНажми кнопку ниже, чтобы открыть приложение.');
    return;
  }

  // проверка админа
  if (!(await isAdmin(msg.from.id))) {
    await sendMessage(chatId, '⛔ У вас нет доступа к админ-командам.');
    return;
  }

  // /admin или /help
  if (cmd === '/admin' || cmd === '/help') {
    await sendMessage(chatId,
      `👑 <b>Админ-панель</b>\n\n` +
      `/stats — статистика\n` +
      `/users — последние юзеры\n` +
      `/promo_create CODE TRIES MAX — создать промокод\n` +
      `/promo_list — список промокодов\n` +
      `/promo_delete CODE — деактивировать\n` +
      `/broadcast TEXT — рассылка`
    );
    return;
  }

  // /promo_create CODE TRIES MAX
  if (cmd === '/promo_create') {
    const code = (args[0] || '').toUpperCase();
    const tries = Number(args[1] || 2);
    const maxUses = Number(args[2] || 100);
    if (!code) return sendMessage(chatId, 'Использование: /promo_create CODE TRIES MAX\nПример: /promo_create START2 2 10');
    try {
      await pool.query(
        `INSERT INTO promo_codes (code, tries, max_uses, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (code) DO UPDATE SET tries=$2, max_uses=$3, is_active=TRUE`,
        [code, tries, maxUses]
      );
      await sendMessage(chatId, `✅ Промокод <b>${code}</b> создан: +${tries} попыток, лимит ${maxUses}`);
    } catch (e) { await sendMessage(chatId, '❌ ' + e.message); }
    return;
  }

  // /promo_list
  if (cmd === '/promo_list') {
    const r = await pool.query(
      `SELECT code, tries, used_count, max_uses, is_active FROM promo_codes ORDER BY created_at DESC LIMIT 30`
    );
    if (!r.rows.length) return sendMessage(chatId, 'Промокодов нет');
    let m = '<b>Промокоды:</b>\n';
    for (const p of r.rows) {
      m += `\n<code>${p.code}</code> · +${p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' · ⛔'}`;
    }
    await sendMessage(chatId, m);
    return;
  }

  // /promo_delete CODE
  if (cmd === '/promo_delete') {
    const code = (args[0] || '').toUpperCase();
    if (!code) return sendMessage(chatId, 'Использование: /promo_delete CODE');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    await sendMessage(chatId, `✅ Промокод ${code} деактивирован`);
    return;
  }

  // /stats
  if (cmd === '/stats') {
    const users = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const tryons = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history');
    const payments = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments');
    const today = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at > NOW() - INTERVAL '1 day'`);
    await sendMessage(chatId,
      `📊 <b>Статистика</b>\n\n` +
      `👥 Всего юзеров: ${users.rows[0].c}\n` +
      `🆕 За сутки: ${today.rows[0].c}\n` +
      `✨ Примерок: ${tryons.rows[0].c}\n` +
      `💳 Платежей: ${payments.rows[0].c} · ⭐ ${payments.rows[0].s}`
    );
    return;
  }

  // /users
  if (cmd === '/users') {
    const r = await pool.query(
      `SELECT tg_id, first_name, username, balance, created_at FROM users ORDER BY created_at DESC LIMIT 15`
    );
    let m = '<b>Последние юзеры:</b>\n';
    for (const u of r.rows) {
      m += `\n${u.first_name || '—'} · @${u.username || '—'} · ✨${u.balance}`;
    }
    await sendMessage(chatId, m);
    return;
  }

  // /broadcast TEXT
  if (cmd === '/broadcast') {
    const txt = args.join(' ');
    if (!txt) return sendMessage(chatId, 'Использование: /broadcast TEXT');
    const r = await pool.query('SELECT tg_id FROM users');
    let sent = 0, fail = 0;
    for (const u of r.rows) {
      try { await sendMessage(u.tg_id, txt); sent++; } catch { fail++; }
    }
    await sendMessage(chatId, `✅ Отправлено: ${sent}, ошибок: ${fail}`);
    return;
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

  // Команды бота
  if (update.message?.text?.startsWith('/')) {
    try { await handleAdminCommand(update.message); } catch (e) { console.error('[admin]', e); }
    return res.sendStatus(200);
  }

  // Успешная оплата
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
// 11. HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });

pool.query('SELECT COUNT(*)::int AS c FROM products')
  .then(r => { if (r.rows[0].c === 0) refreshCatalog(); })
  .catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
