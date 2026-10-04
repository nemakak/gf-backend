function promoMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Создать промокод', callback_data: 'adm_promo_create' }],
      [{ text: '📋 Список промокодов', callback_data: 'adm_promo_list' }],
      [{ text: '❌ Деактивировать', callback_data: 'adm_promo_delete' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

function promoTypesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '+2 попытки', callback_data: 'adm_create_2' }, { text: '+5 попыток', callback_data: 'adm_create_5' }],
      [{ text: '+10 попыток', callback_data: 'adm_create_10' }, { text: '+20 попыток', callback_data: 'adm_create_20' }],
      [{ text: '💎 Безлимит 24ч', callback_data: 'adm_create_unlimited' }],
      [{ text: '← Назад', callback_data: 'adm_promo_menu' }],
    ],
  };
}

function catalogMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📌 Закрепить товар', callback_data: 'adm_pin' }],
      [{ text: '✂️ Открепить товар', callback_data: 'adm_unpin' }],
      [{ text: '🙈 Скрыть товар', callback_data: 'adm_hide' }],
      [{ text: '👁 Вернуть товар', callback_data: 'adm_unhide' }],
      [{ text: '➕ Добавить по ссылкам', callback_data: 'adm_add_links' }],
      [{ text: '✏️ Добавить вручную', callback_data: 'adm_add_manual' }],
      [{ text: '← Назад', callback_data: 'adm_back' }],
    ],
  };
}

const awaitingBroadcast = new Set();
const awaitingModeration = new Map();
const awaitingUserSearch = new Set();
const awaitingAddCustom = new Map();
const awaitingLinks = new Set();
const awaitingLinksDesc = new Map();
const awaitingManualProduct = new Map();

function randomCode(prefix = 'WELCOME') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

async function handleStart(msg) {
  const chatId = msg.chat.id;
  const isAdm = await isAdmin(msg.from.id);
  if (isAdm) {
    await sendMessage(chatId,
      `👑 <b>Админ-панель Style Room</b>\n\nВыбери раздел из меню ниже.`,
      mainAdminKeyboard());
  } else {
    await sendMessage(chatId, '✨ Добро пожаловать в Style Room!\n\nНажми кнопку ниже, чтобы открыть приложение.');
  }
}

async function handleAdminMenu(msg) {
  const chatId = msg.chat.id;
  if (!(await isAdmin(msg.from.id))) return sendMessage(chatId, '⛔ Нет доступа.');
  await sendMessage(chatId, '👑 <b>Админ-панель</b>\n\nВыбери раздел:', mainAdminKeyboard());
}

async function showUserCard(chatId, messageId, tgId, toast = null) {
  try {
    const r = await pool.query(
      `SELECT tg_id, first_name, username, balance, own_tries, sub_active,
              unlimited_until, created_at, last_active,
              (SELECT COUNT(*)::int FROM tryon_history WHERE user_id = users.tg_id) AS total_tryons,
              (SELECT COUNT(*)::int FROM payments WHERE tg_id = users.tg_id) AS payments
       FROM users WHERE tg_id = $1`,
      [tgId]
    );
    if (!r.rows.length) {
      const txt = `❌ Юзер <code>${tgId}</code> не найден.`;
      return messageId
        ? editMessage(chatId, messageId, txt, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] })
        : sendMessage(chatId, txt, { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    }
    const u = r.rows[0];

    const unlimText = u.unlimited_until && new Date(u.unlimited_until) > new Date()
      ? `♾ до ${new Date(u.unlimited_until).toLocaleString('ru-RU')}`
      : 'нет';

    const text =
      `${toast ? '✅ ' + toast + '\n\n' : ''}` +
      `👤 <b>${u.first_name || 'Без имени'}</b>\n` +
      `🔗 @${u.username || '—'}\n` +
      `🆔 <code>${u.tg_id}</code>\n\n` +
      `✨ <b>Обычных примерок:</b> ${u.balance}\n` +
      `📦 <b>Своих товаров:</b> ${u.own_tries}\n` +
      `🎨 <b>Всего примерок:</b> ${u.total_tryons}\n` +
      `💳 <b>Платежей:</b> ${u.payments}\n\n` +
      `💎 Подписка: ${u.sub_active ? 'да' : 'нет'}\n` +
      `♾ Безлимит: ${unlimText}\n` +
      `📅 Создан: ${new Date(u.created_at).toLocaleDateString('ru-RU')}\n` +
      `🕐 Был в сети: ${u.last_active ? new Date(u.last_active).toLocaleString('ru-RU') : '—'}`;

    const kb = userActionsKeyboard(tgId);
    return messageId
      ? editMessage(chatId, messageId, text, kb)
      : sendMessage(chatId, text, kb);
  } catch (e) {
    const txt = '❌ Ошибка: ' + e.message;
    return messageId ? editMessage(chatId, messageId, txt) : sendMessage(chatId, txt);
  }
}

