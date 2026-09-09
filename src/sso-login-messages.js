/**
 * Shared stderr + MCP text for Playwright SSO when automation or IdP redirects fail.
 * Auth is SSO-cookie only, so guidance is about completing/retrying SSO.
 * @param {{ cookieFile: string; logPrefix: string }} p
 */
export function logSsoFallbackToStderr(p) {
  const { cookieFile, logPrefix } = p;
  console.error(
    `${logPrefix} If REST still returns 401 or the browser never reached your app: delete the cookie file below and retry, completing SSO fully in the opened window. Allow pop-ups; disable blockers for the automation window.`
  );
  console.error(`${logPrefix} Cookie file: ${cookieFile}`);
}

/**
 * User-visible block after confluence_login (MCP tool result).
 * @param {{ cookieFile: string; cookieCount: number; sessionProbeOk: boolean }} p
 */
export function buildLoginToolResultText(p) {
  const { cookieFile, cookieCount, sessionProbeOk } = p;
  const lines = [
    `Cookie file: ${cookieFile}`,
    `Cookies captured: ${cookieCount}`,
    `REST session probe (${sessionProbeOk ? "OK before save" : "not confirmed — cookies may still work or may be empty"})`,
    "",
    "If tools still get 401 or SSO never completed in the browser:",
    `- Delete the cookie file above and run login again after closing extra tabs / allowing pop-ups.`,
    "",
    "You can use search, read, and (if permitted) create/update tools when authentication succeeds.",
  ];
  if (cookieCount === 0) {
    lines.splice(
      4,
      0,
      "",
      "WARNING: No cookies were written. SSO likely did not finish on the Confluence origin. Re-run login and complete SSO in the opened window.",
      ""
    );
  }
  return lines.join("\n");
}
