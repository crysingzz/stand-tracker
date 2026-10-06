import { chromium } from "npm:playwright-core";

const api = "https://kegynudaiydthomudwzd.supabase.co/functions/v1/stand-tracker-api/";
const profile = { id: 2, name: "Илья Скворцов", username: "fgtuioth" };
const token = "a".repeat(43);
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  let requests = 0;
  let started = false;
  await page.route(`${api}**`, async (route) => {
    const action = route.request().url().slice(api.length).split("?")[0];
    const headers = { "Access-Control-Allow-Origin": "http://localhost:8765", "Access-Control-Allow-Headers": "content-type, authorization" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let status = 200;
    let body: Record<string, unknown>;
    if (action === "config") body = { enabled: true, botUsername: "ouroboros_stands_tracker_bot" };
    else if (action === "request-code") {
      if (route.request().postDataJSON().username !== "fgtuioth") throw new Error("Wrong profile requested");
      requests++;
      body = { startToken: "b".repeat(43), browserToken: "c".repeat(43), expiresAt: new Date(Date.now() + 300_000).toISOString() };
    } else if (action === "complete-login") {
      if (!started) { status = 409; body = { message: "Сначала откройте бота в Telegram и нажмите Start, чтобы получить код" }; }
      else body = { sessionToken: token, profile, expiresAt: new Date(Date.now() + 43_200_000).toISOString() };
    } else if (action === "state") body = { active: [], requests: [], history: [], profile };
    else { status = 404; body = { message: "Неизвестное действие" }; }
    await route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("http://localhost:8765/");
  await page.locator("#beginLogin").waitFor({ state: "visible" });
  await page.locator("#beginLogin").click();
  if (requests !== 0) throw new Error("Login must require profile selection");
  await page.locator("#loginProfile").selectOption("fgtuioth");
  await page.locator("#beginLogin").click();
  await page.locator("#telegramBotLink").waitFor({ state: "visible" });
  if (requests !== 1) throw new Error("One click must request one code");
  if (await page.locator("#telegramBotLink").getAttribute("href") !== "tg://resolve?domain=ouroboros_stands_tracker_bot") {
    throw new Error("First-time setup must not require a pasted start token");
  }
  await page.locator("#loginCode").fill("12345678");
  await page.locator("#submitCode").click();
  await page.locator("#telegramError").getByText("нажмите Start", { exact: false }).waitFor();
  started = true;
  await page.locator("#submitCode").click();
  await page.locator("#accountName").getByText(profile.name).waitFor();
  if (await page.locator("#accessScreen").isVisible()) throw new Error("First-time login did not finish");
  console.log("PASS: first-time profile selection, plain bot Start, and code login");
} finally {
  await browser.close();
}
