const STANDS = ["AAV", "ALP", "OVD", "TVE"];
const PRIORITIES = {
  low: { label: "Низкий", className: "low" },
  normal: { label: "Обычный", className: "normal" },
  high: { label: "Высокий", className: "high" }
};
const config = window.STAND_TRACKER_CONFIG || {};
const apiUrl = String(config.supabaseUrl || "").replace(/\/+$/, "");
const telegramApiUrl = `${apiUrl}/functions/v1/stand-tracker-api`;
const configured = /^https:\/\//.test(apiUrl) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl);

const $ = (selector) => document.querySelector(selector);
const standGrid = $("#standGrid");
const historyList = $("#historyList");
const accessScreen = $("#accessScreen");
const actionDialog = $("#actionDialog");
const actionForm = $("#actionForm");

let telegramAuth = null;
let profile = null;
let botUsername = "";
let tracker = { active: [], requests: [], history: [] };
let loaded = false;
let pending = false;
let action = null;
let requestEpoch = 0;
let toastTimeout;
let signingIn = false;

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

function showLogin(message = "Войдите через Telegram.") {
  requestEpoch += 1;
  telegramAuth = null;
  profile = null;
  loaded = false;
  if (actionDialog.open) actionDialog.close();
  accessScreen.hidden = false;
  $("#lockButton").hidden = true;
  $("#testNotification").hidden = true;
  $("#accountName").hidden = true;
  $("#telegramStatus").textContent = message;
  $("#telegramRetry").hidden = false;
  setConnection("Нужен вход", "offline");
  render();
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
    showLogin("Подтверждение Telegram устарело. Нажмите «Повторить вход» и подтвердите его заново.");
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
  const canRelease = !session?.occupant_member_id || session.occupant_member_id === profile?.id;
  const canWithdraw = request?.requester_member_id === profile?.id;
  const canRequest = session?.occupant_member_id !== profile?.id;
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
  if (!data || !Array.isArray(data.active) || !Array.isArray(data.requests) || !Array.isArray(data.history)) {
    throw new Error("Сервер вернул неполные данные. Повторите попытку.");
  }
  tracker = data;
  if (data.profile) profile = data.profile;
  loaded = true;
  setConnection("Обновляется", "online");
  render();
}

async function refresh() {
  if (!telegramAuth || pending || document.hidden) return;
  const epoch = requestEpoch;
  try {
    const data = await telegramApi("state");
    if (epoch === requestEpoch && !pending) applyState(data);
  } catch (error) {
    if (epoch === requestEpoch) setConnection(!telegramAuth ? "Войдите снова" : "Нет связи", "offline");
  }
}

function openDialog(type, stand) {
  if (!STANDS.includes(stand) || pending) return;
  action = { type, stand };
  const session = tracker.active.find((item) => item.stand_code === stand);
  const nameField = `<p class="profile-caption">От вашего имени: ${escapeHtml(profile?.name || "")}</p>`;
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
}

