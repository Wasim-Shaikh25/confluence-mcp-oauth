import { CONFIG } from "./config.js";
import { requestJson } from "./confluence.js";
import { deleteCookieFileSync } from "./cookie-lock.js";

/**
 * Background session keep-alive for Confluence SSO cookies.
 *
 * What this CAN do:
 *  - Periodically ping a lightweight REST endpoint (/rest/api/user/current) so
 *    Confluence keeps the session warm (inactivity timeouts are reset by use).
 *  - Detect when the session has gone stale (401/403) and warn on stderr.
 *  - Hard-delete the stale cookie file after N consecutive auth failures, so the
 *    next run starts clean (see CONFLUENCE_STALE_COOKIE_FAILS). Never deletes on a
 *    network error, and only after repeated auth rejections — a single blip is safe.
 *  - Pick up a fresher cookie automatically: cookies are read from disk on every
 *    request, so re-running confluence_login in another window is used with no restart.
 *
 * What this CANNOT do:
 *  - Silently re-authenticate against the SSO/IdP (that needs an interactive
 *    browser round-trip). When the session truly expires, run confluence_login again.
 *
 * Interval: CONFLUENCE_KEEPALIVE_SECONDS (default 120s). Set 0 to disable. After a
 * failed ping the loop retries quickly (CONFLUENCE_KEEPALIVE_RETRY_SECONDS, default
 * 15s) instead of waiting a full interval, so a transient blip cannot let it lapse.
 */

let timer = null;
let consecutiveFailures = 0;
let staleCookieDeleted = false;

function intervalMs() {
  const raw = parseInt(process.env.CONFLUENCE_KEEPALIVE_SECONDS || "120", 10);
  const secs = Number.isFinite(raw) ? raw : 120;
  return secs <= 0 ? 0 : Math.max(30, secs) * 1000;
}

/** Fast retry delay after a failed ping (keeps the session warm despite a blip). */
function retryMs() {
  const raw = parseInt(process.env.CONFLUENCE_KEEPALIVE_RETRY_SECONDS || "15", 10);
  const secs = Number.isFinite(raw) && raw > 0 ? raw : 15;
  return Math.max(5, secs) * 1000;
}

/** Consecutive auth failures before the stale cookie file is hard-deleted. Default 3; 0 disables. */
function staleCookieThreshold() {
  const raw = parseInt(process.env.CONFLUENCE_STALE_COOKIE_FAILS || "3", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

async function pingOnce() {
  try {
    await requestJson(`/rest/api/user/current`);
    if (consecutiveFailures > 0) {
      console.error("[confluence-mcp] Session keep-alive recovered — REST is responding again.");
    }
    consecutiveFailures = 0;
    staleCookieDeleted = false;
    return true;
  } catch (e) {
    consecutiveFailures += 1;
    const msg = e instanceof Error ? e.message : String(e);
    const isAuthFailure = /HTTP 401|HTTP 403/.test(msg) || /Unauthorized|expired|rejected/i.test(msg);
    if (isAuthFailure) {
      console.error(
        `[confluence-mcp] Session keep-alive: Confluence rejected the session (attempt ${consecutiveFailures}). ` +
          `The SSO cookie may have expired. Run the confluence_login tool again to refresh it.`
      );
      maybeDeleteStaleCookie();
    } else {
      consecutiveFailures -= 1; // don't let transient network blips trip the threshold
      console.error(
        `[confluence-mcp] Session keep-alive ping failed (network/other, not counted): ${msg}`
      );
    }
    return false;
  }
}

/** Hard-delete the cookie file only after N consecutive auth failures (safe against transient blips). */
function maybeDeleteStaleCookie() {
  const threshold = staleCookieThreshold();
  if (threshold === 0 || staleCookieDeleted) return;
  if (consecutiveFailures >= threshold) {
    const deleted = deleteCookieFileSync(CONFIG.COOKIE_FILE);
    staleCookieDeleted = true;
    if (deleted) {
      console.error(
        `[confluence-mcp] Deleted stale cookie file after ${consecutiveFailures} consecutive auth failures: ${CONFIG.COOKIE_FILE}. ` +
          `Run the confluence_login tool to re-authenticate.`
      );
    }
  }
}

/** Start the background keep-alive loop. Safe to call once at server startup. */
export function startCookieKeepAlive() {
  if (timer) return;
  const ms = intervalMs();
  if (ms === 0) {
    console.error("[confluence-mcp] Session keep-alive disabled (CONFLUENCE_KEEPALIVE_SECONDS=0).");
    return;
  }
  console.error(
    `[confluence-mcp] Session keep-alive every ${ms / 1000}s (SSO cookies), fast-retry ${retryMs() / 1000}s after a miss.`
  );
  const tick = async () => {
    const ok = await pingOnce();
    const next = ok ? ms : retryMs();
    timer = setTimeout(tick, next);
    if (typeof timer.unref === "function") timer.unref();
  };
  timer = setTimeout(tick, 1000);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopCookieKeepAlive() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
