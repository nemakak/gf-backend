import 'dotenv/config';
import fetch from 'node-fetch';
import { pool } from './db.js';

const TOP_N = 30;
const CLOUDFLARE_PROXY = 'https://gf-images.maxgamingbrawlstars.workers.dev';

// Для каждого запроса — своя категория и фильтр
const QUERIES = [
  // Осень — первая и с осенними запросами
  { q: 'женские осенние пальто',    cat: 'autumn',   autumn: true },
  { q: 'женские осенние куртки',    cat: 'autumn',   autumn: true },
  { q: 'женские тренчи',            cat: 'autumn',   autumn: true },
  { q: 'женские демисезонные куртки', cat: 'autumn', autumn: true },
  { q: 'женские платья',            cat: 'dress' },
  { q: 'женские сарафаны',          cat: 'dress' },
  { q: 'женские юбки',              cat: 'dress' },
  { q: 'женские джинсы',            cat: 'bottom' },
  { q: 'женские брюки',             cat: 'bottom' },
  { q: 'женские шорты',             cat: 'bottom' },
  { q: 'женские костюмы',           cat: 'suit' },
  { q: 'женские куртки',            cat: 'outerwear' },
  { q: 'женские пуховики',          cat: 'outerwear' },
  { q: 'женские свитеры',           cat: 'top' },
  { q: 'женские топы',              cat: 'top' },
  { q: 'женские футболки',          cat: 'top' },
  { q: 'женские худи',              cat: 'top' },
];

// Проверка на "мужское"
const MALE_WORDS = /\b(мужск|мужчин|для мужчин|male|boy|men)\b/i;

function basketFor(id) {
  const vol = Math.floor(id / 100000);
  if (vol <= 143) return '01'; if (vol <= 287) return '02'; if (vol <= 431) return '03';
  if (vol <= 719) return '04'; if (vol <= 1007) return '05'; if (vol <= 1061) return '06';
  if (vol <= 1115) return '07'; if (vol <= 1169) return '08'; if (vol <= 1313) return '09';
  if (vol <= 1601) return '10'; if (vol <= 1655) return '11'; if (vol <= 1919) return '12';
  if (vol <= 2045) return '13'; if (vol <= 2189) return '14'; if (vol <= 2405) return '15';
  if (vol <= 2621) return '16'; if (vol <= 2837) return '17'; return '18';
}
function imageUrl(id) { return `https://spb-basket-cdn-03.geobasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/hq/1.webp`; }
function fallbackUrl(id) { return `https://basket-${basketFor(id)}.wbbasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/big/1.webp`; }
function formatPrice(p) { return p ? `${Math.round(p / 100).toLocaleString('ru-RU')} ₽` : null; }

// Обрезаем название до ~150 символов
function shortenName(name) {
  if (!name) return 'Товар';
  const clean = name.trim();
  if (clean.length <= 150) return clean;
  const cut = clean.slice(0, 150);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + '…';
}

function categorize(name = '', hintCat = 'top') {
  const n = name.toLowerCase();
  if (/(осенн|демисезон|пальто|тренч|пуховик|дубленка|кожанк|бомбер|ветровка|дождевик)/.test(n)) return 'autumn';
  if (/(пальто|тренч|пуховик|шуба|плащ|ветровка|бомбер|дубленка|кожанк|куртк|жилет)/.test(n)) return 'outerwear';
  if (/(костюм|комплект)/.test(n)) return 'suit';
  if (/(платье|сарафан|юбка)/.test(n)) return 'dress';
  if (/(блузка|рубашк|топ|майка|футболка|боди|корсет|водолазк|поло|лонгслив|кроп|бандо|худи|свитер|кардиган|джемпер|кофт)/.test(n)) return 'top';
  if (/(брюк|джинс|штан|лосины|леггинсы|шорт|карго)/.test(n)) return 'bottom';
  return hintCat;
}

function headers() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ];
  return {
    'User-Agent': uas[Math.floor(Math.random() * uas.length)],
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Origin': 'https://www.wildberries.ru',
    'Referer': 'https://www.wildberries.ru/',
    'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'cross-site',
  };
}

// Попытка через Cloudflare Worker-прокси
async function tryViaProxy(url) {
  try {
    const proxied = `${CLOUDFLARE_PROXY}/?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxied, { headers: headers(), timeout: 15000 });
    if (!res.ok) return null;
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

// Напрямую
async function tryDirect(url) {
  try {
    const res = await fetch(url, { headers: headers(), timeout: 12000 });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchSearch(query) {
  const params = new URLSearchParams({
    appType: '1', curr: 'rub', dest: '-1257786',
    query, resultset: 'catalog', sort: 'popular', spp: '30',
    suppressSpellcheck: 'false',
  });

  const endpoints = [
    'https://search.wb.ru/exactmatch/ru/common/v5/search',
    'https://search.wb.ru/exactmatch/ru/common/v4/search',
    'https://u-search.wb.ru/exactmatch/ru/common/v4/search',
  ];

  for (const base of endpoints) {
    const url = `${base}?${params}`;
    // Сначала — напрямую
    let data = await tryDirect(url);
    // Если пусто — через прокси
    if (!data || !data?.data?.products?.length) {
      data = await tryViaProxy(url);
    }
    if (data?.data?.products?.length) return data.data.products;
  }
  throw new Error('Все endpoints WB вернули пустоту');
}

export async function refreshCatalog() {
  const t0 = Date.now();
  console.log('[wb] старт…');
  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0, successQueries = 0;
  const errors = [];

  for (const { q, cat, autumn } of QUERIES) {
    let items = [];
    try {
      items = await fetchSearch(q);
      if (items.length) successQueries++;
    } catch (e) {
      errors.push(`"${q}": ${e.message}`);
      continue;
    }

    for (const p of items.slice(0, TOP_N)) {
      const id = Number(p.id);
      if (!id) continue;

      const name = p.name || 'Товар';
      // Фильтр мужских вещей
      if (MALE_WORDS.test(name)) { totalSkipped++; continue; }

      try {
        const price = formatPrice(p.salePriceU ?? p.priceU);
        const category = autumn ? 'autumn' : categorize(name, cat);
        const img = imageUrl(id);
        const fb = fallbackUrl(id);
        const shortName = shortenName(name);

        const existing = await pool.query('SELECT id FROM products WHERE wb_id = $1', [id]);
        if (existing.rows.length) {
          await pool.query(
            `UPDATE products SET name=$1, price=$2, category=$3, image_url=$4, fallback_url=$5, updated_at=NOW() WHERE wb_id=$6`,
            [shortName, price, category, img, fb, id]
          );
          totalUpdated++;
        } else {
          await pool.query(
            `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',$7,NOW(),NOW())
             ON CONFLICT (wb_id) DO NOTHING`,
            [id, shortName, price, category, img, fb, shortName]
          );
          totalAdded++;
        }
      } catch { totalSkipped++; }
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[wb] ${Date.now() - t0}ms. +${totalAdded} ~${totalUpdated} ⊘${totalSkipped} (ok: ${successQueries}/${QUERIES.length})`);

  if (successQueries === 0) {
    return {
      added: 0, updated: 0, failed: 0, success: false,
      reason: 'WB не отдал результаты. Возможно, изменены endpoints или IP заблокирован.',
      errors,
    };
  }

  return { added: totalAdded, updated: totalUpdated, failed: totalSkipped, success: true, errors };
}
