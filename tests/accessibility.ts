import AxeBuilder from "npm:@axe-core/playwright@4.13.0";
import { chromium } from "npm:playwright-core";

const site = "http://localhost:8765/";
const api = "https://kegynudaiydthomudwzd.supabase.co/functions/v1/stand-tracker-api/";
const profile = { id: 1, name: "Глеб Сорвачев", username: "crysingzz" };
const startToken = "b".repeat(43);
const browserToken = "c".repeat(43);

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  for (const width of [320, 390, 1280]) {
    for (const mode of ["login", "code", "dashboard", "dialog"] as const) {
      const context = await browser.newContext({ viewport: { width, height: 850 } });
      const page = await context.newPage();
      await page.route(`${api}**`, (route) => {
        const action = route.request().url().slice(api.length).split("?")[0];
        const body = action === "config"
          ? { enabled: true, botUsername: "ouroboros_stands_tracker_bot" }
          : action === "request-code"
          ? { startToken, browserToken, expiresAt: new Date(Date.now() + 300_000).toISOString() }
          : { active: [], requests: [], history: [], profile };
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "http://localhost:8765", "Access-Control-Allow-Headers": "content-type, authorization" },
          body: JSON.stringify(body),
        });
      });
      if (mode === "dashboard" || mode === "dialog") {
        await page.addInitScript(() => sessionStorage.setItem("stand-tracker-session", "a".repeat(43)));
      }
      await page.goto(site);
      if (mode === "code") {
        await page.locator("#loginProfile").selectOption("crysingzz");
        await page.locator("#beginLogin").click();
        await page.locator("#loginCode").waitFor({ state: "visible" });
      } else if (mode === "dashboard" || mode === "dialog") {
        await page.locator("#refreshButton").waitFor({ state: "visible" });
        if (mode === "dialog") await page.getByRole("button", { name: "Занять стенд" }).first().click();
      } else {
        await page.locator("#beginLogin").waitFor({ state: "visible" });
      }
      const { violations } = await new AxeBuilder({ page }).analyze();
      if (violations.length) {
        throw new Error(`${mode} ${width}px: ${violations.map((issue) => `${issue.id} (${issue.nodes.length})`).join(", ")}`);
      }
      const size = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
      if (size.page > size.viewport) throw new Error(`${mode} ${width}px: horizontal overflow ${size.page}px`);
      await context.close();
    }
  }
  console.log("PASS: accessibility and responsive layout in login, code, dashboard, and dialog states");
} finally {
  await browser.close();
}