async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data;
  const userId = cb.from.id;

  if (!(await isAdmin(userId))) return answerCallback(cb.id, '⛔ Нет доступа');
  await answerCallback(cb.id);

  if (data === 'adm_back') {
    return editMessage(chatId, messageId, '👑 <b>Админ-панель</b>\n\nВыбери раздел:', mainAdminKeyboard());
  }

  if (data === 'adm_help') {
    return editMessage(chatId, messageId,
      `❓ <b>Помощь по админке</b>\n\n` +
      `<b>📊 Статистика</b> — юзеры, примерки, товары, платежи.\n\n` +
      `<b>👥 Пользователи</b> — список. Нажми на юзера → карточка с действиями.\n\n` +
      `<b>🔍 Поиск юзера</b> — tg_id, @username или часть имени.\n\n` +
      `<b>🎁 Промокоды</b> — создавай коды на попытки/безлимит.\n\n` +
      `<b>📌 Каталог</b> — закрепить/скрыть/вернуть товар по wb_id.\n\n` +
      `<b>➕ Добавить по ссылкам</b> — пришли ссылки WB. Бот спросит описание и добавит все товары.\n\n` +
      `<b>✏️ Добавить вручную</b> — пошаговый ввод.\n\n` +
      `<b>🔄 Обновить названия WB</b> — перезалить названия для товаров с заглушкой.\n\n` +
      `<b>🧹 Очистить старые</b> — удалить товары старше 5 дней.\n\n` +
      `<b>📢 Рассылка</b> — сообщение всем юзерам.`,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
  }

  if (data === 'adm_stats') {
    const users = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const tryons = await pool.query('SELECT COUNT(*)::int AS c FROM tryon_history');
    const products = await pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active = TRUE');
    const payments = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(stars),0)::int AS s FROM payments');
    const today = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE created_at > NOW() - INTERVAL '1 day'`);
    return editMessage(chatId, messageId,
      `📊 <b>Статистика</b>\n\n` +
      `👥 Всего юзеров: <b>${users.rows[0].c}</b>\n` +
      `🆕 За сутки: <b>${today.rows[0].c}</b>\n` +
      `✨ Примерок: <b>${tryons.rows[0].c}</b>\n` +
      `👗 Товаров: <b>${products.rows[0].c}</b>\n` +
      `💳 Платежей: <b>${payments.rows[0].c}</b> · ⭐ <b>${payments.rows[0].s}</b>`,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
  }

  if (data === 'adm_users') {
    return editMessage(chatId, messageId, '👥 <b>Пользователи</b>\n\nВыбери:', usersMenuKeyboard());
  }

  if (data === 'adm_users_last') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '👥 Юзеров пока нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    const btns = r.rows.map(u => ([{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '👥 <b>Последние 20:</b>', { inline_keyboard: btns });
  }

  if (data === 'adm_users_top') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users ORDER BY balance DESC LIMIT 20`);
    const btns = r.rows.map(u => ([{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '💰 <b>Топ по балансу:</b>', { inline_keyboard: btns });
  }

  if (data === 'adm_users_new') {
    const r = await pool.query(`SELECT tg_id, first_name, balance FROM users WHERE created_at > NOW() - INTERVAL '1 day' ORDER BY created_at DESC LIMIT 20`);
    if (!r.rows.length) return editMessage(chatId, messageId, '🆕 Новых за сутки нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_users' }]] });
    const btns = r.rows.map(u => ([{ text: `${u.first_name || '—'} · ✨${u.balance}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    return editMessage(chatId, messageId, '🆕 <b>Новые за сутки:</b>', { inline_keyboard: btns });
  }

  if (data === 'adm_find') {
    awaitingUserSearch.add(userId);
    return editMessage(chatId, messageId,
      `🔍 <b>Поиск юзера</b>\n\nОтправь:\n` +
      `• tg_id — <code>123456789</code>\n` +
      `• @username — <code>@ivan</code>\n` +
      `• имя — <code>Иван</code>`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  if (data.startsWith('usr_show_')) {
    const tgId = Number(data.replace('usr_show_', ''));
    return showUserCard(chatId, messageId, tgId);
  }

  if (data.startsWith('usr_add_custom_')) {
    const tgId = Number(data.replace('usr_add_custom_', ''));
    awaitingAddCustom.set(userId, tgId);
    return editMessage(chatId, messageId,
      `➕ <b>Своё число примерок</b>\n\nОтправь числом (например <code>100</code> или <code>-5</code>).`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: `usr_show_${tgId}` }]] });
  }

  if (/^usr_add_\d+_\d+$/.test(data)) {
    const parts = data.split('_');
    const count = Number(parts[2]);
    const tgId = Number(parts[3]);
    try {
      await pool.query('UPDATE users SET balance = balance + $1 WHERE tg_id = $2', [count, tgId]);
      return showUserCard(chatId, messageId, tgId, `Начислено +${count}`);
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message);
    }
  }

  if (data.startsWith('usr_reset_')) {
    const tgId = Number(data.replace('usr_reset_', ''));
    await pool.query('UPDATE users SET balance = 0 WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Баланс обнулён');
  }

  if (data.startsWith('usr_unlimit_off_')) {
    const tgId = Number(data.replace('usr_unlimit_off_', ''));
    await pool.query('UPDATE users SET unlimited_until = NULL WHERE tg_id = $1', [tgId]);
    return showUserCard(chatId, messageId, tgId, 'Безлимит снят');
  }

  if (data.startsWith('usr_unlimit_')) {
    const tgId = Number(data.replace('usr_unlimit_', ''));
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET unlimited_until = $1 WHERE tg_id = $2', [until, tgId]);
    return showUserCard(chatId, messageId, tgId, 'Безлимит на 24ч выдан');
  }

  if (data.startsWith('usr_delete_')) {
    const tgId = Number(data.replace('usr_delete_', ''));
    await pool.query('DELETE FROM users WHERE tg_id = $1', [tgId]);
    return editMessage(chatId, messageId, `🗑 Юзер <code>${tgId}</code> удалён.`,
      { inline_keyboard: [[{ text: '← К юзерам', callback_data: 'adm_users' }]] });
  }

  if (data === 'adm_promo_menu') {
    return editMessage(chatId, messageId, '🎁 <b>Промокоды</b>', promoMenuKeyboard());
  }

  if (data === 'adm_promo_create') {
    return editMessage(chatId, messageId, '🎁 <b>Создание промокода</b>\n\nВыбери номинал:', promoTypesKeyboard());
  }

  if (data.startsWith('adm_create_')) {
    const type = data.replace('adm_create_', '');
    let tries = 2, unlimited = false;
    if (type === 'unlimited') unlimited = true;
    else tries = Number(type) || 2;
    const code = randomCode();
    try {
      await pool.query(
        `INSERT INTO promo_codes (code, tries, unlimited, max_uses, is_active)
         VALUES ($1, $2, $3, 1000, TRUE)`,
        [code, tries, unlimited]
      );
      const reward = unlimited ? '💎 Безлимит 24 часа' : `🎁 +${tries} попыток`;
      return editMessage(chatId, messageId,
        `✅ <b>Промокод создан</b>\n\n🔑 Код: <code>${code}</code>\n${reward}\n📊 Лимит: 1000 активаций`,
        {
          inline_keyboard: [
            [{ text: '➕ Создать ещё', callback_data: 'adm_promo_create' }],
            [{ text: '← Назад', callback_data: 'adm_promo_menu' }],
          ],
        });
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
    }
  }

  if (data === 'adm_promo_list') {
    const r = await pool.query(
      `SELECT code, tries, unlimited, used_count, max_uses, is_active
       FROM promo_codes ORDER BY created_at DESC LIMIT 20`
    );
    if (!r.rows.length) return editMessage(chatId, messageId, '📋 Промокодов нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
    let m = '📋 <b>Промокоды:</b>\n\n';
    for (const p of r.rows) {
      m += `<code>${p.code}</code> · ${p.unlimited ? '💎' : '+' + p.tries} · ${p.used_count}/${p.max_uses}${p.is_active ? '' : ' · ⛔'}\n`;
    }
    return editMessage(chatId, messageId, m,
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
  }

  if (data === 'adm_promo_delete') {
    const r = await pool.query(`SELECT code FROM promo_codes WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 10`);
    if (!r.rows.length) return editMessage(chatId, messageId, '❌ Активных нет.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_promo_menu' }]] });
    const btns = r.rows.map(p => ([{ text: '❌ ' + p.code, callback_data: 'adm_del_' + p.code }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_promo_menu' }]);
    return editMessage(chatId, messageId, 'Выбери промокод для деактивации:', { inline_keyboard: btns });
  }

  if (data.startsWith('adm_del_')) {
    const code = data.replace('adm_del_', '');
    await pool.query('UPDATE promo_codes SET is_active = FALSE WHERE code = $1', [code]);
    return editMessage(chatId, messageId, `✅ Промокод <code>${code}</code> деактивирован`,
      {
        inline_keyboard: [
          [{ text: '❌ Ещё', callback_data: 'adm_promo_delete' }],
          [{ text: '← Назад', callback_data: 'adm_promo_menu' }],
        ],
      });
  }

  if (data === 'adm_moderate') {
    return editMessage(chatId, messageId,
      '📌 <b>Каталог: модерация</b>\n\nЧто сделать с товаром?',
      catalogMenuKeyboard());
  }

  if (['adm_pin', 'adm_unpin', 'adm_hide', 'adm_unhide'].includes(data)) {
    const action = data.replace('adm_', '');
    awaitingModeration.set(userId, action);
    const prompts = {
      pin: '📌 Отправь <b>wb_id</b> товара для закрепления:',
      unpin: '✂️ Отправь <b>wb_id</b> товара для открепления:',
      hide: '🙈 Отправь <b>wb_id</b> товара, чтобы скрыть:',
      unhide: '👁 Отправь <b>wb_id</b> товара, чтобы вернуть:',
    };
    return editMessage(chatId, messageId, prompts[action],
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_moderate' }]] });
  }

  if (data === 'adm_add_links') {
    awaitingLinks.add(userId);
    return editMessage(chatId, messageId,
      `➕ <b>Добавить товары по ссылкам</b>\n\n` +
      `Отправь <b>одним сообщением</b> ссылки WB или артикулы.\n\n` +
      `Пример:\n<code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>\n<code>183581368</code>\n\n` +
      `После этого я попрошу описание (или <code>-</code>, чтобы без него).`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  if (data === 'adm_add_manual') {
    awaitingManualProduct.set(userId, { step: 'wb_id' });
    return editMessage(chatId, messageId,
      `✏️ <b>Добавление товара вручную</b>\n\n` +
      `Шаг 1/5 — отправь <b>артикул WB</b> (число) или ссылку.`,
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }

  if (data === 'adm_backfill') {
    try {
      const r = await pool.query(
        `SELECT id, wb_id FROM products WHERE name LIKE 'Товар WB%' OR name IS NULL ORDER BY id DESC LIMIT 100`
      );
      if (!r.rows.length) {
        return editMessage(chatId, messageId, '✅ Все товары уже с нормальными названиями.',
          { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
      }
      await editMessage(chatId, messageId,
        `🔄 Обновляю ${r.rows.length} товаров… Это займёт ~${Math.ceil(r.rows.length * 0.3)} сек.`);
      let updated = 0, failed = 0;
      for (const row of r.rows) {
        const info = await fetchWBProductInfo(row.wb_id);
        if (info?.name && !info.name.startsWith('Товар WB')) {
          await pool.query(
            `UPDATE products SET name = $1, price = COALESCE($2, price), updated_at = NOW() WHERE id = $3`,
            [info.name, info.price, row.id]
          );
          updated++;
        } else failed++;
        await new Promise(rs => setTimeout(rs, 250));
      }
      return editMessage(chatId, messageId,
        `✅ <b>Готово</b>\n\nОбновлено: <b>${updated}</b>\nНе удалось: <b>${failed}</b>\n\nОсталось товаров с заглушкой: <b>${failed}</b>`,
        {
          inline_keyboard: [
            [{ text: '🔄 Ещё раз', callback_data: 'adm_backfill' }],
            [{ text: '← Назад', callback_data: 'adm_back' }],
          ],
        });
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    }
  }

  if (data === 'adm_cleanup') {
    try {
      const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
      return editMessage(chatId, messageId,
        `🧹 Очистка выполнена.\nУдалено товаров старше 5 дней: <b>${r.rows[0].deleted_count}</b>`,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    } catch (e) {
      return editMessage(chatId, messageId, '❌ ' + e.message,
        { inline_keyboard: [[{ text: '← Назад', callback_data: 'adm_back' }]] });
    }
  }

  if (data === 'adm_broadcast') {
    awaitingBroadcast.add(userId);
    return editMessage(chatId, messageId,
      '📢 <b>Рассылка</b>\n\nНапиши текст — уйдёт всем юзерам.',
      { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  }
}

// ============================================================
// TEXT HANDLERS
// ============================================================
async function handleBroadcastText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingBroadcast.has(userId)) return false;
  awaitingBroadcast.delete(userId);
  const r = await pool.query('SELECT tg_id FROM users');
  let sent = 0, fail = 0;
  for (const u of r.rows) {
    try {
      await sendMessage(u.tg_id, msg.text);
      sent++;
      if (sent % 25 === 0) await new Promise(rs => setTimeout(rs, 1000));
    } catch { fail++; }
  }
  await sendMessage(chatId, `✅ Отправлено: <b>${sent}</b>, ошибок: <b>${fail}</b>`, mainAdminKeyboard());
  return true;
}

async function handleModerationText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const action = awaitingModeration.get(userId);
  if (!action) return false;

  const wbId = Number(msg.text.trim());
  if (!wbId) { await sendMessage(chatId, '❌ Введи числовой wb_id'); return true; }

  awaitingModeration.delete(userId);
  try {
    const exists = await pool.query('SELECT id, name FROM products WHERE wb_id = $1', [wbId]);
    if (!exists.rows.length) {
      await sendMessage(chatId, `❌ Товар ${wbId} не найден`, mainAdminKeyboard());
      return true;
    }
    const name = exists.rows[0].name;
    if (action === 'pin') await pool.query('UPDATE products SET is_pinned = TRUE WHERE wb_id = $1', [wbId]);
    if (action === 'unpin') await pool.query('UPDATE products SET is_pinned = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'hide') await pool.query('UPDATE products SET is_active = FALSE WHERE wb_id = $1', [wbId]);
    if (action === 'unhide') await pool.query('UPDATE products SET is_active = TRUE WHERE wb_id = $1', [wbId]);
    await sendMessage(chatId, `✅ Готово: <b>${name}</b>`, mainAdminKeyboard());
    return true;
  } catch (e) {
    await sendMessage(chatId, '❌ ' + e.message, mainAdminKeyboard());
    return true;
  }
}

async function handleUserSearch(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingUserSearch.has(userId)) return false;
  awaitingUserSearch.delete(userId);

  const q = msg.text.trim();
  try {
    let r;
    if (/^\d+$/.test(q)) {
      r = await pool.query('SELECT tg_id FROM users WHERE tg_id = $1', [Number(q)]);
    } else if (q.startsWith('@')) {
      r = await pool.query('SELECT tg_id FROM users WHERE LOWER(username) = LOWER($1)', [q.slice(1)]);
    } else {
      r = await pool.query('SELECT tg_id FROM users WHERE LOWER(first_name) LIKE LOWER($1) LIMIT 20', [`%${q}%`]);
    }

    if (!r.rows.length) {
      await sendMessage(chatId, `❌ Никого не найдено по <code>${q}</code>`, mainAdminKeyboard());
      return true;
    }
    if (r.rows.length === 1) {
      return showUserCard(chatId, null, r.rows[0].tg_id, `Найден по "${q}"`);
    }
    const btns = r.rows.map(u => ([{ text: `ID ${u.tg_id}`, callback_data: `usr_show_${u.tg_id}` }]));
    btns.push([{ text: '← Назад', callback_data: 'adm_users' }]);
    await sendMessage(chatId, `🔍 Найдено ${r.rows.length}:`, { inline_keyboard: btns });
    return true;
  } catch (e) {
    await sendMessage(chatId, '❌ ' + e.message, mainAdminKeyboard());
    return true;
  }
}

async function handleAddCustomText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingAddCustom.has(userId)) return false;
  const targetTgId = awaitingAddCustom.get(userId);
  awaitingAddCustom.delete(userId);

  const n = Number(msg.text.trim());
  if (!Number.isFinite(n) || n === 0) {
    await sendMessage(chatId, '❌ Введи число (например 100 или -5)');
    return true;
  }
  await pool.query('UPDATE users SET balance = GREATEST(0, balance + $1) WHERE tg_id = $2', [n, targetTgId]);
  await showUserCard(chatId, null, targetTgId, `${n > 0 ? 'Начислено +' : 'Списано '}${n}`);
  return true;
}

async function handleLinksText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingLinks.has(userId)) return false;
  awaitingLinks.delete(userId);

  const ids = extractWbIds(msg.text);
  if (!ids.length) {
    await sendMessage(chatId,
      `❌ Не нашёл артикулов.\n\nПример:\n<code>https://www.wildberries.ru/catalog/183581368/detail.aspx</code>\nили <code>183581368</code>`,
      mainAdminKeyboard());
    return true;
  }
  awaitingLinksDesc.set(userId, ids);
  await sendMessage(chatId,
    `📝 <b>Введи описание для ${ids.length} товаров</b>\n\n` +
    `Оно будет показано в приложении вместо названия.\n` +
    `Если не нужно — отправь <code>-</code>`,
    { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'adm_back' }]] });
  return true;
}

