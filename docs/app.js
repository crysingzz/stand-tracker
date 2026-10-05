const STANDS = ["AAV", "ALP", "OVD", "TVE"];
const PRIORITIES = {
  low: { label: "Низкий", className: "low" },
  normal: { label: "Обычный", className: "normal" },
  high: { label: "Высокий", className: "high" }
};
const config = window.STAND_TRACKER_CONFIG || {};
const apiUrl = String(config.supabaseUrl || "").replace(/\/+$/, "");
const apiKey = String(config.publishableKey || "");
const telegramApiUrl = `${apiUrl}/functions/v1/stand-tracker-api`;
const configured = (/^https:\/\//.test(apiUrl) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl)) && apiKey.length > 10;

const $ = (selector) => document.querySelector(selector);
const standGrid = $("#standGrid");
const historyList = $("#historyList");
const accessScreen = $("#accessScreen");
const accessForm = $("#accessForm");
const actionDialog = $("#actionDialog");
const actionForm = $("#actionForm");

let teamCode = "";
let loginMode = "team";
let telegramAuth = null;
let profile = null;
let botUsername = "";
let tracker = { active: [], requests: [], history: [] };
let loaded = false;
let pending = false;
let action = null;
let requestEpoch = 0;
let toastTimeout;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function dateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function localDateInput(date) {
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function elapsed(value, live = true) {
  const ms = Math.max(0, live ? Date.now() - new Date(value).getTime() : value);
  if (!Number.isFinite(ms)) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (live) {
    const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return days ? `${days} д ${clock}` : clock;
  }
  if (days) return `${days} д ${hours} ч ${minutes} мин`;
  if (hours) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function setConnection(label, state = "") {
  const node = $("#connectionStatus");
  node.className = `connection-status ${state}`;
  node.innerHTML = `<span class="connection-dot"></span>${escapeHtml(label)}`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 4000);
}

function errorMessage(error) {
  if (error instanceof TypeError) return "Нет связи с сервером. Проверьте интернет и повторите попытку.";
  const message = String(error?.message || "Не удалось выполнить действие");
  if (message.includes("Failed to fetch")) return "Нет связи с сервером. Проверьте интернет и повторите попытку.";
  if (message.includes("Could not find the function")) return "Сервис ещё не настроен. Сообщите администратору команды.";
  return message;
}

async function rpc(name, parameters) {
  if (!configured) throw new Error("Сервис ещё не подключён. Сообщите администратору команды.");
  const response = await fetch(`${apiUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "apikey": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ p_code: teamCode, ...parameters })
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new Error(body?.message || `Ошибка сервера (${response.status})`);
  if (!body || !Array.isArray(body.active) || !Array.isArray(body.requests) || !Array.isArray(body.history)) {
    throw new Error("Сервер вернул неполные данные. Повторите попытку.");
  }
  return body;
}

async function telegramApi(route, params = {}) {
  const response = await fetch(`${telegramApiUrl}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: telegramAuth, params })
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401) {
    telegramAuth = null;
    profile = null;
    loaded = false;
    localStorage.removeItem("stand-tracker-telegram-auth");
    accessScreen.hidden = false;
    $("#lockButton").hidden = true;
    render();
  }
  if (!response.ok) throw new Error(body?.message || `Ошибка сервера (${response.status})`);
  return body;
}

