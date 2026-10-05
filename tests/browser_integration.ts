import { chromium } from "npm:playwright-core";

const site = "http://localhost:8765/";
const api = "https://kegynudaiydthomudwzd.supabase.co/functions/v1/stand-tracker-api/";
const profile = { id: 1, name: "Глеб Сорвачев", username: "crysingzz" };
const emptyState = { active: [], requests: [], history: [], profile };
const signedWidgetExample = { id: 123456, username: "crysingzz", auth_date: 1, hash: "test-only" };

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
  let rejectNextNotice = false;

  await page.route("https://telegram.org/js/telegram-widget.js?22", (route) => route.fulfill({
    status: 200, contentType: "application/javascript", body: "",
  }));
  await page.route(`${api}**`, async (route) => {
    const action = route.request().url().slice(api.length).split("?")[0];
    const headers = { "Access-Control-Allow-Origin": "http://localhost:8765", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let status = 200;
    let body: Record<string, unknown>;
    if (action === "config") body = { enabled: true, botUsername: "ouroboros_stands_tracker_bot" };
    else if (action === "auth") body = { profile, notificationWarning: null };
    else if (action === "state") {
      if (rejectNextState) {
        rejectNextState = false;
        status = 503;
        body = { message: "Временная ошибка" };
      } else body = { ...emptyState, active };
    } else if (action === "claim") {
      const payload = route.request().postDataJSON();
      active = [{ stand_code: payload.params.stand, occupant_name: profile.name, occupant_member_id: profile.id, purpose: payload.params.purpose, priority: payload.params.priority, started_at: new Date().toISOString() }];
      body = { state: { ...emptyState, active }, notificationWarning: null };
    } else if (action === "test-notification") {
      if (rejectNextNotice) {
        rejectNextNotice = false;
        status = 401;
        body = { message: "Подтверждение Telegram устарело" };
      } else body = { delivered: true, notificationWarning: null };
    } else {
      status = 404;
      body = { message: "Неизвестное действие" };
    }
    await route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(site);
  await page.locator("#telegramStatus").getByText("Подтвердите вход", { exact: false }).waitFor();
  assert(await page.locator("#accessForm").count() === 0, "Legacy login form must not exist");
  assert(await page.locator("#accessScreen").isVisible(), "Login overlay must be visible initially");

  await page.evaluate((example) => (window as any).onTelegramAuth(example), signedWidgetExample);
  await page.locator("#accountName").getByText(profile.name).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Login overlay must close after auth and state");
  assert(await page.evaluate(() => localStorage.getItem("stand-tracker-telegram-auth")) === null, "Signed auth must not be persisted");

  await page.getByRole("button", { name: "Занять стенд" }).first().click();
  await page.locator("#purpose").fill("Проверка");
  await page.locator("#priority").selectOption("high");
  await page.locator("#submitDialog").click();
  await page.getByText("Высокий приоритет").waitFor();
  assert((await page.locator(".stand-card.busy").count()) === 1, "Claim must update the stand");

  rejectNextNotice = true;
  await page.locator("#testNotification").click();
  await page.locator("#telegramStatus").getByText("устарело", { exact: false }).waitFor();
  assert(await page.locator("#accessScreen").isVisible(), "Expired auth must return to login");
  assert(!(await page.locator("#accountName").isVisible()), "Expired auth must hide profile");

  rejectNextState = true;
  await page.evaluate((example) => (window as any).onTelegramAuth(example), signedWidgetExample);
  await page.locator("#telegramStatus").getByText("подключён, но стенды", { exact: false }).waitFor();
  assert(await page.locator("#accessScreen").isVisible(), "State failure must keep login overlay");
  await page.locator("#telegramRetry").click();
  await page.locator("#accountName").getByText(profile.name).waitFor();
  assert(!(await page.locator("#accessScreen").isVisible()), "Retry must reuse valid in-memory auth");

  await page.locator("#lockButton").click();
  assert(await page.locator("#accessScreen").isVisible(), "Logout must show login overlay");
  assert(await page.evaluate(() => localStorage.getItem("stand-tracker-telegram-auth")) === null, "Logout must leave no signed auth on disk");
  console.log("PASS: login, claim, expired auth, transient state retry, logout, no legacy fallback");
} finally {
  await browser.close();
}
