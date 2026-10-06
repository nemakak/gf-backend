import 'dotenv/config';
import fetch from 'node-fetch';
import { pool } from './db.js';

const TOP_N = 30;
const CLOUDFLARE_PROXY = 'https://gf-images.maxgamingbrawlstars.workers.dev';

// ============================================================
// ЗАПРОСЫ ПО КАТЕГОРИЯМ
// ============================================================
const QUERIES_BY_CAT = {
  autumn: [
    'женские осенние пальто',
    'женские тренчи',
    'женские демисезонные куртки',
    'женские осенние плащи',
    'женские пальто женские',
    'женские осенние куртки женские',
    'женские пуховики осенние',
    'женские бомберы',
    'женские жилеты осенние',
    'женские дубленки',
  ],
  top: [
    'женские свитеры',
    'женские топы',
    'женские футболки',
    'женские худи',
    'женские блузки',
    'женские кардиганы',
    'женские рубашки',
    'женские лонгсливы',
    'женские свитшоты',
    'женские боди',
  ],
  bottom: [
    'женские джинсы',
    'женские брюки',
    'женские шорты',
    'женские леггинсы',
    'женские брюки палаццо',
    'женские джинсы baggy',
    'женские юбки',
  ],
  outerwear: [
    'женские куртки',
    'женские пуховики',
    'женские жилеты',
    'женские шубы',
  ],
  suit: [
    'женские костюмы',
    'женские комплекты',
    'женские костюмы двойки',
    'женские спортивные костюмы',
  ],
  dress: [
    'женские платья',
    'женские сарафаны',
    'женские юбки',
    'женские платья вечерние',
    'женские платья миди',
    'женские платья мини',
  ],
};

// ============================================================
// ФИЛЬТРЫ
// ============================================================
const MALE_WORDS = /\b(мужск|мужчин|для мужчин|male|boy|men)\b/i;

// Расширенный BLOCK — исключаем обувь, бельё, косметику, детское и т.д.
const BLOCK = /(ботинк|сапог|туфл|кроссовк|балетк|шлепан|тапочк|сандал|босоножк|лофер|мокасин|кеды|слипоны|халат|ночнушк|пижам|пеньюар|термобелье|термошорт|термоштаны|панталон|гольфы|пояс|ремень|ремн|кошел|рюкзак|клатч|косметик|парфюм|крем|маск|сыворотк|помад|тушь|пудр|игрушк|подушк|полотенц|постель|детск|школьн|беременн|больших размеров|для полных|пляжн|купальник|плавки|бель[её]|бельев|трус|трусик|бюст|бра\b|лифчик|чашк|носк|колготк|чулк|комплект\s*белья|нижнее\s*белье|боди[а]?рт|стринг|танга|слип\b|боксер|семейн|пижамк|боди)/i;

// ============================================================
// ХЕЛПЕРЫ
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
  return `https://spb-basket-cdn-03.geobasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/hq/1.webp`;
}
function fallbackUrl(id) {
  return `https://basket-${basketFor(id)}.wbbasket.ru/vol${Math.floor(id/100000)}/part${Math.floor(id/1000)}/${id}/images/big/1.webp`;
}

function formatPrice(p) {
  return p ? `${Math.round(p / 100).toLocaleString('ru-RU')} ₽` : null;
}

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

// ============================================================
// ЗАПРОС К WB ЧЕРЕЗ НЕСКОЛЬКО ENDPOINT'ОВ
// ============================================================
async function tryFetch(url) {
  try {
    const r = await fetch(url, { headers: headers(), timeout: 12000 });
    if (r.ok) {
      const text = await r.text();
      try { return JSON.parse(text); } catch { return null; }
    }
  } catch {}
  try {
    const proxied = `${CLOUDFLARE_PROXY}/?url=${encodeURIComponent(url)}`;
    const r = await fetch(proxied, { headers: headers(), timeout: 15000 });
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

async function fetchSearch(query) {
  const params = new URLSearchParams({
    appType: '1', curr: 'rub', dest: '-1257786',
    query, resultset: 'catalog', sort: 'popular', spp: '30',
    suppressSpellcheck: 'false',
  });

  const endpoints = [
    'https://search.wb.ru/exactmatch/ru/common/v13/search',
    'https://search.wb.ru/exactmatch/ru/common/v9/search',
    'https://u-search.wb.ru/exactmatch/ru/common/v13/search',
    'https://u-search.wb.ru/exactmatch/ru/common/v9/search',
    'https://search.wb.ru/exactmatch/ru/common/v5/search',
    'https://search.wb.ru/exactmatch/ru/common/v4/search',
  ];

  for (const base of endpoints) {
    const data = await tryFetch(`${base}?${params}`);
    const products = data?.data?.products || data?.products || [];
    if (products.length) return products;
  }
  throw new Error('Все endpoints WB вернули пустоту (403 или отключены)');
}

// ============================================================
// ГЛАВНАЯ ФУНКЦИЯ
// ============================================================
export async function refreshCatalog(categoryFilter = 'all') {
  const t0 = Date.now();
  console.log(`[wb] старт (category=${categoryFilter})…`);

  let catsToParse = Object.keys(QUERIES_BY_CAT);
  if (categoryFilter && categoryFilter !== 'all') {
    catsToParse = [categoryFilter];
  }

  let totalAdded = 0, totalUpdated = 0, totalSkipped = 0, successQueries = 0, totalQueries = 0;
  const errors = [];

  for (const cat of catsToParse) {
    const queries = QUERIES_BY_CAT[cat] || [];
    for (const q of queries) {
      totalQueries++;
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

        // Фильтр 1: мужское
        if (MALE_WORDS.test(name)) { totalSkipped++; continue; }
        // Фильтр 2: бельё, обувь, косметика, детское и т.д.
        if (BLOCK.test(name)) { totalSkipped++; continue; }

        try {
          const price = formatPrice(p.salePriceU ?? p.priceU);
          const finalCat = cat === 'autumn' ? 'autumn' : categorize(name, cat);
          const img = imageUrl(id);
          const fb = fallbackUrl(id);
          const shortName = shortenName(name);
          const srcUrl = `https://www.wildberries.ru/catalog/${id}/detail.aspx`;

          const existing = await pool.query('SELECT id FROM products WHERE wb_id = $1', [id]);
          if (existing.rows.length) {
            await pool.query(
              `UPDATE products SET name=$1, price=$2, category=$3, image_url=$4, fallback_url=$5, source_url=$6, updated_at=NOW() WHERE wb_id=$7`,
              [shortName, price, finalCat, img, fb, srcUrl, id]
            );
            totalUpdated++;
          } else {
            await pool.query(
              `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, source_url, updated_at, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',$7,$8,NOW(),NOW())
               ON CONFLICT (wb_id) DO NOTHING`,
              [id, shortName, price, finalCat, img, fb, shortName, srcUrl]
            );
            totalAdded++;
          }
        } catch { totalSkipped++; }
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log(`[wb] ${Date.now() - t0}ms. +${totalAdded} ~${totalUpdated} ⊘${totalSkipped} (ok: ${successQueries}/${totalQueries})`);

  if (successQueries === 0) {
    return {
      added: 0, updated: 0, failed: 0, success: false,
      reason: `WB не отдал ни один товар. Попробуй через VPN или проверь Cloudflare Worker.`,
      errors,
    };
  }

  return { added: totalAdded, updated: totalUpdated, failed: totalSkipped, success: true, errors };
}