function renderCard(stand) {
  const session = tracker.active.find((item) => item.stand_code === stand);
  const request = tracker.requests.find((item) => item.stand_code === stand);
  const kind = !loaded ? "unavailable" : session ? "busy" : "free";
  const status = !loaded ? "Нет данных" : session ? "Занят" : "Свободен";
  const purpose = session?.purpose ? escapeHtml(session.purpose) : "";
  const priority = session ? PRIORITIES[session.priority] || PRIORITIES.normal : null;
  const plannedEnd = session?.planned_end_at ?
    `<div class="metric"><span class="metric-label">План освободить</span><span class="metric-value ${new Date(session.planned_end_at) < new Date() ? "late" : ""}">${dateTime(session.planned_end_at)}</span></div>` : "";
  const requestNote = request ?
    `<div class="request-note"><strong>${escapeHtml(request.requester_name)}</strong> просит освободить до <strong>${dateTime(request.needed_by)}</strong><br>${escapeHtml(request.reason)}</div>` : "";
  const canRelease = loginMode !== "telegram" || !session?.occupant_member_id || session.occupant_member_id === profile?.id;
  const canWithdraw = loginMode !== "telegram" || !request?.requester_member_id || request.requester_member_id === profile?.id;
  const canRequest = loginMode !== "telegram" || session?.occupant_member_id !== profile?.id;
  const buttons = !loaded ? "" : !session ?
    `<button class="primary-button" data-action="claim" data-stand="${stand}" type="button">Занять стенд</button>` :
    `${canRelease ? `<button class="primary-button" data-action="release" data-stand="${stand}" type="button">Освободить</button>` : ""}
     ${request ? canWithdraw ? `<button class="text-button" data-action="withdraw" data-stand="${stand}" type="button">Снять запрос</button>` : "" : canRequest ? `<button class="secondary-button" data-action="request" data-stand="${stand}" type="button">Попросить освободить</button>` : ""}`;
  return `<article class="stand-card ${kind}">
    <div class="card-head"><h3 class="stand-code">${stand}</h3><span class="status-badge ${session ? "busy" : !loaded ? "off" : ""}">${status}</span></div>
    <p class="occupant">${!loaded ? "Ожидание подключения" : session ? escapeHtml(session.occupant_name) : "Никого нет"}</p>
    <p class="purpose">${!loaded ? "Состояние появится после подключения" : session ? purpose || "Причина работы не указана" : "Можно занять сейчас"}</p>
    ${priority ? `<span class="priority-badge ${priority.className}" title="Приоритет задачи">${priority.label} приоритет</span>` : ""}
    ${session ? `<div class="card-metrics">
      <div class="metric"><span class="metric-label">С какого времени</span><span class="metric-value">${dateTime(session.started_at)}</span></div>
      <div class="metric"><span class="metric-label">На стенде</span><span class="metric-value" data-started-at="${escapeHtml(session.started_at)}">${elapsed(session.started_at)}</span></div>
      ${plannedEnd}
    </div>` : ""}
    ${requestNote}<div class="card-actions">${buttons}</div>
  </article>`;
}

function renderHistory() {
  if (!loaded) {
    historyList.innerHTML = `<div class="history-empty">История появится после подключения.</div>`;
    return;
  }
  if (!tracker.history.length) {
    historyList.innerHTML = `<div class="history-empty">Пока нет завершённых сеансов. После освобождения стенда здесь появится запись с длительностью работы.</div>`;
    return;
  }
  historyList.innerHTML = tracker.history.map((item) => `<div class="history-row">
    <span class="history-code">${escapeHtml(item.stand_code)}</span>
    <span class="history-name">${escapeHtml(item.occupant_name)}${item.purpose ? ` · ${escapeHtml(item.purpose)}` : ""}<small class="history-priority">${(PRIORITIES[item.priority] || PRIORITIES.normal).label} приоритет</small></span>
    <span class="history-time">${dateTime(item.started_at)} — ${dateTime(item.ended_at)}</span>
    <span class="history-duration">${elapsed(new Date(item.ended_at) - new Date(item.started_at), false)}</span>
  </div>`).join("");
}

