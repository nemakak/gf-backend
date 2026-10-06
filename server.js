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
const BOT_HANDLE = '@GFstyleroom_bot';
const BOT_NAME = 'GFstyleroom_bot';
fal.config({ credentials: process.env.FAL_KEY });

const MODEL_COSTS = { 'image-apps-v2': 0.04, 'fashn-v1.6': 0.075, 'fashn-v1.5': 0.039 };
const STAR_TO_USD = 0.013;

const SUBSCRIPTIONS = {
  sub_pro:      { title: 'PRО',    stars: 599, oldStars: 999, tries: 50, own: 20, emoji: '💎' },
  sub_medium:   { title: 'MEDIUM', stars: 299, oldStars: 499, tries: 30, own: 10, emoji: '💥' },
  sub_start:    { title: 'START',  stars: 65,  oldStars: 119, tries: 10, own: 0,  emoji: '👌' },
  sub_secret:   { title: 'СЕКРЕТНАЯ', stars: 10, oldStars: 0, tries: 0, own: 2, emoji: '🎁' },
};

const ACHIEVEMENTS = {
  first_tryon:  { emoji: '🥇', name: 'Первая примерка', desc: 'Сделал первую примерку' },
  ten_tryons:   { emoji: '🔟', name: '10 примерок',     desc: 'Сделал 10 примерок' },
  fifty_tryons: { emoji: '💫', name: '50 примерок',     desc: 'Сделал 50 примерок' },
  hundred:      { emoji: '💯', name: '100 примерок',    desc: 'Сделал 100 примерок' },
  first_ref:    { emoji: '👥', name: 'Первый друг',     desc: 'Пригласил первую подругу' },
  three_refs:   { emoji: '🎉', name: '3 подруги',       desc: 'Пригласил 3 подруг' },
  first_pay:    { emoji: '💎', name: 'Первый платёж',   desc: 'Купил попытки' },
  streak_3:     { emoji: '🔥', name: 'Стрик 3 дня',     desc: 'Заходил 3 дня подряд' },
  streak_5:     { emoji: '⚡️', name: 'Стрик 5 дней',    desc: 'Заходил 5 дней подряд' },
  streak_7:     { emoji: '🌟', name: 'Стрик 7 дней',    desc: 'Заходил неделю подряд' },
  multi_tryon:  { emoji: '🎨', name: 'Мульти-примерка', desc: 'Пример 2-3 вещи сразу' },
  own_product:  { emoji: '📦', name: 'Свой товар',      desc: 'Примерил свой товар' },
};

// INIT
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS error_log (id SERIAL PRIMARY KEY, source TEXT NOT NULL, message TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);`);
    const defaults = [
      ['maintenance', 'false'],
      ['maintenance_text', 'Ведутся технические работы. Заходите чуть позже ✨'],
      ['start_balance', '2'],
      ['daily_bonus', '1'],
      ['streak_reward_own', '3'],
      ['streak_enabled', 'true'],
      ['ref_bonus', '1'],
      ['one_time_message', ''],
    ];
    for (const [k, v] of defaults) {
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [k, v]);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS generations (id SERIAL PRIMARY KEY, tg_id BIGINT, model TEXT, cost_usd NUMERIC(10,4) NOT NULL DEFAULT 0, success BOOLEAN NOT NULL DEFAULT TRUE, item_id BIGINT, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE INDEX IF NOT EXISTS generations_time_idx ON generations (created_at DESC);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_notes (id SERIAL PRIMARY KEY, tg_id BIGINT NOT NULL, note TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_abuser BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS abuser_reason TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_days INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_streak_date DATE;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_bonus DATE;`);
    await pool.query(`ALTER TABLE users ALTER COLUMN balance SET DEFAULT 2;`);
    await pool.query(`CREATE TABLE IF NOT EXISTS favorites (id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, product_id BIGINT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, product_id));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS achievements (id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, code TEXT NOT NULL, earned_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, code));`);
    await pool.query(`CREATE TABLE IF NOT EXISTS gifts (id SERIAL PRIMARY KEY, from_tg_id BIGINT NOT NULL, to_tg_id BIGINT, gift_code TEXT UNIQUE NOT NULL, tries INT NOT NULL DEFAULT 0, stars INT NOT NULL DEFAULT 0, claimed BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW(), claimed_at TIMESTAMPTZ);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_broadcasts (id SERIAL PRIMARY KEY, text TEXT NOT NULL, photo_file_id TEXT, run_at TIMESTAMPTZ NOT NULL, sent BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS product_views (id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, product_id BIGINT NOT NULL, category TEXT, viewed_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE INDEX IF NOT EXISTS product_views_user_idx ON product_views (user_id, viewed_at DESC);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS one_time_shown (tg_id BIGINT PRIMARY KEY, shown_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS source_url TEXT;`);
    console.log('[init] ok');
  } catch (e) { console.error('[init]', e.message); }
})();

async function logError(source, message, detail = null) {
  console.error(`[ERROR][${source}] ${message}`, detail || '');
  try {
    await pool.query(`INSERT INTO error_log (source, message, detail) VALUES ($1,$2,$3)`, [source, String(message || '').slice(0, 500), detail ? String(detail).slice(0, 2000) : null]);
    const important = ['tryon', 'wb', 'refresh-catalog', 'auth', 'cleanup'];
    if (important.some(k => source.startsWith(k))) {
      const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
      const text = `⚠️ <b>Ошибка</b>\n\n<code>${source}</code>\n${String(message || '').slice(0, 200)}`;
      for (const a of admins.rows) {
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: a.tg_id, text, parse_mode: 'HTML' }),
        }).catch(() => {});
      }
    }
  } catch {}
}

async function logGeneration(tgId, model, success, itemId = null) {
  try {
    const cost = success ? (MODEL_COSTS[model] || 0) : 0;
    await pool.query(`INSERT INTO generations (tg_id, model, cost_usd, success, item_id) VALUES ($1,$2,$3,$4,$5)`, [tgId, model || 'unknown', cost, success, itemId]);
  } catch (e) { console.error('[logGen]', e.message); }
}

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
app.post('/debug-auth', (req, res) => {
  const initData = req.body.initData || '';
  const p = new URLSearchParams(initData);
  const hash = p.get('hash') || '';
  p.delete('hash');
  const str = [...p.entries()].sort().map(([k, v]) => `${k}=${v}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', key).update(str).digest('hex');
  res.json({
    hasToken: !!BOT_TOKEN,
    tokenPrefix: BOT_TOKEN ? BOT_TOKEN.slice(0, 12) + '…' : null,
    tokenLength: BOT_TOKEN ? BOT_TOKEN.length : 0,
    initDataLength: initData.length,
    hashFromTelegram: hash.slice(0, 12) + '…',
    hashCalculated: calc.slice(0, 12) + '…',
    match: hash === calc,
    userName: (() => { try { return JSON.parse(p.get('user') || '{}').username; } catch { return null; } })(),
  });
});
async function tgApi(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return r.json();
}
const sendMessage = (chatId, text, keyboard = null) => tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const sendPhoto = (chatId, photo, caption = '', keyboard = null) => tgApi('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const editMessage = (chatId, messageId, text, keyboard = null) => tgApi('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
const answerCallback = (id, text = '') => tgApi('answerCallbackQuery', { callback_query_id: id, text });

async function isAdmin(tgId) {
  try { const r = await pool.query('SELECT is_admin FROM users WHERE tg_id = $1', [tgId]); return r.rows[0]?.is_admin === true; } catch { return false; }
}
async function getSetting(key, def = null) {
  try { const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]); return r.rows[0]?.value ?? def; } catch { return def; }
}
async function setSetting(key, value) {
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}
async function isMaintenanceMode() { return (await getSetting('maintenance', 'false')) === 'true'; }
async function isStreakEnabled() { return (await getSetting('streak_enabled', 'true')) === 'true'; }
async function giveAchievement(tgId, code) {
  try {
    const r = await pool.query(`INSERT INTO achievements (user_id, code) VALUES ($1, $2) ON CONFLICT (user_id, code) DO NOTHING RETURNING id`, [tgId, code]);
    if (r.rows.length) {
      const a = ACHIEVEMENTS[code];
      if (a) sendMessage(tgId, `${a.emoji} <b>Новое достижение!</b>\n\n<b>${a.name}</b>\n${a.desc}`).catch(() => {});
    }
  } catch {}
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
      let r = await fetch(url, { headers, timeout: 8000 }).catch(() => null);
      let data = null;
      if (r && r.ok) data = await r.json().catch(() => null);
      if (!data) {
        const proxy = `https://gf-images.maxgamingbrawlstars.workers.dev/?url=${encodeURIComponent(url)}`;
        r = await fetch(proxy, { headers, timeout: 12000 }).catch(() => null);
        if (r && r.ok) data = await r.json().catch(() => null);
      }
      if (!data) continue;
      const p1 = data?.data?.products?.[0];
      if (p1?.name) {
        const name = p1.name.length > 150 ? p1.name.slice(0, 150) + '…' : p1.name;
        return { wb_id: wbId, name, price: p1.salePriceU ? `${Math.round(p1.salePriceU/100).toLocaleString('ru-RU')} ₽` : null, description: name };
      }
      const name2 = data?.imt_name || data?.subj_name;
      if (name2) {
        const price2 = data?.sizes?.[0]?.price?.total ? `${Math.round(data.sizes[0].price.total/100).toLocaleString('ru-RU')} ₽` : null;
        const shortName = name2.length > 150 ? name2.slice(0, 150) + '…' : name2;
        return { wb_id: wbId, name: shortName, price: price2, description: data?.description || shortName };
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

// AUTH
app.post('/api/auth', async (req, res) => {
  const { initData, refCode } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) { logError('auth', 'Unauthorized'); return res.status(401).json({ error: 'Unauthorized' }); }
  const { id: tgId, first_name, username, photo_url } = tgUser;
  try {
    let startBalance = Number(await getSetting('start_balance', '2'));
    if (!Number.isFinite(startBalance) || startBalance < 0) startBalance = 2;
    let dailyBonusTries = Number(await getSetting('daily_bonus', '1'));
    if (!Number.isFinite(dailyBonusTries) || dailyBonusTries < 0) dailyBonusTries = 1;
    let streakReward = Number(await getSetting('streak_reward_own', '3'));
    if (!Number.isFinite(streakReward) || streakReward < 0) streakReward = 3;
    const refBonus = Number(await getSetting('ref_bonus', '1'));
    const streakEnabled = await isStreakEnabled();

    const existing = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    let user, dailyBonus = 0, streakBonus = 0, streakDays = 0;
    const today = new Date().toISOString().slice(0, 10);

    if (existing.rows.length === 0) {
      let inviterId = null;
      if (refCode?.startsWith('ref_')) {
        const parsed = Number(refCode.replace('ref_', ''));
        if (parsed && parsed !== tgId) {
          const inv = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [parsed]);
          if (inv.rows.length) inviterId = parsed;
        }
      }
      const initialBalance = startBalance + dailyBonusTries;
      const ins = await pool.query(
        `INSERT INTO users (tg_id, username, first_name, photo_url, balance, own_tries, sub_active, ref_by, last_active, streak_days, last_streak_date, last_daily_bonus)
         VALUES ($1,$2,$3,$4,$5,0,FALSE,$6,NOW(),1,CURRENT_DATE,CURRENT_DATE) RETURNING *`,
        [tgId, username || null, first_name || null, photo_url || null, initialBalance, inviterId]);
      user = ins.rows[0];
      streakDays = 1;
      dailyBonus = dailyBonusTries;
    } else {
      user = existing.rows[0];
      if (user.is_banned) return res.status(403).json({ error: 'Banned', reason: user.ban_reason || 'Нарушение правил' });
      const upd = await pool.query(`UPDATE users SET first_name=$1, username=$2, photo_url=$3, last_active=NOW() WHERE tg_id=$4 RETURNING *`, [first_name || null, username || null, photo_url || null, tgId]);
      user = upd.rows[0];

      if (streakEnabled) {
        const lastStreak = user.last_streak_date ? new Date(user.last_streak_date).toISOString().slice(0, 10) : null;
        if (lastStreak !== today) {
          const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
          let newStreak = (lastStreak === yesterday) ? (user.streak_days || 0) + 1 : 1;
          if (newStreak % 5 === 0) {
            await pool.query('UPDATE users SET own_tries = own_tries + $1 WHERE tg_id = $2', [streakReward, tgId]);
            streakBonus = streakReward;
            sendMessage(tgId, `🔥 <b>Стрик ${newStreak} дней!</b>\n\n+${streakReward} примерки своих товаров 🎁`).catch(() => {});
          }
          if (newStreak === 3) await giveAchievement(tgId, 'streak_3');
          if (newStreak === 5) await giveAchievement(tgId, 'streak_5');
          if (newStreak === 7) await giveAchievement(tgId, 'streak_7');
          await pool.query('UPDATE users SET streak_days=$1, last_streak_date=CURRENT_DATE WHERE tg_id=$2', [newStreak, tgId]);
          streakDays = newStreak;
        } else {
          streakDays = user.streak_days || 1;
        }

        const lastDaily = user.last_daily_bonus ? new Date(user.last_daily_bonus).toISOString().slice(0, 10) : null;
        if (lastDaily !== today && streakDays % 5 !== 0) {
          await pool.query('UPDATE users SET balance = balance + $1, last_daily_bonus = CURRENT_DATE WHERE tg_id = $2', [dailyBonusTries, tgId]);
          dailyBonus = dailyBonusTries;
          user.balance += dailyBonusTries;
        } else if (lastDaily !== today) {
          await pool.query('UPDATE users SET last_daily_bonus = CURRENT_DATE WHERE tg_id = $1', [tgId]);
        }
      } else {
        streakDays = user.streak_days || 0;
      }
    }

    let oneTimeMsg = null;
    const otm = await getSetting('one_time_message', '');
    if (otm && otm.trim()) {
      const shown = await pool.query('SELECT 1 FROM one_time_shown WHERE tg_id = $1', [tgId]);
      if (!shown.rows.length) {
        oneTimeMsg = otm;
        await pool.query('INSERT INTO one_time_shown (tg_id) VALUES ($1) ON CONFLICT DO NOTHING', [tgId]);
      }
    }

    res.json({
      success: true,
      user: { ...user, streak_days: streakDays },
      daily_bonus: dailyBonus,
      streak_bonus: streakBonus,
      streak_enabled: streakEnabled,
      one_time_message: oneTimeMsg,
    });
  } catch (e) { logError('auth', e.message); res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// ADMIN: пополнение каталога и добавление товаров по ссылкам
// ============================================================

// 1) Пополнение каталога из WB
app.post('/api/admin/refresh-catalog', async (req, res) => {
  const { initData, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdmin(tgUser.id))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const cat = category || 'all';
    // 'all' — тянет все категории, включая Осень, параллельно
    const result = await refreshCatalog(cat);
    res.json(result);
  } catch (e) {
    logError('admin-refresh', e.message);
    res.status(500).json({ success: false, reason: e.message, error: e.message });
  }
});

// 2) Добавление товаров по ссылкам WB (свои товары)
app.post('/api/admin/add-links', async (req, res) => {
  const { initData, links } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdmin(tgUser.id))) return res.status(403).json({ error: 'Forbidden' });
  if (!links || !String(links).trim()) return res.status(400).json({ error: 'Пусто' });

  const ids = extractWbIds(String(links));
  if (!ids.length) return res.status(400).json({ error: 'Не нашёл артикулы WB' });

  const results = [];
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const chunkRes = await Promise.all(chunk.map(async (wbId) => {
      try {
        const info = await fetchWBProductInfo(wbId);
        const name = info?.name || `Товар ${wbId}`;
        const price = info?.price || null;
        const category = guessCategory(name);
        const img = primaryImageUrl(wbId);
        const fb = fallbackImageUrl(wbId);
        const srcUrl = `https://www.wildberries.ru/catalog/${wbId}/detail.aspx`;

        await pool.query(
          `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, source_url, updated_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,$8,NOW(),NOW())
           ON CONFLICT (wb_id) DO UPDATE SET
             name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category,
             image_url=EXCLUDED.image_url, fallback_url=EXCLUDED.fallback_url,
             is_active=TRUE, description=EXCLUDED.description, source_url=EXCLUDED.source_url,
             updated_at=NOW()`,
          [wbId, name, price, category, img, fb, info?.description || name, srcUrl]
        );
        return { wbId, ok: true, name, price, category };
      } catch (e) {
        return { wbId, ok: false, error: e.message };
      }
    }));
    results.push(...chunkRes);
  }

  const ok = results.filter(r => r.ok);
  res.json({ success: true, added: ok.length, failed: results.length - ok.length, items: ok });
});

