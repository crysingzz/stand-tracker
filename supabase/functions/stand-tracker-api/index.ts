// Telegram bot-code API. The bot token stays in Edge Function secrets; browsers
// receive only one-time challenges and revocable opaque site sessions.
const allowedOrigins = new Set([
  "https://crysingzz.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
]);
const MAX_BODY_BYTES = 16_384;
const MAX_WEBHOOK_BYTES = 65_536;
let cachedBot: { username: string; until: number } | null = null;
let webhookReadyUntil = 0;

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cors(origin: string | null): Record<string, string> {
  return origin && allowedOrigins.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }
    : {};
}

function json(value: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(origin) },
  });
}

function serviceKey(): string {
  let key = "";
  try { key = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch { /* use legacy key */ }
  key ||= Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!key) throw new ApiError(503, "Серверный ключ Supabase недоступен");
  return key;
}

async function rpc<T = Record<string, unknown>>(name: string, params: Record<string, unknown>): Promise<T> {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new ApiError(503, "Supabase не подключён");
  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { "apikey": serviceKey(), "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApiError(503, "База данных временно недоступна");
  }
  const raw = await response.text();
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new ApiError(502, "Неверный ответ базы данных"); }
  if (!response.ok) {
    if (response.status >= 500) throw new ApiError(503, "База данных временно недоступна");
    const message = body && typeof body === "object" && "message" in body ? String(body.message) : "Действие не удалось";
    throw new ApiError(400, message);
  }
  return body as T;
}

function botToken(): string {
  return Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim() || "";
}

async function telegram(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // Never log a fetch error: its URL can contain the bot token.
    throw new ApiError(503, "Telegram временно недоступен");
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new ApiError(503, "Telegram временно недоступен");
  return result.result;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return different === 0;
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmacHex(key: string, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomCode(): string {
  const range = 100_000_000;
  const ceiling = Math.floor(0x1_0000_0000 / range) * range;
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= ceiling);
  return String(value % range).padStart(8, "0");
}

function tokenValue(value: unknown): string {
  const token = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(400, "Неверный запрос на вход");
  return token;
}

async function botInfo(): Promise<{ username: string }> {
  if (cachedBot && cachedBot.until > Date.now()) return cachedBot;
  const result = await telegram("getMe");
  if (!result || typeof result !== "object" || !("username" in result) ||
      typeof result.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(result.username)) {
    throw new ApiError(503, "Telegram-бот недоступен");
  }
  cachedBot = { username: result.username, until: Date.now() + 300_000 };
  return cachedBot;
}

async function webhookSecret(): Promise<string> {
  return sha256Hex(`stand-tracker-webhook-v1:${botToken()}`);
}

async function ensureWebhook(): Promise<void> {
  if (webhookReadyUntil > Date.now()) return;
  const base = Deno.env.get("SUPABASE_URL");
  if (!base || !base.startsWith("https://")) throw new ApiError(503, "Сервер не подключён");
  const result = await telegram("setWebhook", {
    url: `${base}/functions/v1/stand-tracker-api/telegram-webhook`,
    secret_token: await webhookSecret(),
    allowed_updates: ["message"],
    max_connections: 10,
    drop_pending_updates: false,
  });
  if (result !== true) throw new ApiError(503, "Не удалось подключить Telegram-бота");
  webhookReadyUntil = Date.now() + 600_000;
}

async function sessionMember(request: Request): Promise<{ id: number; name: string; username: string; telegram_user_id: string }> {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) throw new ApiError(401, "Войдите через Telegram-бота");
  const member = await rpc<Record<string, unknown> | null>("bot_session_resolve", { p_token_hash: await sha256Hex(match[1]) });
  if (!member || !Number.isSafeInteger(Number(member.id)) || !member.telegram_user_id) {
    throw new ApiError(401, "Сеанс истёк. Войдите через бота снова");
  }
  return { id: Number(member.id), name: String(member.name), username: String(member.username), telegram_user_id: String(member.telegram_user_id) };
}

async function readBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(length) || length > maxBytes) throw new ApiError(413, "Слишком большой запрос");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Пустой запрос");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "Слишком большой запрос");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, "Неверный запрос"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "Неверный запрос");
  return body as Record<string, unknown>;
}

