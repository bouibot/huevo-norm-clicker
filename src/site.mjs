// site.mjs - HTTP-клиент huevo.su (ядро из референсного huevoclicker / v2):
//   • антибот 418: кука hchk = XOR data-hchk-a/b
//   • логин: data-k → hv (реверс), POST /login { hv, username, password, captcha_token, captcha, remember }
//   • капча: картинка+токен со страницы логина или GET /captcha/refresh/login
//   • кликер: POST /api/clicker (batch ≤ 400, MIN_GAP 8с), дневной кап → {capped, error:'full'}
// Куки хранятся во внешнем хранилище (SQLite), передаются колбэками loadCookies/saveCookies.
import {
  BASE,
  NET_TIMEOUT_MS,
  sleep,
} from './config.mjs';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0';

// -- антибот: 418 + data-hchk-a/b, кука = XOR байтов попарно - ровно как их JS --
export function solveChallenge(html) {
  const a = html.match(/data-hchk-a="([^"]+)"/)?.[1];
  const b = html.match(/data-hchk-b="([^"]+)"/)?.[1];
  if (!a || !b) return null;
  let t = '';
  for (let i = 0; i < a.length; i += 2) {
    t += String.fromCharCode(parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16));
  }
  return { name: html.match(/document\.cookie\s*=\s*"([^=]+)=/)?.[1] ?? 'hchk', value: t };
}

export class LoginLockError extends Error {
  constructor(seconds) {
    super(`сервер залочил попытки входа${seconds ? ` на ${seconds}с` : ''}`);
    this.seconds = seconds ?? 300;
  }
}
export class CaptchaTimeoutError extends Error {
  constructor() {
    super('код капчи не получен');
  }
}

// -- клиент одного аккаунта --
export class Account {
  /**
   * @param opts.loadCookies  () => string[]   - массив Set-Cookie строк из хранилища
   * @param opts.saveCookies  (raw: string[]) => void
   * @param opts.getCaptchaCode ({image, username, attempt}) => Promise<string> - код (вводит юзер в бота)
   * @param opts.log          (line) => void
   */
  constructor({ login, pass, loadCookies, saveCookies, getCaptchaCode, log = () => {} }) {
    this.login = login;
    this.pass = pass;
    this.loadCookies = loadCookies;
    this.saveCookies = saveCookies;
    this.getCaptchaCode = getCaptchaCode;
    this.log = log;
    this.jar = new Map(); // name -> { v, raw }
    this.stats = { clicks: 0, ok: 0, errors: 0, earned: 0, relogins: 0 };
    this.balance = null;
    this.nextClickAt = 0; // следующий разрешённый клик (MIN_GAP 8с)
    for (const raw of loadCookies?.() ?? []) this.#absorbCookie(raw);
  }

  get label() { return this.login; }

  #absorbCookie(c) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i < 0) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!v) { this.jar.delete(k); return; }
    const exp = /expires=([^;]+)/i.exec(c);
    if (exp) {
      const d = new Date(exp[1]);
      if (!isNaN(d) && d.getTime() < Date.now()) return;
    }
    this.jar.set(k, { v, raw: c });
  }

  cookieHeader() {
    return [...this.jar].map(([k, { v }]) => `${k}=${v}`).join('; ');
  }
  dumpCookies() { return [...this.jar].map(([, c]) => c.raw); }
  clearCookies() { this.jar.clear(); this.saveCookies?.([]); }

  // жив ли сеанс (дёшево: аноним получит страницу логина)
  async sessionAlive() {
    if (!this.jar.get('session')) return false;
    const r = await this.req(`${BASE}/clicker`, { headers: { Accept: 'text/html,*/*' }, follow: false }).catch(() => null);
    if (!r) return false;
    if (r.status === 302) return false;
    if (r.status === 200) {
      return !r.text.includes('id="login-form"') && !r.text.includes('name="username"');
    }
    return false;
  }

  // -- HTTP с авто-челленджем и редиректами --
  async req(url, opt = {}) {
    const { follow = true, maxHops = 8, timeout = NET_TIMEOUT_MS } = opt;
    let { headers: extra = {}, ...rest } = opt;
    let target = url;
    let hops = 0;

    for (;;) {
      let res;
      try {
        res = await fetch(target, {
          redirect: 'manual',
          ...rest,
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'en-US,en;q=0.9',
            Cookie: this.cookieHeader(),
            ...extra,
          },
          signal: AbortSignal.timeout(timeout),
        });
        let cookiesChanged = false;
        for (const c of res.headers.getSetCookie?.() ?? []) {
          if (this.#absorbChanged(c)) cookiesChanged = true;
        }
        if (cookiesChanged) this.saveCookies?.(this.dumpCookies());
      } catch (e) {
        const err = new Error(`сеть: ${e.cause?.code || e.name}: ${e.cause?.message || e.message}`);
        err.net = true;
        throw err;
      }

      if (opt.binary) {
        const buffer = Buffer.from(await res.arrayBuffer());
        return { status: res.status, text: '', buffer, json: null, url: target, headers: res.headers };
      }

      const text = await res.text();

      // антибот: решаем XOR-челлендж и повторяем тот же запрос
      if (res.status === 418) {
        const c = solveChallenge(text);
        if (c && hops < maxHops) {
          this.jar.set(c.name, { v: c.value, raw: `${c.name}=${c.value}; Path=/; Max-Age=259200; SameSite=Lax` });
          this.saveCookies?.(this.dumpCookies());
          hops++;
          continue;
        }
      }

      const loc = res.headers.get('location');
      if (follow && [301, 302, 303, 307, 308].includes(res.status) && loc && hops < maxHops) {
        target = new URL(loc, target).href;
        hops++;
        if (rest.method === 'POST' && res.status !== 307 && res.status !== 308) {
          rest = {}; // редирект после POST обычно на GET
          extra = {};
        }
        continue;
      }

      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, text, json, url: target, headers: res.headers };
    }
  }

  #absorbChanged(c) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i < 0) return false;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) {
      this.jar.delete(k);
      return true;
    }
    const exp = /expires=([^;]+)/i.exec(c);
    if (exp) {
      const d = new Date(exp[1]);
      if (!isNaN(d) && d.getTime() < Date.now()) return false;
    }
    const prev = this.jar.get(k);
    const changed = !prev || prev.raw !== c;
    if (changed) this.jar.set(k, { v, raw: c });
    return changed;
  }

  // -- капча --
  static parsePageCaptcha(html) {
    const token = html.match(/name="captcha_token"\s+value="([^"]+)"/i)?.[1];
    const url = html.match(/src="(\/captcha\/[a-f0-9]+\.png)"/i)?.[1];
    return token && url ? { token, url } : null;
  }

  async fetchImageB64(url) {
    const img = await this.req(`${BASE}${url}`, {
      headers: { Accept: 'image/png,image/webp,*/*' },
      follow: false,
      binary: true,
    });
    return img.buffer.toString('base64');
  }

  // свежая пара токен+картинка через /captcha/refresh/login (бэкофф на 429)
  async refreshCaptcha() {
    for (let i = 0; i < 4; i++) {
      const ref = await this.req(`${BASE}/captcha/refresh/login`, {
        headers: { Accept: 'application/json' },
        follow: false,
      });
      const d = ref.json ?? {};
      if (!d.url) {
        if (ref.status === 429) {
          this.log('капча-сервис просит подождать (429) - пауза 30с');
          await sleep(30000);
          continue;
        }
        throw new Error(`captcha/refresh: HTTP ${ref.status}`);
      }
      const b64 = await this.fetchImageB64(d.url);
      return { token: d.token, base64: b64, url: d.url };
    }
    throw new Error('captcha/refresh: не удалось получить капчу после 429');
  }

  // -- логин (одна попытка; цикл ретраев - в engine) --
  // возвращает: { ok:true } | { retry:true, why } | 'captcha' - неверная капча
  async attemptLogin({ dataK, cap, code }) {
    const hv = [...dataK].reverse().join('');
    const form = new URLSearchParams({
      hv, username: this.login, password: this.pass,
      captcha_token: cap.token, captcha: code.trim(), remember: 'on',
    });
    this.log(`логин с капчей «${code.trim()}»`);
    const r = await this.req(`${BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Origin: BASE, Referer: `${BASE}/login`,
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin',
      },
      body: form.toString(),
      follow: false,
    });

    if (r.status === 302 && r.headers.get('location')) {
      if (await this.sessionAlive()) {
        this.saveCookies?.(this.dumpCookies());
        this.log('логин OK');
        return { ok: true };
      }
      return { retry: true, why: 'логин прошёл, но сессия не подтвердилась' };
    }

    // страница после отказа от сервера: флэш-сообщение среди текстовых кусков
    const msg = r.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    const chunks = msg.split('|').map((s) => s.trim()).filter((s) => s.length > 4);
    const lock = /через\s+(\d+)\s*сек/i.exec(msg);
    if (r.status === 429 || /слишком много неудачных попыток/i.test(msg)) {
      throw new LoginLockError(lock ? Number(lock[1]) : undefined);
    }
    // капча-отказ: сервер пишет «Введите символы с картинки.» (через «т»!) и прочие варианты
    const capFlash = chunks.find((s) => /картинк|кап[т]?ч[аи]|символ/i.test(s));
    if (capFlash) return { retry: true, kind: 'captcha', why: `сервер не принял капчу: «${capFlash.slice(0, 120)}»` };
    // неверные данные учётки - сервер прямо подтверждает ошибку входа
    const credsFlash = chunks.find((s) => /логин или парол|неверн[а-яё]*\s*(парол|логин|учёт|данн)/i.test(s));
    if (credsFlash) return { retry: false, badCreds: true, why: `неверный логин или пароль: «${credsFlash.slice(0, 120)}»` };
    const errFlash = chunks.find((s) => /ошиб|неверн|неправильн|некоррект|не удал/i.test(s));
    if (errFlash) return { retry: true, kind: 'misc', why: `логин отвергнут сервером: «${errFlash.slice(0, 120)}»` };
    const formBack = r.text.includes('name="username"') || r.text.includes('login-form');
    return {
      retry: true,
      why: formBack
        ? 'сервер вернул форму входа без объяснений'
        : `HTTP ${r.status} ${r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 100)}`,
    };
  }

  // свежая страница логина: данные для одной попытки (dataK + капча)
  async fetchLoginForm() {
    const page = await this.req(`${BASE}/login`, {
      headers: { Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    const dataK = page.text.match(/data-k="([^"]+)"/)?.[1];
    if (!dataK) throw new Error('не нашёл data-k на /login - сайт поменялся?');
    const pageCap = Account.parsePageCaptcha(page.text);
    const cap = pageCap
      ? { ...pageCap, base64: await this.fetchImageB64(pageCap.url) }
      : await this.refreshCaptcha();
    return { dataK, cap };
  }

  // полный логин одной попыткой: страница → капча (код от юзера) → POST
  async attemptLoginFlow() {
    const { dataK, cap } = await this.fetchLoginForm();
    const code = await this.getCaptchaCode({ image: cap.base64, username: this.login });
    if (!code) return { retry: true, why: 'пустой код капчи' };
    return await this.attemptLogin({ dataK, cap, code });
  }

  // -- кликер --
  async click(clicks = 400) {
    this.stats.clicks++;
    const wait = this.nextClickAt - Date.now();
    if (wait > 0) await sleep(wait);
    const r = await this.req(`${BASE}/api/clicker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        Origin: BASE, Referer: `${BASE}/clicker`,
        'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
      },
      body: new URLSearchParams({ clicks: String(clicks) }).toString(),
      follow: false,
    });
    this.nextClickAt = Date.now() + 8000;
    const j = r.json;
    if (r.status === 200 && j?.ok === true) {
      this.stats.ok++;
      this.balance = j.balance;
      this.stats.earned += j.earned ?? 0;
      return j;
    }
    if (j?.capped === true || j?.error === 'full') {
      this.stats.errors++;
      return { ok: false, capped: true, __http: r.status, ...(j ?? {}) };
    }
    this.stats.errors++;
    return { __http: r.status, __text: r.text, ...(j ?? {}) };
  }
}
