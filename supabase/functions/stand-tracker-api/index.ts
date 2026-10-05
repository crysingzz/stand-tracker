// Telegram-authenticated API. Set TELEGRAM_BOT_TOKEN in Supabase Edge Function
// secrets; never put it in the GitHub Pages files or the repository.
const allowedOrigins = new Set([
  "https://crysingzz.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
]);
const MAX_BODY_BYTES = 16_384;
let cachedBot: { username: string; until: number } | null = null;

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cors(origin: string | null): Record<string, string> {
  return origin && allowedOrigins.has(origin)
    ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "content-type, apikey", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }
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

async function rpc(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new ApiError(503, "Supabase не подключён");
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "apikey": serviceKey(), "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status >= 500) throw new ApiError(503, "База данных временно недоступна");
    throw new ApiError(400, String(body?.message || "Действие не удалось"));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(502, "Неверный ответ базы данных");
  return body;
}

function botToken(): string {
  return Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim() || "";
}

async function telegram(method: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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

async function verifyTelegramAuth(value: unknown): Promise<{ id: string; username: string | null }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(401, "Войдите через Telegram");
  const auth = value as Record<string, unknown>;
  const id = String(auth.id ?? "");
  const username = auth.username == null || auth.username === "" ? null : String(auth.username);
  const authDate = Number(auth.auth_date);
  const hash = String(auth.hash ?? "").toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)) ||
      (username !== null && !/^[A-Za-z0-9_]{5,32}$/.test(username)) ||
      !Number.isInteger(authDate) || authDate > now + 60 || now - authDate > 86400 ||
      !/^[a-f0-9]{64}$/.test(hash)) {
    throw new ApiError(401, "Подтверждение Telegram недействительно или устарело");
  }

  const checkString = Object.entries(auth)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join("\n");
  const secret = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken()));
  const hmacKey = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(checkString)));
  if (!sameHex(expected, hash)) throw new ApiError(401, "Подтверждение Telegram не прошло проверку");
  return { id, username };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) throw new ApiError(413, "Слишком большой запрос");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Пустой запрос");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
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
    return "Изменение сохранено, но Telegram-уведомление не доставлено. Получателю нужно открыть бота и нажать Start.";
  }
}

function moscowTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) return json({ message: "Источник не разрешён" }, 403, origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  const route = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  try {
    if (request.method === "GET" && route === "config") {
      if (!botToken()) return json({ enabled: false }, 200, origin);
      if (cachedBot && cachedBot.until > Date.now()) return json({ enabled: true, botUsername: cachedBot.username }, 200, origin);
      try {
        const bot = await telegram("getMe");
        if (typeof bot.username !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) throw new Error("Invalid bot username");
        cachedBot = { username: bot.username, until: Date.now() + 300_000 };
        return json({ enabled: true, botUsername: bot.username }, 200, origin);
      } catch {
        return json({ enabled: false }, 200, origin);
      }
    }
    if (!botToken()) throw new ApiError(503, "Telegram-бот ещё не подключён администратором");
    if (request.method !== "POST") throw new ApiError(405, "Метод не поддерживается");
    const body = await readBody(request);
    const identity = await verifyTelegramAuth(body.auth);
    const member = await rpc("telegram_resolve_member", {
      p_telegram_user_id: identity.id,
      p_telegram_username: identity.username,
    });
    const memberId = Number(member.id);
    if (!Number.isSafeInteger(memberId)) throw new ApiError(502, "Неверный профиль");

    if (route === "auth") {
      let notificationWarning: string | null = null;
      if (member.newly_linked) {
        notificationWarning = await sendNotice(identity.id, `Профиль ${member.name} подключён к трекеру стендов. Теперь вы будете получать связанные с вами уведомления.`);
      }
      return json({ profile: { id: memberId, name: member.name, username: member.username }, notificationWarning }, 200, origin);
    }
    if (route === "state") return json(await rpc("member_state", { p_member_id: memberId }), 200, origin);
    if (route === "test-notification") {
      const warning = await sendNotice(identity.id, `Проверка уведомлений трекера стендов для профиля ${member.name}.`);
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
