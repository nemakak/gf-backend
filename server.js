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
// ✅ FLUX 2 LoRA Gallery: специализированная модель для примерки
const VTON_MODEL = 'fal-ai/flux-2-lora-gallery/virtual-tryon';
fal.config({ credentials: process.env.FAL_KEY });

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
        `INSERT INTO users (tg_id, username, first_name, photo_url, balance, ref_by)
         VALUES ($1,$2,$3,$4,3,$5) RETURNING *`,
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
// 2. ПРОКСИ ДЛЯ КАРТИНОК WB
// ============================================================
app.get('/api/img', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Bad url');

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('Bad url'); }

  if (!/\.wbbasket\.ru$/.test(parsed.hostname) && !/\.wbstatic\.net$/.test(parsed.hostname)) {
    return res.status(400).send('Bad host');
  }

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Referer': 'https://www.wildberries.ru/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
    });
    if (!r.ok) return res.status(404).send('Not found');
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(buf);
  } catch (e) {
    console.error('[img]', e.message);
    res.status(500).send('Proxy error');
  }
});

// ============================================================
// 3. SYNC-CATALOG
// ============================================================
app.post('/api/sync-catalog', async (req, res) => {
  const { items, secret } = req.body;

  if (secret !== 'GF_ROOM_2024_SECRET') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Empty items' });
  }

  try {
    let saved = 0;
    for (const it of items) {
      if (!it.wb_id || !it.image_url || !it.category) continue;
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name = EXCLUDED.name,
           price = EXCLUDED.price,
           category = EXCLUDED.category,
           image_url = EXCLUDED.image_url,
           fallback_url = EXCLUDED.fallback_url,
           is_active = TRUE,
           updated_at = NOW()`,
        [it.wb_id, it.name, it.price, it.category, it.image_url, it.fallback_url]
      );
      saved++;
    }
    console.log(`[sync] saved ${saved} items`);
    res.json({ success: true, saved });
  } catch (e) {
    console.error('[sync]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 4. CATALOG
// ============================================================
app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 100, offset = 0 } = req.query;
    const params = [];
    let where = 'WHERE is_active = TRUE';
    if (category && category !== 'Все' && category !== 'all') {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    params.push(Number(limit), Number(offset));
    const q = `SELECT id, wb_id, name, price, category, image_url, fallback_url
               FROM products ${where}
               ORDER BY updated_at DESC, id DESC
               LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    res.json({ success: true, items: r.rows });
  } catch (e) {
    console.error('[catalog]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// 5. TRYON (FLUX 2 LoRA Gallery — самая дешёвая)
// ============================================================
app.post('/api/tryon', async (req, res) => {
  const { initData, humanImg, garmentUrl, itemId } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const tgId = tgUser.id;

  try {
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];

    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && user.balance <= 0) {
      return res.status(402).json({ error: 'No tries left' });
    }
    if (!hasUnlimited) {
      await pool.query('UPDATE users SET balance = balance - 1 WHERE tg_id = $1', [tgId]);
    }

    let resultUrl = null, isMock = false;
    try {
      // ✅ FLUX 2 LoRA Gallery: image_urls — МАССИВ (человек + одежда), prompt ОБЯЗАТЕЛЕН
      const r = await fal.subscribe(VTON_MODEL, {
        input: {
          image_urls: [humanImg, garmentUrl], // [person, garment] — порядок важен
          prompt: 'A person wearing a stylish garment, virtual try-on, full body shot, natural lighting',
          num_inference_steps: 40, // по умолчанию 40, можно 1-50
          guidance_scale: 2.5,     // по умолчанию 2.5
          lora_scale: 1.0,         // сила эффекта примерки
          num_images: 1,
          output_format: 'jpeg',   // быстрее чем png
        },
        logs: false,
      });
      resultUrl = r?.data?.images?.[0]?.url || null; // ✅ Возвращает images[], а не image{}
      if (!resultUrl) throw new Error('empty fal response');
    } catch (e) {
      console.warn('[tryon] fal failed, mock used:', e.message);
      resultUrl = garmentUrl;
      isMock = true;
    }

    await pool.query(
      `INSERT INTO tryon_history (user_id, product_id, result_url, is_mock)
       VALUES ($1,$2,$3,$4)`,
      [tgId, itemId ? Number(itemId) : null, resultUrl, isMock]
    );

    if (user.ref_by && !user.ref_rewarded && !isMock) {
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + 3 WHERE tg_id = $1', [user.ref_by]);
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: user.ref_by,
          text: '🎉 Ваша подруга сделала первую примерку! +3 попытки ✨',
        }),
      }).catch(() => {});
    }

    res.json({ success: true, resultUrl, isMock });
  } catch (e) {
    console.error('[tryon]', e);
    res.json({
      success: true,
      resultUrl: garmentUrl || 'https://via.placeholder.com/600x800?text=Try+On',
      isMock: true,
    });
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
  } catch (e) {
    console.error('[onboarded]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// 7. INVOICE
// ============================================================
app.post('/api/create-invoice', async (req, res) => {
  const { tgId, productType } = req.body;
  let title = '10 примерок одежды', amount = 1;
  let payload = `pack10:${tgId}:${Date.now()}`;
  if (productType === 'pass24h') {
    title = 'Суточный безлимит (24 ч)';
    amount = 1;
    payload = `pass24h:${tgId}:${Date.now()}`;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: 'Оплата цифровых услуг в мини-приложении',
        payload, currency: 'XTR',
        prices: [{ label: title, amount }],
      }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoiceLink: data.result });
  } catch (e) {
    console.error('[invoice]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 8. WEBHOOK
// ============================================================
app.post('/api/webhook/telegram', async (req, res) => {
  const update = req.body;

  if (update.pre_checkout_query) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }),
    });
    return res.sendStatus(200);
  }

  if (update.message?.successful_payment) {
    const pay = update.message.successful_payment;
    const [productType, tgIdRaw] = (pay.invoice_payload || '').split(':');
    const tgId = Number(tgIdRaw);
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
        } else if (productType === 'pass24h') {
          const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [until, tgId]);
        }
      }
    } catch (e) { console.error('[webhook]', e); }
  }
  res.sendStatus(200);
});

// ============================================================
// 9. HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

cron.schedule('0 0,12 * * *', () => {
  console.log('[cron] refreshing WB catalog...');
  refreshCatalog();
});

pool.query('SELECT COUNT(*)::int AS c FROM products')
  .then(r => { if (r.rows[0].c === 0) refreshCatalog(); })
  .catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