async function submitAction(event) {
  event.preventDefault();
  if (!action || pending) return;
  const { type, stand } = action;
  const fields = new FormData(actionForm);
  let params;
  try {
    if (type === "claim") {
      const planned = String(fields.get("plannedEnd") || "");
      params = { stand, purpose: String(fields.get("purpose") || "").trim(), plannedEnd: planned ? new Date(planned).toISOString() : null, priority: String(fields.get("priority") || "") };
    } else if (type === "release") {
      params = { stand };
    } else if (type === "request") {
      params = { stand, neededBy: new Date(String(fields.get("neededBy"))).toISOString(), reason: String(fields.get("reason") || "").trim() };
    } else {
      params = { stand };
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
    const result = await telegramApi(type, params);
    applyState(result.state);
    actionDialog.close();
    showToast(result.notificationWarning || { claim: "Стенд занят", release: "Стенд освобождён", request: "Запрос отправлен", withdraw: "Запрос снят" }[type]);
  } catch (error) {
    if (telegramAuth) {
      $("#dialogError").textContent = errorMessage(error);
      setConnection("Нет связи", "offline");
    }
  } finally {
    pending = false;
    $("#submitDialog").disabled = false;
  }
}

$("#lockButton").addEventListener("click", () => {
  showLogin("Вы вышли из трекера. Для нового входа подтвердите Telegram.");
});

window.onTelegramAuth = async (user) => {
  if (signingIn) return;
  signingIn = true;
  const epoch = ++requestEpoch;
  telegramAuth = user;
  $("#telegramError").textContent = "";
  $("#telegramStatus").textContent = "Проверяем Telegram и загружаем стенды…";
  try {
    const result = await telegramApi("auth");
    if (epoch !== requestEpoch) return;
    profile = result.profile;
    const data = await telegramApi("state");
    if (epoch !== requestEpoch) return;
    applyState(data);
    accessScreen.hidden = true;
    $("#lockButton").hidden = false;
    $("#testNotification").hidden = false;
    $("#accountName").textContent = profile.name;
    $("#accountName").hidden = false;
    if (result.notificationWarning) showToast(result.notificationWarning);
  } catch (error) {
    if (epoch === requestEpoch && telegramAuth) {
      $("#telegramStatus").textContent = profile ? `Профиль «${profile.name}» подключён, но стенды пока не загрузились.` : "Не удалось войти.";
      $("#telegramError").textContent = errorMessage(error);
      $("#telegramRetry").hidden = false;
      setConnection("Нет связи", "offline");
    }
  } finally {
    signingIn = false;
  }
};

function startTelegramLogin(username) {
  botUsername = username;
  $("#telegramBotLink").href = `https://t.me/${encodeURIComponent(botUsername)}`;
  $("#telegramBotLink").hidden = false;
  $("#telegramStatus").textContent = "Подтвердите вход в Telegram. Если вы уже входили, Telegram может сразу передать подтверждение.";
  $("#telegramRetry").hidden = false;
  $("#telegramWidget").replaceChildren();
  const script = document.createElement("script");
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.setAttribute("data-telegram-login", botUsername);
  script.setAttribute("data-size", "large");
  script.setAttribute("data-radius", "10");
  script.setAttribute("data-request-access", "write");
  script.setAttribute("data-onauth", "onTelegramAuth(user)");
  script.onerror = () => { $("#telegramError").textContent = "Не удалось загрузить кнопку Telegram. Проверьте соединение и попробуйте снова."; };
  $("#telegramWidget").append(script);
}

async function initialize() {
  localStorage.removeItem("stand-tracker-telegram-auth");
  localStorage.removeItem("stand-tracker-code");
  if (!configured) {
    $("#telegramError").textContent = "Сервис ещё подключается. Попросите администратора завершить настройку.";
    $("#telegramStatus").textContent = "Вход временно недоступен.";
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
  } catch { /* Report unavailable configuration; never fall back to a shared secret. */ }
  $("#telegramStatus").textContent = "Вход через Telegram сейчас недоступен.";
  $("#telegramError").textContent = "Не удалось подключиться к сервису. Повторите попытку или сообщите администратору.";
  $("#telegramRetry").hidden = false;
  setConnection("Нет связи", "offline");
}

$("#telegramRetry").addEventListener("click", async () => {
  $("#telegramError").textContent = "";
  if (profile && telegramAuth) {
    try {
      applyState(await telegramApi("state"));
      accessScreen.hidden = true;
      $("#lockButton").hidden = false;
      $("#testNotification").hidden = false;
      $("#accountName").textContent = profile.name;
      $("#accountName").hidden = false;
      return;
    } catch (error) {
      if (telegramAuth) $("#telegramError").textContent = errorMessage(error);
    }
  }
  if (botUsername) startTelegramLogin(botUsername);
  else initialize();
});

$("#testNotification").addEventListener("click", async () => {
  const button = $("#testNotification");
  button.disabled = true;
  try {
    const result = await telegramApi("test-notification");
    showToast(result.notificationWarning || "Проверочное сообщение отправлено вам в Telegram.");
  } catch (error) {
    if (telegramAuth) showToast(errorMessage(error));
  } finally {
    button.disabled = false;
  }
});

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
