// db.mjs - SQLite (встроенный node:sqlite, без нативных зависимостей).
// Схема: аккаунты + пользователи бота + админы + коды приглашений.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mskDay } from './config.mjs';

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_user_id INTEGER NOT NULL,
      tg_chat_id INTEGER NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      cookies TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      status_note TEXT NOT NULL DEFAULT '',
      balance INTEGER,
      clicks_total INTEGER NOT NULL DEFAULT 0,
      errors_total INTEGER NOT NULL DEFAULT 0,
      earned_today INTEGER NOT NULL DEFAULT 0,
      earned_day TEXT NOT NULL DEFAULT '',
      last_click_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      tg_user_id INTEGER PRIMARY KEY,
      tg_chat_id INTEGER NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      first_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      tg_user_id INTEGER PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'admin',  -- 'owner' | 'admin'
      added_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY COLLATE NOCASE,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      used_by INTEGER,                -- tg_user_id активировавшего
      used_by_username TEXT NOT NULL DEFAULT '',
      used_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0  -- 1 = отозван владельцем до активации
    );
  `);
  return new Db(db);
}

export const S = {
  RUNNING: 'running',
  LOGGING: 'logging',
  WAITING_CAPTCHA: 'waiting_captcha',
  NEED_LOGIN: 'need_login',
  CAPPED: 'capped',
  LOCKED: 'locked',
  ERROR: 'error',
  STOPPED: 'stopped',
};

export class Db {
  constructor(db) {
    this.db = db;
    this.q = {
      accAdd: db.prepare(
        `INSERT INTO accounts (tg_user_id, tg_chat_id, username, password, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ),
      accByUser: db.prepare(`SELECT * FROM accounts WHERE tg_user_id = ? ORDER BY id`),
      accAll: db.prepare(`SELECT * FROM accounts ORDER BY id`),
      accById: db.prepare(`SELECT * FROM accounts WHERE id = ?`),
      accByUsername: db.prepare(`SELECT * FROM accounts WHERE username = ? COLLATE NOCASE`),
      accByUserId: db.prepare(`SELECT * FROM accounts WHERE tg_user_id = ? AND id = ?`),
      accStatus: db.prepare(`UPDATE accounts SET status = ?, status_note = ? WHERE id = ?`),
      accCookies: db.prepare(`UPDATE accounts SET cookies = ? WHERE id = ?`),
      accBalance: db.prepare(
        `UPDATE accounts SET balance = ?, clicks_total = clicks_total + ?, errors_total = errors_total + ?
         WHERE id = ?`
      ),
      accEarned: db.prepare(`SELECT earned_day, earned_today FROM accounts WHERE id = ?`),
      accEarnedUpd: db.prepare(
        `UPDATE accounts SET earned_day = ?, earned_today = ? WHERE id = ?`
      ),
      accLastClick: db.prepare(`UPDATE accounts SET last_click_at = ? WHERE id = ?`),
      accPassword: db.prepare(`UPDATE accounts SET password = ? WHERE id = ?`),
      accDelete: db.prepare(`DELETE FROM accounts WHERE id = ?`),
      setGet: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      setSet: db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ),
      accountsActive: db.prepare(
        `SELECT COUNT(*) AS n FROM accounts WHERE status != 'stopped'`
      ),
      userUpsert: db.prepare(
        `INSERT INTO users (tg_user_id, tg_chat_id, username, first_name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET
           tg_chat_id = excluded.tg_chat_id,
           username = excluded.username,
           first_name = excluded.first_name,
           last_seen_at = excluded.last_seen_at`
      ),
      broadcastTargets: db.prepare(
        `SELECT tg_chat_id FROM users
         UNION
         SELECT tg_chat_id FROM accounts`
      ),
      usersCount: db.prepare(`SELECT COUNT(*) AS n FROM users`),
      adminAll: db.prepare(`SELECT * FROM admins ORDER BY created_at`),
      adminById: db.prepare(`SELECT * FROM admins WHERE tg_user_id = ?`),
      adminAdd: db.prepare(
        `INSERT INTO admins (tg_user_id, role, added_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(tg_user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`
      ),
      adminDelete: db.prepare(`DELETE FROM admins WHERE tg_user_id = ?`),
      // -- коды приглашений --
      inviteAdd: db.prepare(
        `INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)`
      ),
      inviteByCode: db.prepare(`SELECT * FROM invites WHERE code = ? COLLATE NOCASE`),
      inviteUsedBy: db.prepare(`SELECT * FROM invites WHERE used_by = ?`),
      inviteMarkUsed: db.prepare(
        `UPDATE invites SET used_by = ?, used_by_username = ?, used_at = ? WHERE code = ?`
      ),
      inviteRevoke: db.prepare(`UPDATE invites SET revoked = 1 WHERE code = ? COLLATE NOCASE`),
      inviteDelete: db.prepare(`DELETE FROM invites WHERE code = ? COLLATE NOCASE`),
      inviteList: db.prepare(
        `SELECT * FROM invites
         ORDER BY (used_at IS NULL) DESC, created_at DESC LIMIT ?`
      ),
      inviteStats: db.prepare(
        `SELECT
           COALESCE(SUM(used_at IS NULL AND revoked = 0), 0) AS free,
           COALESCE(SUM(used_at IS NOT NULL), 0)             AS used,
           COALESCE(SUM(used_at IS NULL AND revoked = 1), 0) AS revoked
         FROM invites`
      ),
    };
  }

  // -- аккаунты --
  addAccount(tgUserId, tgChatId, username, password) {
    try {
      const r = this.q.accAdd.run(tgUserId, tgChatId, username, password, Date.now());
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(String(e))) return null; // логин уже есть
      throw e;
    }
  }
  getAccount(id) { return this.q.accById.get(id) ?? null; }
  getAccountForUser(tgUserId, id) { return this.q.accByUserId.get(tgUserId, id) ?? null; }
  accountsOfUser(tgUserId) { return this.q.accByUser.all(tgUserId); }
  allAccounts() { return this.q.accAll.all(); }
  findAccountByUsername(username) { return this.q.accByUsername.get(username) ?? null; }
  deleteAccount(id) { this.q.accDelete.run(id); }
  setStatus(id, status, note = '') { this.q.accStatus.run(status, note, id); }
  saveCookies(id, cookies) { this.q.accCookies.run(JSON.stringify(cookies ?? []), id); }
  updateBalance(id, balance, clicks = 0, errors = 0) {
    this.q.accBalance.run(balance, clicks, errors, id);
    this.q.accLastClick.run(Date.now(), id);
  }

  changePassword(id, password) { this.q.accPassword.run(password, id); }

  // дневной заработок (для статистики, комиссий нет)
  earnedState(id) {
    return this.q.accEarned.get(id) ?? { earned_day: '', earned_today: 0 };
  }
  /** добавляем заработок за сегодня (с авто-сбросом на новый день) */
  addEarned(id, delta) {
    const st = this.earnedState(id);
    const today = mskDay();
    const earnedToday = st.earned_day === today ? st.earned_today + delta : delta;
    this.q.accEarnedUpd.run(today, earnedToday, id);
    return { earnedToday };
  }

  // -- настройки --
  setting(key, def = null) {
    const r = this.q.setGet.get(key);
    return r ? r.value : def;
  }
  setSetting(key, value) { this.q.setSet.run(key, String(value)); }

  activeAccountsCount() { return Number(this.q.accountsActive.get().n); }

  // -- пользователи бота (для рассылки) --
  upsertUser(tgUserId, tgChatId, username = '', firstName = '') {
    const now = Date.now();
    this.q.userUpsert.run(tgUserId, tgChatId, username ?? '', firstName ?? '', now, now);
  }
  usersCount() { return Number(this.q.usersCount.get().n); }
  /** все чаты для /broadcast: пользователи бота + владельцы аккаунтов */
  broadcastTargets() {
    return this.q.broadcastTargets.all().map((r) => Number(r.tg_chat_id));
  }

  // -- админы (владелец задаётся через .env OWNER_ID) --
  allAdmins() { return this.q.adminAll.all(); }
  adminRow(tgUserId) { return this.q.adminById.get(tgUserId) ?? null; }
  isAdmin(tgUserId) { return !!this.q.adminById.get(tgUserId); }
  adminRole(tgUserId) { return this.q.adminById.get(tgUserId)?.role ?? null; }
  addAdmin(tgUserId, role = 'admin', addedBy = null) {
    this.q.adminAdd.run(tgUserId, role, addedBy, Date.now());
  }
  removeAdmin(tgUserId) { this.q.adminDelete.run(tgUserId); }

  // -- коды приглашений --
  /** Создать код; вернёт false, если такой уже есть. */
  addInvite(code, createdBy) {
    try {
      this.q.inviteAdd.run(code, createdBy, Date.now());
      return true;
    } catch (e) {
      if (/UNIQUE/.test(String(e))) return false;
      throw e;
    }
  }
  findInvite(code) { return this.q.inviteByCode.get(code) ?? null; }
  inviteUsedBy(tgUserId) { return this.q.inviteUsedBy.get(tgUserId) ?? null; }
  markInviteUsed(code, tgUserId, username = '') {
    this.q.inviteMarkUsed.run(tgUserId, username, Date.now(), code);
  }
  revokeInvite(code) { this.q.inviteRevoke.run(code); }
  deleteInvite(code) { this.q.inviteDelete.run(code); }
  listInvites(limit = 50) { return this.q.inviteList.all(limit); }
  inviteStats() {
    const r = this.q.inviteStats.get();
    return { free: Number(r.free), used: Number(r.used), revoked: Number(r.revoked) };
  }
}
