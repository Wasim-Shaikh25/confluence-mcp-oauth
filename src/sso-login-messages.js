/**
 * Shared stderr + MCP text for Playwright SSO when automation or IdP redirects fail.
 * @param {{ patEnvKey: string; cookieFile: string; logPrefix: string }} p
 */
export function logSsoFallbackToStderr(p) {
  const { patEnvKey, cookieFile, logPrefix } = p;
  console.error(
    `${logPrefix} If REST still returns 401 or the browser never reached your app: use ${patEnvKey} in mcp.json and set PREFER_SSO_COOKIES=0, or delete the cookie file below and retry. Allow pop-ups; disable blockers for the automation window.`
  );
  console.error(`${logPrefix} Cookie file: ${cookieFile}`);
}

/**
 * User-visible block after confluence_login / jira_login (MCP tool result).
 * @param {{ patEnvKey: string; cookieFile: string; cookieCount: number; sessionProbeOk: boolean }} p
 */
export function buildLoginToolResultText(p) {
  const { patEnvKey, cookieFile, cookieCount, sessionProbeOk } = p;
  const lines = [
    `Cookie file: ${cookieFile}`,
    `Cookies captured: ${cookieCount}`,
    `REST session probe (${sessionProbeOk ? "OK before save" : "not confirmed — cookies may still work or may be empty"})`,
    "",
    "If tools still get 401 or SSO never completed in the browser:",
    `- Set ${patEnvKey} in Cursor mcp.json for this server and add PREFER_SSO_COOKIES=0 (uses the token instead of cookies).`,
    `- Or delete the cookie file above and run login again after closing extra tabs / allowing pop-ups.`,
    "",
    "You can use search, read, and (if permitted) create/update tools when authentication succeeds.",
  ];
  if (cookieCount === 0) {
    lines.splice(
      4,
      0,
      "",
      "WARNING: No cookies were written. SSO likely did not finish on the Confluence origin. Prefer PAT + PREFER_SSO_COOKIES=0 until browser login works.",
      ""
    );
  }
  return lines.join("\n");
}
