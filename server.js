import React, { useState, useEffect, useCallback, useRef } from 'react';

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'https://gf-backend-uc51.onrender.com';
const PROXY_URL = 'https://gf-images.maxgamingbrawlstars.workers.dev';

const CATEGORIES = [
  { key: 'all',       label: 'Все',            emoji: '✨' },
  { key: 'top',       label: 'Верх',           emoji: '👕' },
  { key: 'bottom',    label: 'Низ',            emoji: '👖' },
  { key: 'outerwear', label: 'Верхняя одежда', emoji: '🧥' },
  { key: 'suit',      label: 'Костюмы',        emoji: '🥼' },
  { key: 'dress',     label: 'Платья',         emoji: '👗' },
  { key: 'accessory', label: 'Аксессуары',     emoji: '🕶' },
];

const SUBS = [
  { id: 'pro', emoji: '💎', name: 'PRО', subtitle: 'Максимум возможностей', priceOld: 999, priceNew: 599, accent: '#D4B595',
    features: [
      { icon: '👗', text: '50 обычных примерок' },
      { icon: '📦', text: '20 примерок своих товаров' },
      { icon: '🎨', text: '5 раз — примерка 2–4 вещей одновременно' },
      { icon: '💬', text: '3 консультации стилиста' },
    ]},
  { id: 'medium', emoji: '💥', name: 'MEDIUM', subtitle: 'Оптимальный выбор', priceOld: 499, priceNew: 299, accent: '#B89876',
    features: [
      { icon: '👗', text: '30 обычных примерок' },
      { icon: '📦', text: '10 примерок своих товаров' },
      { icon: '💬', text: '1 консультация стилиста' },
    ]},
  { id: 'start', emoji: '👌', name: 'START', subtitle: 'Для знакомства', priceOld: 119, priceNew: 65, accent: '#8A6E52',
    features: [
      { icon: '👗', text: '10 обычных примерок' },
      { icon: '💬', text: '1 консультация со стилистом' },
    ]},
];

const FALLBACK = [
  { id: 1, wb_id: 183581368, name: 'Платье Y2K миди', price: '3 990 ₽', category: 'dress',
    image_url: 'https://spb-basket-cdn-03.geobasket.ru/vol1835/part183581/183581368/images/hq/1.webp',
    fallback_url: 'https://basket-13.wbbasket.ru/vol1835/part183581/183581368/images/big/1.webp' },
];

const HINTS = [
  'Обычно занимает 10–20 секунд',
  'ИИ подбирает образ…',
  'Почти готово ✨',
  'Это займёт ещё чуть-чуть',
];

function haptic(t = 'light') {
  try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(t); } catch {}
}

function compressImage(file, maxSide = 768, quality = 0.75) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const k = Math.min(1, maxSide / Math.max(width, height));
        width = Math.round(width * k); height = Math.round(height * k);
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        res(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = rej;
      img.src = e.target.result;
    };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function fixDrive(u) {
  if (!u) return u;
  const m = u.match(/drive\.google\.com\/(?:uc\?.*id=|file\/d\/)([a-zA-Z0-9_-]+)/);
  return m && m[1] ? `https://lh3.googleusercontent.com/d/${m[1]}` : u;
}