function textValue(value: unknown, max: number): string {
  const result = String(value ?? "").trim();
  if (result.length > max) throw new ApiError(400, `Текст слишком длинный (до ${max} символов)`);
  return result;
}

function timeValue(value: unknown): string | null {
  if (value === null || value === "" || value === undefined) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new ApiError(400, "Проверьте указанное время");
  return parsed.toISOString();
}

function standValue(value: unknown): string {
  const stand = String(value || "");
  if (!["AAV", "ALP", "OVD", "TVE"].includes(stand)) throw new ApiError(400, "Неизвестный стенд");
  return stand;
}

async function sendNotice(chatId: unknown, message: string): Promise<string | null> {
  if (chatId === null || chatId === undefined) return "Изменение сохранено, но получатель ещё не подключил Telegram-уведомления.";
  try {
    await telegram("sendMessage", { chat_id: chatId, text: message });
    return null;
  } catch {
    return "Изменение сохранено, но доставку Telegram-уведомления не удалось подтвердить. Получателю нужно открыть бота и нажать Start.";
  }
}

function moscowTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

async function handleTelegramWebhook(request: Request, origin: string | null): Promise<Response> {
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!sameHex(supplied, await webhookSecret())) throw new ApiError(403, "Недопустимый запрос");
  const update = await readBody(request, MAX_WEBHOOK_BYTES);
  const message = update.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return json({ ok: true }, 200, origin);
  const item = message as Record<string, unknown>;
  const sender = item.from;
  const chat = item.chat;
  if (!sender || typeof sender !== "object" || !chat || typeof chat !== "object") return json({ ok: true }, 200, origin);
  const from = sender as Record<string, unknown>;
  const conversation = chat as Record<string, unknown>;
  if (conversation.type !== "private" || !Number.isSafeInteger(from.id) || from.id !== conversation.id) {
    return json({ ok: true }, 200, origin);
  }
  const command = typeof item.text === "string" ? /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{43}))?\s*$/.exec(item.text) : null;
  if (!command) return json({ ok: true }, 200, origin);
  if (!command[1]) {
    await telegram("sendMessage", { chat_id: from.id, text: "Чтобы войти в трекер стендов, откройте сайт и нажмите «Получить код в Telegram». Затем перейдите по выданной ссылке." });
    return json({ ok: true }, 200, origin);
  }
  const startHash = await sha256Hex(command[1]);
  const code = randomCode();
  const codeHash = await hmacHex(botToken(), `${startHash}:${code}`);
  let result: Record<string, unknown>;
  try {
    result = await rpc("bot_login_start", {
      p_start_hash: startHash,
      p_telegram_user_id: from.id,
      p_telegram_username: typeof from.username === "string" ? from.username : null,
      p_code_hash: codeHash,
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400) throw error;
    await telegram("sendMessage", { chat_id: from.id, text: "Этот Telegram-аккаунт не привязан к профилю команды. Попросите администратора проверить ваш @username." });
    return json({ ok: true }, 200, origin);
  }
  if (result.status === "ready") {
    await telegram("sendMessage", { chat_id: from.id, text: `Код для входа в трекер стендов: ${code}\n\nВведите его на сайте в течение 5 минут. Никому не пересылайте код.` });
  } else {
    await telegram("sendMessage", { chat_id: from.id, text: "Ссылка на вход устарела или уже использована. Вернитесь на сайт и запросите новую." });
  }
  return json({ ok: true }, 200, origin);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) return json({ message: "Источник не разрешён" }, 403, origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  const route = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  try {
    if (!botToken()) throw new ApiError(503, "Telegram-бот ещё не подключён администратором");
    if (request.method === "GET" && route === "config") {
      try {
        const bot = await botInfo();
        await ensureWebhook();
        return json({ enabled: true, botUsername: bot.username }, 200, origin);
      } catch {
        return json({ enabled: false }, 200, origin);
      }
    }
    if (request.method !== "POST") throw new ApiError(405, "Метод не поддерживается");
    if (route === "telegram-webhook") return await handleTelegramWebhook(request, origin);
    const body = await readBody(request);
    if (route === "begin-login") {
      await ensureWebhook();
      const bot = await botInfo();
      const startToken = randomToken();
      const browserToken = randomToken();
      const challenge = await rpc<Record<string, unknown>>("bot_login_begin", {
        p_start_hash: await sha256Hex(startToken), p_browser_hash: await sha256Hex(browserToken),
      });
      return json({ startToken, browserToken, startLink: `https://t.me/${bot.username}?start=${startToken}`, expiresAt: challenge.expires_at }, 200, origin);
    }
    if (route === "complete-login") {
      const startToken = tokenValue(body.startToken);
      const browserToken = tokenValue(body.browserToken);
      const code = String(body.code ?? "");
      if (!/^\d{8}$/.test(code)) throw new ApiError(400, "Введите восьмизначный код из чата с ботом");
      const startHash = await sha256Hex(startToken);
      const sessionToken = randomToken();
      const result = await rpc<Record<string, unknown>>("bot_login_complete", {
        p_start_hash: startHash,
        p_browser_hash: await sha256Hex(browserToken),
        p_code_hash: await hmacHex(botToken(), `${startHash}:${code}`),
        p_session_hash: await sha256Hex(sessionToken),
      });
      if (result.status !== "ok") {
        const failures: Record<string, [number, string]> = {
          pending: [409, "Сначала откройте бота по ссылке и получите код"],
          wrong: [400, `Неверный код. Осталось попыток: ${Number(result.remaining) || 0}`],
          locked: [429, "Слишком много неверных кодов. Запросите новую ссылку"],
          expired: [410, "Код устарел. Запросите новую ссылку"],
          invalid: [400, "Неверный запрос на вход"],
        };
        const failure = failures[String(result.status)] || [400, "Не удалось войти"];
        throw new ApiError(failure[0], failure[1]);
      }
      return json({ sessionToken, profile: result.profile, expiresAt: result.expires_at }, 200, origin);
    }
    const member = await sessionMember(request);
    const memberId = member.id;
    if (route === "logout") {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("Authorization") || "")?.[1];
      if (!token) throw new ApiError(401, "Войдите через Telegram-бота");
      await rpc<boolean>("bot_session_revoke", { p_token_hash: await sha256Hex(token) });
      return json({ ok: true }, 200, origin);
    }
    if (route === "state") return json(await rpc("member_state", { p_member_id: memberId }), 200, origin);
    if (route === "test-notification") {
      const warning = await sendNotice(member.telegram_user_id, `Проверка уведомлений трекера стендов для профиля ${member.name}.`);
      return json({ delivered: !warning, notificationWarning: warning }, 200, origin);
    }

    const params = body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? body.params as Record<string, unknown> : {};
    const stand = standValue(params.stand);
    let result: Record<string, unknown>;
    let notice: string | null = null;
    if (route === "claim") {
      result = await rpc("member_claim", {
        p_member_id: memberId, p_stand: stand,
        p_purpose: textValue(params.purpose, 200),
        p_planned_end: timeValue(params.plannedEnd),
        p_priority: params.priority,
      });
    } else if (route === "request") {
      const neededBy = timeValue(params.neededBy);
      const reason = textValue(params.reason, 300);
      result = await rpc("member_request_release", {
        p_member_id: memberId, p_stand: stand,
        p_needed_by: neededBy, p_reason: reason,
      });
      notice = await sendNotice(result.recipient_chat_id,
        `${member.name} просит освободить стенд ${stand} до ${moscowTime(neededBy || "")} МСК.\nПричина: ${reason}`);
    } else if (route === "release") {
      result = await rpc("member_release", { p_member_id: memberId, p_stand: stand });
      if (result.recipient_chat_id) notice = await sendNotice(result.recipient_chat_id, `Стенд ${stand} освободился. Вы оставляли запрос на этот стенд.`);
    } else if (route === "withdraw") {
      result = await rpc("member_withdraw_release_request", { p_member_id: memberId, p_stand: stand });
      if (result.recipient_chat_id) notice = await sendNotice(result.recipient_chat_id, `${member.name} снял запрос на освобождение стенда ${stand}.`);
    } else {
      throw new ApiError(404, "Неизвестное действие");
    }
    return json({ state: result.state, notificationWarning: notice }, 200, origin);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : "Внутренняя ошибка сервиса";
    if (!(error instanceof ApiError)) console.error(error);
    return json({ message }, status, origin);
  }
});
