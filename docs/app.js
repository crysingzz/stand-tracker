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

let sessionToken = null;
let loginChallenge = null;
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
  sessionToken = null;
  loginChallenge = null;
  sessionStorage.removeItem("stand-tracker-session");
  profile = null;
  loaded = false;
  if (actionDialog.open) actionDialog.close();
  accessScreen.hidden = false;
  $("#lockButton").hidden = true;
  $("#testNotification").hidden = true;
  $("#accountName").hidden = true;
  $("#telegramStatus").textContent = message;
  $("#codeStep").hidden = true;
  $("#telegramBotLink").hidden = true;
  $("#telegramBotLink").removeAttribute("href");
  $("#manualCommand").textContent = "";
  $("#loginCode").value = "";
  $("#beginLogin").hidden = !botUsername;
  $("#telegramRetry").hidden = true;
  setConnection("Нужен вход", "offline");
  render();
}

async function telegramApi(route, payload = {}, protectedRoute = true) {
  const response = await fetch(`${telegramApiUrl}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(protectedRoute && sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
    body: JSON.stringify(payload)
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (response.status === 401 && protectedRoute) {
    showLogin("Сеанс завершился. Получите новый код в Telegram.");
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
  if (!sessionToken || pending || document.hidden) return;
  const epoch = requestEpoch;
  try {
    const data = await telegramApi("state");
    if (epoch === requestEpoch && !pending) applyState(data);
  } catch (error) {
    if (epoch === requestEpoch) setConnection(!sessionToken ? "Войдите снова" : "Нет связи", "offline");
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
      <div class="planned-end-control">
        <span class="field-label">Планируете освободить</span>
        <button id="addPlannedEnd" class="secondary-button" type="button" aria-controls="plannedEndField" aria-expanded="false">Указать время</button>
        <div id="plannedEndField" class="planned-end-field" hidden>
          <label for="plannedEnd">Когда освободите</label>
          <input id="plannedEnd" name="plannedEnd" type="datetime-local" min="${localDateInput(new Date(Date.now() + 60000))}" value="" autocomplete="off" />
          <button id="clearPlannedEnd" class="text-button" type="button">Убрать время</button>
          <span class="field-hint">Необязательно. Это время увидят все.</span>
        </div>
      </div>`;
    submit = "Занять";
  } else if (type === "release") {
    title = "Освободить стенд";
    description = session?.occupant_member_id
      ? `Завершить работу ${escapeHtml(session.occupant_name)}? Время будет сохранено в истории.`
      : "Это старая запись без подтверждённого владельца. Любой участник команды может закрыть её; время останется в истории.";
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
    const result = await telegramApi(type, { params });
    applyState(result.state);
    actionDialog.close();
    showToast(result.notificationWarning || { claim: "Стенд занят", release: "Стенд освобождён", request: "Запрос отправлен", withdraw: "Запрос снят" }[type]);
  } catch (error) {
    if (sessionToken) {
      $("#dialogError").textContent = errorMessage(error);
      setConnection("Нет связи", "offline");
    }
  } finally {
    pending = false;
    $("#submitDialog").disabled = false;
  }
}

function showTracker() {
  accessScreen.hidden = true;
  $("#lockButton").hidden = false;
  $("#testNotification").hidden = false;
  $("#accountName").textContent = profile.name;
  $("#accountName").hidden = false;
}

async function beginLogin() {
  const button = $("#beginLogin");
  button.disabled = true;
  $("#telegramError").textContent = "";
  $("#telegramStatus").textContent = "Готовим одноразовую ссылку…";
  try {
    const challenge = await telegramApi("begin-login", {}, false);
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge.startToken) ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge.browserToken) ||
        challenge.startLink !== `https://t.me/${botUsername}?start=${challenge.startToken}`) throw new Error("Сервер вернул неверную ссылку");
    loginChallenge = challenge;
    $("#telegramBotLink").href = `tg://resolve?domain=${botUsername}&start=${challenge.startToken}`;
    $("#telegramBotLink").hidden = false;
    $("#manualBotName").textContent = `@${botUsername}`;
    $("#manualCommand").textContent = `/start ${challenge.startToken}`;
    $("#codeStep").hidden = false;
    $("#telegramRetry").hidden = false;
    $("#telegramRetry").textContent = "Запросить новую ссылку";
    $("#beginLogin").hidden = true;
    $("#loginCode").value = "";
    $("#telegramStatus").textContent = "Откройте приложение Telegram, нажмите Start в чате бота и введите код из личного сообщения.";
  } catch (error) {
    $("#telegramStatus").textContent = "Не удалось подготовить вход.";
    $("#telegramError").textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

$("#beginLogin").addEventListener("click", beginLogin);
$("#copyCommand").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#manualCommand").textContent);
    showToast("Команда скопирована. Отправьте её в личный чат бота.");
  } catch {
    showToast("Не удалось скопировать автоматически. Выделите команду вручную.");
  }
});
$("#codeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!loginChallenge || signingIn) return;
  signingIn = true;
  $("#submitCode").disabled = true;
  $("#telegramError").textContent = "";
  try {
    const result = await telegramApi("complete-login", {
      startToken: loginChallenge.startToken,
      browserToken: loginChallenge.browserToken,
      code: $("#loginCode").value.trim(),
    }, false);
    sessionToken = result.sessionToken;
    profile = result.profile;
    sessionStorage.setItem("stand-tracker-session", sessionToken);
    loginChallenge = null;
    $("#loginCode").value = "";
    $("#manualCommand").textContent = "";
    try {
      applyState(await telegramApi("state"));
      showTracker();
    } catch (error) {
      if (sessionToken) {
        $("#telegramStatus").textContent = "Вход выполнен, но стенды пока не загрузились.";
        $("#telegramError").textContent = errorMessage(error);
        $("#telegramRetry").textContent = "Повторить загрузку";
        $("#telegramRetry").hidden = false;
        $("#codeStep").hidden = true;
      }
    }
  } catch (error) {
    $("#telegramError").textContent = errorMessage(error);
  } finally {
    signingIn = false;
    $("#submitCode").disabled = false;
  }
});

