# Changelog

All notable changes to this project are documented here.

## 0.2.0

### Breaking changes

- **Removed token/PAT authentication.** Auth is now **SSO cookies only**. The
  environment variables `CONFLUENCE_PAT`, `CONFLUENCE_API_TOKEN`, and
  `PREFER_SSO_COOKIES` are no longer read and have no effect. Complete
  `confluence_login` once to authenticate; the saved session cookies are used for
  every REST call.
  - Migration: remove those keys from your `mcp.json` env, run the
    `confluence_login` tool, and complete SSO in the browser window.
  - Note: `CONFLUENCE_VISION_API_KEY` / `OPENAI_API_KEY` (for the optional
    `confluence_describe_attachment` vision helper) are unaffected — that is a
    separate third-party API, not Confluence auth.

### Added

- **Background session keep-alive.** While the server runs, a loop pings
  `/rest/api/user/current` on an interval to keep the Confluence SSO session warm
  and warns on stderr if the cookie goes stale. Configure with
  `CONFLUENCE_KEEPALIVE_SECONDS` (default 240; `0` disables).
- **Stale-cookie cleanup.** After several consecutive auth failures the keep-alive
  hard-deletes the stale cookie file so the next run starts clean. Threshold is
  `CONFLUENCE_STALE_COOKIE_FAILS` (default 3; `0` disables). Deletion never happens
  on a network error, and only after repeated auth rejections — a single transient
  blip will not remove a good session. SSO cookies cannot be renewed headlessly, so
  when the session truly expires, run `confluence_login` again.

### Changed

- Error messages and docs updated to reflect SSO-cookie-only auth.
