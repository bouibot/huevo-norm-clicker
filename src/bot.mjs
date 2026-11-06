// bot.mjs - Telegram-интерфейс:
//  • доступ ТОЛЬКО по одноразовым кодам приглашений (создаёт владелец в /admin)
//  • диалог добавления аккаунта, ручное решение капчи, управление аккаунтами
//  • админ-панель: коды приглашений, статистика, рассылка, мульти-админка
// Комиссии нет - весь фарм остаётся клиенту.
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { S } from './db.mjs';
import {
  OWNER_ID, CAPTCHA_WAIT_MS,
  COMMUNITY_TG, COMMUNITY_FARM, BROADCAST_DELAY_MS,
  randomInviteCode, sleep,
} from './config.mjs';

const STATUS_RU = {
  [S.RUNNING]: '🟢 фармит',
  [S.LOGGING]: '🟡 логинится',
  [S.WAITING_CAPTCHA]: '🟠 ждёт капчу',
  [S.NEED_LOGIN]: '🔑 нужен перелогин',
  [S.CAPPED]: '🌤 дневной кап',
  [S.LOCKED]: '🔒 вход залочен',
  [S.ERROR]: '🔴 ошибка',
  [S.STOPPED]: '⏸ остановлен',
  new: '⚪️ новый',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('ru-RU'));
const dt = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '');

// код: 4..32 символа латиница/цифры/дефис
const INVITE_RE = /^[A-Za-z0-9-]{4,32}$/;
const normCode = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase();

