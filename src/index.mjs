// index.mjs - точка входа: база → ферма → бот.
import { openDb } from './db.mjs';
import { Engine } from './engine.mjs';
import { createBot } from './bot.mjs';
import { BOT_TOKEN, DB_FILE, OWNER_ID } from './config.mjs';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = '1.0.0';
console.log(`🥚 huevo invite-clicker v${VERSION} запускаюсь...`);

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.stack || e));

// - защита от второго экземпляра: два процесса с одним токеном делят getUpdates -
try {
  mkdirSync(dirname(DB_FILE), { recursive: true });
  const lockFile = dirname(DB_FILE) + '/bot.lock';
  if (existsSync(lockFile)) {
    const oldPid = Number(readFileSync(lockFile, 'utf8').trim());
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch {}
      if (alive) {
        console.error(`[lock] Бот уже запущен другим процессом (PID ${oldPid}). Не запускаю второй.`);
        console.error('[lock] Останови старый: systemctl stop huevo-clicker (или kill ' + oldPid + ')');
        process.exit(1);
      }
    }
  }
  writeFileSync(lockFile, String(process.pid));
  process.on('exit', () => { try { unlinkSync(lockFile); } catch {} });
} catch (e) {
  console.warn('[lock] не удалось проверить lock:', e.message);
}

const db = openDb(DB_FILE);
const captchaBridge = { request: async () => null }; // бот подменит метод

const engine = new Engine(db, captchaBridge, { toUser: () => {}, toAdmin: () => {} });

const { bot, notifyUser, notifyAdmin, notifySend } = createBot(BOT_TOKEN, db, engine);

// живые уведомления
engine.notify.toUser = notifyUser;
engine.notify.toAdmin = notifyAdmin;
engine.notify.send = notifySend;       // HTML + кнопки (сообщение «нужен перелогин»)

// запускаем фермы по всем незавершённым аккаунтам
engine.startAll();

// Telegram long polling
bot.start({
  onStart: (me) => {
    console.log(`[bot] polling запущен как @${me.username} (v${VERSION})`);
    if (OWNER_ID) {
      bot.api.sendMessage(OWNER_ID, `✅ Бот запущен (версия ${VERSION}).`).catch((e) =>
        console.error('[bot] не смог написать админу:', e.message));
    }
  },
}).catch((e) => {
  if (/409|conflict/i.test(String(e?.message))) {
    console.error('[bot] getUpdates конфликт: другой процесс бота уже читает апдейты!');
    console.error('[bot] Убей второй экземпляр, иначе капчи и команды будут пропадать.');
  } else {
    console.error('[bot] polling старт не удался:', e?.message || e);
  }
});
process.on('SIGTERM', () => bot.stop().catch(() => {}));
process.on('SIGINT', () => bot.stop().catch(() => {}));
