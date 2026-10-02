import 'dotenv/config';
import fetch from 'node-fetch';
import { pool } from './db.js';

const WB_SEARCH = 'https://search.wb.ru/exactmatch/ru/common/v4/search';
const QUERY = 'трендовая одежда женская';
const TOP_N = 100;

function basketFor(id) {
  const vol = Math.floor(id / 100000);
  if (vol <= 143) return 'basket-01';
  if (vol <= 287) return 'basket-02';
  if (vol <= 431) return 'basket-03';
  if (vol <= 719) return 'basket-04';
  if (vol <= 1007) return 'basket-05';
  if (vol <= 1061) return 'basket-06';
  if (vol <= 1115) return 'basket-07';
  if (vol <= 1169) return 'basket-08';
  if (vol <= 1313) return 'basket-09';
  if (vol <= 1601) return 'basket-10';
  if (vol <= 1655) return 'basket-11';
  if (vol <= 1919) return 'basket-12';
  if (vol <= 2045) return 'basket-13';
  if (vol <= 2189) return 'basket-14';
  if (vol <= 2405) return 'basket-15';
  if (vol <= 2621) return 'basket-16';
  if (vol <= 2837) return 'basket-17';
  return 'basket-18';
}

export function imageUrl(id) {
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  const basket = basketFor(id);
  return `https://${basket}.wbbasket.ru/vol${vol}/part${part}/${id}/images/big/1.webp`;
}

function fallbackUrl(id) {
  return `https://images.wbstatic.net/c516x688/new/${String(id).slice(0, 4)}/${id}-1.jpg`;
}

function categorize(name = '') {
  const n = name.toLowerCase();
  if (/(платье|сарафан)/.test(n)) return 'Платья';
  if (/(пальто|куртк|пуховик|шуба|плащ|ветровк|бомбер)/.test(n)) return 'Верхняя одежда';
  if (/(жакет|пиджак|блейзер|кардиган)/.test(n)) return 'Жакеты';
  if (/(свитер|худи|джемпер|водолазк|кофт|лонгслив)/.test(n)) return 'Трикотаж';
  if (/(брюк|джинс|штан|леггинс|палаццо)/.test(n)) return 'Брюки';
  if (/(топ|майк|футболк|боди|корсет|рубашк|блузк)/.test(n)) return 'Топы';
  return 'Другое';
}

function formatPrice(p) {
  if (!p) return null;
  return `${Math.round(p / 100).toLocaleString('ru-RU')} ₽`;
}

async function fetchWB() {
  const params = new URLSearchParams({
    appType: '1', curr: 'rub', dest: '-1257786',
    query: QUERY, resultset: 'catalog', sort: 'popular', spp: '30',
  });
  const res = await fetch(`${WB_SEARCH}?${params}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`WB HTTP ${res.status}`);
  const data = await res.json();
  return (data?.data?.products || []).slice(0, TOP_N);
}

export async function refreshCatalog() {
  try {
    const items = await fetchWB();
    if (!items.length) return console.warn('[wb] empty, keep old');

    let saved = 0;
    for (const p of items) {
      const id = Number(p.id);
      if (!id) continue;
      const name = p.name || 'Товар';
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'auto',NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name=EXCLUDED.name, price=EXCLUDED.price, category=EXCLUDED.category,
           image_url=EXCLUDED.image_url, fallback_url=EXCLUDED.fallback_url,
           is_active=TRUE, updated_at=NOW()`,
        [id, name, formatPrice(p.salePriceU ?? p.priceU),
         categorize(name), imageUrl(id), fallbackUrl(id)]
      );
      saved++;
    }
    console.log(`[wb] refreshed ${saved} items`);
  } catch (e) {
    console.error('[wb] failed:', e.message);
  }
}
