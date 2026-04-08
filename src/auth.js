import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { withCookieFileLockSync } from "./cookie-lock.js";
import { buildLoginToolResultText, logSsoFallbackToStderr } from "./sso-login-messages.js";

const LOG = "[confluence-mcp]";

/**
 * `page.evaluate` throws if a navigation happens mid-call (typical during IdP / SSO redirects).
 * Treat as "not ready yet" so the login poll continues instead of aborting the whole tool.
 * @param {import('playwright').Page} page
 * @param {() => Promise<boolean>} runEvaluate
 */
async function probeSessionWithNavigationGuard(page, runEvaluate) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    return await runEvaluate();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /Execution context was destroyed|most likely because of a navigation/i.test(msg) ||
      /Target page, context or browser has been closed/i.test(msg)
    ) {
      return false;
    }
    throw e;
  }
}

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
        `${LOG} CONFLUENCE_LOGIN_URL host (${loginHost}) differs from CONFLUENCE_BASE_URL host (${baseHost}).`
      );
      console.error(
        `${LOG} Using Confluence login entry instead so SSO round-trips through Confluence: ${fallback}`
      );
      login = fallback;
    }
  } catch {
    // keep CONFIG.LOGIN_URL
  }
  return login;
}

/**
 * Probe REST from the page (same origin cookies) to detect login without waiting full LOGIN_WAIT_MS.
 * Must not use `response.ok` alone: unauthenticated calls may follow redirects to a login page that
 * returns HTTP 200 + HTML, which would falsely signal "ready" and close the browser immediately.
 */
async function confluenceSessionLooksReady(page) {
  const base = CONFIG.CONFLUENCE_BASE_URL.replace(/\/$/, "");
  return probeSessionWithNavigationGuard(page, () =>
    page.evaluate(async (b) => {
      try {
        const r = await fetch(`${b}/rest/api/user/current`, { credentials: "include" });
        if (!r.ok) return false;
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("json")) return false;
        const text = await r.text();
        if (text.trim().startsWith("<")) return false;
        const data = JSON.parse(text);
        if (!data || typeof data !== "object") return false;
        return Boolean(
          data.username ||
            data.accountId ||
            data.email ||
            data.displayName ||
            data.userKey
        );
      } catch {
        return false;
      }
    }, base)
  );
}

/**
 * Opens a browser so the user can complete SSO; stores Playwright cookie export for REST calls.
 * Polls the REST API and saves as soon as the session works (does not always wait the full timeout).
 * @returns {{ cookiePath: string; cookieCount: number; sessionProbeOk: boolean }}
 */
export async function loginWithSSO() {
  fs.mkdirSync(path.dirname(CONFIG.COOKIE_FILE), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  let ready = false;
  let cookies = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const entryUrl = resolveLoginEntryUrl();

    console.error(`${LOG} Opening browser for SSO login...`);
    console.error(`${LOG} Entry: ${entryUrl}`);
    await page.goto(entryUrl, {
      waitUntil: "domcontentloaded",
      timeout: 180_000,
    });

    console.error(
      `${LOG} Complete SSO in this window. Waiting until Confluence REST accepts the session (or timeout)...`
    );
    const deadline = Date.now() + CONFIG.LOGIN_WAIT_MS;
    /** First probe only after login/redirect paint — avoids racing domcontentloaded with a false read. */
    await new Promise((r) => setTimeout(r, Math.min(1500, CONFIG.LOGIN_POLL_MS)));

    while (Date.now() < deadline) {
      if (await confluenceSessionLooksReady(page)) {
        ready = true;
        console.error(`${LOG} Session detected (REST /user/current OK). Saving cookies...`);
        break;
      }
      await new Promise((r) => setTimeout(r, CONFIG.LOGIN_POLL_MS));
    }

    if (!ready) {
      console.error(
        `${LOG} REST did not confirm login within ${CONFIG.LOGIN_WAIT_MS / 1000}s — loading base URL once more to capture cookies anyway.`
      );
    }

    console.error(`${LOG} Loading ${CONFIG.CONFLUENCE_BASE_URL} to capture Confluence cookies...`);
    try {
      await page.goto(CONFIG.CONFLUENCE_BASE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
    } catch (e) {
      console.error(`${LOG} Warning: final Confluence load failed:`, e?.message ?? e);
    }

    cookies = await context.cookies();
    withCookieFileLockSync(CONFIG.COOKIE_FILE, () => {
      fs.writeFileSync(CONFIG.COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf8");
    });

    if (!Array.isArray(cookies) || cookies.length === 0) {
      console.error(
        `${LOG} WARNING: No cookies captured — SSO may not have completed on this origin (redirects, pop-up blockers, or IdP blocking automation).`
      );
      logSsoFallbackToStderr({
        patEnvKey: "CONFLUENCE_PAT (or CONFLUENCE_API_TOKEN)",
        cookieFile: CONFIG.COOKIE_FILE,
        logPrefix: LOG,
      });
    } else {
      console.error(`${LOG} Login complete. Session stored at`, CONFIG.COOKIE_FILE);
    }

    return {
      cookiePath: CONFIG.COOKIE_FILE,
      cookieCount: cookies.length,
      sessionProbeOk: ready,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG} Browser login error:`, msg);
    logSsoFallbackToStderr({
      patEnvKey: "CONFLUENCE_PAT (or CONFLUENCE_API_TOKEN)",
      cookieFile: CONFIG.COOKIE_FILE,
      logPrefix: LOG,
    });
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Text for MCP tool response after login (includes PAT / cookie-file troubleshooting).
 */
export function loginToolResultText(result) {
  return buildLoginToolResultText({
    patEnvKey: "CONFLUENCE_PAT (or CONFLUENCE_API_TOKEN)",
    cookieFile: result.cookiePath,
    cookieCount: result.cookieCount,
    sessionProbeOk: result.sessionProbeOk,
  });
}
