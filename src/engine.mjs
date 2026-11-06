// engine.mjs - ферма: по каждому аккаунту крутится асинхронный цикл
//   сессия жива? → клик → пауза. Без комиссий - весь фарм остаётся клиенту.
// Логины сериализуются глобальным мьютексом (один IP - лимит неудачных попыток).
import {
  Account,
  LoginLockError,
  CaptchaTimeoutError,
} from './site.mjs';
import { InlineKeyboard } from 'grammy';
import { S } from './db.mjs';
import {
  CLICK_BATCH, CAPPED_WAIT_MS,
  CAPTCHA_WAIT_MS,
} from './config.mjs';

const ts = () => new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false });
const stamp = (s) => console.log(`[${ts()}] [${s}]`);

export class Engine {
  /**
   * @param db        Db
   * @param captchaBridge { request(chatId, imageB64, login): Promise<string|null>, cancel?(login) }
   * @param notify    { toUser(chatId, text), toAdmin(text), send?(chatId, text, kb) - HTML + клавиатура }
   */
  constructor(db, captchaBridge, notify) {
    this.db = db;
    this.captcha = captchaBridge;
    this.notify = notify;
    this.farms = new Map(); // accountId → { stopped, task, acc, deferLogin, earlyLogin, needLogin, lastNeedNotifyAt, loggingNow, wake }
    this.loginChain = Promise.resolve(); // простой сериализатор логинов
  }

  // -- управление фермами --
  // после рестарта бота не дёргаем юзеров капчей: если сессия мертва - присылаем кнопку «Перелогиниться»
  startAll() {
    for (const row of this.db.allAccounts()) {
      if (row.status !== S.STOPPED) this.start(row.id, row, { deferLogin: true });
    }
  }