async function handleLinksDescText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingLinksDesc.has(userId)) return false;
  const ids = awaitingLinksDesc.get(userId);
  awaitingLinksDesc.delete(userId);

  const description = msg.text.trim() === '-' ? null : msg.text.trim();
  await sendMessage(chatId, `⏳ Обрабатываю ${ids.length} товаров…`);

  let added = 0, failed = 0;
  const results = [];
  for (const wbId of ids) {
    try {
      const info = await fetchWBProductInfo(wbId);
      const name = info?.name || `Товар WB ${wbId}`;
      const price = info?.price || null;
      const category = guessCategory(name);
      const imageUrl = primaryImageUrl(wbId);
      const fallbackUrl = fallbackImageUrl(wbId);
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,NOW(),NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name = EXCLUDED.name, price = EXCLUDED.price, category = EXCLUDED.category,
           image_url = EXCLUDED.image_url, fallback_url = EXCLUDED.fallback_url,
           is_active = TRUE, description = EXCLUDED.description, updated_at = NOW()`,
        [wbId, name, price, category, imageUrl, fallbackUrl, description]
      );
      added++;
      results.push(`✅ <code>${wbId}</code> — ${name.slice(0, 40)}`);
    } catch (e) {
      failed++;
      results.push(`❌ <code>${wbId}</code> — ${e.message}`);
    }
  }
  await sendMessage(chatId,
    `📦 <b>Готово</b>\n\n✅ Добавлено: <b>${added}</b>\n❌ Ошибок: <b>${failed}</b>\n\n` +
    results.slice(0, 30).join('\n') +
    (results.length > 30 ? `\n…и ещё ${results.length - 30}` : ''),
    mainAdminKeyboard());
  return true;
}

async function handleManualProductText(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!awaitingManualProduct.has(userId)) return false;

  const state = awaitingManualProduct.get(userId);
  const text = msg.text.trim();

  if (state.step === 'wb_id') {
    const ids = extractWbIds(text);
    if (!ids.length) { await sendMessage(chatId, '❌ Не нашёл артикул.'); return true; }
    state.wb_id = ids[0];
    state.step = 'name';
    awaitingManualProduct.set(userId, state);
    await sendMessage(chatId, `📝 Шаг 2/5 — введи <b>название</b> товара:`);
    return true;
  }
  if (state.step === 'name') {
    state.name = text; state.step = 'price';
    awaitingManualProduct.set(userId, state);
    await sendMessage(chatId, `💰 Шаг 3/5 — введи <b>цену</b> (например <code>3 490 ₽</code>):`);
    return true;
  }
  if (state.step === 'price') {
    state.price = text; state.step = 'category';
    awaitingManualProduct.set(userId, state);
    await sendMessage(chatId,
      `📂 Шаг 4/5 — введи <b>категорию</b>:\n\n` +
      `<code>top</code> — верх\n<code>bottom</code> — низ\n` +
      `<code>outerwear</code> — верхняя одежда\n<code>suit</code> — костюмы\n` +
      `<code>dress</code> — платья\n<code>accessory</code> — аксессуары`);
    return true;
  }
  if (state.step === 'category') {
    const allowed = ['top', 'bottom', 'outerwear', 'suit', 'dress', 'accessory'];
    const cat = text.toLowerCase().trim();
    if (!allowed.includes(cat)) {
      await sendMessage(chatId, `❌ Неверная категория. Допустимо: ${allowed.join(', ')}`);
      return true;
    }
    state.category = cat; state.step = 'description';
    awaitingManualProduct.set(userId, state);
    await sendMessage(chatId, `📄 Шаг 5/5 — введи <b>описание</b> (или <code>-</code>):`);
    return true;
  }
  if (state.step === 'description') {
    state.description = text === '-' ? null : text;
    awaitingManualProduct.delete(userId);
    try {
      const imageUrl = primaryImageUrl(state.wb_id);
      const fallbackUrl = fallbackImageUrl(state.wb_id);
      await pool.query(
        `INSERT INTO products (wb_id, name, price, category, image_url, fallback_url, is_active, source, description, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,'manual',$7,NOW(),NOW())
         ON CONFLICT (wb_id) DO UPDATE SET
           name = EXCLUDED.name, price = EXCLUDED.price, category = EXCLUDED.category,
           image_url = EXCLUDED.image_url, fallback_url = EXCLUDED.fallback_url,
           is_active = TRUE, description = EXCLUDED.description, updated_at = NOW()`,
        [state.wb_id, state.name, state.price, state.category, imageUrl, fallbackUrl, state.description]
      );
      await sendMessage(chatId,
        `✅ <b>Товар добавлен!</b>\n\n` +
        `🆔 <code>${state.wb_id}</code>\n📝 ${state.name}\n` +
        `💰 ${state.price || '—'}\n📂 ${state.category}\n📄 ${state.description || '—'}`,
        mainAdminKeyboard());
    } catch (e) {
      await sendMessage(chatId, '❌ ' + e.message, mainAdminKeyboard());
    }
    return true;
  }
  return false;
}

function guessCategory(name) {
  const n = (name || '').toLowerCase();
  if (/(очки|оправа|повязк|ободок|заколк|шарф|бандана|сумк)/.test(n)) return 'accessory';
  if (/(пальто|тренч|пуховик|шуба|плащ|ветровка|бомбер|дубленка|кожанк|куртк|жилет)/.test(n)) return 'outerwear';
  if (/(костюм|комплект)/.test(n)) return 'suit';
  if (/(платье|сарафан|юбка)/.test(n)) return 'dress';
  if (/(блузка|рубашк|топ|майка|футболка|боди|корсет|водолазк|поло|лонгслив|кроп|бандо|худи|свитер|кардиган|джемпер|кофт)/.test(n)) return 'top';
  if (/(брюк|джинс|штан|лосины|леггинс|шорт|карго)/.test(n)) return 'bottom';
  return 'top';
}

// ============================================================
// 12. WEBHOOK
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

  if (update.callback_query) {
    try { await handleCallback(update.callback_query); } catch (e) { console.error('[cb]', e.message); }
    return res.sendStatus(200);
  }

  if (update.message?.text) {
    const text = update.message.text.trim();

    if (await handleBroadcastText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleModerationText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleUserSearch(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleAddCustomText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleLinksDescText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleLinksText(update.message).catch(() => false)) return res.sendStatus(200);
    if (await handleManualProductText(update.message).catch(() => false)) return res.sendStatus(200);

    if (text === '/start') { await handleStart(update.message); return res.sendStatus(200); }
    if (text === '/admin' || text === '/menu') { await handleAdminMenu(update.message); return res.sendStatus(200); }
    return res.sendStatus(200);
  }

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
        } else if (SUBSCRIPTIONS[productType]) {
          const sub = SUBSCRIPTIONS[productType];
          await pool.query(
            `UPDATE users SET balance = balance + $1, own_tries = own_tries + $2, sub_active = TRUE WHERE tg_id = $3`,
            [sub.tries, sub.own || 0, tgId]
          );
        }
      }
    } catch (e) { console.error('[webhook]', e.message); }
  }
  res.sendStatus(200);
});

// ============================================================
// 13. HEALTH + CRON
// ============================================================
app.get('/', (_req, res) => res.send('GF Style Room API ✨'));
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

cron.schedule('0 0,12 * * *', () => { refreshCatalog(); });

cron.schedule('0 3 * * *', async () => {
  try {
    const r = await pool.query('SELECT deleted_count FROM cleanup_old_products()');
    console.log(`[cron] cleanup: удалено ${r.rows[0].deleted_count}`);
  } catch (e) { console.error('[cron] cleanup error:', e.message); }
});

pool.query('SELECT COUNT(*)::int AS c FROM products')
  .then(r => { if (r.rows[0].c === 0) refreshCatalog(); })
  .catch(() => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