export function createBot(token, db, engine) {
  if (!token) throw new Error('BOT_TOKEN не задан (.env)');
  const bot = new Bot(token);

  // chatId → { stage: 'user'|'pass'|'adm-addadmin'|'inv-custom'|'bc-text'|'bc-confirm'|'pw', ... }
  const flows = new Map();

  const notifyUser = (chatId, text) => {
    if (chatId) bot.api.sendMessage(chatId, text).catch(() => {});
  };
  // HTML-сообщение с инлайн-клавиатурой (для кнопки «Перелогиниться» из engine)
  const notifySend = (chatId, text, kb) => {
    if (chatId) bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  };
  // админам (владелец из .env + все, кого добавили): один текст → всем
  const adminIds = () => {
    const ids = new Set();
    if (OWNER_ID) ids.add(OWNER_ID);
    for (const a of db.allAdmins()) ids.add(a.tg_user_id);
    return [...ids];
  };
  const notifyAdmin = async (text) => {
    for (const id of adminIds()) bot.api.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});
  };

  // мост: engine вызывает captcha.request(chatId, imageB64, login) → Promise<код|null>.
  // Фото уходит юзеру, ожидания капчи копятся в FIFO на чат: первый ответ = первая капча.
  const captchaWaiters = new Map(); // chatId → [waiter]
  engine.captcha.request = (chatId, imageB64, username) =>
    new Promise((resolve) => {
      const list = captchaWaiters.get(chatId) ?? [];
      const w = {
        user: username,
        resolve(code) {
          clearTimeout(w.timer);
          const rest = (captchaWaiters.get(chatId) ?? []).filter((x) => x !== w);
          rest.length ? captchaWaiters.set(chatId, rest) : captchaWaiters.delete(chatId);
          const clean = code && String(code).trim();
          resolve(clean || null);
        },
      };
      w.timer = setTimeout(() => {
        w.resolve(null);
        notifyUser(
          chatId,
          `⏳ ${username}: код капчи не получил за ${CAPTCHA_WAIT_MS / 60000} мин - попробую позже.`
        );
      }, CAPTCHA_WAIT_MS);
      list.push(w);
      captchaWaiters.set(chatId, list);
      console.log(`[bot] капча → chat ${chatId} (${list.length} в очереди)`);
      bot.api
        .sendPhoto(chatId, new InputFile(Buffer.from(imageB64, 'base64')), {
          caption:
            `🧩 Капча для <b>${esc(username)}</b>.\n` +
            `Отправь код одним сообщением (на это ${CAPTCHA_WAIT_MS / 60000} мин).\n` +
            `Не можешь разобрать - жми «🔄 Другая капча».`,
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('🔄 Другая капча', `capregen:${chatId}`),
        })
        .catch(() => w.resolve(null));
    });
  // отмена всех ожиданий капчи конкретного аккаунта (когда юзер остановил его в боте)
  engine.captcha.cancel = (username) => {
    if (!username) return;
    for (const [chatId, list] of captchaWaiters) {
      for (const w of list.filter((x) => x.user === username)) w.resolve(null);
    }
  };

  // -- права: владелец (OWNER_ID из .env / claim) + админы из БД --
  function isOwner(userId) {
    if (userId && userId === OWNER_ID) return true;
    return db.adminRole(userId) === 'owner';
  }
  const isAdmin = (userId) =>
    !userId ? false : isOwner(userId) || db.isAdmin(userId);

  // активирован кодом? (админы и владелец - мимо гейта)
  function isActivated(userId) {
    if (isAdmin(userId)) return true;
    return !!db.inviteUsedBy(userId);
  }

  // если владельца нет нигде (нет OWNER_ID и пусто в БД) - первый, кто вызвал /admin, становится владельцем (claim)
  function claimOwner(ctx) {
    if (OWNER_ID || db.allAdmins().length) return;
    db.addAdmin(ctx.from.id, 'owner', null);
    console.log(`[bot] владелец: claim id ${ctx.from.id}`);
  }

  // -- helpers --
  const MENU = () =>
    new InlineKeyboard()
      .text('➕ Добавить аккаунт', 'add').row()
      .text('📋 Мои аккаунты', 'accs').row()
      .text('🆘 Помощь /help', 'helpbtn');

  // розовый приветственный экран для неактивированных
  const INVITE_PROMPT =
    '🎟 <b>Доступ по приглашению</b>\n\n' +
    'Этот бот работает только по кодам приглашений.\n' +
    'Пришли мне код одним сообщением (или командой <code>/code КОД</code>), и появится меню.\n\n' +
    'Код выдаёт владелец бота.';

  function accText(r) {
    const st = STATUS_RU[r.status] ?? r.status;
    let t = `${esc(st)} - <b>${esc(r.username)}</b>`;
    if (r.balance != null) t += ` - ${fmt(r.balance)} 🪙`;
    t += `\nсегодня: +${fmt(r.earned_today)} 🪙`;
    if (r.status_note && r.status !== S.RUNNING) t += `\n<i>${esc(r.status_note)}</i>`;
    return t;
  }

  function accKeyboard(r) {
    const kb = new InlineKeyboard();
    if (r.status === S.STOPPED) {
      kb.text('▶️ Запустить', `acc:${r.id}:start`).text('🗑', `accdel:${r.id}`);
    } else {
      kb.text('⏸ Остановить', `acc:${r.id}:stop`).text('🗑', `accdel:${r.id}`);
    }
    kb.row().text('🔑 Сменить пароль', `accpw:${r.id}`);
    return kb;
  }

  function accountsMessage(rows) {
    if (!rows.length) {
      return { text: 'Аккаунтов пока нет - добавь первый.', keyboard: MENU() };
    }
    let text = '📋 <b>Мои аккаунты</b>\n\n';
    const kb = new InlineKeyboard();
    for (const r of rows) {
      const st = STATUS_RU[r.status] ?? r.status;
      text += `${st} · <b>${esc(r.username)}</b>` +
        (r.balance != null ? ` · ${fmt(r.balance)} 🪙` : '') +
        `\n<i>сегодня +${fmt(r.earned_today)} 🪙</i>\n\n`;
      if (r.status === S.STOPPED) kb.text(`▶️ ${r.username}`, `acc:${r.id}:start`).text('🗑', `accdel:${r.id}`);
      else kb.text(`⏸ ${r.username}`, `acc:${r.id}:stop`).text('🗑', `accdel:${r.id}`);
      kb.text('🔑', `accpw:${r.id}`).row();
    }
    kb.text('➕ Добавить аккаунт', 'add');
    return { text, keyboard: kb };
  }

  async function sendAccounts(ctx) {
    const rows = db.accountsOfUser(ctx.from.id);
    const { text, keyboard } = accountsMessage(rows);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // запоминаем каждого юзера бота (нужно для /broadcast)
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat?.type === 'private') {
      try { db.upsertUser(ctx.from.id, ctx.chat.id, ctx.from.username, ctx.from.first_name); } catch {}
    }
    return next();
  });

  // -- активация кода приглашения --
  // возвращает { ok, reply } - reply уже отформатирован
  function redeemInvite(rawCode, from) {
    const code = normCode(rawCode);
    if (!code || !INVITE_RE.test(code)) {
      return { ok: false, reply: '❓ Это не похоже на код приглашения.\nКод выглядит примерно так: <code>HUEVO-A2B3C4D5E6</code>. Попробуй ещё раз.' };
    }
    const inv = db.findInvite(code);
    if (!inv) {
      return { ok: false, reply: '🚫 Такой код не найден.\nПроверь код (регистр не важен) и пришли ещё раз.' };
    }
    if (inv.revoked) {
      return { ok: false, reply: '🚫 Этот код отозван владельцем, он не работает.' };
    }
    if (inv.used_at) {
      return { ok: false, reply: '🚫 Этот код уже активирован другим юзером.' };
    }
    const already = db.inviteUsedBy(from.id);
    if (already) {
      return { ok: false, reply: 'Ты уже активирован в боте - повторная активация не нужна.' };
    }
    db.markInviteUsed(inv.code, from.id, from.username ? `@${from.username}` : (from.first_name || ''));
    return { ok: true, reply: null, invite: inv, tgWho: `@${from.username || from.first_name || ''}` };
  }

  function welcomeActivated() {
    return new InlineKeyboard()
      .url('📢 Telegram-канал', COMMUNITY_TG)
      .url('🍀 huevo autofarm', COMMUNITY_FARM);
  }

  async function sendActivatedWelcome(ctx) {
    await ctx.reply(
      '🎟 <b>Код принят - добро пожаловать!</b>\n\n' +
        'Как это работает:\n' +
        '1. <code>/add</code> - добавь логин/пароль своего аккаунта huevo.su\n' +
        '2. Реши капчу прямо в чате (пришлю фото)\n' +
        '3. Ферма фармит твою копилку по правилам сайта 24/7\n\n' +
        'Комиссий нет - всё нафармленное остаётся у тебя.\n\n' +
        '<b>⚠️ Просьба:</b> подпишись на наши сообщества - так мы развиваем сервис:',
      { parse_mode: 'HTML', reply_markup: welcomeActivated() }
    ).catch(() => {});
    return ctx.reply('Меню:', { reply_markup: MENU() });
  }

  async function tryRedeem(ctx, rawCode) {
    const r = redeemInvite(rawCode, ctx.from);
    if (r.ok) {
      const who = ctx.from.username ? `@${ctx.from.username}` : esc(ctx.from.first_name || '');
      notifyAdmin(
        `🎟 Код <b>${invBadge(r.invite)}</b> активирован: <b>${who}</b> <code>${ctx.from.id}</code>`
      );
      return sendActivatedWelcome(ctx);
    }
    return ctx.reply(r.reply, { parse_mode: 'HTML' });
  }

  const invBadge = (inv) =>
    inv ? `<code>${esc(inv.code)}</code>` : '-';

  // -- команды --
  bot.command('start', async (ctx) => {
    // неактивированному даём только гейт: /start <КОД> работает как /code КОД
    const arg = normCode(ctx.message.text.split(/\s+/)[1] || '');
    if (!isActivated(ctx.from?.id)) {
      if (arg) return tryRedeem(ctx, arg);
      return ctx.reply(INVITE_PROMPT, { parse_mode: 'HTML' });
    }
    if (arg) return tryRedeem(ctx, arg); // на всякий случай - лишним не будет
    return ctx.reply(
      '🥚 <b>huevo кликер</b>\n\n' +
        'Добавь аккаунт - бот сам залогинится (капчу решаешь ты) и фармит копилку 24/7.\n' +
        'Комиссий нет - всё нафармленное остаётся у тебя.',
      { parse_mode: 'HTML', reply_markup: MENU() }
    );
  });

  bot.command('code', (ctx) => {
    if (isActivated(ctx.from?.id)) {
      return ctx.reply('Ты уже активирован - код больше не нужен. 🙃', { reply_markup: MENU() });
    }
    const arg = ctx.message.text.split(/\s+/)[1] || '';
    if (arg) return tryRedeem(ctx, arg);
    return ctx.reply('🎟 Пришли код приглашения сообщением: <code>/code HUEVO-A2B3C4D5E6</code> (или просто пришли код).', { parse_mode: 'HTML' });
  });

  bot.command('help', (ctx) => {
    if (!isActivated(ctx.from?.id)) return ctx.reply(INVITE_PROMPT);
    const t =
      '/start - меню\n' +
      '/add - добавить аккаунт\n' +
      '/accounts - мои аккаунты\n' +
      '/cancel - прервать ввод';
    if (isAdmin(ctx.from?.id)) {
      return ctx.reply(t + '\n\n<i>Админ:</i>\n/admin - панель админа\n/broadcast - рассылка всем', { parse_mode: 'HTML' });
    }
    return ctx.reply(t);
  });

  bot.command('add', (ctx) => {
    if (!isActivated(ctx.from?.id)) return ctx.reply(INVITE_PROMPT);
    flows.set(ctx.chat.id, { stage: 'user' });
    return ctx.reply('👤 Логин аккаунта huevo.su: (или /cancel)');
  });
  bot.command('accounts', (ctx) => {
    if (!isActivated(ctx.from?.id)) return ctx.reply(INVITE_PROMPT);
    return sendAccounts(ctx);
  });
  bot.command('cancel', (ctx) => {
    const flow = flows.get(ctx.chat.id);
    flows.delete(ctx.chat.id);
    const ws = captchaWaiters.get(ctx.chat.id);
    if (ws?.length) for (const w of [...ws]) w.resolve(null);
    if (flow || ws?.length) {
      return ctx.reply('❌ Отменено.', {
        reply_markup: flow?.stage?.startsWith('adm') || flow?.stage?.startsWith('bc') ? adminKeyboard(ctx.from.id) : MENU(),
      });
    }
    return ctx.reply('Нечего отменять.', { reply_markup: isActivated(ctx.from?.id) ? MENU() : undefined });
  });

  // -- кнопки-меню --
  bot.callbackQuery('add', async (ctx) => {
    if (!isActivated(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 нужен код приглашения');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'user' });
    await ctx.reply('👤 Логин аккаунта huevo.su: (или /cancel)');
  });
  bot.callbackQuery('accs', async (ctx) => {
    if (!isActivated(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 нужен код приглашения');
    await ctx.answerCallbackQuery().catch(() => {});
    await sendAccounts(ctx);
  });
  bot.callbackQuery('helpbtn', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(
      '🆘 <b>Что может бот</b>\n\n' +
        '• <b>/add</b> - добавить аккаунт huevo.su (логин → пароль → капча)\n' +
        '• <b>/accounts</b> - список аккаунтов: статус, баланс, запуск/остановка\n' +
        '• Капча решается прямо в чате: присылаю фото, ты отвечаешь кодом\n' +
        '• Если сессию выкинуло - приду с кнопкой «Перелогиниться»\n' +
        '• <b>/cancel</b> - прервать ожидание ввода',
      { parse_mode: 'HTML' }
    );
  });

  // старт/стоп/удаление аккаунта (только владелец учётки)
  bot.callbackQuery(/^acc:(\d+):(start|stop)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const action = ctx.match[2];
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    if (action === 'stop') {
      if (row.status !== S.STOPPED) {
        await engine.stop(id, true);
        notifyUser(row.tg_chat_id, `⏸ ${row.username}: кликер остановлен.`);
      }
    } else if (row.status === S.STOPPED) {
      engine.start(id, row);
    }
    const fresh = db.getAccount(id);
    await ctx.reply(accText(fresh), { parse_mode: 'HTML', reply_markup: accKeyboard(fresh) });
  });

  bot.callbackQuery(/^accdel:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(`🗑 Удалить <b>${esc(row.username)}</b>? Клики прекратятся, данные сотрутся.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('✅ Удалить', `accdel:${id}:yes`).text('❌ Оставить', 'accs'),
    });
  });

  bot.callbackQuery(/^accdel:(\d+):yes$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    await engine.remove(id);
    await ctx.reply(`🗑 ${row.username}: удалён.`, { reply_markup: MENU() });
  });

  // -- смена пароля аккаунта --
  bot.callbackQuery(/^accpw:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'pw', accId: id });
    await ctx.reply(`🔐 Новый пароль для <b>${esc(row.username)}</b>: (или /cancel)`, { parse_mode: 'HTML' });
  });

  // -- приём капчи + диалоги ввода (текст) --
  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const t = ctx.message.text.trim();

    // 1) жду код капчи - первый ответивший текст в чате уходит первому в очереди
    const waiters = captchaWaiters.get(chatId);
    if (waiters?.length) {
      console.log(`[bot] код принят от chat ${chatId} (в очереди капч: ${waiters.length})`);
      waiters[0].resolve(t);
      return;
    }

    // 2) неактивированный юзер: любой текст считаем попыткой ввести код приглашения
    if (!isActivated(ctx.from?.id)) {
      if (t.startsWith('/')) return next(); // команды обрабатываются выше
      return tryRedeem(ctx, t);
    }

    const flow = flows.get(chatId);
    if (!flow) return next();

    if (flow.stage === 'adm-addadmin') {
      flows.delete(chatId);
      if (!isOwner(ctx.from?.id)) {
        return ctx.reply('🚫 Добавлять админов может только владелец бота.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      const n = Number(t.replace(/[^\d]/g, ''));
      if (!n || n < 1000) {
        return ctx.reply('Нужен числовой Telegram ID (например 123456789). Ещё раз или /cancel.', {
          reply_markup: adminKeyboard(ctx.from.id),
        });
      }
      db.addAdmin(n, 'admin', ctx.from.id);
      notifyAdmin(`👥 Новый админ добавлен: <code>${n}</code> (кем: ${ctx.from.id})`);
      return ctx.reply(`✅ Админ <code>${n}</code> добавлен.`, {
        parse_mode: 'HTML',
        reply_markup: adminKeyboard(ctx.from.id),
      });
    }

    if (flow.stage === 'inv-custom') {
      flows.delete(chatId);
      if (!isOwner(ctx.from?.id)) {
        return ctx.reply('🚫 Коды создаёт только владелец бота.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      const code = normCode(t);
      if (!INVITE_RE.test(code)) {
        return ctx.reply('Код: 4-32 символа, латиница/цифры/дефис. Ещё раз или /cancel.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      if (!db.addInvite(code, ctx.from.id)) {
        return ctx.reply('🚫 Такой код уже есть. Другой или /cancel.', { reply_markup: adminKeyboard(ctx.from.id) });
      }
      notifyAdmin(`🎟 Создан код <code>${esc(code)}</code> (кем: ${ctx.from.id})`);
      return ctx.reply(`✅ Код <code>${esc(code)}</code> создан. Отправь его нужному юзеру.\n\n<i>Активация: юзер шлёт код боту вместе с <code>/start</code> или просто сообщением.</i>`, {
        parse_mode: 'HTML',
        reply_markup: codesKeyboard(6),
      });
    }

    // -- рассылка: текст сообщения и подтверждение --
    if (flow.stage === 'bc-text') {
      flows.delete(chatId);
      return startBroadcast(ctx, t);
    }

    if (flow.stage === 'pw') {
      if (t.length < 3) return ctx.reply('Подозрительно короткий пароль. Ещё раз или /cancel.');
      const accId = flow.accId;
      const row = db.getAccountForUser(ctx.from.id, accId);
      if (!row) { flows.delete(chatId); return ctx.reply('🚫 Аккаунт не найден.', { reply_markup: MENU() }); }
      flows.delete(chatId);
      db.changePassword(accId, t);
      notifyAdmin(`🔑 Сменён пароль аккаунта @${row.username} (юзер ${ctx.from.id})`);
      if (row.status === S.STOPPED) {
        return ctx.reply(`✅ Пароль для <b>${esc(row.username)}</b> обновлён.\nЗапусти аккаунт: «Мои аккаунты» → ▶️.`, {
          parse_mode: 'HTML',
        });
      }
      // аккаунт жив - пересоздаём ферму и сразу логинимся с новым паролем
      await engine.stop(accId, false);
      engine.start(accId, null, { earlyLogin: true });
      return ctx.reply(`✅ Пароль для <b>${esc(row.username)}</b> обновлён.\nПробую войти с новым паролем - скоро пришлю капчу.`, {
        parse_mode: 'HTML',
      });
    }

    if (flow.stage === 'user') {
      if (!/^[A-Za-z0-9_.\-]{2,50}$/.test(t)) {
        return ctx.reply('Логин странноватый (буквы/цифры/._-). Ещё раз или /cancel.');
      }
      if (db.findAccountByUsername(t)) {
        return ctx.reply('🚫 Такой аккаунт уже есть в системе. Другой логин или /cancel.');
      }
      flow.login = t;
      flow.stage = 'pass';
      return ctx.reply(`🔐 Пароль для <b>${esc(t)}</b>: (или /cancel)`, { parse_mode: 'HTML' });
    }

    if (flow.stage === 'pass') {
      if (t.length < 3) return ctx.reply('Подозрительно короткий пароль. Ещё раз или /cancel.');
      const accId = db.addAccount(ctx.from.id, chatId, flow.login, t);
      flows.delete(chatId);
      if (accId == null) {
        return ctx.reply('🚫 Кто-то уже добавил такой аккаунт. /accounts', { reply_markup: MENU() });
      }
      await ctx.reply(`✅ <b>${esc(flow.login)}</b> добавлен.\n📋 Начинаю вход - скоро пришлю капчу.`, {
        parse_mode: 'HTML',
      });
      engine.start(accId, null, { earlyLogin: true });
      return;
    }

    return next();
  });

  // (обработчик без next() ломал бы команды ниже по цепочке - поэтому везде next())

  // ================= АДМИНКА =================
  // владелец: коды приглашений + статистика + рассылка + админы
  const adminKeyboard = (viewerId = 0) => {
    const nAdmins = adminIds().length;
    const inv = db.inviteStats();
    const kb = new InlineKeyboard();
    if (isOwner(viewerId)) {
      kb.text(`🎟 Коды: ${inv.free} свободно`, 'adm:codes').row();
    }
    kb.text('📊 Все аккаунты', 'adm:stats').row()
      .text('📢 Рассылка', 'adm:broadcast')
      .text(`👥 Админы (${nAdmins})`, 'adm:admins');
    return kb;
  };

  function adminText() {
    const inv = db.inviteStats();
    return (
      '🛠 <b>Админ-панель</b>\n' +
      `Коды приглашений: 🟩 свободно <b>${inv.free}</b> · ✅ активировано <b>${inv.used}</b>` +
      (inv.revoked ? ` · 🚫 отозвано <b>${inv.revoked}</b>` : '') + '\n' +
      `Аккаунтов в системе: ${db.allAccounts().length} (активных: ${db.activeAccountsCount()})\n` +
      `Юзеров в боте: ${db.usersCount()} · админов: ${adminIds().length}`
    );
  }

  bot.command('admin', (ctx) => {
    claimOwner(ctx);
    if (!isAdmin(ctx.from?.id)) {
      const hint = OWNER_ID
        ? `В .env задан OWNER_ID=${OWNER_ID} (или ADMIN_ID), а твой Telegram id: <code>${ctx.from?.id}</code>.`
        : 'Владелец не задан - попроси админа добавить тебя: /adminadd <твой id>.';
      return ctx.reply(`🚫 Только для админов.\n${hint}\nПоправь .env и перезапусти бота.`, { parse_mode: 'HTML' });
    }
    return ctx.reply(adminWhichText(ctx.from.id), { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });
  function adminWhichText(id) {
    const base = adminText();
    const role = isOwner(id) ? 'владелец' : 'админ';
    return `${base}\nМоя роль: <b>${role}</b>`;
  }

  // -- мульти-админка: /adminadd, /admindel, /admins --
  bot.command('adminadd', (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.reply('🚫 Добавлять админов может только владелец бота.');
    const ids = (ctx.message.text.split(/\s+/).slice(1) || [])
      .map((x) => Number(x.replace(/[^\d]/g, '')))
      .filter((n) => n >= 1000);
    if (!ids.length) return ctx.reply('Формат: <code>/adminadd 123456789</code> (можно несколько через пробел).', { parse_mode: 'HTML' });
    const lines = [];
    for (const id of ids) {
      db.addAdmin(id, 'admin', ctx.from.id);
      notifyAdmin(`👥 Новый админ добавлен: <code>${id}</code> (кем: ${ctx.from.id})`);
      lines.push(`✅ <code>${id}</code> - добавлен`);
    }
    return ctx.reply(`👥 Админы обновлены:\n${lines.join('\n')}`, { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.command('admindel', (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.reply('🚫 Удалять админов может только владелец бота.');
    const ids = (ctx.message.text.split(/\s+/).slice(1) || [])
      .map((x) => Number(x.replace(/[^\d]/g, '')))
      .filter((n) => n >= 1000);
    if (!ids.length) return ctx.reply('Формат: <code>/admindel 123456789</code> (можно несколько через пробел).', { parse_mode: 'HTML' });
    const lines = [];
    for (const id of ids) {
      if (id === OWNER_ID) {
        lines.push(`🚫 <code>${id}</code> - владелец из .env, не удаляется через бота`);
        continue;
      }
      if (db.adminRole(id) === 'owner') {
        lines.push(`🚫 <code>${id}</code> - владелец (claim), через бота не удаляется`);
        continue;
      }
      if (!db.isAdmin(id)) {
        lines.push(`- <code>${id}</code> - и так не админ`);
        continue;
      }
      db.removeAdmin(id);
      lines.push(`🗑 <code>${id}</code> - убран`);
    }
    return ctx.reply(`👥 Админы обновлены:\n${lines.join('\n')}`, { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.command('admins', (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('🚫 Только для админов.');
    return ctx.reply(adminsText(), { parse_mode: 'HTML', reply_markup: adminsKeyboard(ctx.from.id) });
  });

  function adminsText() {
    let t = '👥 <b>Админы бота</b>\n\n';
    if (OWNER_ID) t += `👑 <b>Владелец (.env OWNER_ID)</b>: <code>${OWNER_ID}</code>\n`;
    const claim = db.allAdmins().find((a) => a.role === 'owner');
    if (claim && claim.tg_user_id !== OWNER_ID) t += `👑 <b>Владелец (claim)</b>: <code>${claim.tg_user_id}</code>\n`;
    for (const a of db.allAdmins().filter((x) => x.role !== 'owner')) {
      t += `• <code>${a.tg_user_id}</code>${a.added_by ? ` (добавил ${a.added_by})` : ''}\n`;
    }
    t += `\nВсего админов: <b>${adminIds().length}</b>`;
    return t;
  }
  function adminsKeyboard(viewerId) {
    const kb = new InlineKeyboard();
    if (isOwner(viewerId)) {
      kb.text('➕ Добавить админа', 'adm:addadmin');
      for (const a of db.allAdmins().filter((x) => x.role === 'admin')) {
        kb.row().text(`🗑 ${a.tg_user_id}`, `admdel:${a.tg_user_id}`);
      }
      kb.row();
    }
    kb.text('⬅️ Назад', 'adm:panel');
    return kb;
  }

  // ================= КОДЫ ПРИГЛАШЕНИЙ =================
  // текстовая сводка + список последних 20 кодов
  function codesText() {
    const inv = db.inviteStats();
    const rows = db.listInvites(20);
    let t =
      `🎟 <b>Коды приглашений</b>\n` +
      `Свободно: <b>${inv.free}</b> · активировано: <b>${inv.used}</b>` +
      (inv.revoked ? ` · отозвано: <b>${inv.revoked}</b>` : '') + '\n\n';
    if (!rows.length) t += '- кодов ещё нет - создай первый кнопкой ниже -\n';
    for (const r of rows) {
      if (r.used_at) {
        t += `✅ <code>${esc(r.code)}</code> · <b>${esc(r.used_by_username || r.used_by)}</b> · ${dt(r.used_at)}\n`;
      } else if (r.revoked) {
        t += `🚫 <code>${esc(r.code)}</code> · отозван · создан ${dt(r.created_at)}\n`;
      } else {
        t += `🟩 <code>${esc(r.code)}</code> · свободен · создан ${dt(r.created_at)}\n`;
      }
    }
    if (inv.free + inv.used + inv.revoked > rows.length) t += '\n<i>... показаны последние 20</i>';
    t += '\n<i>Юзер активирует код: шлёт его боту сообщением или /start КОД</i>';
    return t;
  }

  function codesKeyboard(tail = 0) {
    const kb = new InlineKeyboard()
      .text('🎲 Сгенерировать код', 'inv:new')
      .text('✍️ Свой код', 'inv:custom')
      .row();
    // кнопки для свободных кодов - кнопка = отзыв кода
    const free = db.listInvites(50).filter((r) => !r.used_at && !r.revoked).slice(0, tail);
    if (free.length) {
      for (const r of free) kb.text(`🚫 ${r.code}`, `inv:rev:${r.code}`);
      kb.row();
    }
    kb.text('⬅️ Назад', 'adm:panel');
    return kb;
  }

  function codesPanelHeader() { return codesText(); }

  bot.callbackQuery('adm:codes', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(codesPanelHeader(), { parse_mode: 'HTML', reply_markup: codesKeyboard(10) });
  });

  bot.callbackQuery('inv:new', async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    await ctx.answerCallbackQuery('Код создан').catch(() => {});
    let code = randomInviteCode();
    let guard = 0;
    while (!db.addInvite(code, ctx.from.id) && guard++ < 5) code = randomInviteCode();
    notifyAdmin(`🎟 Создан код <code>${esc(code)}</code> (кем: ${ctx.from.id})`);
    await ctx.reply(
      `✅ Код <code>${esc(code)}</code> создан. Отправь его юзеру.\n\n<i>Юзер шлёт этот код боту сообщением (или /start ${code}) - и получает доступ.</i>`,
      { parse_mode: 'HTML', reply_markup: codesKeyboard(10) }
    );
  });

  bot.callbackQuery('inv:custom', async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'inv-custom' });
    await ctx.reply('✍️ Текст кода (4-32 символа: латиница/цифры/дефис), например <code>HUEVO-VASYA</code>: (или /cancel)', { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^inv:rev:(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    const code = ctx.match[1];
    const inv = db.findInvite(code);
    if (!inv) return ctx.answerCallbackQuery('код не найден');
    if (inv.used_at) return ctx.answerCallbackQuery('уже активирован - отзывать поздно');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(`🚫 Отозвать код <code>${esc(inv.code)}</code>? Юзер больше не сможет его активировать.`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Отозвать', `inv:revyes:${inv.code}`)
        .text('❌ Оставить', 'adm:codes'),
    });
  });

  bot.callbackQuery(/^inv:revyes:(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    const code = ctx.match[1];
    await ctx.answerCallbackQuery('Отозван').catch(() => {});
    db.revokeInvite(code);
    notifyAdmin(`🚫 Код отозван: <code>${esc(code)}</code> (кем: ${ctx.from.id})`);
    await ctx.reply(`🚫 Код <code>${esc(code)}</code> отозван.`, {
      parse_mode: 'HTML',
      reply_markup: codesKeyboard(10),
    });
  });

  // -- рассылка /broadcast --
  bot.command('broadcast', (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('🚫 Только для админов.');
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (arg) return startBroadcast(ctx, arg);
    flows.set(ctx.chat.id, { stage: 'bc-text' });
    return ctx.reply(
      '📢 Что разослать всем юзерам бота?\n\n' +
        'Можно HTML: <code>&lt;b&gt;жирный&lt;/b&gt;</code>, <code>&lt;i&gt;курсив&lt;/i&gt;</code>, <code>&lt;a href="..."&gt;ссылка&lt;/a&gt;</code>.\n' +
        '(/cancel - отмена)',
      { parse_mode: 'HTML' }
    );
  });

  async function startBroadcast(ctx, text) {
    const targets = db.broadcastTargets();
    if (!targets.length) return ctx.reply('Бот пустой - рассылать некому.', { reply_markup: adminKeyboard(ctx.from.id) });
    flows.set(ctx.chat.id, { stage: 'bc-confirm', bcText: text });
    await ctx.reply(`📢 <b>Предпросмотр рассылки</b> (получателей: ${targets.length}):\n\n${esc(text).slice(0, 3500)}`, {
      parse_mode: 'HTML',
    });
    return ctx.reply('Отправляем?', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Отправить всем', 'bc:yes')
        .text('❌ Отмена', 'bc:no'),
    });
  }

  async function runBroadcast(notifyChat, text) {
    const targets = db.broadcastTargets();
    let sent = 0, failed = 0;
    const parseErr = /pars|entit|can't parse entities/i;
    for (const chatId of targets) {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        sent++;
      } catch (e) {
        const msg = String(e?.message || e);
        if (parseErr.test(msg)) {
          // HTML не понравился Telegram - пробуем тот же текст как plain text
          try { await bot.api.sendMessage(chatId, text); sent++; } catch { failed++; }
        } else {
          failed++; // юзер заблокировал бота / чат недоступен
        }
      }
      await sleep(BROADCAST_DELAY_MS); // ~18 msg/s < лимита Telegram 30 msg/s
    }
    const report = `📢 Рассылка завершена.\nПолучателей: ${targets.length}\n✅ доставлено: ${sent}\n❌ не доставлено: ${failed}`;
    console.log(`[bot] broadcast: ${sent}/${targets.length} ok`);
    notifyUser(notifyChat, report);
    return { sent, failed, total: targets.length };
  }

  bot.callbackQuery('adm:broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'bc-text' });
    await ctx.reply(
      '📢 Что разослать всем юзерам бота?\n\n' +
        'Можно HTML: <code>&lt;b&gt;жирный&lt;/b&gt;</code>.\n' +
        '(/cancel - отмена)',
      { parse_mode: 'HTML' }
    );
  });

  bot.callbackQuery('adm:addadmin', async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    await ctx.answerCallbackQuery().catch(() => {});
    flows.set(ctx.chat.id, { stage: 'adm-addadmin' });
    await ctx.reply('👥 Telegram ID нового админа (например 123456789): (или /cancel)');
  });

  bot.callbackQuery(/^admdel:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) return ctx.answerCallbackQuery('🚫 только владелец');
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery().catch(() => {});
    db.removeAdmin(id);
    notifyAdmin(`👥 Админ убран: <code>${id}</code> (кем: ${ctx.from.id})`);
    await ctx.reply(`🗑 <code>${id}</code> - убран из админов.`, {
      parse_mode: 'HTML',
      reply_markup: adminsKeyboard(ctx.from.id),
    });
  });

  bot.callbackQuery('bc:yes', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    const flow = flows.get(ctx.chat.id);
    if (flow?.stage !== 'bc-confirm' || !flow.bcText) {
      await ctx.answerCallbackQuery('Нечего отправлять - сначала /broadcast').catch(() => {});
      return;
    }
    flows.delete(ctx.chat.id);
    await ctx.answerCallbackQuery('Запускаю рассылку...').catch(() => {});
    const msg = await ctx.reply('⏳ Рассылка пошла...', { reply_markup: new InlineKeyboard() });
    await runBroadcast(ctx.chat.id, flow.bcText);
    try { await bot.api.deleteMessage(ctx.chat.id, msg.message_id); } catch {}
    await ctx.reply('Готово.', { reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('bc:no', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    flows.delete(ctx.chat.id);
    await ctx.answerCallbackQuery('Отменено').catch(() => {});
    await ctx.reply('❌ Рассылка отменена.', { reply_markup: adminKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('adm:stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    const rows = db.allAccounts();
    let t = '📊 <b>Все аккаунты</b>\n\n';
    if (!rows.length) t += '- пусто -';
    const kb = new InlineKeyboard();
    for (const r of rows) t += accText(r) + '\n\n';
    kb.text('🎟 Коды', 'adm:codes').row().text('⬅️ Назад', 'adm:panel');
    await ctx.reply(t, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.callbackQuery('adm:admins', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(adminsText(), { parse_mode: 'HTML', reply_markup: adminsKeyboard(ctx.from.id) });
  });

  bot.callbackQuery('adm:panel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCallbackQuery('🚫');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(adminWhichText(ctx.from.id), { parse_mode: 'HTML', reply_markup: adminKeyboard(ctx.from.id) });
  });

  // -- кнопка «🔑 Перелогиниться» (шлёт её engine, код relog:<accountId>) --
  // ВАЖНО: не await-им логин внутри обработчика! grammY обрабатывает апдейты
  // последовательно, а логин ждёт код капчи следующим апдейтом - иначе дедлок.
  bot.callbackQuery(/^relog:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const row = db.getAccountForUser(ctx.from.id, id);
    if (!row) return ctx.answerCallbackQuery('🚫 не найден');
    const busy = engine.farms.get(id)?.loggingNow;
    await ctx.answerCallbackQuery(busy ? 'Вход уже идёт, жди капчу.' : 'Запрашиваю страницу входа...').catch(() => {});
    engine.relogin(id)
      .then((r) => {
        // успех уже присылает сам engine («✅ вход выполнен») - не дублируем
        if (!r.ok && r.why === 'аккаунт не запущен') {
          notifyUser(row.tg_chat_id, `⏸ ${row.username}: аккаунт остановлен - сначала запусти его («Мои аккаунты» → ▶️).`);
        } else if (!r.ok && r.why !== 'вход уже идёт') {
          notifyUser(row.tg_chat_id, `❌ ${row.username}: ${r.why}. Нажми «🔑 Перелогиниться» ещё раз.`);
        }
      })
      .catch((e) => {
        console.error('[relog]', e?.stack || e);
        notifyUser(row.tg_chat_id, `❌ ${row.username}: внутренняя ошибка входа. Нажми кнопку ещё раз.`);
      });
  });

  // кнопка «🔄 Другая капча»: последнюю ждущую капчу перезапрашиваем на новую картинку
  bot.callbackQuery(/^capregen:(-?\d+)$/, async (ctx) => {
    const chatId = Number(ctx.match[1]);
    if (ctx.from.id !== chatId) return ctx.answerCallbackQuery('🚫');
    const list = captchaWaiters.get(chatId);
    if (!list?.length) return ctx.answerCallbackQuery('Капча не запрошена.');
    await ctx.answerCallbackQuery('Шлю новую капчу...').catch(() => {});
    list[list.length - 1].resolve('__regen__');
  });

  // неизвестные кнопки
  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery().catch(() => {}));

  // ошибки бота
  bot.catch((err) => console.error('[bot]', err.error?.stack || err.error || err));

  return { bot, notifyUser, notifyAdmin, notifySend, adminIds };
}