app.get('/api/settings', async (_req, res) => {
  try {
    const maintenance = await isMaintenanceMode();
    const text = await getSetting('maintenance_text', 'Ведутся технические работы');
    res.json({ success: true, maintenance, maintenance_text: text });
  } catch { res.json({ success: true, maintenance: false, maintenance_text: '' }); }
});

app.get('/api/catalog', async (req, res) => {
  try {
    const { category, limit = 300, offset = 0, seed = '' } = req.query;
    const params = [];
    let where = "WHERE is_active = TRUE AND category != 'accessory'";
    if (category && category !== 'all' && category !== 'accessory') { params.push(category); where += ` AND category = $${params.length}`; }
    params.push(Number(limit), Number(offset));
    let orderBy = `MD5(category || id::text || '${seed.replace(/'/g, '')}') ASC`;
    if (category === 'all' || !category) orderBy = `MD5(id::text || '${seed.replace(/'/g, '')}') ASC`;
    const q = `WITH ranked AS (SELECT id, wb_id, name, price, category, image_url, fallback_url, description, is_pinned, source_url, ROW_NUMBER() OVER (PARTITION BY category ORDER BY updated_at DESC, id DESC) AS rn FROM products ${where}) SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url FROM ranked ORDER BY is_pinned DESC NULLS LAST, ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const r = await pool.query(q, params);
    res.json({ success: true, items: r.rows });
  } catch (e) { logError('catalog', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/view', async (req, res) => {
  const { initData, productId, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try { await pool.query(`INSERT INTO product_views (user_id, product_id, category) VALUES ($1,$2,$3)`, [tgUser.id, productId, category || null]); res.json({ success: true }); }
  catch { res.json({ success: false }); }
});

app.get('/api/top-products', async (_req, res) => {
  try {
    const r = await pool.query(`SELECT p.id, p.wb_id, p.name, p.image_url, p.fallback_url, p.category, p.price, COUNT(t.id)::int AS tryons FROM products p JOIN tryon_history t ON t.product_id = p.id WHERE p.is_active = TRUE AND t.created_at > NOW() - INTERVAL '30 days' GROUP BY p.id ORDER BY tryons DESC LIMIT 10`);
    res.json({ success: true, items: r.rows });
  } catch { res.json({ success: true, items: [] }); }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.tg_id, u.first_name, u.photo_url, COUNT(t.id)::int AS tryons
      FROM users u JOIN tryon_history t ON t.user_id = u.tg_id
      WHERE t.created_at > NOW() - INTERVAL '30 days' AND u.is_admin = FALSE AND u.is_banned = FALSE
      GROUP BY u.tg_id ORDER BY tryons DESC LIMIT 15`);
    res.json({ success: true, items: r.rows });
  } catch { res.json({ success: true, items: [] }); }
});

app.post('/api/my-rank', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const my = await pool.query(`SELECT COUNT(*)::int AS c FROM tryon_history WHERE user_id = $1`, [tgUser.id]);
    const myCount = my.rows[0].c;
    if (myCount === 0) return res.json({ success: true, rank: null, total: 0, my_count: 0 });
    const better = await pool.query(`SELECT COUNT(*)::int AS c FROM (SELECT user_id, COUNT(*)::int AS c FROM tryon_history WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY user_id) x WHERE x.c > $1`, [myCount]);
    const total = await pool.query(`SELECT COUNT(DISTINCT user_id)::int AS c FROM tryon_history`);
    res.json({ success: true, rank: better.rows[0].c + 1, total: total.rows[0].c, my_count: myCount });
  } catch { res.json({ success: true, rank: null, total: 0, my_count: 0 }); }
});