function ProductImage({ src, fallback, alt, className = '' }) {
  const [i, setI] = useState(0);
  const list = (() => {
    const L = [];
    const add = (u) => { if (u && !L.includes(u)) L.push(u); };
    const s = fixDrive(src);
    const f = fixDrive(fallback);
    if (s) add(`${PROXY_URL}/?url=${encodeURIComponent(s)}`);
    if (s) add(s);
    if (f && f !== s) {
      add(`${PROXY_URL}/?url=${encodeURIComponent(f)}`);
      add(f);
    }
    const m = (src || '').match(/^(https:\/\/[^/]+)\/vol(\d+)\/part(\d+)\/(\d+)\//);
    if (m) {
      const host = m[1], id = m[4];
      const sizes = ['hq', 'big', 'c516x688', 'c246x328', 'small'];
      for (const size of sizes) {
        add(`${PROXY_URL}/?url=${encodeURIComponent(`${host}/vol${m[2]}/part${m[3]}/${id}/images/${size}/1.webp`)}`);
      }
    }
    add('https://placehold.co/400x500/1A1412/D4B595?text=Style+Room');
    return L;
  })();
  const url = list[i] || list[list.length - 1];
  return (
    <img src={url} alt={alt}
      onError={() => i < list.length - 1 && setI(i + 1)}
      className={`object-cover bg-card ${className}`}
      loading="lazy" />
  );
}

function ProductCard({ item, onPick }) {
  return (
    <button
      onClick={() => { haptic('light'); onPick(item); }}
      className="group relative bg-card border border-border1 rounded-2xl overflow-hidden shadow-card hover:border-accentSoft active:scale-[0.98] transition-all duration-200 text-left w-full">
      <div className="relative aspect-[3/4] overflow-hidden">
        <ProductImage src={item.image_url} fallback={item.fallback_url} alt={item.name}
          className="w-full h-full group-hover:scale-105 transition-transform duration-500" />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />
        <div className="absolute top-2.5 left-2.5 px-2.5 py-1 rounded-full bg-bg/80 backdrop-blur border border-border2 text-[9px] uppercase tracking-wider2 text-accentSoft">
          {CATEGORIES.find(c => c.key === item.category)?.label || 'Одежда'}
        </div>
        <a href={`https://www.wildberries.ru/catalog/${item.wb_id}/detail.aspx`}
          target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
          className="absolute top-2.5 right-2.5 w-8 h-8 rounded-full bg-bg/80 backdrop-blur flex items-center justify-center border border-border2 text-sm hover:bg-accent hover:text-bg transition">
          🛍
        </a>
        <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1">
          <span className="text-xs font-bold text-white">≈ {item.price ? item.price.replace(/^≈\s*/, '') : '—'}</span>
        </div>
      </div>
      <div className="p-3">
        <div className="font-serif text-[13px] leading-tight line-clamp-2 h-[34px] text-title">{item.description || item.name}</div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider2 text-muted">Примерить</span>
          <span className="w-7 h-7 rounded-full border border-accentSoft text-accent flex items-center justify-center text-xs group-hover:bg-accent group-hover:text-bg transition">✨</span>
        </div>
      </div>
    </button>
  );
}

function SubscriptionsScreen({ onBack, onBuy }) {
  const [expanded, setExpanded] = useState('pro');
  return (
    <main className="px-5 pt-6 animate-fade-in pb-24">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="w-8 h-8 rounded-full border border-border2 flex items-center justify-center text-muted active:scale-95">←</button>
        <div>
          <div className="text-[10px] uppercase tracking-wider2 text-muted mb-0.5">Style Room</div>
          <div className="font-serif text-2xl leading-tight">Подписки</div>
        </div>
      </div>
      <div className="space-y-4">
        {SUBS.map(sub => {
          const isOpen = expanded === sub.id;
          return (
            <div key={sub.id} className="bg-card rounded-3xl overflow-hidden transition-all duration-300"
              style={{ border: `1px solid ${isOpen ? sub.accent : '#2a1f1a'}`, boxShadow: isOpen ? `0 0 30px ${sub.accent}20` : 'none' }}>
              <button onClick={() => { haptic('light'); setExpanded(isOpen ? null : sub.id); }}
                className="w-full flex items-center justify-between px-5 py-5 text-left">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl"
                    style={{ background: `${sub.accent}20`, border: `1px solid ${sub.accent}40` }}>
                    {sub.emoji}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider2 mb-0.5" style={{ color: sub.accent }}>{sub.subtitle}</div>
                    <div className="font-serif text-lg text-title leading-tight">{sub.name}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted line-through">{sub.priceOld}⭐️</span>
                      <span className="text-base font-bold" style={{ color: sub.accent }}>{sub.priceNew}⭐️</span>
                    </div>
                  </div>
                </div>
                <span className="text-lg transition-transform duration-300" style={{ color: sub.accent, transform: isOpen ? 'rotate(180deg)' : 'rotate(0)' }}>⌄</span>
              </button>
              <div className="overflow-hidden transition-all duration-300 ease-out" style={{ maxHeight: isOpen ? 400 : 0 }}>
                <div className="border-t border-border1 px-5 py-4 bg-bgSoft/40">
                  <div className="text-[10px] uppercase tracking-wider2 text-accentSoft mb-3">Что входит</div>
                  <ul className="space-y-3 mb-5">
                    {sub.features.map((f, i) => (
                      <li key={i} className="flex items-start gap-3 text-xs text-title leading-relaxed">
                        <span className="text-base shrink-0">{f.icon}</span>
                        <span className="pt-0.5">{f.text}</span>
                      </li>
                    ))}
                  </ul>
                  <button onClick={() => { haptic('medium'); onBuy(sub.id); }}
                    className="w-full py-4 rounded-2xl text-xs font-bold uppercase tracking-wider2 text-bg active:scale-[0.98] transition"
                    style={{ background: sub.accent }}>
                    Оформить за {sub.priceNew}⭐️
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div className="text-center text-[10px] text-muted pt-2 pb-3 leading-relaxed">Оплата через Telegram Stars.<br />Попытки зачисляются автоматически.</div>
      </div>
    </main>
  );
}

function BuyTriesScreen({ onBack, onBuy, user }) {
  const [count, setCount] = useState(5);
  const total = count * 5;
  return (
    <main className="px-5 pt-6 animate-fade-in pb-24">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="w-8 h-8 rounded-full border border-border2 flex items-center justify-center text-muted active:scale-95">←</button>
        <div>
          <div className="text-[10px] uppercase tracking-wider2 text-muted mb-0.5">Докупка</div>
          <div className="font-serif text-2xl leading-tight">Попытки</div>
        </div>
      </div>
      <div className="bg-card border border-border1 rounded-3xl p-6 mb-5 text-center">
        <div className="text-[10px] uppercase tracking-wider2 text-muted mb-2">Сколько примерок?</div>
        <div className="flex items-center justify-center gap-4 mb-4">
          <button onClick={() => { haptic('light'); setCount(c => Math.max(1, c - 1)); }}
            className="w-12 h-12 rounded-full border border-border2 text-2xl text-accent active:scale-90">−</button>
          <div className="text-5xl font-serif text-title min-w-[100px]">{count}</div>
          <button onClick={() => { haptic('light'); setCount(c => Math.min(500, c + 1)); }}
            className="w-12 h-12 rounded-full border border-accentSoft text-2xl text-accent active:scale-90">+</button>
        </div>
        <div className="flex gap-2 justify-center mb-5">
          {[5, 10, 25, 50].map(n => (
            <button key={n} onClick={() => { haptic('light'); setCount(n); }}
              className={`px-3 py-1.5 rounded-full border text-xs ${count === n ? 'bg-accent text-bg border-accent font-bold' : 'border-border2 text-muted2'}`}>
              {n}
            </button>
          ))}
        </div>
        <div className="text-[10px] uppercase tracking-wider2 text-muted">Итого</div>
        <div className="text-3xl font-serif text-title mt-1">{total}⭐️</div>
        <div className="text-[10px] text-muted mt-2">1 примерка = 5⭐️</div>
      </div>
      <div className="bg-card border border-border1 rounded-2xl p-4 mb-5">
        <div className="text-[10px] uppercase tracking-wider2 text-accentSoft mb-2">У вас сейчас</div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-title">Обычных примерок</span>
          <span className="text-lg font-serif text-accent">{user?.balance ?? 0}</span>
        </div>
      </div>
      <button onClick={() => { haptic('medium'); onBuy(count); }}
        className="w-full bg-accent hover:bg-accentH text-bg py-4 rounded-2xl text-sm font-bold uppercase tracking-wider2 active:scale-[0.98] transition">
        Купить {count} за {total}⭐️
      </button>
    </main>
  );
}

function HistoryScreen({ onBack }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const initData = window.Telegram?.WebApp?.initData || '';
    fetch(`${BACKEND}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
      .then(r => r.json())
      .then(d => { if (d.success) setItems(d.items || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const share = (url) => {
    const text = 'Смотри, как я примерила вещь через Style Room ✨';
    if (window.Telegram?.WebApp?.openTelegramLink) {
      window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
    } else {
      window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank');
    }
  };

  return (
    <main className="px-5 pt-6 animate-fade-in pb-24">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="w-8 h-8 rounded-full border border-border2 flex items-center justify-center text-muted active:scale-95">←</button>
        <div>
          <div className="text-[10px] uppercase tracking-wider2 text-muted mb-0.5">Архив</div>
          <div className="font-serif text-2xl leading-tight">Мои примерки</div>
        </div>
      </div>
      {loading && <div className="text-center py-16 text-muted text-sm">Загрузка…</div>}
      {!loading && items.length === 0 && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">👗</div>
          <div className="text-sm text-title mb-2">Здесь пока пусто</div>
          <div className="text-xs text-muted">Сделайте первую примерку</div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {items.map(it => (
          <div key={it.id} className="bg-card border border-border1 rounded-2xl overflow-hidden">
            <div className="aspect-[3/4] bg-cardHover">
              <img src={it.result_url} alt="" className="w-full h-full object-cover" loading="lazy"
                onError={(e) => { e.target.src = 'https://placehold.co/400x500/1A1412/D4B595?text=Style+Room'; }} />
            </div>
            <div className="p-2.5">
              <div className="text-[10px] text-muted line-clamp-2 h-[26px]">{it.product_name || 'Товар'}</div>
              <div className="flex gap-1.5 mt-2">
                <button onClick={() => share(it.result_url)}
                  className="flex-1 bg-bgSoft border border-border2 text-accent text-[10px] uppercase tracking-wider2 py-2 rounded-xl active:scale-95">Share</button>
                {it.product_wb_id && (
                  <a href={`https://www.wildberries.ru/catalog/${it.product_wb_id}/detail.aspx`} target="_blank" rel="noreferrer"
                    className="flex-1 bg-accent text-bg text-[10px] uppercase tracking-wider2 py-2 rounded-xl text-center font-bold">WB</a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}

function ProfileScreen({ user, onOpenSubs, onOpenBuyTries, onOpenHistory, onToast }) {
  const balance = user?.balance || 0;
  const ownTries = user?.own_tries || 0;
  const hasSub = user?.sub_active === true && (user?.balance || 0) > 0;
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);

  const redeemPromo = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    try {
      const r = await fetch(`${BACKEND}/api/redeem-promo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData || '', code: promoCode.trim() }),
      });
      const d = await r.json();
      if (d.success) {
        onToast(d.unlimited ? '🎁 Безлимит на 24 часа!' : `🎁 +${d.tries} попыток!`);
        setPromoOpen(false);
        setPromoCode('');
        setTimeout(() => window.location.reload(), 1500);
      } else {
        onToast(d.error || 'Ошибка');
      }
    } catch { onToast('Ошибка соединения'); }
    finally { setPromoLoading(false); }
  };

  return (
    <main className="px-5 pt-6 animate-fade-in pb-24">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-wider2 text-muted mb-1">Аккаунт</div>
        <h1 className="font-serif text-3xl leading-tight">Профиль</h1>
      </div>

      <div className="bg-card border border-border1 rounded-3xl p-5 mb-4">
        <div className="flex items-center gap-4">
          <div className="relative">
            <img src={user?.photo_url || 'https://placehold.co/120x120/1A1412/D4B595?text=U'} alt=""
              className="w-16 h-16 rounded-full object-cover border-2 border-border2" />
            <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-accent border-2 border-bg" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-medium leading-tight truncate">{user?.first_name || 'Гость'}</div>
            <div className="text-xs text-muted truncate">@{user?.username || 'user'}</div>
            {hasSub ? (
              <div className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-1 rounded-full"
                style={{ background: 'rgba(212,181,149,0.15)', border: '1px solid rgba(212,181,149,0.4)' }}>
                <span className="text-[10px]">💎</span>
                <span className="text-[10px] font-bold text-accent uppercase tracking-wider2">Подписка активна</span>
              </div>
            ) : (
              <button onClick={onOpenSubs}
                className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-1 rounded-full border border-border2 active:scale-95 transition">
                <span className="text-[10px]">💎</span>
                <span className="text-[10px] font-medium text-muted uppercase tracking-wider2">Оформить</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <button onClick={onOpenBuyTries} className="bg-card border border-border1 hover:border-accentSoft active:scale-[0.98] rounded-2xl p-4 text-left transition relative">
          <div className="text-2xl mb-1">👗</div>
          <div className="text-3xl font-serif text-title leading-none">{balance}</div>
          <div className="text-[10px] uppercase tracking-wider2 text-muted mt-2">Обычных примерок</div>
          <div className="absolute top-3 right-3 w-7 h-7 rounded-full bg-accent text-bg flex items-center justify-center text-lg font-bold">+</div>
        </button>
        <div className="bg-card border border-border1 rounded-2xl p-4">
          <div className="text-2xl mb-1">📦</div>
          <div className="text-3xl font-serif text-title leading-none">{ownTries}</div>
          <div className="text-[10px] uppercase tracking-wider2 text-muted mt-2">Своих товаров</div>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <button onClick={onOpenHistory}
          className="w-full bg-card border border-border1 hover:border-accentSoft active:scale-[0.99] rounded-2xl px-4 py-4 flex items-center justify-between transition">
          <div className="flex items-center gap-3">
            <span className="text-xl">🕓</span>
            <div className="text-left">
              <div className="text-sm font-medium text-title">Предыдущие примерки</div>
              <div className="text-[10px] text-muted">История и покупки на WB</div>
            </div>
          </div>
          <span className="text-muted">→</span>
        </button>
        <button onClick={onOpenSubs}
          className="w-full bg-card border border-border1 hover:border-accentSoft active:scale-[0.99] rounded-2xl px-4 py-4 flex items-center justify-between transition">
          <div className="flex items-center gap-3">
            <span className="text-xl">💎</span>
            <div className="text-left">
              <div className="text-sm font-medium text-title">Подписки</div>
              <div className="text-[10px] text-muted">Больше попыток и возможностей</div>
            </div>
          </div>
          <span className="text-muted">→</span>
        </button>
        <button onClick={onOpenBuyTries}
          className="w-full bg-card border border-border1 hover:border-accentSoft active:scale-[0.99] rounded-2xl px-4 py-4 flex items-center justify-between transition">
          <div className="flex items-center gap-3">
            <span className="text-xl">✨</span>
            <div className="text-left">
              <div className="text-sm font-medium text-title">Докупить попытки</div>
              <div className="text-[10px] text-muted">1 примерка = 5⭐️</div>
            </div>
          </div>
          <span className="text-muted">→</span>
        </button>
      </div>

      {!promoOpen ? (
        <button onClick={() => setPromoOpen(true)}
          className="w-full bg-bgSoft border border-accentSoft text-accent rounded-2xl px-4 py-4 flex items-center justify-center gap-2 active:scale-[0.99] transition">
          <span>🎁</span>
          <span className="text-sm font-medium">Ввести промокод</span>
        </button>
      ) : (
        <div className="bg-card border border-accentSoft rounded-2xl p-4 animate-fade-in">
          <div className="text-[10px] uppercase tracking-wider2 text-accent mb-2">🎁 Промокод</div>
          <div className="flex gap-2">
            <input
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              placeholder="ВВЕДИ КОД"
              disabled={promoLoading}
              autoComplete="off"
              className="flex-1 bg-bg border border-border1 rounded-xl px-3 py-3 text-sm outline-none focus:border-accentSoft placeholder:text-muted uppercase"
            />
            <button onClick={redeemPromo} disabled={promoLoading || !promoCode.trim()}
              className="px-4 py-3 rounded-xl bg-accent text-bg text-xs font-bold uppercase tracking-wider2 disabled:opacity-40">
              {promoLoading ? '…' : 'Применить'}
            </button>
          </div>
          <button onClick={() => { setPromoOpen(false); setPromoCode(''); }}
            className="text-[10px] text-muted mt-3">Отмена</button>
        </div>
      )}

      <div className="text-center text-[10px] text-muted pt-6">Style Room · v1.0</div>
    </main>
  );
}

function SearchScreen({ catalog, onPick }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => {
      try { inputRef.current?.focus({ preventScroll: true }); } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, []);

  const dismissKeyboard = () => {
    try { inputRef.current?.blur(); } catch {}
    haptic('light');
  };

  const results = q.trim()
    ? catalog.filter(p => p.name.toLowerCase().includes(q.toLowerCase().trim()))
    : [];

  return (
    <main className="px-5 pt-6 animate-fade-in pb-24">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-wider2 text-muted mb-1">Найти вещь</div>
        <h1 className="font-serif text-3xl leading-tight">Поиск</h1>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); dismissKeyboard(); }} className="relative mb-3">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') dismissKeyboard(); }}
          placeholder="Название, категория…"
          enterKeyHint="done"
          inputMode="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          className="w-full bg-card border border-border1 rounded-2xl pl-11 pr-12 py-3.5 text-sm outline-none focus:border-accentSoft placeholder:text-muted transition"
        />
        <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" />
        </svg>
        {q && (
          <button type="button"
            onClick={() => { setQ(''); dismissKeyboard(); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full border border-border2 text-muted flex items-center justify-center text-xs">
            ✕
          </button>
        )}
      </form>

      <button
        type="button"
        onClick={dismissKeyboard}
        className="w-full bg-bgSoft border border-border2 text-accent py-3 rounded-2xl text-xs font-medium uppercase tracking-wider2 mb-6 active:scale-[0.98] transition"
      >
        ⌨️ Готово — скрыть клавиатуру
      </button>

      {!q.trim() && (
        <div className="text-center py-20">
          <div className="text-6xl mb-4">🔍</div>
          <div className="font-serif text-lg text-title mb-2">Что будем искать?</div>
          <div className="text-xs text-muted max-w-xs mx-auto">Введите название вещи или категорию</div>
        </div>
      )}
      {q.trim() && results.length === 0 && (
        <div className="text-center py-16 text-muted text-sm">Ничего не найдено</div>
      )}
      {q.trim() && results.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {results.map(item => <ProductCard key={item.id} item={item} onPick={onPick} />)}
        </div>
      )}
    </main>
  );
}

const SLIDES = [
  { emoji: '✨', title: 'Примерь любой образ', text: 'Загрузите фото в полный рост, выберите вещь — ИИ покажет, как она сидит именно на вас' },
  { emoji: '🛍️', title: 'Актуальные тренды WB', text: 'Каталог обновляется автоматически — свежие находки Wildberries всегда под рукой' },
  { emoji: '👥', title: 'Приглашай подруг', text: 'За каждую подругу, которая сделает первую примерку, вы обе получите +3 попытки' },
];

function Onboarding({ onDone }) {
  const [i, setI] = useState(0);
  const last = i === SLIDES.length - 1;
  const s = SLIDES[i];
  const next = () => { haptic('medium'); last ? onDone() : setI(i + 1); };
  return (
    <div className="min-h-screen flex flex-col px-8 pt-16 pb-10 bg-bg">
      <div className="flex justify-center gap-2 mb-12">
        {SLIDES.map((_, k) => <div key={k} className={`h-[3px] rounded-full transition-all duration-300 ${k === i ? 'w-8 bg-accent' : 'w-2 bg-border2'}`} />)}
      </div>
      <div key={i} className="flex-1 flex flex-col items-center justify-center text-center animate-slide-up">
        <div className="text-7xl mb-8">{s.emoji}</div>
        <h2 className="font-serif text-3xl mb-4 leading-tight">{s.title}</h2>
        <p className="text-sm text-muted2 leading-relaxed max-w-xs">{s.text}</p>
      </div>
      <button onClick={next} className="w-full bg-accent hover:bg-accentH text-bg py-4 rounded-2xl text-sm font-medium uppercase tracking-wider2 active:scale-[0.98] transition">
        {last ? 'Начать' : 'Продолжить'}
      </button>
      {!last && <button onClick={onDone} className="mt-4 text-xs text-muted">Пропустить</button>}
    </div>
  );
}

function BottomNav({ active, onChange }) {
  const items = [
    { key: 'catalog', label: 'Разделы',  emoji: '🗂' },
    { key: 'search',  label: 'Поиск',    emoji: '🔍' },
    { key: 'subs',    label: 'Подписка', emoji: '💎' },
    { key: 'profile', label: 'Профиль',  emoji: '👤' },
  ];
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-bg/95 backdrop-blur-md border-t border-border1 px-3 pt-2"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 8px), 8px)' }}>
      <div className="flex items-center justify-around max-w-md mx-auto">
        {items.map(it => {
          const isActive = active === it.key;
          return (
            <button key={it.key} onClick={() => { haptic('light'); onChange(it.key); }}
              className="flex flex-col items-center gap-1 py-2 px-3 rounded-xl min-w-[60px] active:scale-95 transition">
              <span className={`text-lg transition-opacity ${isActive ? 'opacity-100' : 'opacity-50'}`}>{it.emoji}</span>
              <span className={`text-[9px] uppercase tracking-wider2 transition ${isActive ? 'text-accent font-bold' : 'text-muted'}`}>{it.label}</span>
              {isActive && <div className="w-1 h-1 rounded-full bg-accent" />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [tab, setTab] = useState('catalog');
  const [screen, setScreen] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState(null);
  const [humanImg, setHumanImg] = useState('');
  const [resultImage, setResultImage] = useState(null);
  const [viral, setViral] = useState(false);
  const [toast, setToast] = useState('');
  const [hintIdx, setHintIdx] = useState(0);
  const fileRef = useRef(null);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 2500); };

  // Подсказки во время загрузки примерки
  useEffect(() => {
    if (tab !== 'loading') return;
    setHintIdx(0);
    const t = setInterval(() => setHintIdx(i => (i + 1) % HINTS.length), 4000);
    return () => clearInterval(t);
  }, [tab]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready(); tg.expand();
      tg.setHeaderColor?.('#0C0A08');
      tg.setBackgroundColor?.('#0C0A08');
      tg.disableVerticalSwipes?.();
    }
    const initData = tg?.initData || '';
    const startParam = tg?.initDataUnsafe?.start_param;

    fetch(`${BACKEND}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, refCode: startParam }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setUser(d.user);
          if (!d.user.onboarded && localStorage.getItem('gf_onboarded') !== '1') setShowOnboarding(true);
        } else setUserGuest();
      })
      .catch(() => setUserGuest());
  }, []);

  const setUserGuest = () => setUser({
    tg_id: 0, first_name: 'Ошибка авторизации', username: '—', photo_url: '',
    balance: 0, own_tries: 0, sub_active: false, onboarded: true,
  });

  const finishOnboarding = async () => {
    localStorage.setItem('gf_onboarded', '1');
    setShowOnboarding(false);
    try {
      await fetch(`${BACKEND}/api/onboarded`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: window.Telegram?.WebApp?.initData || '' }),
      });
    } catch {}
  };

  const loadCatalog = useCallback(async (cat) => {
    setLoading(true);
    try {
      const q = cat && cat !== 'all' ? `?category=${encodeURIComponent(cat)}` : '';
      const r = await fetch(`${BACKEND}/api/catalog${q}`);
      const d = await r.json();
      setCatalog(d.success && d.items.length ? d.items : FALLBACK);
    } catch { setCatalog(FALLBACK); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCatalog(category); }, [category, loadCatalog]);

  const share = () => {
    haptic('medium');
    const refLink = `https://t.me/GFstyleroom_bot/app?startapp=ref_${user?.tg_id || 0}`;
    const text = 'Смотри, какое крутое мини-приложение с примеркой одежды ✨';
    const url = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(text)}`;
    if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url);
    else window.open(url, '_blank');
  };

  const onPickFile = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      setHumanImg(await compressImage(f, 768, 0.75));
      showToast('Фото загружено');
    } catch { showToast('Не удалось обработать фото'); }
  };

  const buySubscription = async (subId) => {
    haptic('medium');
    if (!user?.tg_id) return showToast('Откройте в Telegram');
    try {
      const r = await fetch(`${BACKEND}/api/create-invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tgId: user.tg_id, productType: `sub_${subId}` }),
      });
      const d = await r.json();
      if (!d.invoiceLink) throw new Error(d.error || 'no invoice');
      window.Telegram.WebApp.openInvoice(d.invoiceLink, (s) => {
        if (s === 'paid') { showToast('Подписка активирована ✨'); setTimeout(() => window.location.reload(), 1500); }
      });
    } catch { showToast('Ошибка оплаты'); }
  };

  const buyTries = async (count) => {
    haptic('medium');
    if (!user?.tg_id) return showToast('Откройте в Telegram');
    try {
      const r = await fetch(`${BACKEND}/api/create-invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tgId: user.tg_id, productType: 'custom_tries', tries: count }),
      });
      const d = await r.json();
      if (!d.invoiceLink) throw new Error(d.error || 'no invoice');
      window.Telegram.WebApp.openInvoice(d.invoiceLink, (s) => {
        if (s === 'paid') { showToast('Попытки зачислены ✨'); setTimeout(() => window.location.reload(), 1500); }
      });
    } catch { showToast('Ошибка оплаты'); }
  };

  const runTryOn = async () => {
    if (!selected) return showToast('Выберите товар');
    if (!humanImg) return showToast('Загрузите фото');
    haptic('medium');
    setTab('loading');
    const t0 = Date.now();
    try {
      const r = await fetch(`${BACKEND}/api/tryon`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: window.Telegram?.WebApp?.initData || '',
          humanImg,
          garmentUrl: selected.image_url,
          itemId: selected.id,
          isAccessory: selected.category === 'accessory',
          category: selected.category,
        }),
      });
      const d = await r.json();
      console.log(`[tryon] ответ за ${Date.now() - t0}ms:`, d);
      if (d.success && d.resultUrl) {
        setResultImage(d.resultUrl);
        setUser(u => u ? { ...u, balance: Math.max(0, (u.balance || 0) - 1) } : u);
        setTab('result');
        if (Math.random() < 0.3) setTimeout(() => setViral(true), 800);
      } else {
        showToast(d.error || 'Ошибка примерки');
        setTab('catalog');
      }
    } catch {
      showToast('Ошибка соединения');
      setTab('catalog');
    }
  };

  const resetTryOn = () => { setTab('catalog'); setSelected(null); setResultImage(null); setHumanImg(''); };

  if (!user) return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg">
      <div className="spinner mb-6" />
      <div className="text-xs text-muted tracking-wider2 uppercase">Загрузка</div>
    </div>
  );

  if (showOnboarding) return <Onboarding onDone={finishOnboarding} />;

  const isTryOn = tab === 'upload' || tab === 'loading' || tab === 'result';

  if (screen === 'subs') return <><SubscriptionsScreen onBack={() => setScreen(null)} onBuy={buySubscription} /><BottomNav active="subs" onChange={(k) => { setScreen(null); setTab(k); }} /></>;
  if (screen === 'buyTries') return <><BuyTriesScreen onBack={() => setScreen(null)} onBuy={buyTries} user={user} /><BottomNav active="profile" onChange={(k) => { setScreen(null); setTab(k); }} /></>;
  if (screen === 'history') return <><HistoryScreen onBack={() => setScreen(null)} /><BottomNav active="profile" onChange={(k) => { setScreen(null); setTab(k); }} /></>;

  return (
    <div className="min-h-screen bg-bg text-title pb-24">
      {!isTryOn && (
        <header className="sticky top-0 z-40 bg-bg/85 backdrop-blur-md border-b border-border1 px-5 py-3.5">
          <div className="flex items-center justify-between">
            <button onClick={() => { haptic('light'); setTab('profile'); }} className="flex items-center gap-3 active:scale-95 transition">
              <img src={user.photo_url || 'https://placehold.co/80x80/1A1412/D4B595?text=U'} alt=""
                className="w-9 h-9 rounded-full object-cover border border-border2" />
              <div className="text-left">
                <div className="text-sm font-medium leading-tight">{user.first_name || 'Гость'}</div>
                <div className="text-[11px] text-muted">@{user.username || 'user'}</div>
              </div>
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => { haptic('light'); setScreen('buyTries'); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border2 active:scale-95 transition">
                <span className="text-[11px] text-muted">✨</span>
                <span className="text-xs font-medium">{user.balance ?? 0}</span>
                <span className="text-accent text-sm font-bold leading-none">+</span>
              </button>
              <button onClick={() => { haptic('medium'); setScreen('subs'); }}
                className="px-3 py-1.5 rounded-full bg-accent text-bg text-xs font-bold active:scale-95 transition">
                💎
              </button>
            </div>
          </div>
        </header>
      )}

      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-card border border-border2 text-title text-xs px-4 py-2.5 rounded-full shadow-soft animate-slide-up">
          {toast}
        </div>
      )}

      {tab === 'catalog' && (
        <main className="px-5 pt-6">
          <div className="flex items-end justify-between mb-6">
            <div>
              <div className="text-[10px] uppercase tracking-wider2 text-muted mb-1">Коллекция</div>
              <h1 className="font-serif text-3xl leading-tight">Гардероб</h1>
              <p className="text-xs text-muted2 mt-1.5">Примерьте образ за секунды</p>
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar mb-6 -mx-5 px-5">
            {CATEGORIES.map(c => {
              const active = category === c.key;
              return (
                <button key={c.key} onClick={() => { haptic('light'); setCategory(c.key); }}
                  className={`whitespace-nowrap text-xs px-3.5 py-2 rounded-full border flex items-center gap-1.5 transition-all duration-200 active:scale-95 ${active ? 'bg-accent text-bg border-accent font-medium' : 'border-border2 text-muted2'}`}>
                  <span>{c.emoji}</span>{c.label}
                </button>
              );
            })}
          </div>
          {loading ? (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-card border border-border1 rounded-2xl overflow-hidden animate-pulse">
                  <div className="aspect-[3/4] bg-border1" />
                  <div className="p-3 space-y-2"><div className="h-2 bg-border1 rounded w-1/2" /><div className="h-3 bg-border1 rounded w-full" /></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {catalog.map(item => <ProductCard key={item.id} item={item} onPick={(it) => { setSelected(it); setTab('upload'); }} />)}
            </div>
          )}
          <button onClick={share}
            className="w-full mt-8 bg-bgSoft border border-border2 text-accent py-4 rounded-2xl text-xs font-medium uppercase tracking-wider2 flex items-center justify-center gap-2 active:scale-[0.98] transition">
            <span>👥</span> Поделиться с подругой · +3
          </button>
        </main>
      )}

      {tab === 'search' && <SearchScreen catalog={catalog} onPick={(it) => { setSelected(it); setTab('upload'); }} />}

      {tab === 'profile' && (
        <ProfileScreen user={user}
          onOpenSubs={() => setScreen('subs')}
          onOpenBuyTries={() => setScreen('buyTries')}
          onOpenHistory={() => setScreen('history')}
          onToast={showToast} />
      )}

      {tab === 'upload' && selected && (
        <main className="px-5 pt-5 animate-fade-in">
          <button onClick={() => setTab('catalog')} className="text-xs text-muted mb-5 flex items-center gap-1 active:scale-95 transition">← Назад</button>
          <div className="bg-card border border-border1 rounded-2xl overflow-hidden mb-6">
            <div className="aspect-[4/3]">
              <ProductImage src={selected.image_url} fallback={selected.fallback_url} alt={selected.name} className="w-full h-full" />
            </div>
            <div className="p-4">
              <div className="text-[10px] uppercase tracking-wider2 text-accentSoft mb-1">{CATEGORIES.find(x => x.key === selected.category)?.label || 'Одежда'}</div>
              <div className="font-serif text-base leading-tight text-title">{selected.description || selected.name}</div>
              <div className="text-xs text-muted mt-1.5 flex items-center gap-1"><span className="text-accent">≈</span><span>{selected.price ? selected.price.replace(/^≈\s*/, '') : '—'}</span></div>
            </div>
          </div>
          <div className="bg-card border border-border2 rounded-2xl p-4 mb-4">
            <div className="text-[10px] uppercase tracking-wider2 text-accent mb-2">📸 {selected.category === 'accessory' ? 'Для аксессуаров' : 'Для одежды'}</div>
            <div className="text-xs text-title leading-relaxed">
              {selected.category === 'accessory'
                ? 'Загрузите фото лица — очки, повязки и ободки будут примерены прямо на него.'
                : 'Загрузите фото в полный рост — вещь будет примерена на вас.'}
            </div>
          </div>
          <button onClick={() => fileRef.current?.click()}
            className="w-full bg-card border border-dashed border-border2 hover:border-accentSoft rounded-2xl py-8 text-sm text-muted2 mb-3 flex flex-col items-center gap-2 active:scale-[0.99] transition">
            <span className="text-2xl">{humanImg ? '✓' : '📷'}</span>
            <span>{humanImg ? 'Фото загружено' : 'Загрузить фото'}</span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" onChange={onPickFile} className="hidden" />
          {humanImg && <img src={humanImg} alt="preview" className="w-full max-h-72 object-contain rounded-2xl mb-4 border border-border1 animate-fade-in" />}
          <button onClick={runTryOn} disabled={!humanImg}
            className="w-full bg-accent hover:bg-accentH disabled:opacity-30 disabled:cursor-not-allowed text-bg py-4 rounded-2xl text-sm font-medium uppercase tracking-wider2 mt-4 active:scale-[0.98] transition">
            {selected.category === 'accessory' ? 'Примерить аксессуар' : 'Запустить примерку'}
          </button>
        </main>
      )}

      {tab === 'loading' && (
        <div className="min-h-[75vh] flex flex-col items-center justify-center px-8 text-center">
          <div className="spinner mb-8" />
          <div className="font-serif text-xl mb-2">Подбираем образ</div>
          <div className="text-xs text-muted transition-opacity duration-300">{HINTS[hintIdx]}</div>
        </div>
      )}

      {tab === 'result' && (
        <main className="px-5 pt-5 animate-fade-in">
          <div className="text-[10px] uppercase tracking-wider2 text-muted mb-3">Результат</div>
          {resultImage && resultImage.startsWith('http') ? (
            <>
              <img src={resultImage} alt="result"
                className="w-full rounded-2xl border border-border1 shadow-soft mb-5"
                onError={(e) => { e.target.src = 'https://placehold.co/600x800/1A1412/D4B595?text=Ошибка+загрузки'; }} />
              <a href={`https://www.wildberries.ru/catalog/${selected?.wb_id}/detail.aspx`} target="_blank" rel="noreferrer"
                className="block w-full bg-accent hover:bg-accentH text-bg text-center py-4 rounded-2xl text-sm font-medium uppercase tracking-wider2 mb-3 active:scale-[0.98] transition">
                Купить на Wildberries
              </a>
            </>
          ) : (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">😕</div>
              <div className="text-sm text-title mb-2">Не удалось сгенерировать фото</div>
              <div className="text-xs text-muted mb-6">Попробуй другой товар или загрузи фото в полный рост</div>
            </div>
          )}
          <button onClick={resetTryOn} className="w-full border border-border2 text-muted2 py-4 rounded-2xl text-sm active:scale-[0.98] transition">Вернуться в каталог</button>
        </main>
      )}

      {viral && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-5 animate-fade-in">
          <div className="bg-card border border-border2 rounded-3xl p-7 max-w-sm w-full text-center shadow-soft animate-slide-up">
            <div className="text-3xl mb-4">✨</div>
            <h3 className="font-serif text-2xl mb-3">Понравилось?</h3>
            <p className="text-xs text-muted2 leading-relaxed mb-6">Поделись с подругой — как только она сделает первую примерку, вы обе получите <span className="text-accent">+3 попытки</span></p>
            <button onClick={() => { setViral(false); share(); }}
              className="w-full bg-accent text-bg py-3.5 rounded-2xl text-xs font-medium uppercase tracking-wider2 mb-3 active:scale-[0.98] transition">Поделиться</button>
            <button onClick={() => setViral(false)} className="text-xs text-muted">Закрыть</button>
          </div>
        </div>
      )}

      {!isTryOn && (
        <BottomNav active={tab} onChange={(k) => { setScreen(null); setTab(k); if (k === 'subs') setScreen('subs'); }} />
      )}
    </div>
  );
}
