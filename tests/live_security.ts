const api = "https://kegynudaiydthomudwzd.supabase.co/functions/v1/stand-tracker-api";

async function expectStatus(name: string, path: string, status: number, origin?: string): Promise<void> {
  const response = await fetch(`${api}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== status) throw new Error(`${name}: expected ${status}, got ${response.status}`);
}

await expectStatus("anonymous state", "state", 401, "https://crysingzz.github.io");
await expectStatus("legacy login", "auth", 401, "https://crysingzz.github.io");
await expectStatus("unsigned webhook", "telegram-webhook", 403);
await expectStatus("foreign browser origin", "begin-login", 403, "https://example.com");
await expectStatus("missing profile", "request-code", 400, "https://crysingzz.github.io");

const config = await fetch(`${api}/config`, { signal: AbortSignal.timeout(15_000) });
const body = await config.json();
if (config.status !== 200 || body.enabled !== true || body.botUsername !== "ouroboros_stands_tracker_bot") {
  throw new Error("Telegram integration is unavailable");
}

console.log("PASS: live API denies unauthenticated and foreign requests; Telegram configuration is available");
