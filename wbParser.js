import 'dotenv/config';
import fetch from 'node-fetch';
import { pool } from './db.js';

const WB_SEARCH = 'https://search.wb.ru/exactmatch/ru/common/v4/search';
const TOP_N = 100;

// Категории для пополнения: категория WB → наша категория
const QUERIES = [
  { q: 'женская одежда',           cat: 'top' },
  { q: 'женские платья',           cat: 'dress' },
  { q: 'женские джинсы',           cat: 'bottom' },
  { q: 'женские брюки',            cat: 'bottom' },
  { q: 'женские костюмы',          cat: 'suit' },
  { q: 'женские куртки',           cat: 'outerwear' },
  { q: 'женские пальто',           cat: 'autumn' },
  { q: 'женские свитеры',          cat: 'top' },
  { q: 'женские топы',             cat: 'top' },
  { q: 'женские юбки',             cat: 'dress' },
];

// ============================================================
// УТИЛИТЫ
// ============================================================
function basketFor(id) {
  const vol = Math.floor(id / 100000);
  if (vol <= 143) return '01'; if (vol <= 287) return '02'; if (vol <= 431) return '03';
  if (vol <= 719) return '04'; if (vol <= 1007) return '05'; if (vol <= 1061) return '06';
  if (vol <= 1115) return '07'; if (vol <= 1169) return '08'; if (vol <= 1313) return '09';
  if (vol <= 1601) return '10'; if (vol <= 1655) return '11'; if (vol <= 1919) return '12';
  if (vol <= 2045) return '13'; if (vol <= 2189) return '14'; if (vol <= 2405) return '15';
  if (vol <= 2621) return '16'; if (vol <= 2837) return '17'; return '18';
}

function imageUrl(id) {
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://spb-basket-cdn-03.geobasket.ru/vol${vol}/part${part}/${id}/images/hq/1.webp`;
}

function fallbackUrl(id) {
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://basket-${basketFor(id)}.wbbasket.ru/vol${vol}/part${part}/${id}/images/big/1.webp`;
}

function formatPrice(p) {
  if (!p) return null;
  return `${Math.round(p / 100).toLocaleString('ru-RU')} ₽`;
}

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

// ============================================================
// ПАРСЕР — тянет товары по одному запросу
// ============================================================
async function fetchWB(query, max = TOP_N) {
  const params = new URLSearchParams({
    appType: '1', curr: 'rub', dest: '-1257786',
    query, resultset: 'catalog', sort: 'popular', spp: '30',
    suppressSpellcheck: 'false',
  });
  const url = `${WB_SEARCH}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'Origin': 'https://www.wildberries.ru',
      'Referer': 'https://www.wildberries.ru/',
    },
  });
  if (!res.ok) throw new Error(`WB search HTTP ${res.status} для "${query}"`);
  const data = await res.json();
  const products = data?.data?.products || [];
  return products.slice(0, max);
}

// ============================================================
// ОСНОВНАЯ ФУНКЦИЯ — вызывается из cron и вручную
// ============================================================
export async function refreshCatalog() {
  const t0 = Date.now();
  console.log('[wb] старт пополнения каталога…');
  let totalAdded = 0, totalUpdated = 0, totalFailed = 0;
  const errors = [];

  try {
    for (const { q, cat } of QUERIES) {
      let items = [];
      try {
        items = await fetchWB(q, 30);
      } catch (e) {
        console.warn(`[wb] не удалось получить "${q}": ${e.message}`);
        errors.push(`${q}: ${e.message}`);
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

          // Проверяем, есть ли товар
          const existing = await pool.query('SELECT id FROM products WHERE wb_id = $1', [id]);

          if (existing.rows.length) {
            // Обновляем
            await pool.query(
              `UPDATE products SET name=$1, price=$2, category=$3, image_url=$4, fallback_url=$5, updated_at=NOW()
               WHERE wb_id=$6`,
              [name, price, category, img, fb, id]
            );
            totalUpdated++;
          } else {
            // Добавляем новый
            await pool.query(
              `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',$7,NOW(),NOW())
               ON CONFLICT (wb_id) DO NOTHING`,
              [id, name, price, category, img, fb, name]
            );
            totalAdded++;
          }
        } catch (e) {
          totalFailed++;
        }
        await new Promise(r => setTimeout(r, 50));
      }

      // Пауза между запросами
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[wb] готово за ${Date.now() - t0}ms. Добавлено: ${totalAdded}, обновлено: ${totalUpdated}, ошибок: ${totalFailed}`);
    return { added: totalAdded, updated: totalUpdated, failed: totalFailed, errors };
  } catch (e) {
    console.error('[wb] критическая ошибка:', e.message);
    return { added: totalAdded, updated: totalUpdated, failed: totalFailed, errors: [...errors, e.message] };
  }
}