app.post('/api/favorites/toggle', async (req, res) => {
  const { initData, productId } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const exist = await pool.query('SELECT id FROM favorites WHERE user_id=$1 AND product_id=$2', [tgUser.id, productId]);
    if (exist.rows.length) {
      await pool.query('DELETE FROM favorites WHERE user_id=$1 AND product_id=$2', [tgUser.id, productId]);
      return res.json({ success: true, liked: false });
    }
    await pool.query('INSERT INTO favorites (user_id, product_id) VALUES ($1, $2)', [tgUser.id, productId]);
    res.json({ success: true, liked: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/favorites/list', async (req, res) => {
  const { initData, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const params = [tgUser.id];
    let where = 'WHERE f.user_id = $1 AND p.is_active = TRUE';
    if (category && category !== 'all') { params.push(category); where += ` AND p.category = $${params.length}`; }
    const r = await pool.query(`SELECT p.id, p.wb_id, p.name, p.price, p.category, p.image_url, p.fallback_url, p.description, p.source_url FROM favorites f JOIN products p ON p.id = f.product_id ${where} ORDER BY f.created_at DESC LIMIT 200`, params);
    res.json({ success: true, items: r.rows });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/achievements', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT code FROM achievements WHERE user_id = $1', [tgUser.id]);
    const owned = r.rows.map(x => x.code);
    const list = Object.entries(ACHIEVEMENTS).map(([code, a]) => ({ code, emoji: a.emoji, name: a.name, desc: a.desc, earned: owned.includes(code) }));
    res.json({ success: true, items: list });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/gift/create', async (req, res) => {
  const { initData, tries } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const n = Math.max(1, Math.min(50, Number(tries) || 5));
  const stars = n * 5;
  const code = 'gift_' + crypto.randomBytes(6).toString('hex');
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Подарок: ${n} примерок`, description: 'Подарочная ссылка', payload: `gift:${tgUser.id}:${n}:${code}`, currency: 'XTR', prices: [{ label: `${n} примерок`, amount: stars }] }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    await pool.query(`INSERT INTO gifts (from_tg_id, gift_code, tries, stars) VALUES ($1, $2, $3, $4)`, [tgUser.id, code, n, stars]);
    res.json({ success: true, invoiceLink: data.result, giftCode: code });
  } catch (e) { logError('gift-create', e.message); res.status(500).json({ error: e.message }); }
});
app.post('/api/gift/claim', async (req, res) => {
  const { initData, giftCode } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const g = await pool.query(`SELECT * FROM gifts WHERE gift_code = $1 AND claimed = FALSE`, [giftCode]);
    if (!g.rows.length) return res.status(404).json({ error: 'Подарок не найден или уже использован' });
    const gift = g.rows[0];
    if (gift.from_tg_id === tgUser.id) return res.status(400).json({ error: 'Нельзя активировать свой подарок' });
    await pool.query(`UPDATE gifts SET claimed = TRUE, to_tg_id = $1, claimed_at = NOW() WHERE gift_code = $2`, [tgUser.id, giftCode]);
    await pool.query(`UPDATE users SET balance = balance + $1 WHERE tg_id = $2`, [gift.tries, tgUser.id]);
    sendMessage(gift.from_tg_id, `🎁 Твою подарочную ссылку активировали!`).catch(() => {});
    res.json({ success: true, tries: gift.tries });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

async function withTimeout(promise, ms, label, abortController = null) {
  let timeoutId;
  const timeoutPromise = new Promise((_, rej) => { timeoutId = setTimeout(() => { if (abortController) abortController.abort(); rej(new Error(`${label}: timeout ${ms}ms`)); }, ms); });
  try { return await Promise.race([promise, timeoutPromise]); } finally { clearTimeout(timeoutId); }
}
function logFalError(label, e) {
  console.warn(`[tryon] FAIL ${label}: ${e.message || '(пустая)'}`);
  try { logError(`tryon:${label}`, e.message || '(пустая ошибка)', JSON.stringify({ name: e.name, status: e.status })); } catch {}
}
async function fetchImageAsBase64(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Referer': 'https://www.wildberries.ru/', 'Accept': 'image/*,*/*;q=0.8' }, timeout: 10000 });
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
  const controller = new AbortController();
  try {
    const url = await withTimeout(
      fal.subscribe('fal-ai/image-apps-v2/virtual-try-on', { input: { person_image_url: humanImg, clothing_image_url: garmentData }, logs: false, abortSignal: controller.signal }).then(r => r?.data?.image?.url || r?.data?.images?.[0]?.url || null),
      30000, 'image-apps-v2', controller);
    if (url) return { url, model: 'image-apps-v2' };
  } catch (e) { logFalError('image-apps-v2', e); }
  return { url: null, model: null };
}

async function checkAbuse(tgId) {
  try {
    const hour = await pool.query(`SELECT COUNT(*)::int AS c FROM generations WHERE tg_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [tgId]);
    if (hour.rows[0].c > 100) {
      await pool.query('UPDATE users SET is_banned = TRUE, ban_reason = $1 WHERE tg_id = $2', ['Автобан: >100 генераций в час', tgId]);
      sendMessage(tgId, `🚫 <b>Автобан</b>\n\nСлишком много запросов (>100/час).`).catch(() => {});
      const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
      for (const a of admins.rows) sendMessage(a.tg_id, `🚫 <b>Автобан</b> юзера <code>${tgId}</code>\n>100 генераций/час`).catch(() => {});
      return true;
    }
  } catch {}
  return false;
}

app.post('/api/tryon', async (req, res) => {
  const { initData, humanImg, garmentUrl, itemId, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!humanImg || !garmentUrl) return res.status(400).json({ error: 'Нет фото или товара' });
  try {
    if (await checkAbuse(tgId)) return res.status(403).json({ error: 'Заблокировано' });
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Вы заблокированы' });
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && user.balance <= 0) return res.status(402).json({ error: 'Нет попыток' });
    const { url: resultUrl, model } = await runFalTryon({ humanImg, garmentUrl });
    await logGeneration(tgId, model, !!resultUrl, itemId);
    if (!resultUrl) return res.json({ success: false, error: 'Не получилось. Попробуй другое фото.' });
    if (!hasUnlimited) await pool.query('UPDATE users SET balance = balance - 1 WHERE tg_id = $1', [tgId]);
    const snap = itemId ? (await pool.query('SELECT wb_id, name, image_url FROM products WHERE id = $1', [itemId])).rows[0] || {} : {};
    await pool.query(`INSERT INTO tryon_history (user_id, product_id, product_wb_id, product_name, product_image, result_url, is_mock, category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tgId, itemId ? Number(itemId) : null, snap.wb_id || null, snap.name || null, snap.image_url || null, resultUrl, false, category || null]);
    const total = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history WHERE user_id = $1', [tgId]);
    const c = total.rows[0].c;
    if (c >= 1) await giveAchievement(tgId, 'first_tryon');
    if (c >= 10) await giveAchievement(tgId, 'ten_tryons');
    if (c >= 50) await giveAchievement(tgId, 'fifty_tryons');
    if (c >= 100) await giveAchievement(tgId, 'hundred');
    if (user.ref_by && !user.ref_rewarded) {
      const refBonus = Number(await getSetting('ref_bonus', '1'));
      await pool.query('UPDATE users SET ref_rewarded = TRUE WHERE tg_id = $1', [tgId]);
      await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [refBonus, user.ref_by]);
      sendMessage(user.ref_by, `🎉 Подруга сделала первую примерку! +${refBonus} попытка ✨`).catch(() => {});
      const refCnt = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE ref_by = $1 AND ref_rewarded = TRUE', [user.ref_by]);
      if (refCnt.rows[0].c >= 1) await giveAchievement(user.ref_by, 'first_ref');
      if (refCnt.rows[0].c >= 3) await giveAchievement(user.ref_by, 'three_refs');
    }
    res.json({ success: true, resultUrl, model });
  } catch (e) { logError('tryon', e.message); res.json({ success: false, error: 'Что-то пошло не так.' }); }
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
    if (await checkAbuse(tgId)) return res.status(403).json({ error: 'Заблокировано' });
    const u = await pool.query('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = u.rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Заблокированы' });
    const hasUnlimited = user.unlimited_until && new Date(user.unlimited_until) > new Date();
    if (!hasUnlimited && (user.own_tries || 0) <= 0) return res.status(402).json({ error: 'Нет попыток своих товаров' });
    const info = await fetchWBProductInfo(wbId);
    const garmentUrl = primaryImageUrl(wbId);
    const productName = info?.name || `Товар ${wbId}`;
    const { url: resultUrl, model } = await runFalTryon({ humanImg, garmentUrl });
    await logGeneration(tgId, model, !!resultUrl, null);
    if (!resultUrl) return res.json({ success: false, error: 'Не получилось.' });
    if (!hasUnlimited) await pool.query('UPDATE users SET own_tries = own_tries - 1 WHERE tg_id = $1', [tgId]);
    await pool.query(`INSERT INTO tryon_history (user_id, product_wb_id, product_name, product_image, result_url, is_mock) VALUES ($1,$2,$3,$4,$5,$6)`, [tgId, wbId, productName, garmentUrl, resultUrl, false]);
    await giveAchievement(tgId, 'own_product');
    try {
      await sendPhoto(tgId, resultUrl, `✨ <b>Твоя примерка готова!</b>\n\nОткрой приложение, чтобы скачать или поделиться`,
        { inline_keyboard: [[{ text: '🛍 Открыть Style Room', web_app: { url: FRONT_URL } }]] });
    } catch {}
    res.json({ success: true, resultUrl, productName });
  } catch (e) { logError('tryon-by-link', e.message); res.json({ success: false, error: 'Что-то пошло не так.' }); }
});

app.post('/api/tryon-multi', async (req, res) => {
  const { initData, humanImg, items } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tgId = tgUser.id;
  if (!Array.isArray(items) || items.length < 2 || items.length > 3) return res.status(400).json({ error: 'Нужно 2–3 вещи' });
  const cats = items.map(i => i.category);
  const uniqCats = new Set(cats);
  if (uniqCats.size !== cats.length) return res.status(400).json({ error: 'Можно примерять вместе только товары из разных категорий' });
  if (cats.filter(c => c === 'suit').length > 0 && cats.filter(c => ['top','bottom'].includes(c)).length > 0) {
    return res.status(400).json({ error: 'Костюм не сочетается с верхом или низом. Выбери другое' });
  }
  try {
    if (await checkAbuse(tgId)) return res.status(403).json({ error: 'Заблокировано' });
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
      if (r.url) await pool.query(`INSERT INTO tryon_history (user_id, product_id, product_name, result_url, is_mock) VALUES ($1,$2,$3,$4,$5)`, [tgId, r.itemId || null, r.name || null, r.url, false]);
    }
    if (success > 0) await giveAchievement(tgId, 'multi_tryon');
    if (success === 0) return res.json({ success: false, error: 'Не получилось.' });
    res.json({ success: true, results, charged: success });
  } catch (e) { logError('tryon-multi', e.message); res.json({ success: false, error: 'Что-то пошло не так.' }); }
});

app.post('/api/history', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(`SELECT id, result_url, is_mock, created_at, category, COALESCE(product_name, 'Товар') AS product_name, product_wb_id, product_image FROM tryon_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [tgUser.id]);
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
  } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/idea', async (req, res) => {
  const { initData, text } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return res.status(400).json({ error: 'Пусто' });
  try {
    await pool.query(`INSERT INTO ideas (tg_id, first_name, username, text) VALUES ($1,$2,$3,$4)`, [tgUser.id, tgUser.first_name || null, tgUser.username || null, clean]);
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
  try { await pool.query('UPDATE users SET onboarded = TRUE WHERE tg_id = $1', [tgUser.id]); res.json({ success: true }); } catch { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/create-invoice', async (req, res) => {
  const { tgId, productType, tries, ownTries } = req.body;
  let title = '10 примерок', amount = 50, payload = `pack10:${tgId}:${Date.now()}`;
  if (SUBSCRIPTIONS[productType]) {
    const sub = SUBSCRIPTIONS[productType]; title = `${sub.emoji} ${sub.title}`; amount = sub.stars;
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

async function checkBrokenProducts() {
  const t0 = Date.now();
  try {
    const r = await pool.query(`SELECT id, wb_id, name FROM products WHERE is_active = TRUE`);
    let checked = 0, broken = 0;
    const brokenList = [];
    for (let i = 0; i < r.rows.length; i += 10) {
      const chunk = r.rows.slice(i, i + 10);
      await Promise.all(chunk.map(async (row) => {
        checked++;
        try {
          const info = await fetchWBProductInfo(row.wb_id);
          if (!info?.name) {
            await pool.query(`UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [row.id]);
            broken++;
            brokenList.push(`${row.wb_id} — ${(row.name || '').slice(0, 40)}`);
          }
        } catch {}
      }));
    }
    console.log(`[cleanup] ${Date.now() - t0}ms. ${checked} → ${broken}`);
    const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
    if (broken > 0) {
      const msg = `🧹 Автопроверка\n\nПроверено: ${checked}\nСкрыто: <b>${broken}</b>\n\n` + brokenList.slice(0, 15).map(t => `• <code>${t}</code>`).join('\n');
      for (const a of admins.rows) sendMessage(a.tg_id, msg).catch(() => {});
    }
  } catch (e) { logError('cleanup', e.message); }
}

async function autoCleanupIrrelevant() {
  try {
    const r = await pool.query(`
      UPDATE products SET is_active = FALSE, updated_at = NOW()
      WHERE is_active = TRUE AND source = 'auto'
        AND id NOT IN (SELECT DISTINCT product_id FROM product_views WHERE viewed_at > NOW() - INTERVAL '30 days')
        AND id NOT IN (SELECT DISTINCT product_id FROM tryon_history WHERE product_id IS NOT NULL AND created_at > NOW() - INTERVAL '30 days')
        AND updated_at < NOW() - INTERVAL '30 days'
      RETURNING id
    `);
    console.log(`[auto-cleanup] скрыто: ${r.rowCount}`);
  } catch (e) { console.error('[auto-cleanup]', e.message); }
}

function mainAdminKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'adm_stats' }],
      [{ text: '💰 Финансы', callback_data: 'adm_expenses' }, { text: '📈 Аналитика', callback_data: 'adm_analytics' }],
      [{ text: '👥 Юзеры', callback_data: 'adm_users' }, { text: '🎁 Выдать', callback_data: 'adm_give_tries' }],
      [{ text: '🛍 Каталог', callback_data: 'adm_catalog' }],
      [{ text: '🎟 Промокоды', callback_data: 'adm_promo' }, { text: '🎁 Подарки', callback_data: 'adm_gifts' }],
      [{ text: '📢 Рассылка', callback_data: 'adm_broadcast' }],
      [{ text: '⚙️ Настройки', callback_data: 'adm_globals' }],
      [{ text: '🔔 Ошибки', callback_data: 'adm_errors' }, { text: '🚧 Тех.режим', callback_data: 'adm_maintenance' }],
    ],
  };
}
function catalogMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Добавить по ссылкам', callback_data: 'adm_add_link' }],
      [{ text: '🗑 Удалить по ссылкам', callback_data: 'adm_remove_links' }],
      [{ text: '🔄 Пополнить из WB', callback_data: 'adm_refresh_catalog' }],
      [{ text: '📦 Массовые операции', callback_data: 'adm_mass_menu' }],
      [{ text: '🔍 Проверить битые', callback_data: 'adm_check_products' }],
      [{ text: '🗑 Удалить битые', callback_data: 'adm_delete_broken' }],
      [{ text: '📌 Закрепить', callback_data: 'adm_pin' }, { text: '🙈 Скрыть', callback_data: 'adm_hide' }],
      [{ text: '👁 Вернуть', callback_data: 'adm_unhide' }, { text: '🗑 Удалить один', callback_data: 'adm_delete' }],
      [{ text: '🔄 Обновить названия', callback_data: 'adm_backfill' }],
      [{ text: '🧹 Старше 5 дней', callback_data: 'adm_cleanup' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}
function massMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔀 Сменить категорию у всех', callback_data: 'adm_mass_change_cat' }],
      [{ text: '🗑 Удалить все из категории', callback_data: 'adm_mass_delete_cat' }],
      [{ text: '👁 Скрыть все из категории', callback_data: 'adm_mass_hide_cat' }],
      [{ text: '💥 УДАЛИТЬ ВСЕ ТОВАРЫ', callback_data: 'adm_mass_delete_all' }],
      [{ text: '← Назад', callback_data: 'adm_catalog' }],
    ],
  };
}
function globalsKeyboard(streakEnabled) {
  return {
    inline_keyboard: [
      [{ text: '🎁 Стартовый баланс', callback_data: 'adm_set_start' }],
      [{ text: '📅 Ежедневный бонус', callback_data: 'adm_set_daily' }],
      [{ text: '🔥 Награда за стрик', callback_data: 'adm_set_streak' }],
      [{ text: streakEnabled ? '🔥 Стрик: ВКЛ ✅' : '🔥 Стрик: ВЫКЛ ❌', callback_data: 'adm_toggle_streak' }],
      [{ text: '👥 Бонус за друга', callback_data: 'adm_set_ref' }],
      [{ text: '📩 Одноразовое сообщение', callback_data: 'adm_set_otm' }],
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
      [{ text: '🏆 Топ по примеркам', callback_data: 'adm_users_leaderboard' }],
      [{ text: '🆕 За сутки', callback_data: 'adm_users_new' }],
      [{ text: '🔍 Найти', callback_data: 'adm_find' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}
function userActionsKeyboard(tgId, isBanned = false, isAdmin = false) {
  return {
    inline_keyboard: [
      [{ text: '🎁 +5', callback_data: `usr_add_5_${tgId}` }, { text: '🎁 +10', callback_data: `usr_add_10_${tgId}` }],
      [{ text: '🎁 +25', callback_data: `usr_add_25_${tgId}` }, { text: '🎁 +50', callback_data: `usr_add_50_${tgId}` }],
      [{ text: '➖ −5', callback_data: `usr_sub_5_${tgId}` }, { text: '➖ −10', callback_data: `usr_sub_10_${tgId}` }, { text: '➖ −25', callback_data: `usr_sub_25_${tgId}` }],
      [{ text: '✏️ Своё число', callback_data: `usr_add_custom_${tgId}` }],
      [{ text: '📦 +5 своих', callback_data: `usr_addown_5_${tgId}` }, { text: '📦 −5 своих', callback_data: `usr_subown_5_${tgId}` }],
      [{ text: '📦 Своё число', callback_data: `usr_addown_custom_${tgId}` }],
      [{ text: '♾ 24ч', callback_data: `usr_unlimit_${tgId}` }, { text: '❌ Снять', callback_data: `usr_unlimit_off_${tgId}` }],
      [{ text: '📝 Заметки', callback_data: `usr_notes_${tgId}` }],
      [{ text: isAdmin ? '❌ Снять админа' : '💎 Сделать админом', callback_data: isAdmin ? `usr_admin_off_${tgId}` : `usr_admin_on_${tgId}` }],
      [{ text: isBanned ? '✅ Разблокировать' : '🚫 Заблокировать', callback_data: `usr_${isBanned ? 'unban' : 'ban'}_${tgId}` }],
      [{ text: '💬 Сообщение', callback_data: `usr_dm_${tgId}` }],
      [{ text: '🗑 Удалить', callback_data: `usr_delete_${tgId}` }],
      [{ text: '← К юзерам', callback_data: 'adm_users' }],
    ],
  };
}
function maintenanceKeyboard(isOn) {
  return {
    inline_keyboard: [
      [{ text: isOn ? '✅ Включить' : '🚧 Включить тех.режим', callback_data: isOn ? 'adm_maint_off' : 'adm_maint_on' }],
      [{ text: '✏️ Текст для юзеров', callback_data: 'adm_maint_text' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

const awaitingBroadcast = new Set();
const awaitingBroadcastPhoto = new Map();
const awaitingScheduled = new Map();
const awaitingUserSearch = new Set();
const awaitingAddCustom = new Map();
const awaitingAddOwnCustom = new Map();
const awaitingLinkForAdd = new Set();
const awaitingLinkForRemove = new Set();
const awaitingPromoCustom = new Map();
const awaitingProductAction = new Map();
const awaitingDM = new Map();
const awaitingMaintText = new Set();
const awaitingBanReason = new Map();
const awaitingNote = new Map();
const awaitingGlobalValue = new Map();
const awaitingMassAction = new Map();

function randomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  if (await isAdmin(msg.from.id)) await sendMessage(chatId, '👑 <b>Админ-панель</b>', mainAdminKeyboard());
  else await sendMessage(chatId, '✨ <b>Style Room</b> — ИИ-примерочная в Telegram.', { inline_keyboard: [[{ text: '🛍 Открыть', web_app: { url: FRONT_URL } }]] });
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
  const catBack = { inline_keyboard: [[{ text: '← К каталогу', callback_data: 'adm_catalog' }]] };

  if (data === 'adm_back') return back();

  // ГЛОБАЛЬНЫЕ НАСТРОЙКИ
  if (data === 'adm_globals') {
    const streakEnabled = await isStreakEnabled();
    const sb = await getSetting('start_balance', '2');
    const db = await getSetting('daily_bonus', '1');
    const sr = await getSetting('streak_reward_own', '3');
    const rb = await getSetting('ref_bonus', '1');
    const otm = await getSetting('one_time_message', '');
    return editMessage(chatId, messageId, `⚙️ <b>Настройки</b>\n\n🎁 Стартовый: <b>${sb}</b>\n📅 Ежедневный: <b>${db}</b>\n🔥 Стрик: <b>${streakEnabled ? 'ВКЛ' : 'ВЫКЛ'}</b>\n   Награда: <b>${sr}</b> своих\n👥 Реферал: <b>${rb}</b>\n📩 Одноразовое: ${otm ? '<i>задано</i>' : '<i>пусто</i>'}`, globalsKeyboard(streakEnabled));
  }
  if (['adm_set_start','adm_set_daily','adm_set_streak','adm_set_ref','adm_set_otm'].includes(data)) {
    const key = data === 'adm_set_start' ? 'start_balance' : data === 'adm_set_daily' ? 'daily_bonus' : data === 'adm_set_streak' ? 'streak_reward_own' : data === 'adm_set_ref' ? 'ref_bonus' : 'one_time_message';
    awaitingGlobalValue.set(userId, key);
    const labels = { start_balance: 'стартовый баланс', daily_bonus: 'ежедневный бонус', streak_reward_own: 'награда за стрик', ref_bonus: 'бонус за друга', one_time_message: 'одноразовое сообщение (или "-" чтобы очистить)' };
    return editMessage(chatId, messageId, `✏️ Введи: <b>${labels[key]}</b>`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_globals' }]] });
  }
  if (data === 'adm_toggle_streak') {
    const cur = await isStreakEnabled();
    await setSetting('streak_enabled', cur ? 'false' : 'true');
    return editMessage(chatId, messageId, `🔥 Стрик ${cur ? 'ВЫКЛЮЧЕН' : 'ВКЛЮЧЁН'}. Число у юзеров сохранено.`, globalsKeyboard(!cur));
  }

  // ПОПОЛНИТЬ КАТАЛОГ
  if (data === 'adm_refresh_catalog') {
    return editMessage(chatId, messageId,
      '🔄 <b>Пополнить каталог</b>\n\nЧто тянем из WB?',
      { inline_keyboard: [
        [{ text: '🌍 Все категории', callback_data: 'adm_rc_all' }],
        [{ text: '🍂 Только Осень', callback_data: 'adm_rc_autumn' }],
        [{ text: '👕 Только Верх', callback_data: 'adm_rc_top' }],
        [{ text: '👖 Только Низ', callback_data: 'adm_rc_bottom' }],
        [{ text: '🧥 Только Верхняя одежда', callback_data: 'adm_rc_outerwear' }],
        [{ text: '🥼 Только Костюмы', callback_data: 'adm_rc_suit' }],
        [{ text: '👗 Только Платья', callback_data: 'adm_rc_dress' }],
        [{ text: '← К каталогу', callback_data: 'adm_catalog' }],
      ]});
  }
  if (data.startsWith('adm_rc_')) {
    const cat = data.replace('adm_rc_', '');
    const catLabels = { all: 'все категории', autumn: 'Осень', top: 'Верх', bottom: 'Низ', outerwear: 'Верхняя одежда', suit: 'Костюмы', dress: 'Платья' };
    await editMessage(chatId, messageId, `🔄 <b>Пополняю «${catLabels[cat] || cat}»…</b>\n\nЭто займёт до 1–2 минут.`, catBack);
    try {
      const result = await refreshCatalog(cat === 'all' ? 'all' : cat);
      let msg;
      if (!result.success) {
        msg = `❌ <b>Не удалось</b>\n\n${result.reason}\n\n` + (result.errors && result.errors.length ? `Первые ошибки:\n${result.errors.slice(0, 3).map(e => '• ' + e).join('\n')}` : '');
      } else if (result.added === 0 && result.updated === 0) {
        msg = `⚠️ <b>Не добавлено ничего нового</b>\n\nКатегория: <b>${catLabels[cat] || cat}</b>\n\nВсе товары уже в базе.`;
      } else {
        msg = `✅ <b>Готово!</b>\n\nКатегория: <b>${catLabels[cat] || cat}</b>\n\n➕ Новых: <b>${result.added}</b>\n🔄 Обновлено: <b>${result.updated}</b>\n⊘ Пропущено: <b>${result.failed}</b>`;
      }
      for (const a of admins.rows) sendMessage(a.tg_id, msg, catBack).catch(() => {});
    } catch (e) {
      logError('refresh-catalog', e.message);
      for (const a of admins.rows) sendMessage(a.tg_id, `❌ Ошибка: ${e.message}`, catBack).catch(() => {});
    }
    return;
  }

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
      return editMessage(chatId, messageId, `📊 <b>Статистика</b>\n\n👥 Юзеров: <b>${u.rows[0].c}</b> (бан: ${banned.rows[0].c})\n🔥 Активных 7д: <b>${active7.rows[0].c}</b>\n✨ Примерок: <b>${t.rows[0].c}</b>\n🛍 Товаров: <b>${p.rows[0].c}</b> (скрыто: ${ph.rows[0].c})\n💳 Платежей: <b>${pay.rows[0].c}</b> · ⭐️ <b>${pay.rows[0].s}</b>\n🔔 Ошибок за сутки: <b>${err24.rows[0].c}</b>`, { inline_keyboard: [[{ text: '📕 Все ошибки', callback_data: 'adm_err_history' }], backKb.inline_keyboard[0]] });
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  if (data === 'adm_expenses') {
    try {
      const all = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE`);
      const today = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE AND created_at > NOW() - INTERVAL '1 day'`);
      const week = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE AND created_at > NOW() - INTERVAL '7 days'`);
      const month = await pool.query(`SELECT COALESCE(SUM(cost_usd),0)::numeric AS sum FROM generations WHERE success = TRUE AND created_at > NOW() - INTERVAL '30 days'`);
      const failed = await pool.query(`SELECT COUNT(*)::int AS c FROM generations WHERE success = FALSE`);
      const incAll = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments`);
      const inc30 = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments WHERE created_at > NOW() - INTERVAL '30 days'`);
      const inc7 = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments WHERE created_at > NOW() - INTERVAL '7 days'`);
      const incToday = await pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments WHERE created_at > NOW() - INTERVAL '1 day'`);
      const usdAll = Number(incAll.rows[0].s) * STAR_TO_USD, usd30 = Number(inc30.rows[0].s) * STAR_TO_USD, usd7 = Number(inc7.rows[0].s) * STAR_TO_USD, usdToday = Number(incToday.rows[0].s) * STAR_TO_USD;
      const costAll = Number(all.rows[0].sum), cost30 = Number(month.rows[0].sum), cost7 = Number(week.rows[0].sum), costToday = Number(today.rows[0].sum);
      const pAll = usdAll - costAll, p30 = usd30 - cost30, p7 = usd7 - cost7, pT = usdToday - costToday;
      const fc = (usd7 / 7) * 30 - (cost7 / 7) * 30;
      const sign = (n) => n >= 0 ? '+' : '';
      const fmt = (n) => `$${Number(n).toFixed(2)}`;
      let advice = '';
      const dailyAvgCost = cost7 / 7;
      const dailyAvgIncome = usd7 / 7;
      if (dailyAvgCost > dailyAvgIncome * 1.5) advice = '\n\n⚠️ Расходы сильно превышают доходы. Проверь цены/промо.';
      else if (dailyAvgIncome > dailyAvgCost * 2) advice = '\n\n🎉 Отличная рентабельность! Можно масштабироваться.';
      return editMessage(chatId, messageId, `💰 <b>Финансы</b>\n\n<b>Доходы (⭐️ → $):</b>\nСегодня: ${incToday.rows[0].c} · ${fmt(usdToday)}\n7 дней: ${inc7.rows[0].c} · ${fmt(usd7)}\n30 дней: ${inc30.rows[0].c} · ${fmt(usd30)}\nВсего: ${incAll.rows[0].c} · ${fmt(usdAll)}\n\n<b>Расходы (FAL):</b>\nСегодня: ${fmt(costToday)}\n7 дней: ${fmt(cost7)}\n30 дней: ${fmt(cost30)}\nВсего: ${fmt(costAll)}\nНеудачных: ${failed.rows[0].c}\n\n<b>Прибыль:</b>\nСегодня: ${sign(pT)}<b>${fmt(pT)}</b>\n7 дней: ${sign(p7)}<b>${fmt(p7)}</b>\n30 дней: ${sign(p30)}<b>${fmt(p30)}</b>\nВсего: ${sign(pAll)}<b>${fmt(pAll)}</b>\n\n🔮 <b>Прогноз 30 дней:</b> ${sign(fc)}<b>${fmt(fc)}</b>${advice}`, backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  if (data === 'adm_analytics') {
    try {
      const days = await pool.query(`SELECT DATE(created_at)::text AS d, COUNT(*)::int AS c FROM tryon_history WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY d ASC`);
      let chart = '';
      const maxC = Math.max(1, ...days.rows.map(r => r.c));
      for (const row of days.rows) chart += `${row.d.slice(5)}  ${'█'.repeat(Math.round((row.c / maxC) * 10))}  ${row.c}\n`;
      const topP = await pool.query(`SELECT p.id, p.wb_id, COALESCE(p.name,'Товар') AS name, COUNT(t.id)::int AS c FROM tryon_history t JOIN products p ON p.id = t.product_id WHERE t.created_at > NOW() - INTERVAL '30 days' GROUP BY p.id ORDER BY c DESC LIMIT 5`);
      let tp = '';
      for (const p of topP.rows) tp += `• <a href="https://www.wildberries.ru/catalog/${p.wb_id}/detail.aspx">${p.name.slice(0, 40)}</a> — ${p.c}\n`;
      const f = (await pool.query(`SELECT (SELECT COUNT(*)::int FROM users) AS u, (SELECT COUNT(DISTINCT user_id)::int FROM tryon_history) AS t, (SELECT COUNT(DISTINCT tg_id)::int FROM payments) AS p`)).rows[0];
      const c1 = f.u > 0 ? Math.round((f.t / f.u) * 100) : 0;
      const c2 = f.t > 0 ? Math.round((f.p / f.t) * 100) : 0;
      return editMessage(chatId, messageId, `📈 <b>Аналитика</b>\n\n<b>Примерки 7д:</b>\n<pre>${chart || '—'}</pre>\n<b>Топ товаров (кликни):</b>\n${tp || '—'}\n<b>Воронка:</b>\n1. Зарегались: ${f.u}\n2. Примерка: ${f.t} (${c1}%)\n3. Купили: ${f.p} (${c2}%)`, backKb);
    } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, backKb); }
  }

  if (data === 'adm_maintenance') {
    const on = await isMaintenanceMode();
    const text = await getSetting('maintenance_text', '');
    return editMessage(chatId, messageId, `🚧 <b>Тех.режим</b>\n\nСтатус: ${on ? '🔴 ВКЛ' : '🟢 ВЫКЛ'}\n\nТекст: <i>${text}</i>\n\n<i>Админы видят приложение всегда</i>`, maintenanceKeyboard(on));
  }
  if (data === 'adm_maint_on') { await setSetting('maintenance', 'true'); return editMessage(chatId, messageId, `🔴 Включено`, maintenanceKeyboard(true)); }
  if (data === 'adm_maint_off') { await setSetting('maintenance', 'false'); return editMessage(chatId, messageId, `🟢 Выключено`, maintenanceKeyboard(false)); }
  if (data === 'adm_maint_text') { awaitingMaintText.add(userId); return editMessage(chatId, messageId, `✏️ Пришли текст:\nСейчас: <i>${await getSetting('maintenance_text', '')}</i>`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_maintenance' }]] }); }

  if (data === 'adm_errors') {
    const last5 = await pool.query(`SELECT source, message, created_at FROM error_log ORDER BY created_at DESC LIMIT 5`);
    let m = `🔔 <b>Последние 5 ошибок</b>\n\n`;
    if (last5.rows.length) for (const e of last5.rows) m += `${new Date(e.created_at).toLocaleTimeString('ru-RU')} · <code>${e.source}</code>\n${(e.message || '').slice(0, 100)}\n\n`;
    else m += `Чисто ✅`;
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '📕 Все ошибки', callback_data: 'adm_err_history' }], backKb.inline_keyboard[0]] });
  }
  if (data === 'adm_err_history') {
    const r = await pool.query(`SELECT source, message, created_at FROM error_log ORDER BY created_at DESC LIMIT 30`);
    if (!r.rows.length) return editMessage(chatId, messageId, '📕 Журнал пуст ✅', backKb);
    let m = `📕 <b>Журнал</b>\n\n`;
    for (const e of r.rows) { const t = new Date(e.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); m += `<b>${t}</b> · <code>${e.source}</code>\n${(e.message || '').slice(0, 150)}\n\n`; }
    return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '🗑 Очистить', callback_data: 'adm_err_clear' }], backKb.inline_keyboard[0]] });
  }
  if (data === 'adm_err_clear') { await pool.query('DELETE FROM error_log'); return editMessage(chatId, messageId, '🗑 Очищено', backKb); }

  if (data === 'adm_give_tries') { awaitingUserSearch.add(userId); return editMessage(chatId, messageId, `🎁 @username или ID:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] }); }

  if (data === 'adm_users') return editMessage(chatId, messageId, '👥 <b>Юзеры</b>', usersMenuKeyboard());
  if (data === 'adm_users_last') { const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY created_at DESC LIMIT 20`); const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]); btns.push([{ text: '←', callback_data: 'adm_users' }]); return editMessage(chatId, messageId, '👥 Последние:', { inline_keyboard: btns }); }
  if (data === 'adm_users_top') { const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 20`); const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]); btns.push([{ text: '←', callback_data: 'adm_users' }]); return editMessage(chatId, messageId, '💰 Топ:', { inline_keyboard: btns }); }
  if (data === 'adm_users_leaderboard') { const r = await pool.query(`SELECT u.tg_id, u.first_name, COUNT(t.id)::int AS c FROM users u JOIN tryon_history t ON t.user_id = u.tg_id WHERE t.created_at > NOW() - INTERVAL '30 days' AND u.is_admin = FALSE GROUP BY u.tg_id ORDER BY c DESC LIMIT 20`); if (!r.rows.length) return editMessage(chatId, messageId, 'Пока никого', usersMenuKeyboard()); const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ${u.c}`, callback_data: `usr_show_${u.tg_id}` }]); btns.push([{ text: '←', callback_data: 'adm_users' }]); return editMessage(chatId, messageId, '🏆 Топ по примеркам:', { inline_keyboard: btns }); }
  if (data === 'adm_users_new') { const r = await pool.query(`SELECT tg_id, first_name, balance FROM users WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 20`); const btns = r.rows.map(u => [{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]); btns.push([{ text: '←', callback_data: 'adm_users' }]); return editMessage(chatId, messageId, '🆕 За сутки:', { inline_keyboard: btns }); }
  if (data === 'adm_find') { awaitingUserSearch.add(userId); return editMessage(chatId, messageId, '🔍 @username или ID:', { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] }); }
  if (data.startsWith('usr_show_')) return showUserCard(chatId, messageId, Number(data.replace('usr_show_', '')));
  if (data.startsWith('usr_add_custom_')) { const tgId = Number(data.replace('usr_add_custom_', '')); awaitingAddCustom.set(userId, tgId); return editMessage(chatId, messageId, '✏️ Сколько попыток? (можно −)', { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] }); }
  if (data.startsWith('usr_addown_custom_')) { const tgId = Number(data.replace('usr_addown_custom_', '')); awaitingAddOwnCustom.set(userId, tgId); return editMessage(chatId, messageId, '✏️ Сколько своих? (можно −)', { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] }); }
  if (/^usr_add_\d+_\d+$/.test(data)) { const [, , count, tgId] = data.split('_'); await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [Number(count), Number(tgId)]); return showUserCard(chatId, messageId, Number(tgId), `+${count}`); }
  if (/^usr_sub_\d+_\d+$/.test(data)) { const [, , count, tgId] = data.split('_'); await pool.query('UPDATE users SET balance = GREATEST(0, balance - $1) WHERE tg_id = $2', [Number(count), Number(tgId)]); return showUserCard(chatId, messageId, Number(tgId), `−${count}`); }
  if (/^usr_addown_\d+_\d+$/.test(data)) { const [, , count, tgId] = data.split('_'); await pool.query('UPDATE users SET own_tries = own_tries + $1 WHERE tg_id = $2', [Number(count), Number(tgId)]); return showUserCard(chatId, messageId, Number(tgId), `+${count} своих`); }
  if (/^usr_subown_\d+_\d+$/.test(data)) { const [, , count, tgId] = data.split('_'); await pool.query('UPDATE users SET own_tries = GREATEST(0, own_tries - $1) WHERE tg_id = $2', [Number(count), Number(tgId)]); return showUserCard(chatId, messageId, Number(tgId), `−${count} своих`); }
  if (data.startsWith('usr_unlimit_off_')) { const tgId = Number(data.replace('usr_unlimit_off_', '')); await pool.query('UPDATE users SET unlimited_until = NULL WHERE tg_id = $1', [tgId]); return showUserCard(chatId, messageId, tgId, 'Снят'); }
  if (data.startsWith('usr_unlimit_')) { const tgId = Number(data.replace('usr_unlimit_', '')); await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [new Date(Date.now() + 86400000), tgId]); return showUserCard(chatId, messageId, tgId, '24ч'); }
  if (data.startsWith('usr_admin_on_')) { const tgId = Number(data.replace('usr_admin_on_', '')); await pool.query('UPDATE users SET is_admin = TRUE WHERE tg_id = $1', [tgId]); return showUserCard(chatId, messageId, tgId, '👑 Теперь админ'); }
  if (data.startsWith('usr_admin_off_')) { const tgId = Number(data.replace('usr_admin_off_', '')); await pool.query('UPDATE users SET is_admin = FALSE WHERE tg_id = $1', [tgId]); return showUserCard(chatId, messageId, tgId, 'Снят с админов'); }
  if (data.startsWith('usr_ban_')) { const tgId = Number(data.replace('usr_ban_', '')); awaitingBanReason.set(userId, tgId); return editMessage(chatId, messageId, `🚫 Причина блокировки:`, { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] }); }
  if (data.startsWith('usr_unban_')) { const tgId = Number(data.replace('usr_unban_', '')); await pool.query('UPDATE users SET is_banned = FALSE, ban_reason = NULL WHERE tg_id = $1', [tgId]); return showUserCard(chatId, messageId, tgId, '✅ Разблокирован'); }
  if (data.startsWith('usr_notes_')) { const tgId = Number(data.replace('usr_notes_', '')); const r = await pool.query('SELECT note, created_at FROM user_notes WHERE tg_id = $1 ORDER BY created_at DESC LIMIT 10', [tgId]); let m = `📝 <b>Заметки</b>\n\n`; if (r.rows.length) for (const n of r.rows) m += `${new Date(n.created_at).toLocaleString('ru-RU')}\n${n.note}\n\n`; else m += `Нет заметок. Отправь текст — сохраню.`; awaitingNote.set(userId, tgId); return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '←', callback_data: `usr_show_${tgId}` }]] }); }
  if (data.startsWith('usr_dm_')) { const tgId = Number(data.replace('usr_dm_', '')); awaitingDM.set(userId, tgId); return editMessage(chatId, messageId, `💬 Сообщение для <code>${tgId}</code>:`, { inline_keyboard: [[{ text: '❌', callback_data: `usr_show_${tgId}` }]] }); }
  if (data.startsWith('usr_delete_')) { const tgId = Number(data.replace('usr_delete_', '')); await pool.query('DELETE FROM users WHERE tg_id = $1', [tgId]); return editMessage(chatId, messageId, '🗑 Удалён', { inline_keyboard: [[{ text: '←', callback_data: 'adm_users' }]] }); }

  if (data === 'adm_catalog') return editMessage(chatId, messageId, '🛍 <b>Каталог</b>', catalogMenuKeyboard());
  if (data === 'adm_mass_menu') return editMessage(chatId, messageId, '📦 <b>Массовые операции</b>', massMenuKeyboard());
  if (data === 'adm_mass_delete_all') { awaitingMassAction.set(userId, 'delete_all'); return editMessage(chatId, messageId, `⚠️ <b>УДАЛИТЬ ВСЕ?</b>\n\nНапиши <code>УДАЛИТЬ ВСЕ</code>.`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_mass_menu' }]] }); }
  if (data === 'adm_mass_change_cat') { awaitingMassAction.set(userId, 'change_cat'); return editMessage(chatId, messageId, `🔀 Формат: <code>откуда куда</code>\nПример: <code>top bottom</code>`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_mass_menu' }]] }); }
  if (data === 'adm_mass_delete_cat') { awaitingMassAction.set(userId, 'delete_cat'); return editMessage(chatId, messageId, `🗑 Категория (top/bottom/dress/outerwear/suit/autumn):`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_mass_menu' }]] }); }
  if (data === 'adm_mass_hide_cat') { awaitingMassAction.set(userId, 'hide_cat'); return editMessage(chatId, messageId, `👁 Категория:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_mass_menu' }]] }); }
  if (data === 'adm_add_link') { awaitingLinkForAdd.add(userId); return editMessage(chatId, messageId, `➕ Пришли ссылки (каждую с новой строки):`, catBack); }
  if (data === 'adm_remove_links') { awaitingLinkForRemove.add(userId); return editMessage(chatId, messageId, `🗑 Пришли ссылки для удаления:`, catBack); }
  if (data === 'adm_check_products') { editMessage(chatId, messageId, `🧹 <b>Запущено в фоне</b>`, catBack).catch(() => {}); setImmediate(() => { checkBrokenProducts().catch(e => logError('cleanup-bg', e.message)); }); return; }
  if (data === 'adm_delete_broken') {
    editMessage(chatId, messageId, `🗑 <b>Удаляю в фоне</b>`, catBack).catch(() => {});
    setImmediate(async () => {
      try {
        const r = await pool.query(`SELECT id, wb_id, name FROM products WHERE is_active = TRUE`);
        let deleted = 0; const dl = [];
        for (let i = 0; i < r.rows.length; i += 10) {
          const chunk = r.rows.slice(i, i + 10);
          await Promise.all(chunk.map(async (row) => {
            try {
              const info = await fetchWBProductInfo(row.wb_id);
              if (!info?.name) { await pool.query('DELETE FROM products WHERE id = $1', [row.id]); deleted++; dl.push(`${row.wb_id} — ${(row.name || '').slice(0, 30)}`); }
            } catch {}
          }));
        }
        const msg = `🗑 Удалено: <b>${deleted}</b>\n\n` + dl.slice(0, 15).map(t => `• <code>${t}</code>`).join('\n');
        for (const a of admins.rows) sendMessage(a.tg_id, msg, catBack).catch(() => {});
      } catch (e) { logError('delete-broken', e.message); }
    });
    return;
  }
  if (['adm_pin', 'adm_hide', 'adm_unhide', 'adm_delete'].includes(data)) { const action = data.replace('adm_', ''); awaitingProductAction.set(userId, action); const p = { pin: '📌 Ссылка:', hide: '🙈 Ссылка:', unhide: '👁 Ссылка:', delete: '🗑 Ссылка:' }; return editMessage(chatId, messageId, p[action], catBack); }
  if (data === 'adm_backfill') {
    await editMessage(chatId, messageId, `🔄 <b>Обновляю…</b>`, catBack);
    try {
      const r = await pool.query(`SELECT id, wb_id, name FROM products WHERE name ~ '^Товар\\s' OR name IS NULL OR TRIM(name) = '' OR name LIKE 'Товар%' ORDER BY id DESC LIMIT 300`);
      if (!r.rows.length) { await sendMessage(chatId, `ℹ️ Все названия нормальные`, catBack); return; }
      let u = 0, f = 0; const fails = [];
      for (const row of r.rows) { const info = await fetchWBProductInfo(row.wb_id); if (info?.name && !info.name.startsWith('Товар ')) { await pool.query(`UPDATE products SET name=$1, price=COALESCE($2, price), description=COALESCE(description, $3), updated_at=NOW() WHERE id=$4`, [info.name, info.price, info.description || info.name, row.id]); u++; } else { f++; fails.push(row.wb_id); } await new Promise(rs => setTimeout(rs, 200)); }
      let m = `✅ <b>Обновлено:</b> ${u}\n❌ <b>Не удалось:</b> ${f}`;
      if (fails.length) m += `\n\nНе найденные WB: ${fails.slice(0, 10).join(', ')}`;
      await sendMessage(chatId, m, catBack);
    } catch (e) { await sendMessage(chatId, '❌ ' + e.message, catBack); }
    return;
  }
  if (data === 'adm_cleanup') { try { const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()'); return editMessage(chatId, messageId, `🧹 Удалено: <b>${r.rows[0].deleted_count}</b>`, catBack); } catch (e) { return editMessage(chatId, messageId, '❌ ' + e.message, catBack); } }

  if (data === 'adm_promo') return editMessage(chatId, messageId, '🎟 <b>Промокоды</b>', promoMenuKeyboard());
  if (data === 'adm_promo_custom') { awaitingPromoCustom.set(userId, { step: 'code' }); return editMessage(chatId, messageId, '🎟 Код:', { inline_keyboard: [[{ text: '❌', callback_data: 'adm_promo' }]] }); }
  if (data.startsWith('adm_promo_quick_')) { const type = data.replace('adm_promo_quick_', ''); const code = randomCode(); let tries = 0, unlimited = false; if (type === 'unlimited') unlimited = true; else tries = Number(type); await pool.query(`INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1,$2,$3,1000,TRUE,$4)`, [code, tries, unlimited, unlimited ? 'Безлимит' : `+${tries}`]); return editMessage(chatId, messageId, `✅ <code>${code}</code>`, { inline_keyboard: [[{ text: '🎟', callback_data: 'adm_promo' }]] }); }
  if (data === 'adm_promo_list') { const r = await pool.query(`SELECT code, tries, unlimited, used_count, max_uses, is_active FROM promo_codes ORDER BY created_at DESC LIMIT 20`); if (!r.rows.length) return editMessage(chatId, messageId, 'Пусто', backKb); let m = `🎟 <b>Промокоды</b>\n\n`; for (const p of r.rows) m += `<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' ⛔'}\n`; return editMessage(chatId, messageId, m, { inline_keyboard: [[{ text: '←', callback_data: 'adm_promo' }]] }); }
  if (data === 'adm_promo_delete') { const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`); if (!r.rows.length) return editMessage(chatId, messageId, 'Активных нет', backKb); const btns = r.rows.map(p => [{ text: '❌ ' + p.code, callback_data: 'adm_promodel_' + p.code }]); btns.push([{ text: '←', callback_data: 'adm_promo' }]); return editMessage(chatId, messageId, 'Удалить:', { inline_keyboard: btns }); }
  if (data.startsWith('adm_promodel_')) { const code = data.replace('adm_promodel_', ''); await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]); return editMessage(chatId, messageId, `✅ Деактивирован`, { inline_keyboard: [[{ text: '←', callback_data: 'adm_promo' }]] }); }

  if (data === 'adm_gifts') { const r = await pool.query(`SELECT from_tg_id, gift_code, tries, stars, claimed FROM gifts ORDER BY created_at DESC LIMIT 20`); let m = `🎁 <b>Подарки</b>\n\n`; if (!r.rows.length) m += `Пока никто не дарил.`; else for (const g of r.rows) m += `${g.claimed ? '✅' : '⏳'} <code>${g.gift_code}</code> · ${g.tries} · ${g.stars}⭐️\n`; return editMessage(chatId, messageId, m, backKb); }

  if (data === 'adm_broadcast') { awaitingBroadcast.add(userId); awaitingBroadcastPhoto.delete(userId); return editMessage(chatId, messageId, `📢 Пришли текст. Фото — по желанию.`, { inline_keyboard: [[{ text: '📷 С фото', callback_data: 'adm_broadcast_photo' }], [{ text: '🕐 Отложенная', callback_data: 'adm_broadcast_scheduled' }], [{ text: '❌', callback_data: 'adm_back' }]] }); }
  if (data === 'adm_broadcast_photo') { awaitingBroadcastPhoto.set(userId, { text: null }); return editMessage(chatId, messageId, `📷 Сначала текст, потом фото:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] }); }
  if (data === 'adm_broadcast_scheduled') { awaitingScheduled.set(userId, { step: 'text' }); return editMessage(chatId, messageId, `🕐 <b>Отложенная рассылка</b>\n\nШаг 1/2: пришли текст:`, { inline_keyboard: [[{ text: '❌', callback_data: 'adm_back' }]] }); }
}

async function showUserCard(chatId, messageId, tgId, toast = null) {
  try {
    const r = await pool.query(`SELECT tg_id, first_name, username, balance, own_tries, is_admin, is_banned, ban_reason, created_at, last_active, streak_days, (SELECT COUNT(*)::int FROM tryon_history WHERE user_id = users.tg_id) AS total_tryons, (SELECT COALESCE(SUM(cost_usd),0)::numeric FROM generations WHERE tg_id = users.tg_id AND success = TRUE) AS spent_usd, (SELECT COALESCE(SUM(stars),0)::int FROM payments WHERE tg_id = users.tg_id) AS stars_paid, (SELECT COUNT(*)::int FROM favorites WHERE user_id = users.tg_id) AS fav_cnt FROM users WHERE tg_id = $1`, [tgId]);
    if (!r.rows.length) return messageId ? editMessage(chatId, messageId, '❌ Не найден') : sendMessage(chatId, '❌ Не найден');
    const u = r.rows[0];
    let text = toast ? `✅ <b>${toast}</b>\n\n` : '';
    text += `👤 <b>${u.first_name || '—'}</b>`;
    if (u.username) text += ` @${u.username}`;
    text += `\n🆔 <code>${u.tg_id}</code>`;
    if (u.is_admin) text += ` 👑`;
    if (u.is_banned) text += `\n🚫 Забанен: ${u.ban_reason || '—'}`;
    text += `\n\n✨ Обычных: <b>${u.balance}</b>\n📦 Своих: <b>${u.own_tries}</b>\n🎨 Примерок: <b>${u.total_tryons}</b>\n`;
    text += `❤️ Избранное: <b>${u.fav_cnt}</b>\n🔥 Стрик: <b>${u.streak_days || 0}</b> дн.\n`;
    text += `💰 Потратил: <b>$${Number(u.spent_usd).toFixed(2)}</b>\n`;
    text += `💎 Оплатил: <b>${u.stars_paid}</b>⭐️`;
    const kb = userActionsKeyboard(tgId, u.is_banned, u.is_admin);
    return messageId ? editMessage(chatId, messageId, text, kb) : sendMessage(chatId, text, kb);
  } catch (e) { return messageId ? editMessage(chatId, messageId, '❌ ' + e.message) : sendMessage(chatId, '❌ ' + e.message); }
}

async function handleGlobalValue(msg) {
  if (!awaitingGlobalValue.has(msg.from.id)) return false;
  const key = awaitingGlobalValue.get(msg.from.id);
  awaitingGlobalValue.delete(msg.from.id);
  const val = msg.text.trim();
  if (key === 'one_time_message') {
    const clean = val === '-' ? '' : val.slice(0, 500);
    await setSetting('one_time_message', clean);
    const streakEnabled = await isStreakEnabled();
    await sendMessage(msg.chat.id, clean ? `✅ Сообщение сохранено:\n\n<i>${clean}</i>` : `✅ Очищено`, globalsKeyboard(streakEnabled));
    return true;
  }
  if (!/^-?\d+$/.test(val)) { await sendMessage(msg.chat.id, '❌ Введи число'); return true; }
  await setSetting(key, val);
  const labels = { start_balance: 'Стартовый баланс', daily_bonus: 'Ежедневный бонус', streak_reward_own: 'Награда за стрик', ref_bonus: 'Бонус за друга' };
  const streakEnabled = await isStreakEnabled();
  await sendMessage(msg.chat.id, `✅ ${labels[key] || key} = <b>${val}</b>`, globalsKeyboard(streakEnabled));
  return true;
}
async function handleMassAction(msg) {
  if (!awaitingMassAction.has(msg.from.id)) return false;
  const action = awaitingMassAction.get(msg.from.id);
  awaitingMassAction.delete(msg.from.id);
  const text = msg.text.trim();
  const catBack = { inline_keyboard: [[{ text: '← К каталогу', callback_data: 'adm_catalog' }]] };
  try {
    if (action === 'delete_all') { if (text.toUpperCase() !== 'УДАЛИТЬ ВСЕ') { await sendMessage(msg.chat.id, '❌ Отменено', catBack); return true; } const r = await pool.query('DELETE FROM products'); await sendMessage(msg.chat.id, `💥 Удалено: <b>${r.rowCount}</b>`, catBack); return true; }
    if (action === 'change_cat') { const [from, to] = text.toLowerCase().split(/\s+/); const allowed = ['top','bottom','outerwear','suit','dress','autumn','accessory']; if (!allowed.includes(from) || !allowed.includes(to)) { await sendMessage(msg.chat.id, `❌ Пример: <code>top bottom</code>`, catBack); return true; } const r = await pool.query('UPDATE products SET category = $1, updated_at = NOW() WHERE category = $2', [to, from]); await sendMessage(msg.chat.id, `✅ Перенесено: <b>${r.rowCount}</b>\n${from} → ${to}`, catBack); return true; }
    if (action === 'delete_cat') { const cat = text.toLowerCase().trim(); const r = await pool.query('DELETE FROM products WHERE category = $1', [cat]); await sendMessage(msg.chat.id, `🗑 Удалено из «${cat}»: <b>${r.rowCount}</b>`, catBack); return true; }
    if (action === 'hide_cat') { const cat = text.toLowerCase().trim(); const r = await pool.query('UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE category = $1', [cat]); await sendMessage(msg.chat.id, `👁 Скрыто из «${cat}»: <b>${r.rowCount}</b>`, catBack); return true; }
  } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, catBack); }
  return true;
}
async function handleScheduledText(msg) {
  if (!awaitingScheduled.has(msg.from.id)) return false;
  const st = awaitingScheduled.get(msg.from.id);
  if (st.step === 'text') { st.text = msg.text.trim().slice(0, 2000); st.step = 'time'; awaitingScheduled.set(msg.from.id, st); await sendMessage(msg.chat.id, `🕐 Шаг 2/2: когда отправить?\n\nФормат: <code>ДД.ММ ЧЧ:ММ</code>\nПример: <code>25.12 18:30</code>`); return true; }
  if (st.step === 'time') {
    const m = msg.text.match(/(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})/);
    if (!m) { await sendMessage(msg.chat.id, `❌ Формат: <code>25.12 18:30</code>`); return true; }
    const [, d, mo, h, mi] = m;
    const year = new Date().getFullYear();
    const runAt = new Date(year, Number(mo)-1, Number(d), Number(h), Number(mi));
    if (runAt < new Date()) { await sendMessage(msg.chat.id, `❌ Дата в прошлом`); return true; }
    awaitingScheduled.delete(msg.from.id);
    await pool.query(`INSERT INTO scheduled_broadcasts (text, run_at) VALUES ($1, $2)`, [st.text, runAt]);
    await sendMessage(msg.chat.id, `✅ Запланировано на ${runAt.toLocaleString('ru-RU')}`, mainAdminKeyboard());
    return true;
  }
  return false;
}
async function handleMaintText(msg) { if (!awaitingMaintText.has(msg.from.id)) return false; awaitingMaintText.delete(msg.from.id); const text = msg.text.trim().slice(0, 500); if (!text) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; } await setSetting('maintenance_text', text); const on = await isMaintenanceMode(); await sendMessage(msg.chat.id, `✅ Текст: <i>${text}</i>`, maintenanceKeyboard(on)); return true; }
async function handleBanReason(msg) { if (!awaitingBanReason.has(msg.from.id)) return false; const tgId = awaitingBanReason.get(msg.from.id); awaitingBanReason.delete(msg.from.id); const reason = msg.text.trim().slice(0, 200); await pool.query('UPDATE users SET is_banned = TRUE, ban_reason = $1 WHERE tg_id = $2', [reason, tgId]); await showUserCard(msg.chat.id, null, tgId, '🚫 Заблокирован'); return true; }
async function handleNote(msg) { if (!awaitingNote.has(msg.from.id)) return false; const tgId = awaitingNote.get(msg.from.id); awaitingNote.delete(msg.from.id); const note = msg.text.trim().slice(0, 500); if (!note) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; } await pool.query('INSERT INTO user_notes (tg_id, note) VALUES ($1, $2)', [tgId, note]); await sendMessage(msg.chat.id, `✅ Сохранено`, { inline_keyboard: [[{ text: '←', callback_data: `usr_show_${tgId}` }]] }); return true; }
async function handleBroadcastText(msg) {
  if (awaitingBroadcast.has(msg.from.id)) { awaitingBroadcast.delete(msg.from.id); const r = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE'); let s = 0, f = 0; await sendMessage(msg.chat.id, `📤 Рассылка на ${r.rows.length}…`); for (const u of r.rows) { try { await sendMessage(u.tg_id, msg.text); s++; if (s % 25 === 0) await new Promise(rs => setTimeout(rs, 1000)); } catch { f++; } } await sendMessage(msg.chat.id, `✅ Доставлено: <b>${s}</b>, ошибок: <b>${f}</b>`, mainAdminKeyboard()); return true; }
  if (awaitingBroadcastPhoto.has(msg.from.id) && !awaitingBroadcastPhoto.get(msg.from.id).text) { awaitingBroadcastPhoto.set(msg.from.id, { text: msg.text }); await sendMessage(msg.chat.id, '📷 Теперь фото:'); return true; }
  if (awaitingBroadcastPhoto.has(msg.from.id) && awaitingBroadcastPhoto.get(msg.from.id).text) { if (msg.text.trim().toLowerCase() === 'нет' || msg.text.trim() === '-') { const st = awaitingBroadcastPhoto.get(msg.from.id); awaitingBroadcastPhoto.delete(msg.from.id); const r = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE'); let s = 0, f = 0; for (const u of r.rows) { try { await sendMessage(u.tg_id, st.text); s++; if (s % 25 === 0) await new Promise(rs => setTimeout(rs, 1000)); } catch { f++; } } await sendMessage(msg.chat.id, `✅ Доставлено: ${s} · Ошибок: ${f}`, mainAdminKeyboard()); return true; } }
  return false;
}
async function handleBroadcastPhoto(msg) { if (!awaitingBroadcastPhoto.has(msg.from.id)) return false; const st = awaitingBroadcastPhoto.get(msg.from.id); if (!st.text) { await sendMessage(msg.chat.id, '❌ Сначала текст'); return true; } const photos = msg.photo; if (!photos?.length) return false; const fileId = photos[photos.length - 1].file_id; awaitingBroadcastPhoto.delete(msg.from.id); const r = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE'); let s = 0, f = 0; await sendMessage(msg.chat.id, `📤 Рассылка с фото на ${r.rows.length}…`); for (const u of r.rows) { try { await sendPhoto(u.tg_id, fileId, st.text); s++; if (s % 25 === 0) await new Promise(rs => setTimeout(rs, 1500)); } catch { f++; } } await sendMessage(msg.chat.id, `✅ Доставлено: <b>${s}</b>, ошибок: <b>${f}</b>`, mainAdminKeyboard()); return true; }
async function handleUserSearch(msg) { if (!awaitingUserSearch.has(msg.from.id)) return false; awaitingUserSearch.delete(msg.from.id); const q = msg.text.trim().replace(/^@/, ''); let r; if (/^\d+$/.test(q)) r = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [Number(q)]); else r = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [q]); if (!r.rows.length) { await sendMessage(msg.chat.id, `❌ Не найден`, mainAdminKeyboard()); return true; } await showUserCard(msg.chat.id, null, r.rows[0].tg_id); return true; }
async function handleAddCustomText(msg) { if (!awaitingAddCustom.has(msg.from.id)) return false; const target = awaitingAddCustom.get(msg.from.id); awaitingAddCustom.delete(msg.from.id); const n = Number(msg.text.trim()); if (!Number.isFinite(n) || n === 0) { await sendMessage(msg.chat.id, '❌ Число'); return true; } await pool.query('UPDATE users SET balance = GREATEST(0, balance + $1) WHERE tg_id = $2', [n, target]); await showUserCard(msg.chat.id, null, target, `${n > 0 ? '+' : ''}${n}`); return true; }
async function handleAddOwnCustomText(msg) { if (!awaitingAddOwnCustom.has(msg.from.id)) return false; const target = awaitingAddOwnCustom.get(msg.from.id); awaitingAddOwnCustom.delete(msg.from.id); const n = Number(msg.text.trim()); if (!Number.isFinite(n) || n === 0) { await sendMessage(msg.chat.id, '❌ Число'); return true; } await pool.query('UPDATE users SET own_tries = GREATEST(0, own_tries + $1) WHERE tg_id = $2', [n, target]); await showUserCard(msg.chat.id, null, target, `${n > 0 ? '+' : ''}${n} своих`); return true; }
async function handleDM(msg) { if (!awaitingDM.has(msg.from.id)) return false; const target = awaitingDM.get(msg.from.id); awaitingDM.delete(msg.from.id); try { await sendMessage(target, `💬 <b>Сообщение:</b>\n\n${msg.text}`); await sendMessage(msg.chat.id, '✅', mainAdminKeyboard()); } catch (e) { await sendMessage(msg.chat.id, '❌ ' + e.message, mainAdminKeyboard()); } return true; }
async function handleAddLinkText(msg) {
  if (!awaitingLinkForAdd.has(msg.from.id)) return false;
  awaitingLinkForAdd.delete(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Артикулов не найдено', mainAdminKeyboard()); return true; }
  await sendMessage(msg.chat.id, `⏳ Нашёл ${ids.length}, добавляю…`);
  const results = [];
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const r_ = await Promise.all(chunk.map(async (wbId) => {
      try {
        let img = primaryImageUrl(wbId);
        const info = await fetchWBProductInfo(wbId);
        const name = info?.name || `Товар ${wbId}`;
        const price = info?.price || null;
        const category = guessCategory(name);
        const sourceUrl = `https://www.wildberries.ru/catalog/${wbId}/detail.aspx`;
        await pool.query(`INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, source_url, updated_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,$8,NOW(),NOW()) ON CONFLICT (wb_id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category, image_url=EXCLUDED.image_url, fallback_url=EXCLUDED.fallback_url, is_active=TRUE, description=EXCLUDED.description, source_url=EXCLUDED.source_url, updated_at=NOW()`, [wbId, name, price, category, img, fallbackImageUrl(wbId), info?.description || name, sourceUrl]);
        return { wbId, status: 'ok', name, price, category };
      } catch (e) { return { wbId, status: 'error' }; }
    }));
    results.push(...r_);
  }
  const ok = results.filter(r => r.status === 'ok');
  let m = `<b>📦 Готово</b>\n\n✅ Добавлено: <b>${ok.length}</b>\n\n`;
  for (const r of ok.slice(0, 10)) m += `• <b>${r.name.slice(0, 45)}</b> · ${r.price || '—'} · ${r.category}\n`;
  await sendMessage(msg.chat.id, m, mainAdminKeyboard());
  return true;
}
async function handleRemoveLinksText(msg) {
  if (!awaitingLinkForRemove.has(msg.from.id)) return false;
  awaitingLinkForRemove.delete(msg.from.id);
  const ids = extractWbIds(msg.text);
  if (!ids.length) { await sendMessage(msg.chat.id, '❌ Артикулов не найдено', mainAdminKeyboard()); return true; }
  let d = 0, nf = 0; const dl = [];
  for (const wbId of ids) { try { const r = await pool.query('DELETE FROM products WHERE wb_id = $1 RETURNING name', [wbId]); if (r.rows.length) { d++; dl.push(`${wbId} — ${r.rows[0].name.slice(0, 30)}`); } else nf++; } catch {} }
  let m = `🗑 <b>Удаление завершено</b>\n\n✅ Удалено: <b>${d}</b>\n`;
  if (nf) m += `ℹ️ Не найдено: <b>${nf}</b>\n`;
  m += `\n`;
  for (const t of dl.slice(0, 15)) m += `• <code>${t}</code>\n`;
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
  if (state.step === 'code') { const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20); if (!code) { await sendMessage(msg.chat.id, '❌ Пусто'); return true; } const dup = await pool.query('SELECT 1 FROM promo_codes WHERE code = $1', [code]); if (dup.rows.length) { await sendMessage(msg.chat.id, '❌ Занят'); return true; } state.code = code; state.step = 'tries'; awaitingPromoCustom.set(msg.from.id, state); await sendMessage(msg.chat.id, 'Сколько попыток? (или <code>unlimited</code>):'); return true; }
  if (state.step === 'tries') { let tries = 0, unlimited = false; if (text.toLowerCase() === 'unlimited') unlimited = true; else { tries = Number(text); if (!Number.isFinite(tries) || tries <= 0) { await sendMessage(msg.chat.id, '❌ > 0'); return true; } } state.tries = tries; state.unlimited = unlimited; state.step = 'max_uses'; awaitingPromoCustom.set(msg.from.id, state); await sendMessage(msg.chat.id, 'Лимит активаций (0 = ∞):'); return true; }
  if (state.step === 'max_uses') { const maxUses = Number(text); if (!Number.isFinite(maxUses) || maxUses < 0) { await sendMessage(msg.chat.id, '❌ ≥ 0'); return true; } await pool.query(`INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active, label) VALUES ($1,$2,$3,$4,TRUE,$5)`, [state.code, state.tries, state.unlimited, maxUses === 0 ? 999999 : maxUses, state.unlimited ? 'Безлимит' : `+${state.tries}`]); awaitingPromoCustom.delete(msg.from.id); await sendMessage(msg.chat.id, `✅ <code>${state.code}</code>`, { inline_keyboard: [[{ text: '🎟', callback_data: 'adm_promo' }]] }); return true; }
}