function render() {
  standGrid.innerHTML = STANDS.map(renderCard).join("");
  renderHistory();
  $("#busyCount").textContent = loaded ? String(tracker.active.length) : "—";
  if (loaded) $("#lastUpdated").textContent = `Обновлено ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
}

function applyState(data) {
  tracker = data;
  if (data.profile) profile = data.profile;
  loaded = true;
  setConnection("Обновляется", "online");
  render();
}

async function refresh() {
  if ((loginMode === "telegram" ? !telegramAuth : !teamCode) || pending || document.hidden) return;
  const epoch = requestEpoch;
  try {
    const data = loginMode === "telegram" ? await telegramApi("state") : await rpc("get_tracker_state", {});
    if (epoch === requestEpoch && !pending) applyState(data);
  } catch (error) {
    if (epoch === requestEpoch) setConnection(loginMode === "telegram" && !telegramAuth ? "Войдите снова" : "Нет связи", "offline");
  }
}

function rememberName(name) {
  localStorage.setItem("stand-tracker-name", name);
}

function openDialog(type, stand) {
  if (!STANDS.includes(stand) || pending) return;
  action = { type, stand };
  const session = tracker.active.find((item) => item.stand_code === stand);
  const name = escapeHtml(localStorage.getItem("stand-tracker-name") || "");
  const nameField = loginMode === "telegram"
    ? `<p class="profile-caption">От вашего имени: ${escapeHtml(profile?.name || "")}</p>`
    : `<div><label for="personName">Ваше имя</label><input id="personName" name="personName" maxlength="80" value="${name}" autocomplete="name" required /></div>`;
  $("#dialogEyebrow").textContent = `СТЕНД ${stand}`;
  $("#dialogError").textContent = "";
  let title, description, fields, submit;
  if (type === "claim") {
    title = "Занять стенд";
    description = "Время начала зафиксируется автоматически.";
    fields = `${nameField}
      <div><label for="purpose">Чем занимаетесь</label><input id="purpose" name="purpose" maxlength="200" placeholder="Например, ПСИ" /><span class="field-hint">Необязательно</span></div>
      <div><label for="priority">Приоритет задачи</label><select id="priority" name="priority" required><option value="low">Низкий — может подождать</option><option value="normal" selected>Обычный</option><option value="high">Высокий — срочно нужен стенд</option></select></div>
      <div><label for="plannedEnd">Планируете освободить</label><input id="plannedEnd" name="plannedEnd" type="datetime-local" min="${localDateInput(new Date(Date.now() + 60000))}" /><span class="field-hint">Необязательно. Это время увидят все.</span></div>`;
    submit = "Занять";
  } else if (type === "release") {
    title = "Освободить стенд";
    description = `Завершить работу ${session ? escapeHtml(session.occupant_name) : "на стенде"}? Время будет сохранено в истории.`;
    fields = nameField;
    submit = "Освободить";
  } else if (type === "request") {
    title = "Попросить освободить";
    description = "Коллега увидит время, к которому нужен стенд, и причину.";
    fields = `${nameField}
      <div><label for="neededBy">Когда нужен стенд</label><input id="neededBy" name="neededBy" type="datetime-local" min="${localDateInput(new Date(Date.now() + 60000))}" value="${localDateInput(new Date(Date.now() + 3600000))}" required /></div>
      <div><label for="reason">Причина</label><textarea id="reason" name="reason" maxlength="300" placeholder="Например, срочная проверка платы" required></textarea></div>`;
    submit = "Отправить запрос";
  } else if (type === "withdraw") {
    title = "Снять запрос";
    description = "Запрос на освобождение будет убран у всех участников команды.";
    fields = "";
    submit = "Снять запрос";
  } else return;
  $("#dialogTitle").textContent = title;
  $("#dialogDescription").innerHTML = description;
  $("#dialogFields").innerHTML = fields;
  $("#submitDialog").textContent = submit;
  actionDialog.showModal();
  $("#personName")?.focus();
}

async function submitAction(event) {
  event.preventDefault();
  if (!action || pending) return;
  const { type, stand } = action;
  const fields = new FormData(actionForm);
  const name = loginMode === "telegram" ? profile?.name || "" : String(fields.get("personName") || "").trim();
  let rpcName, params;
  try {
    if (type === "claim") {
      const planned = String(fields.get("plannedEnd") || "");
      rpcName = "claim_stand_with_priority";
      params = { p_stand: stand, p_name: name, p_purpose: String(fields.get("purpose") || "").trim(), p_planned_end: planned ? new Date(planned).toISOString() : null, p_priority: String(fields.get("priority") || "") };
    } else if (type === "release") {
      rpcName = "release_stand";
      params = { p_stand: stand, p_actor: name };
    } else if (type === "request") {
      rpcName = "request_release";
      params = { p_stand: stand, p_name: name, p_needed_by: new Date(String(fields.get("neededBy"))).toISOString(), p_reason: String(fields.get("reason") || "").trim() };
    } else {
      rpcName = "withdraw_release_request";
      params = { p_stand: stand };
    }
  } catch {
    $("#dialogError").textContent = "Проверьте указанное время.";
    return;
  }
  $("#dialogError").textContent = "";
  $("#submitDialog").disabled = true;
  pending = true;
  requestEpoch += 1;
  try {
    let data;
    let notificationWarning = null;
    if (loginMode === "telegram") {
      const telegramParams = { stand };
      if (type === "claim") Object.assign(telegramParams, { purpose: params.p_purpose, plannedEnd: params.p_planned_end, priority: params.p_priority });
      if (type === "request") Object.assign(telegramParams, { neededBy: params.p_needed_by, reason: params.p_reason });
      const result = await telegramApi(type, telegramParams);
      data = result.state;
      notificationWarning = result.notificationWarning;
    } else {
      data = await rpc(rpcName, params);
      if (name) rememberName(name);
    }
    applyState(data);
    actionDialog.close();
    showToast(notificationWarning || { claim: "Стенд занят", release: "Стенд освобождён", request: "Запрос отправлен", withdraw: "Запрос снят" }[type]);
  } catch (error) {
    $("#dialogError").textContent = errorMessage(error);
    setConnection("Нет связи", "offline");
  } finally {
    pending = false;
    $("#submitDialog").disabled = false;
  }
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured) return;
  teamCode = $("#teamCode").value.trim();
  $("#accessError").textContent = "";
  $("#accessSubmit").disabled = true;
  try {
    const data = await rpc("get_tracker_state", {});
    if ($("#rememberCode").checked) localStorage.setItem("stand-tracker-code", teamCode);
    else localStorage.removeItem("stand-tracker-code");
    applyState(data);
    accessScreen.hidden = true;
    $("#lockButton").hidden = false;
  } catch (error) {
    teamCode = "";
    localStorage.removeItem("stand-tracker-code");
    $("#accessError").textContent = errorMessage(error);
    setConnection("Нет связи", "offline");
  } finally {
    $("#accessSubmit").disabled = false;
  }
});

$("#lockButton").addEventListener("click", () => {
  requestEpoch += 1;
  loaded = false;
  if (loginMode === "telegram") {
    telegramAuth = null;
    profile = null;
    localStorage.removeItem("stand-tracker-telegram-auth");
  } else {
    teamCode = "";
    localStorage.removeItem("stand-tracker-code");
    $("#teamCode").value = "";
    $("#rememberCode").checked = false;
  }
  $("#lockButton").hidden = true;
  accessScreen.hidden = false;
  setConnection("Закрыто");
  render();
  if (loginMode === "team") $("#teamCode").focus();
});

$("#legacyAccessButton").addEventListener("click", () => {
  loginMode = "team";
  telegramAuth = null;
  profile = null;
  $("#telegramAccess").hidden = true;
  accessForm.hidden = false;
  $("#lockButton").textContent = "Сменить код";
  $("#teamCode").focus();
});

window.onTelegramAuth = async (user) => {
  telegramAuth = user;
  $("#telegramError").textContent = "";
  try {
    const result = await telegramApi("auth");
    profile = result.profile;
    localStorage.setItem("stand-tracker-telegram-auth", JSON.stringify(user));
    const data = await telegramApi("state");
    applyState(data);
    accessScreen.hidden = true;
    $("#lockButton").textContent = "Выйти";
    $("#lockButton").hidden = false;
    if (result.notificationWarning) showToast(result.notificationWarning);
  } catch (error) {
    telegramAuth = null;
    profile = null;
    localStorage.removeItem("stand-tracker-telegram-auth");
    $("#telegramError").textContent = errorMessage(error);
  }
};

function startTelegramLogin(username) {
  loginMode = "telegram";
  botUsername = username;
  accessForm.hidden = true;
  $("#telegramAccess").hidden = false;
  $("#telegramBotLink").href = `https://t.me/${encodeURIComponent(botUsername)}`;
  $("#lockButton").textContent = "Выйти";
  const script = document.createElement("script");
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.setAttribute("data-telegram-login", botUsername);
  script.setAttribute("data-size", "large");
  script.setAttribute("data-radius", "10");
  script.setAttribute("data-request-access", "write");
  script.setAttribute("data-onauth", "onTelegramAuth(user)");
  $("#telegramWidget").append(script);
  const saved = localStorage.getItem("stand-tracker-telegram-auth");
  if (saved) {
    try { window.onTelegramAuth(JSON.parse(saved)); }
    catch { localStorage.removeItem("stand-tracker-telegram-auth"); }
  }
}