$("#lockButton").addEventListener("click", async () => {
  const button = $("#lockButton");
  button.disabled = true;
  try {
    await telegramApi("logout");
    showLogin("Вы вышли. Для нового входа получите код в Telegram.");
  } catch (error) {
    if (sessionToken) showToast(`Не удалось завершить сеанс: ${errorMessage(error)}`);
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  localStorage.removeItem("stand-tracker-telegram-auth");
  localStorage.removeItem("stand-tracker-code");
  if (!configured) {
    $("#telegramError").textContent = "Сервис ещё подключается. Попросите администратора завершить настройку.";
    $("#telegramStatus").textContent = "Вход временно недоступен.";
    setConnection("Не подключено", "offline");
    return;
  }
  sessionToken = sessionStorage.getItem("stand-tracker-session");
  if (sessionToken) {
    try {
      applyState(await telegramApi("state"));
      showTracker();
      return;
    } catch (error) {
      if (sessionToken) {
        $("#telegramStatus").textContent = "Не удалось загрузить стенды.";
        $("#telegramError").textContent = errorMessage(error);
        $("#telegramRetry").textContent = "Повторить загрузку";
        $("#telegramRetry").hidden = false;
        setConnection("Нет связи", "offline");
        return;
      }
    }
  }
  try {
    const response = await fetch(`${telegramApiUrl}/config`, { cache: "no-store" });
    const telegramConfig = response.ok ? await response.json() : null;
    if (telegramConfig?.enabled && /^[A-Za-z0-9_]{5,32}$/.test(telegramConfig.botUsername)) {
      botUsername = telegramConfig.botUsername;
      $("#telegramStatus").textContent = "Нажмите кнопку, чтобы получить код в Telegram.";
      $("#beginLogin").hidden = false;
      $("#telegramRetry").hidden = true;
      setConnection("Нужен вход", "offline");
      return;
    }
  } catch { /* No insecure fallback. */ }
  $("#telegramStatus").textContent = "Вход через Telegram сейчас недоступен.";
  $("#telegramError").textContent = "Не удалось подключиться к сервису. Повторите попытку или сообщите администратору.";
  $("#telegramRetry").textContent = "Повторить подключение";
  $("#telegramRetry").hidden = false;
  setConnection("Нет связи", "offline");
}

$("#telegramRetry").addEventListener("click", async () => {
  $("#telegramError").textContent = "";
  if (sessionToken) {
    try {
      applyState(await telegramApi("state"));
      showTracker();
    } catch (error) {
      if (sessionToken) $("#telegramError").textContent = errorMessage(error);
    }
  } else if (botUsername) await beginLogin();
  else await initialize();
});

$("#testNotification").addEventListener("click", async () => {
  const button = $("#testNotification");
  button.disabled = true;
  try {
    const result = await telegramApi("test-notification");
    showToast(result.notificationWarning || "Проверочное сообщение отправлено вам в Telegram.");
  } catch (error) {
    if (sessionToken) showToast(errorMessage(error));
  } finally {
    button.disabled = false;
  }
});

standGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) openDialog(button.dataset.action, button.dataset.stand);
});
actionForm.addEventListener("submit", submitAction);
actionDialog.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("#addPlannedEnd, #clearPlannedEnd");
  if (!button) return;
  const field = $("#plannedEndField");
  const input = $("#plannedEnd");
  const addButton = $("#addPlannedEnd");
  if (button.id === "addPlannedEnd") {
    field.hidden = false;
    addButton.hidden = true;
    addButton.setAttribute("aria-expanded", "true");
    input.focus();
    try { input.showPicker?.(); } catch { /* Native picker is optional. */ }
  } else {
    input.value = "";
    field.hidden = true;
    addButton.hidden = false;
    addButton.setAttribute("aria-expanded", "false");
    addButton.focus();
  }
});
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