app.post('/api/webhook/telegram', async (req, res) => {
  const update = req.body;
  if (update.pre_checkout_query) { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true }) }); return res.sendStatus(200); }
  if (update.callback_query) { try { await handleCallback(update.callback_query); } catch (e) { logError('callback', e.message); } return res.sendStatus(200); }
  if (update.message?.photo) { try { await handleBroadcastPhoto(update.message); } catch (e) { logError('broadcast-photo', e.message); } return res.sendStatus(200); }
  if (update.message?.text) {
    const text = update.message.text.trim();
    if (await handleScheduledText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleMassAction(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleGlobalValue(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleMaintText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleBanReason(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleNote(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleUserSearch(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddOwnCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleDM(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddLinkText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleRemoveLinksText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleProductAction(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handlePromoCustom(update.message).catch(() => false)) return res.sendStatus(200);
    if (text === '/admin' || text === '/start' || text === '/menu') { await handleStart(update.message); return res.sendStatus(200); }
    if (text === '/privacy') { await sendMessage(update.message.chat.id, `📄 Политика конфиденциальности\n\nСобираем: Telegram ID, имя, @username, фото (не сохраняются).\nПередаём: только fal.ai.\nУдаление: напиши администратору.`); return res.sendStatus(200); }
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
        else if (productType === 'gift') {}
        else if (SUBSCRIPTIONS[productType]) {
          const sub = SUBSCRIPTIONS[productType];
          await pool.query(`UPDATE users SET balance = balance + $1, own_tries = own_tries + $2, sub_active = TRUE WHERE tg_id = $3`, [sub.tries, sub.own || 0, tgId]);
          await giveAchievement(tgId, 'first_pay');
        }
      }
    } catch (e) { logError('payment', e.message); }
  }
  res.sendStatus(200);
});
// ============================================================
// ADMIN endpoints
// ============================================================

// 1) Пополнение каталога — вызывается из админки
app.post('/api/admin/refresh-catalog', async (req, res) => {
  const { initData, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdmin(tgUser.id))) return res.status(403).json({ error: 'Forbidden' });

  try {
    const cat = category || 'all';
    // refreshCatalog работает и с 'all', и с отдельной категорией
    const result = await refreshCatalog(cat);
    res.json(result);
  } catch (e) {
    logError('admin-refresh', e.message);
    res.status(500).json({ success: false, reason: e.message, error: e.message });
  }
});

// 2) Список всех товаров для подчистки
app.post('/api/admin/products/list', async (req, res) => {
  const { initData, category } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdmin(tgUser.id))) return res.status(403).json({ error: 'Forbidden' });

  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (category && category !== 'all') {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT id, wb_id, name, price, category, image_url, fallback_url, is_active, is_pinned
       FROM products ${where}
       ORDER BY is_pinned DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
       LIMIT 500`,
      params
    );
    res.json({ success: true, items: r.rows });
  } catch (e) {
    logError('admin-products-list', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3) Действия над товаром: pin/unpin/hide/unhide/delete
app.post('/api/admin/products/action', async (req, res) => {
  const { initData, action, productId, wbId } = req.body;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await isAdmin(tgUser.id))) return res.status(403).json({ error: 'Forbidden' });

  if (!productId) return res.status(400).json({ error: 'productId обязателен' });

  try {
    let sql = null;
    let msg = '';
    switch (action) {
      case 'pin':     sql = `UPDATE products SET is_pinned = TRUE  WHERE id = $1`; msg = '📌 Закреплено'; break;
      case 'unpin':   sql = `UPDATE products SET is_pinned = FALSE WHERE id = $1`; msg = '📌 Откреплено'; break;
      case 'hide':    sql = `UPDATE products SET is_active = FALSE WHERE id = $1`; msg = '🙈 Скрыто'; break;
      case 'unhide':  sql = `UPDATE products SET is_active = TRUE, is_pinned = FALSE WHERE id = $1`; msg = '👁 Возвращено'; break;
      case 'delete':  sql = `DELETE FROM products WHERE id = $1`; msg = '🗑 Удалено'; break;
      default: return res.status(400).json({ error: 'Неизвестное действие' });
    }
    await pool.query(sql, [productId]);
    res.json({ success: true, message: msg });
  } catch (e) {
    logError('admin-product-action', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ============================================================ // ПОИСК по всей базе товаров // ============================================================ app.get('// ============================================================ // ПОИСК: сортировка по числу совпадений + морфология (pg_trgm) // ============================================================ app.get('app.get('/api/search', async (req, res) => {   const raw = String(req.query.q || '').trim().toLowerCase();   const limit = Math.min(100, Number(req.query.limit) || 50);   if (raw.length < 2) return res.json({ success: true, items: [] });    try {     const words = raw.split(/\s+/).filter(w => w.length >= 2);     if (!words.length) return res.json({ success: true, items: [] });      // Корень слова: режем русские окончания, оставляем минимум 4 буквы     const stem = (w) => {       if (w.length <= 4) return w;       const stripped = w.replace(/(иями|ями|ами|ией|иях|иям|ию|ия|ие|ые|ых|ой|ый|ая|ое|ов|ам|ах|ям|ях|ом|ем|у|ю|ы|и|а|я|е|о|й|ь)$/u, '');       return stripped.length >= 4 ? stripped : w.slice(0, 4);     };      const params = [];     const scoreParts = [];     const whereParts = [];      for (const w of words) {       const r = stem(w);       params.push(`%${w}%`, `%${r}%`);       const wIdx = params.length - 1;       const rIdx = params.length;       whereParts.push(`(LOWER(name) LIKE $${wIdx} OR LOWER(name) LIKE $${rIdx})`);       scoreParts.push(`(CASE WHEN LOWER(name) LIKE $${wIdx} THEN 2 ELSE 0 END)`);       scoreParts.push(`(CASE WHEN LOWER(name) LIKE $${rIdx} THEN 1 ELSE 0 END)`);     }      params.push(String(Date.now()));     const seedIdx = params.length;     params.push(limit);     const limitIdx = params.length;      const sql = `       SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url,         (${scoreParts.join(' + ')}) AS match_score       FROM products       WHERE is_active = TRUE AND (${whereParts.join(' OR ')})       ORDER BY match_score DESC, MD5(id::text || $${seedIdx}) ASC       LIMIT $${limitIdx}     `;     const r = await pool.query(sql, params);     const items = r.rows.map(({ match_score, ...rest }) => rest);     res.json({ success: true, items, count: items.length });   } catch (e) {     logError('search', e.message);     res.status(500).json({ error: 'Server error' });   } });', async (req, res) => {   const raw = String(req.query.q || '').trim().toLowerCase();   const limit = Math.min(100, Number(req.query.limit) || 50);   if (raw.length < 2) return res.json({ success: true, items: [] });    try {     // Разбиваем запрос на слова, длиной >= 2     const words = raw.split(/\s+/).filter(w => w.length >= 2);     if (!words.length) return res.json({ success: true, items: [] });      // Для каждого слова строим "корень" — обрезаем окончания     // Например: "костюмы" → "костюм", "платья" → "плать"     const roots = words.map(w => {       if (w.length <= 4) return w;                    // короткие не трогаем       // Убираем частые русские окончания       return w         .replace(/(иями|ями|ами|ией|иях|иям|ию|ия|ие|ые|ых|ой|ый|ая|ое|ов|ам|ах|ям|ях|ом|ем|у|ю|ы|и|а|я|е|о|й|ь)$/u, '')         || w.slice(0, Math.max(3, w.length - 2));     // если после среза пусто — режем 2 символа     });      // Каждое слово ищем и как есть, и как корень     // Собираем SQL: для каждого слова по 2 условия LIKE     const params = [];     const scoreParts = []; // считает количество совпавших слов     const whereParts = []; // основное условие OR      for (let i = 0; i < words.length; i++) {       const w = words[i];       const r = roots[i];        params.push(`%${w}%`, `%${r}%`);       const wIdx = params.length - 1;      // индекс %w%       const rIdx = params.length;          // индекс %r%        // WHERE: слово найдено либо целиком, либо по корню       whereParts.push(`(LOWER(name) LIKE $${wIdx} OR LOWER(name) LIKE $${rIdx})`);        // SCORE: +1 если слово совпало (в любом виде), +2 если слово в начале названия       scoreParts.push(         `(CASE WHEN LOWER(name) LIKE $${wIdx} OR LOWER(name) LIKE $${rIdx} THEN 1 ELSE 0 END)`       );       scoreParts.push(         `(CASE WHEN LOWER(name) LIKE $${params.length + 1} THEN 2 ELSE 0 END)`       );       params.push(`${w}%`);                // префикс без % в начале     }      // seed для рандома + limit     params.push(String(Date.now()));     const seedIdx = params.length;     params.push(limit);     const limitIdx = params.length;      const sql = `       SELECT         id, wb_id, name, price, category, image_url, fallback_url, description, source_url,         (${scoreParts.join(' + ')}) AS match_score       FROM products       WHERE is_active = TRUE         AND (${whereParts.join(' OR ')})       ORDER BY         match_score DESC,         MD5(id::text || $${seedIdx}) ASC       LIMIT $${limitIdx}     `;      const r = await pool.query(sql, params);      // Убираем match_score из ответа — фронту он не нужен     const items = r.rows.map(({ match_score, ...rest }) => rest);      res.json({ success: true, items, count: items.length });   } catch (e) {     logError('search', e.message);     // fallback: если pg_trgm не установлен — простой LIKE без морфологии     try {       const words = raw.split(/\s+/).filter(w => w.length >= 2);       if (!words.length) return res.json({ success: true, items: [] });       const params = [];       const conds = words.map(w => {         params.push(`%${w}%`);         return `LOWER(name) LIKE $${params.length}`;       });       params.push(limit);       const sql = `         SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url         FROM products         WHERE is_active = TRUE AND (${conds.join(' OR ')})         ORDER BY MD5(id::text || '${Date.now()}') ASC         LIMIT $${params.length}       `;       const r = await pool.query(sql, params);       res.json({ success: true, items: r.rows, fallback: true });     } catch (e2) {       res.status(500).json({ error: 'Server error' });     }   } });', async (req, res) => {   const q = String(req.query.q || '').trim().toLowerCase();   const limit = Math.min(100, Number(req.query.limit) || 50);   if (q.length < 2) return res.json({ success: true, items: [] });    try {     // Разбиваем запрос на слова и ищем ЛЮБОЕ совпадение (OR)     const words = q.split(/\s+/).filter(w => w.length >= 2);     if (!words.length) return res.json({ success: true, items: [] });      const params = [];     const likeClauses = words.map(w => {       params.push(`%${w}%`);       return `LOWER(name) LIKE $${params.length}`;     });      // Плюс приоритет: если название начинается с первого слова — выше     params.push(`${words[0]}%`);     const prefixIdx = params.length;      params.push(String(Date.now()));     const seedIdx = params.length;      params.push(limit);     const limitIdx = params.length;      const sql = `       SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url       FROM products       WHERE is_active = TRUE         AND (${likeClauses.join(' OR ')})       ORDER BY         CASE WHEN LOWER(name) LIKE $${prefixIdx} THEN 0 ELSE 1 END,         MD5(id::text || $${seedIdx}) ASC       LIMIT $${limitIdx}     `;      const r = await pool.query(sql, params);     res.json({ success: true, items: r.rows });   } catch (e) {     logError('search', e.message);     res.status(500).json({ error: 'Server error' });   } }); res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

cron.schedule('0 */2 * * *', () => { refreshCatalog(); });
cron.schedule('0 */5 * * *', () => { checkBrokenProducts(); });
cron.schedule('0 4 * * *', () => { autoCleanupIrrelevant(); });
cron.schedule('* * * * *', async () => {
  try {
    const r = await pool.query(`SELECT id, text, photo_file_id FROM scheduled_broadcasts WHERE sent = FALSE AND run_at <= NOW() LIMIT 5`);
    for (const row of r.rows) {
      const users = await pool.query('SELECT tg_id FROM users WHERE is_banned = FALSE');
      let s = 0, f = 0;
      for (const u of users.rows) {
        try {
          if (row.photo_file_id) await sendPhoto(u.tg_id, row.photo_file_id, row.text);
          else await sendMessage(u.tg_id, row.text);
          s++;
          if (s % 25 === 0) await new Promise(rs => setTimeout(rs, 1000));
        } catch { f++; }
      }
      await pool.query('UPDATE scheduled_broadcasts SET sent = TRUE WHERE id = $1', [row.id]);
      const admins = await pool.query('SELECT tg_id FROM users WHERE is_admin = TRUE');
      for (const a of admins.rows) sendMessage(a.tg_id, `✅ Отложенная рассылка #${row.id}\n\nДоставлено: ${s}, ошибок: ${f}`).catch(() => {});
    }
  } catch (e) { console.error('[cron-broadcast]', e.message); }
});