async function initialize() {
  if (!configured) {
    $("#accessError").textContent = "Сервис ещё подключается. Попросите администратора завершить настройку.";
    $("#accessSubmit").disabled = true;
    setConnection("Не подключено", "offline");
    return;
  }
  try {
    const response = await fetch(`${telegramApiUrl}/config`, { cache: "no-store" });
    const telegramConfig = response.ok ? await response.json() : null;
    if (telegramConfig?.enabled && /^[A-Za-z0-9_]{5,32}$/.test(telegramConfig.botUsername)) {
      startTelegramLogin(telegramConfig.botUsername);
      setConnection("Закрыто");
      return;
    }
  } catch { /* Shared-code access remains available while Telegram is being configured. */ }
  const saved = localStorage.getItem("stand-tracker-code");
  if (saved) {
    $("#teamCode").value = saved;
    $("#rememberCode").checked = true;
    accessForm.requestSubmit();
  } else {
    setConnection("Закрыто");
  }
}

standGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) openDialog(button.dataset.action, button.dataset.stand);
});
actionForm.addEventListener("submit", submitAction);
$("#closeDialog").addEventListener("click", () => actionDialog.close());
$("#cancelDialog").addEventListener("click", () => actionDialog.close());
actionDialog.addEventListener("close", () => { action = null; });

setInterval(() => {
  document.querySelectorAll("[data-started-at]").forEach((node) => {
    node.textContent = elapsed(node.dataset.startedAt);
  });
}, 1000);
setInterval(refresh, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

render();
initialize();
