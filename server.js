// ============================================================
// 2. ПРОКСИ ДЛЯ КАРТИНОК WB (2 провайдера)
// ============================================================
app.get('/api/img', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Bad url');

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('Bad url'); }

  if (!/\.wbbasket\.ru$/.test(parsed.hostname)) {
    return res.status(400).send('Bad host');
  }

  // Пробуем wsrv.nl (европейский прокси — обходит блок WB)
  const wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(url)}`;

  try {
    const r = await fetch(wsrvUrl, {
      headers: { 'User-Agent': 'GF-Style-Room/1.0' },
    });
    if (r.ok) {
      const buf = await r.buffer();
      res.set('Content-Type', r.headers.get('content-type') || 'image/webp');
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(buf);
    }
  } catch (e) { /* fallback ниже */ }

  // Fallback: напрямую с WB (с Referer)
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
  } catch (e) {
    console.error('[img]', e.message);
    res.status(500).send('Proxy error');
  }
});
