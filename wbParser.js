import 'dotenv/config';
import fetch from 'node-fetch';
import { pool } from './db.js';

// Рабочие endpoint'ы WB
const WB_ENDPOINTS = [
  'https://search.wb.ru/exactmatch/ru/common/v4/search',
  'https://search.wb.ru/exactmatch/ru/common/v5/search',
  'https://u-search.wb.ru/exactmatch/ru/common/v4/search',
];

const TOP_N = 30;

const QUERIES = [
  { q: 'женская одежда',  cat: 'top' },
  { q: 'женские платья',  cat: 'dress' },
  { q: 'женские джинсы',  cat: 'bottom' },
  { q: 'женские брюки',   cat: 'bottom' },
  { q: 'женские костюмы', cat: 'suit' },
  { q: 'женские куртки',  cat: 'outerwear' },
  { q: 'женские пальто',  cat: 'autumn' },
  { q: 'женские свитеры', cat: 'top' },
  { q: 'женские топы',    cat: 'top' },
  { q: 'женские юбки',    cat: 'dress' },
];

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

function categorize(name = '') {
  const n = name.toLowerCase();
  if (/(осенн|демисезон|пальто|тренч|пуховик|дубленка|кожанк|бомбер|ветровка)/.test(n)) return 'autumn';
  if (/(пальто|тренч|пуховик|шуба|плащ|ветровка|бомбер|дубленка|кожанк|куртк|жилет)/.test(n)) return 'outerwear';
  if (/(костюм|комплект)/.test(n)) return 'suit';
  if (/(платье|сарафан|юбка)/.test(n)) return 'dress';
  if (/(блузка|рубашк|топ|майка|футболка|боди|корсет|водолазк|поло|лонгслив|кроп|бандо|худи|свитер|кардиган|джемпер|кофт)/.test(n)) return 'top';
  if (/(брюк|джинс|штан|лосины|леггинсы|шорт|карго)/.test(n)) return 'bottom';
  return 'top';
}

async function fetchWB(query, max = TOP_N) {
  const params = new URLSearchParams({
    appType: '1', curr: 'rub', dest: '-1257786',
    query, resultset: 'catalog', sort: 'popular', spp: '30',
    suppressSpellcheck: 'false',
  });
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Origin': 'https://www.wildberries.ru',
    'Referer': 'https://www.wildberries.ru/',
  };

  let lastErr = 'unknown';
  for (const base of WB_ENDPOINTS) {
    try {
      const res = await fetch(`${base}?${params.toString()}`, { headers, timeout: 10000 });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const data = await res.json();
      const products = data?.data?.products || [];
      if (products.length) return products.slice(0, max);
      lastErr = 'пустой ответ';
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

export async function refreshCatalog() {
  const t0 = Date.now();
  console.log('[wb] старт…');
  let totalAdded = 0, totalUpdated = 0, totalFailed = 0, totalSkipped = 0;
  let successQueries = 0;
  const errors = [];

  for (const { q, cat } of QUERIES) {
    let items = [];
    try {
      items = await fetchWB(q, TOP_N);
      if (items.length) successQueries++;
    } catch (e) {
      console.warn(`[wb] "${q}": ${e.message}`);
      errors.push(`"${q}": ${e.message}`);
      continue;
    }

    for (const p of items) {
      const id = Number(p.id);
      if (!id) continue;
      try {
        const name = p.name || 'Товар';
        const price = formatPrice(p.salePriceU ?? p.priceU);
        const category = categorize(name) || cat;
        const img = imageUrl(id);
        const fb = fallbackUrl(id);

        const existing = await pool.query('SELECT id FROM products WHERE wb_id = $1', [id]);
        if (existing.rows.length) {
          await pool.query(
            `UPDATE products SET name=$1, price=$2, category=$3, image_url=$4, fallback_url=$5, updated_at=NOW() WHERE wb_id=$6`,
            [name, price, category, img, fb, id]);
          totalUpdated++;
        } else {
          await pool.query(
            `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',$7,NOW(),NOW())
             ON CONFLICT (wb_id) DO NOTHING`,
            [id, name, price, category, img, fb, name]);
          totalAdded++;
        }
      } catch { totalFailed++; }
      await new Promise(r => setTimeout(r, 40));
    }
    await new Promise(r => setTimeout(r, 300));
  }

  const took = Date.now() - t0;
  console.log(`[wb] готово ${took}ms. +${totalAdded} ~${totalUpdated} ❌${totalFailed} (запросов ок: ${successQueries}/${QUERIES.length})`);

  // Если НИ ОДИН запрос не сработал — это явная ошибка
  if (successQueries === 0) {
    return {
      added: 0, updated: 0, failed: 0,
      success: false,
      reason: 'WB не отдал ни один результат. Возможно, изменился API или бан по IP.',
      errors,
    };
  }

  return { added: totalAdded, updated: totalUpdated, failed: totalFailed, success: true, errors };
}
