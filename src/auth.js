import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

/**
 * Entry URL for login. Using the SSO portal host only (without visiting Confluence)
 * does not set cookies for the Confluence origin, so REST calls get 401.
 */
function resolveLoginEntryUrl() {
  const base = CONFIG.CONFLUENCE_BASE_URL;
  let login = CONFIG.LOGIN_URL;
  try {
    const baseHost = new URL(base).hostname;
    const loginHost = new URL(login).hostname;
    if (loginHost !== baseHost) {
      const fallback = `${base}/login.action`;
      console.error(
        `CONFLUENCE_LOGIN_URL host (${loginHost}) differs from CONFLUENCE_BASE_URL host (${baseHost}).`
      );
      console.error(
        `Using Confluence login entry instead so SSO round-trips through Confluence: ${fallback}`
      );
      login = fallback;
    }
  } catch {
    // keep CONFIG.LOGIN_URL
  }
  return login;
}

/**
 * Opens a browser so the user can complete SSO; stores Playwright cookie export for REST calls.
 */
export async function loginWithSSO() {
  fs.mkdirSync(path.dirname(CONFIG.COOKIE_FILE), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const entryUrl = resolveLoginEntryUrl();

  console.error("Opening browser for SSO login...");
  console.error(`Entry: ${entryUrl}`);
  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });

  console.error("Complete SSO until you are logged into Confluence in this window.");
  console.error(`Waiting up to ${CONFIG.LOGIN_WAIT_MS / 1000} seconds...`);

  await new Promise((resolve) => setTimeout(resolve, CONFIG.LOGIN_WAIT_MS));

  // Reload Confluence so session cookies for the REST API origin are present.
  console.error(`Loading ${CONFIG.CONFLUENCE_BASE_URL} to capture Confluence cookies...`);
  try {
    await page.goto(CONFIG.CONFLUENCE_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
  } catch (e) {
    console.error("Warning: final Confluence load failed:", e?.message ?? e);
  }

  const cookies = await context.cookies();
  fs.writeFileSync(CONFIG.COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf8");

  await browser.close();
  console.error("Login complete. Session stored at", CONFIG.COOKIE_FILE);
}
