// config.mjs - читает .env и дефолты (без внешних зависимостей).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(__dirname);

// читаем .env вручную (KEY=VALUE, # - комментарии)
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}

export const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const OWNER_ID = Number(process.env.OWNER_ID || process.env.ADMIN_ID || 0);
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
export const DB_FILE = join(DATA_DIR, 'clicker.db');
export const BASE = (process.env.HUE_BASE || 'https://huevo.su').replace(/\/$/, '');

// сообщества, на которые просим подписаться при активации кода
export const COMMUNITY_TG = process.env.COMMUNITY_TG || 'https://t.me/lovemelikeimdead';
export const COMMUNITY_FARM = process.env.COMMUNITY_FARM || 'https://huevo.su/autofarm';

// капча ждёт код от юзера столько, потом аккаунт «засыпает» до следующего вопроса
export const CAPTCHA_WAIT_MS = 10 * 60_000;
// базовые паузы кликера (сервер: MIN_GAP 8с, MAX_BATCH 400)
export const CLICK_BATCH = 400;
// ожидание при дневном капе
export const CAPPED_WAIT_MS = 10 * 60_000;
// таймаут сети
export const NET_TIMEOUT_MS = 30_000;
// пауза между сообщениями рассылки (~18 msg/s, лимит Telegram - 30/s)
export const BROADCAST_DELAY_MS = 55;

// -- коды приглашений --
// алфавит без похожих символов (0/O, 1/I/l)
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_RANDOM_LEN = 10; // HUEVO-XXXXXXXXXX
export const INVITE_PREFIX = 'HUEVO-';

export function randomInviteCode(len = INVITE_RANDOM_LEN, prefix = INVITE_PREFIX) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return `${prefix}${s}`;
}

export function mskDay(d = new Date()) {
  return d.toLocaleString('en-CA', { timeZone: 'Europe/Moscow' }).slice(0, 10);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