  start(accountId, row = null, { deferLogin = false, earlyLogin = false } = {}) {
    if (this.farms.has(accountId)) return;
    const rec = row ?? this.db.getAccount(accountId);
    if (!rec) return;
    this.db.setStatus(accountId, S.RUNNING, '');
    const farm = {
      stopped: false, task: null, acc: null, wake: null,
      deferLogin,      // после рестарта: авто-логин запрещён, ждём кнопку юзера
      earlyLogin,      // только что добавленный аккаунт: юзер рядом, можно сразу спросить капчу
      needLogin: false,      // сессия мертва, ждём перелогин через кнопку
      needCreds: false,      // логин/пароль неверны - ждём смены пароля
      lastNeedNotifyAt: 0,   // когда последний раз присылали кнопку (троттлинг)
      loggingNow: false,     // прямо сейчас идёт вход (по кнопке)
    };
    this.farms.set(accountId, farm);
    farm.task = this.#runFarm(farm, rec).catch((e) =>
      stamp(`farm ${rec.username}: фатально ${e?.stack || e}`));
  }

  async stop(accountId, markStopped = true) {
    const rec = this.db.getAccount(accountId);
    const farm = this.farms.get(accountId);
    if (farm) {
      farm.stopped = true;
      try { farm.wake?.(); } catch {}
    }
    // если ждали код капчи - отменяем ожидание, тогда farm.task завершится сразу
    try { this.captcha.cancel?.(rec?.username); } catch {}
    if (markStopped && rec) this.db.setStatus(accountId, S.STOPPED, '');
    if (farm?.task) {
      // обычно таска завершается быстро (wake + отменённая капча), но не ждём вечно
      await Promise.race([
        farm.task.catch(() => {}),
        new Promise((r) => setTimeout(r, 10_000)),
      ]);
    }
    this.farms.delete(accountId);
    if (markStopped) stamp(`${rec?.username}: остановлен`);
  }

  async remove(accountId) {
    const rec = this.db.getAccount(accountId);
    await this.stop(accountId, false);
    this.db.deleteAccount(accountId);
    if (rec) stamp(`${rec.username}: удалён`);
  }

  /** прерываемая пауза: stop() поднимает farm.wake и цикл выходит сразу */
  #park(farm, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        farm.wake = null;
        resolve();
      }, ms);
      farm.wake = () => {
        clearTimeout(timer);
        farm.wake = null;
        resolve();
      };
    });
  }

  async #runFarm(farm, rec) {
    const { id, username } = rec;
    if (!farm.acc) farm.acc = this.#makeAccount(rec);
    const acc = farm.acc;
    let netFails = 0;

    while (!farm.stopped) {
      const row = this.db.getAccount(id);
      if (!row) return; // удалён

      // неверные данные учётки - молчим, пока юзер не сменит пароль
      if (farm.needCreds) { await this.#park(farm, 60_000); continue; }

      try {
        // ---- сессия ----
        if (!(await acc.sessionAlive())) {
          // вход запущен по кнопке - тихо ждём, farm-цикл не мешает
          if (farm.loggingNow) { await this.#park(farm, 30_000); continue; }

          // сразу после добавления аккаунта юзер рядом - честно пробуем войти без кнопки
          if (farm.earlyLogin) {
            farm.earlyLogin = false;
            const okNew = await this.#loginWithBackoff(farm, id, username);
            if (!okNew) {
              farm.needLogin = true;
              this.#notifyNeedLogin(farm, id, username, true);
              await this.#park(farm, 30_000);
            }
            continue;
          }

          // выкинуло / перезапуск: уведомляем юзера кнопкой и ждём перелогин
          this.#notifyNeedLogin(farm, id, username);
          this.db.setStatus(id, S.NEED_LOGIN, 'нужен вход с капчей');
          await this.#park(farm, 5 * 60_000); // раз в 5 минут проверяем, не перелогинился ли
          continue;
        }
        if (farm.stopped) return;

        // сессия жива - сбрасываем «нужен перелогин»
        if (farm.needLogin || farm.deferLogin) {
          farm.needLogin = false;
          farm.deferLogin = false;
        }

        // ---- клик ----
        const j = await acc.click(CLICK_BATCH);
        netFails = 0;
        this.db.setStatus(id, S.RUNNING, '');

        if (j?.ok === true) {
          this.db.updateBalance(id, j.balance ?? null, 1, 0);
          this.db.addEarned(id, Number(j.earned ?? 0));

          const slightly = 400 + Math.floor(Math.random() * 1500);
          await this.#park(farm, slightly); // небольшой джиттер поверх MIN_GAP 8с внутри click()
          continue;
        }

        if (j?.capped) {
          this.db.updateBalance(id, j.balance ?? null, 0, 1);
          this.db.setStatus(id, S.CAPPED, j.balance_text ?? '');
          stamp(`${username}: дневной кап - до сброса (${j.balance_text ?? ''})`);
          await this.#park(farm, CAPPED_WAIT_MS);
          continue;
        }

        if (j?.__http === 401 || j?.__http === 403) {
          this.db.updateBalance(id, null, 0, 1);
          stamp(`${username}: HTTP ${j.__http} - перелогин`);
          acc.clearCookies();
          await this.#park(farm, 3000);
          continue;
        }

        const wait = Number(j?.retry) || 10;
        this.db.updateBalance(id, null, 0, 1);
        stamp(`${username}: ${j?.error || `HTTP ${j?.__http}`} → ждём ${wait}с`);
        await this.#park(farm, (wait + 1) * 1000);
      } catch (e) {
        if (e instanceof LoginLockError) {
          this.db.setStatus(id, S.LOCKED, e.message);
          stamp(`${username}: ${e.message}`);
          await this.#park(farm, (e.seconds + 10) * 1000);
          continue;
        }
        netFails++;
        this.db.updateBalance(id, null, 0, 1);
        stamp(`${username}: сеть/ошибка: ${e.message} (серия ${netFails})`);
        if (netFails >= 3) {
          this.db.setStatus(id, S.ERROR, `сеть: ${e.message}`);
          if (netFails === 3) {
            this.notify.toUser(this.db.getAccount(id)?.tg_chat_id,
              `⚠️ ${username}: проблемы с сетью/сайтом, продолжаю пробовать.`);
          }
          await this.#park(farm, 60_000);
          continue;
        }
        await this.#park(farm, 15_000);
      }
    }
  }

  #makeAccount(rec) {
    return new Account({
      login: rec.username,
      pass: rec.password,
      log: (line) => stamp(`${rec.username}: ${line}`),
      loadCookies: () => {
        const row = this.db.getAccount(rec.id);
        try { return JSON.parse(row?.cookies ?? '[]'); } catch { return []; }
      },
      saveCookies: (raw) => this.db.saveCookies(rec.id, raw),
      getCaptchaCode: ({ image }) =>
        this.captcha.request(rec.tg_chat_id, image, rec.username),
    });
  }

  // -- «нужен перелогин»: кнопка юзеру; force=true - после неудачной попытки входа --
  #notifyNeedLogin(farm, id, username, force = false) {
    const now = Date.now();
    if (!force && farm.lastNeedNotifyAt && now - farm.lastNeedNotifyAt < 25 * 60_000) return;
    farm.lastNeedNotifyAt = now;
    const row = this.db.getAccount(id);
    if (!row) return;
    this.db.setStatus(id, S.NEED_LOGIN, 'нужен вход с капчей');
    stamp(`${username}: сессия мертва - жду перелогин по кнопке`);
    const kb = new InlineKeyboard().text('🔑 Перелогиниться', `relog:${id}`);
    this.notify.send?.(
      row.tg_chat_id,
      `🔐 <b>${username}</b>: сессия умерла, нужен вход с капчей.\nНажми кнопку - пришлю капчу.`,
      kb
    );
  }

  // вход по кнопке юзера (юзер точно на месте - можно спрашивать капчу)
  async relogin(accountId) {
    const row = this.db.getAccount(accountId);
    const farm = this.farms.get(accountId);
    if (!row || !farm || farm.stopped) {
      stamp(`relog ${row?.username ?? accountId}: аккаунт не запущен`);
      return { ok: false, why: 'аккаунт не запущен' };
    }
    if (farm.loggingNow) {
      stamp(`${row.username}: relog - вход уже идёт`);
      return { ok: false, why: 'вход уже идёт' };
    }
    if (farm.needCreds) {
      stamp(`${row.username}: relog - данные неверны, нужна смена пароля`);
      return { ok: false, why: 'неверный логин или пароль - сначала смени пароль через меню аккаунта' };
    }
    stamp(`${row.username}: relog - начинаю вход по кнопке`);
    const ok = await this.#loginWithBackoff(farm, accountId, row.username);
    if (ok) {
      farm.needLogin = false;
      farm.deferLogin = false;
      farm.lastNeedNotifyAt = 0;
    } else {
      farm.needLogin = true;
      // сразу новая кнопка: юзер может попробовать ещё раз
      this.#notifyNeedLogin(farm, accountId, row.username, true);
    }
    const why = ok ? '' : (farm.loginLastWhy || 'вход не удался (см. сообщения выше)');
    stamp(`${row.username}: relog - завершён, результат: ${ok ? 'ok' : `fail: ${why}`}`);
    return { ok, why };
  }

  // вход с ретраями (юзер присутствует: кнопка / только что добавил аккаунт)
  async #loginWithBackoff(farm, id, username, baseAttempt = 0) {
    farm.loggingNow = true;
    try {
      return await this.#loginAttemptLoop(farm, id, username, baseAttempt);
    } finally {
      farm.loggingNow = false;
    }
  }

  async #loginAttemptLoop(farm, id, username, baseAttempt = 0) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (farm.stopped) return false;
      const n = baseAttempt + attempt;
      this.db.setStatus(id, S.LOGGING, `вход, попытка ${n}`);
      try {
        this.db.setStatus(id, S.LOGGING, `страница логина (попытка ${n})`);
        const got = await farm.acc.fetchLoginForm();
        let dataK = got.dataK;
        let cap = got.cap;

        // спрашиваем код; юзер может попросить другую капчу кнопкой «🔄 Другая капча»
        let code = null;
        for (;;) {
          this.db.setStatus(id, S.WAITING_CAPTCHA, 'жду код капчи');
          const chatId = await this.#chatId(id);
          code = await this.captcha.request(chatId, cap.base64, username);
          if (farm.stopped) return false;
          if (code === '__regen__') {
            stamp(`${username}: юзер запросил новую капчу`);
            const fresh = await farm.acc.fetchLoginForm();
            dataK = fresh.dataK;
            cap = fresh.cap;
            continue;
          }
          break;
        }
        if (!code) { // юзер не ответил - кнопка «Перелогиниться» уже есть в чате
          stamp(`${username}: код капчи так и не пришёл (${CAPTCHA_WAIT_MS / 60000} мин)`);
          this.db.setStatus(id, S.NEED_LOGIN, 'код капчи не получен');
          return false;
        }
        stamp(`${username}: код капчи принят («${code}») - отправляю логин`);

        // POST логина - под мьютексом
        this.db.setStatus(id, S.LOGGING, 'отправляю логин');
        const prev = this.loginChain;
        let release;
        this.loginChain = new Promise((r) => (release = r));
        await prev;
        let res;
        try {
          await this.#park(farm, 2000 + Math.floor(Math.random() * 3000)); // разносим логины
          res = await farm.acc.attemptLogin({ dataK, cap, code });
        } finally {
          release();
        }

        if (res.badCreds) {
          // сервер подтвердил: login/password неверны - ретраить бессмысленно
          farm.needCreds = true;
          this.db.setStatus(id, S.ERROR, 'неверный логин или пароль');
          farm.loginLastWhy = res.why;
          stamp(`${username}: НЕВЕРНЫЙ ЛОГИН ИЛИ ПАРОЛЬ - жду смены пароля`);
          const kb = new InlineKeyboard().text('🔑 Сменить пароль', `accpw:${id}`);
          this.notify.send?.(
            await this.#chatId(id),
            `⛔ <b>${username}</b>: неверный логин или пароль.\n` +
              `Проверь данные на huevo.su, потом жми кнопку - обновишь пароль и сразу зайдём.`,
            kb
          );
          return false;
        }
        if (res.ok) {
          this.db.setStatus(id, S.RUNNING, '');
          stamp(`${username}: вошли (попытка ${n})`);
          this.notify.toUser(await this.#chatId(id), `✅ ${username}: вход выполнен, кликаю.`);
          return true;
        }
        stamp(`${username}: POST логина → FAIL: ${res.why}`);
        farm.loginLastWhy = res.why;
        if (attempt === 1) {
          this.notify.toUser(
            await this.#chatId(id),
            `⚠️ ${username}: ${res.why}.\nПрисылаю новую капчу - введи код с новой картинки.`
          );
        }
        this.db.setStatus(id, S.LOGGING, res.why);
        await this.#park(farm, 8000);
      } catch (e) {
        if (e instanceof CaptchaTimeoutError) {
          this.db.setStatus(id, S.NEED_LOGIN, 'код капчи не получен');
          return false;
        }
        if (e instanceof LoginLockError) {
          this.db.setStatus(id, S.LOCKED, e.message);
          stamp(`${username}: ${e.message}`);
          await this.#park(farm, (e.seconds + 10) * 1000);
          return false;
        }
        stamp(`${username}: вход: ${e.message}`);
        console.error(e.stack || e);
        this.db.setStatus(id, S.LOGGING, `вход: ${e.message}`);
        await this.#park(farm, 10_000);
      }
    }
    this.db.setStatus(id, S.ERROR, 'вход не удался 4 раза - попробуй кнопку заново');
    return false;
  }

  async #chatId(id) {
    return this.db.getAccount(id)?.tg_chat_id;
  }
}
