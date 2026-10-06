import { chromium } from "npm:playwright-core";

const site = "http://localhost:8765/";
const api = "https://kegynudaiydthomudwzd.supabase.co/functions/v1/stand-tracker-api/";
const profile = { id: 1, name: "Глеб Сорвачев", username: "crysingzz" };
const emptyState = { active: [], requests: [], history: [], profile };
const token = "a".repeat(43);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage();
  let active: Record<string, unknown>[] = [];
  let rejectNextState = false;
  let rejectNextClaim = false;
  let delayNextClaim = false;
  let rejectNextNotice = false;
  let rejectNextLogout = false;
  let submittedPlannedEnd: unknown = undefined;
  let loginCount = 0;
  let beginCount = 0;
  let logoutCount = 0;
  let usedWidget = false;

  await page.route("https://telegram.org/**", (route) => { usedWidget = true; return route.abort(); });
  await page.route(`${api}**`, async (route) => {
    const action = route.request().url().slice(api.length).split("?")[0];
    const headers = { "Access-Control-Allow-Origin": "http://localhost:8765", "Access-Control-Allow-Headers": "content-type, authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let status = 200;
    let body: Record<string, unknown>;
    if (action === "config") body = { enabled: true, botUsername: "ouroboros_stands_tracker_bot" };
    else if (action === "request-code") {
      assert(route.request().postDataJSON().username === "crysingzz", "Selected profile must be sent to the server");
      beginCount++;
      body = { startToken: "b".repeat(43), browserToken: "c".repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString() };
    }
    else if (action === "complete-login") {
      const payload = route.request().postDataJSON();
      if (payload.code === "12345678") { loginCount++; body = { sessionToken: token, profile, expiresAt: new Date(Date.now() + 43200000).toISOString() }; }
      else { status = 400; body = { message: "Неверный код" }; }
    }
    else if (action === "logout") {
      if (rejectNextLogout) { rejectNextLogout = false; status = 503; body = { message: "Временная ошибка" }; }
      else { logoutCount++; body = { ok: true }; }
    }
    else if (action === "state") {
      assert(route.request().headers().authorization === `Bearer ${token}`, "Protected state needs session bearer");
      if (rejectNextState) {
        rejectNextState = false;
        status = 503;
        body = { message: "Временная ошибка" };
      } else body = { ...emptyState, active };
    } else if (action === "claim") {
      if (rejectNextClaim) { rejectNextClaim = false; status = 400; body = { message: "Стенд уже занят" }; }
      else {
        if (delayNextClaim) { delayNextClaim = false; await new Promise((resolve) => setTimeout(resolve, 700)); }
        const payload = route.request().postDataJSON();
        submittedPlannedEnd = payload.params.plannedEnd;
        active = [...active, { stand_code: payload.params.stand, occupant_name: profile.name, occupant_member_id: profile.id, purpose: payload.params.purpose, priority: payload.params.priority, planned_end_at: payload.params.plannedEnd, started_at: new Date().toISOString() }];
        body = { state: { ...emptyState, active }, notificationWarning: null };
      }
    } else if (action === "test-notification") {
      if (rejectNextNotice) {
        rejectNextNotice = false;
        status = 401;
        body = { message: "Сеанс истёк" };
      } else body = { delivered: true, notificationWarning: null };
    } else {
      status = 404;
      body = { message: "Неизвестное действие" };
    }
    await route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(site);
  await page.locator("#beginLogin").waitFor({ state: "visible" });
  assert(await page.locator("#accessForm").count() === 0, "Legacy login form must not exist");
  assert(await page.locator("#telegramWidget").count() === 0, "Telegram widget must not exist");
  assert(!usedWidget, "Telegram widget must never be fetched");
  assert(await page.locator("#accessScreen").isVisible(), "Login overlay must be visible initially");

  await page.locator("#loginProfile").selectOption("crysingzz");
  await page.locator("#beginLogin").click();
  await page.locator("#telegramBotLink").waitFor({ state: "visible" });
  assert((await page.locator("#telegramBotLink").getAttribute("href")) === "tg://resolve?domain=ouroboros_stands_tracker_bot", "First-time link must open only the bot, without a token");
  assert(await page.locator("#manualCommand").count() === 0, "No command must be copied into the bot");
  assert((await page.locator("#telegramStatus").textContent())?.includes("Проверьте чат"), "User should be told to check Telegram");
  await page.locator("#loginCode").fill("87654321");
  await page.locator("#submitCode").click();
  await page.getByText("Неверный код").waitFor();
  assert(await page.locator("#accessScreen").isVisible(), "Wrong code must not log in");
  await page.locator("#loginCode").fill("12345678");
  await page.locator("#submitCode").click();
  await page.locator("#accountName").getByText(profile.name).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Login overlay must close after auth and state");
  assert(await page.evaluate(() => sessionStorage.getItem("stand-tracker-session")) === token, "Only opaque site session must be stored");
  assert(loginCount === 1, "Correct code must complete login once");
  await page.reload();
  await page.locator("#accountName").getByText(profile.name).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Reload must restore a valid session");
  await page.locator("#lockButton").click();
  await page.locator("#beginLogin").waitFor({ state: "visible" });
  assert(await page.locator("#beginLogin").isVisible(), "Logout after reload must offer a new login");
  await page.locator("#beginLogin").click();
  await page.locator("#loginCode").fill("12345678");
  await page.locator("#submitCode").click();
  await page.locator("#accountName").getByText(profile.name).waitFor();

  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const size = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(size.page <= size.viewport, `No horizontal overflow at ${width}px: ${size.page}px`);
  }
  await page.setViewportSize({ width: 390, height: 800 });

  rejectNextState = true;
  await page.locator("#refreshButton").click();
  await page.locator("#connectionStatus.offline").getByText("Нет связи").waitFor();
  await page.locator("#refreshButton").click();
  await page.locator("#connectionStatus.online").getByText("На связи").waitFor();

  await page.getByRole("button", { name: "Занять стенд" }).first().click();
  rejectNextClaim = true;
  await page.locator("#submitDialog").click();
  await page.locator("#dialogError").getByText("Стенд уже занят").waitFor();
  assert(await page.locator("#connectionStatus.online").count() === 1, "Business conflict must not be labeled offline");
  await page.locator("#purpose").fill("Проверка");
  await page.locator("#priority").selectOption("high");
  assert(!(await page.locator("#plannedEndField").isVisible()), "Planned end must be collapsed initially");
  assert(await page.locator("#plannedEnd").inputValue() === "", "Planned end must start empty");
  await page.locator("#addPlannedEnd").click();
  assert(await page.locator("#plannedEndField").isVisible(), "Planned end must open on click");
  const future = await page.evaluate(() => {
    const date = new Date(Date.now() + 3_600_000);
    const part = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
  });
  await page.locator("#plannedEnd").fill(future);
  await page.locator("#clearPlannedEnd").click();
  assert(!(await page.locator("#plannedEndField").isVisible()), "Clear must collapse planned end");
  assert(await page.locator("#plannedEnd").inputValue() === "", "Clear must remove the selected time");
  delayNextClaim = true;
  await page.locator("#submitDialog").click();
  assert(await page.locator("#closeDialog").isDisabled(), "Close must be disabled while saving");
  assert(await page.locator("#cancelDialog").isDisabled(), "Cancel must be disabled while saving");
  await page.keyboard.press("Escape");
  assert(await page.locator("#actionDialog").evaluate((dialog: HTMLDialogElement) => dialog.open), "Escape must not hide an action in progress");
  await page.getByText("Высокий приоритет").waitFor();
  assert((await page.locator(".stand-card.busy").count()) === 1, "Claim must update the stand");
  assert(submittedPlannedEnd === null, "Claim after clearing time must send null");

  await page.getByRole("button", { name: "Занять стенд" }).first().click();
  await page.locator("#addPlannedEnd").click();
  await page.locator("#plannedEnd").fill(future);
  await page.locator("#submitDialog").click();
  assert(typeof submittedPlannedEnd === "string" && !Number.isNaN(Date.parse(submittedPlannedEnd)), "Selected planned end must reach the API");
  await page.getByText("План освободить").waitFor();

  rejectNextNotice = true;
  await page.locator("#testNotification").click();
  await page.locator("#telegramStatus").getByText("Сеанс завершился", { exact: false }).waitFor();
  assert(await page.locator("#accessScreen").isVisible(), "Expired auth must return to login");
  assert(!(await page.locator("#accountName").isVisible()), "Expired auth must hide profile");
  assert(await page.evaluate(() => sessionStorage.getItem("stand-tracker-session")) === null, "Expired session must be cleared");

  rejectNextState = true;
  await page.locator("#beginLogin").click();
  await page.locator("#loginCode").fill("12345678");
  await page.locator("#submitCode").click();
  await page.locator("#telegramStatus").getByText("стенды пока не загрузились", { exact: false }).waitFor();
  assert(await page.locator("#accessScreen").isVisible(), "State failure must keep login overlay");
  await page.locator("#telegramRetry").click();
  await page.locator("#accountName").getByText(profile.name).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Retry must reuse valid site session");

  rejectNextLogout = true;
  await page.locator("#lockButton").click();
  await page.getByText("Не удалось завершить сеанс", { exact: false }).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Failed revoke must keep session visible");
  await page.locator("#lockButton").click();
  await page.locator("#accessScreen").waitFor({ state: "visible" });
  assert(await page.locator("#accessScreen").isVisible(), "Logout must show login overlay");
  assert(await page.evaluate(() => sessionStorage.getItem("stand-tracker-session")) === null, "Logout must remove the site session");
  assert(logoutCount === 2, "Both logouts must revoke their server sessions");

  await page.addInitScript(() => {
    for (const key of ["getItem", "setItem", "removeItem"] as const) {
      Object.defineProperty(Storage.prototype, key, { configurable: true, value() { throw new DOMException("Storage blocked", "SecurityError"); } });
    }
  });
  await page.reload();
  await page.locator("#beginLogin").waitFor({ state: "visible" });
  await page.locator("#loginProfile").selectOption("crysingzz");
  const previousBegins = beginCount;
  await page.evaluate(() => { document.querySelector<HTMLButtonElement>("#beginLogin")!.click(); document.querySelector<HTMLButtonElement>("#beginLogin")!.click(); });
  await page.locator("#telegramBotLink").waitFor({ state: "visible" });
  assert(beginCount === previousBegins + 1, "Double click must create one challenge");
  await page.locator("#loginCode").fill("12345678");
  await page.locator("#submitCode").click();
  await page.locator("#accountName").getByText(profile.name).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Login must work with blocked browser storage");
  await page.getByText("Браузер не сохранил сеанс", { exact: false }).waitFor();
  console.log("PASS: bot-code login, blocked storage, mobile layout, refresh, conflicts, optional planned end, expiry, retry, revoked logout");
} finally {
  await browser.close();
}