pool.query('SELECT COUNT(*)::int AS c FROM products').then(r => { if (r.rows[0].c === 0) refreshCatalog(); }).catch(() => {});
// ============================================================
// ПОИСК: сортировка по совпадениям + морфология
// ============================================================
app.get('/api/search', async (req, res) => {
  const raw = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(100, Number(req.query.limit) || 50);
  if (raw.length < 2) return res.json({ success: true, items: [] });

  try {
    const words = raw.split(/\s+/).filter(w => w.length >= 2);
    if (!words.length) return res.json({ success: true, items: [] });

    const roots = words.map(w => {
      if (w.length <= 4) return w;
      return w.replace(/(иями|ями|ами|ией|иях|иям|ию|ия|ие|ые|ых|ой|ый|ая|ое|ов|ам|ах|ям|ях|ом|ем|у|ю|ы|и|а|я|е|о|й|ь)$/u, '')
        || w.slice(0, Math.max(3, w.length - 2));
    });

    const params = [];
    const scoreParts = [];
    const whereParts = [];

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const r = roots[i];

      params.push(`%${w}%`, `%${r}%`);
      const wIdx = params.length - 1;
      const rIdx = params.length;

      whereParts.push(`(LOWER(name) LIKE $${wIdx} OR LOWER(name) LIKE $${rIdx})`);

      scoreParts.push(`(CASE WHEN LOWER(name) LIKE $${wIdx} OR LOWER(name) LIKE $${rIdx} THEN 1 ELSE 0 END)`);

      params.push(`${w}%`);
      scoreParts.push(`(CASE WHEN LOWER(name) LIKE $${params.length} THEN 2 ELSE 0 END)`);
    }

    params.push(String(Date.now()));
    const seedIdx = params.length;
    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      SELECT
        id, wb_id, name, price, category, image_url, fallback_url, description, source_url,
        (${scoreParts.join(' + ')}) AS match_score
      FROM products
      WHERE is_active = TRUE
        AND (${whereParts.join(' OR ')})
      ORDER BY
        match_score DESC,
        MD5(id::text || $${seedIdx}) ASC
      LIMIT $${limitIdx}
    `;

    const r = await pool.query(sql, params);
    const items = r.rows.map(({ match_score, ...rest }) => rest);
    res.json({ success: true, items, count: items.length });
  } catch (e) {
    logError('search', e.message);
    try {
      const words = raw.split(/\s+/).filter(w => w.length >= 2);
      if (!words.length) return res.json({ success: true, items: [] });
      const params = [];
      const conds = words.map(w => {
        params.push(`%${w}%`);
        return `LOWER(name) LIKE $${params.length}`;
      });
      params.push(limit);
      const sql = `
        SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url
        FROM products
        WHERE is_active = TRUE AND (${conds.join(' OR ')})
        ORDER BY MD5(id::text || '${Date.now()}') ASC
        LIMIT $${params.length}
      `;
      const r = await pool.query(sql, params);
      res.json({ success: true, items: r.rows, fallback: true });
    } catch (e2) {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// ============================================================
// ПЕРСОНАЛЬНЫЙ КАТАЛОГ — на основе истории просмотров
// ============================================================
app.get('/api/catalog-personal', async (req, res) => {
  const initData = req.headers['x-init-data'] || '';
  const limit = Math.min(50, Number(req.query.limit) || 40);
  const tgUser = verifyTelegramInitData(initData);

  // Гость — отдаём случайные
  if (!tgUser) {
    try {
      const r = await pool.query(
        `SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url
         FROM products WHERE is_active = TRUE
         ORDER BY RANDOM() LIMIT $1`, [limit]
      );
      return res.json({ success: true, items: r.rows, personalized: false });
    } catch { return res.json({ success: true, items: [] }); }
  }

  try {
    // 1) Любимые категории по просмотрам и примеркам за 30 дней
    const prefs = await pool.query(
      `SELECT category, COUNT(*)::int AS c
       FROM product_views
       WHERE user_id = $1 AND viewed_at > NOW() - INTERVAL '30 days' AND category IS NOT NULL
       GROUP BY category ORDER BY c DESC LIMIT 3`,
      [tgUser.id]
    );

    const topCats = prefs.rows.map(x => x.category);

    // 2) Если истории мало — добавляем категории по примеркам
    if (topCats.length < 2) {
      const tried = await pool.query(
        `SELECT p.category, COUNT(*)::int AS c
         FROM tryon_history t JOIN products p ON p.id = t.product_id
         WHERE t.user_id = $1 AND t.created_at > NOW() - INTERVAL '30 days'
         GROUP BY p.category ORDER BY c DESC LIMIT 3`,
        [tgUser.id]
      );
      for (const row of tried.rows) {
        if (row.category && !topCats.includes(row.category)) topCats.push(row.category);
      }
    }

    // 3) Если совсем ничего — рандом
    if (!topCats.length) {
      const r = await pool.query(
        `SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url
         FROM products WHERE is_active = TRUE ORDER BY RANDOM() LIMIT $1`, [limit]
      );
      return res.json({ success: true, items: r.rows, personalized: false });
    }

    // 4) 70% — из любимых категорий, 30% — остальное
    const favLimit = Math.ceil(limit * 0.7);
    const randLimit = limit - favLimit;

    const fav = await pool.query(
      `SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url
       FROM products WHERE is_active = TRUE AND category = ANY($1)
       ORDER BY RANDOM() LIMIT $2`,
      [topCats, favLimit]
    );
    const rand = await pool.query(
      `SELECT id, wb_id, name, price, category, image_url, fallback_url, description, source_url
       FROM products WHERE is_active = TRUE AND category != ALL($1)
       ORDER BY RANDOM() LIMIT $2`,
      [topCats, randLimit]
    );

    const items = [...fav.rows, ...rand.rows].sort(() => Math.random() - 0.5);
    res.json({ success: true, items, personalized: true, topCats });
  } catch (e) {
    logError('catalog-personal', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
