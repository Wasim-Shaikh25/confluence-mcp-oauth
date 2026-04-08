# Confluence SSO MCP

A **[Model Context Protocol (MCP)](https://modelcontextprotocol.io/)** server for **Atlassian Confluence**. It connects **Cursor**, **Claude Desktop**, and other MCP clients to **whatever Confluence site you configure**—your company’s Data Center, a Cloud site (`*.atlassian.net`), or any host where the **Confluence REST API** is available and you can authenticate.

---

## See also (sibling projects)

| Project | Purpose |
|---------|---------|
| **Jira MCP** | [jira-mcp-auth](https://github.com/Wasim-Shaikh25/jira-mcp-auth) — Jira REST + optional SSO ([`jira-mcp-oauth`](https://www.npmjs.com/package/jira-mcp-oauth) on npm). Same PAT/cookie patterns as this server. |
| **GitHub Enterprise launcher** | [mcp-github-enterprise-launcher](https://github.com/Wasim-Shaikh25/mcp-github-enterprise-launcher) — npm stdio wrapper for a `github-mcp-server` binary. |
| **SonarQube launcher** | [mcp-sonarqube-launcher](https://github.com/Wasim-Shaikh25/mcp-sonarqube-launcher) — npm stdio wrapper for a SonarQube MCP JAR. |

---

## What this project does

Teams often use **SSO** (SAML, OIDC, etc.) or strict API policies. This server is **not tied to one vendor or tenant**: you set **`CONFLUENCE_BASE_URL`** to your environment.

- **Optional Personal Access Token (PAT)** or API token — When your site supports it, set one in MCP config; the server sends `Authorization: Bearer` on each request.
- **Browser SSO via cookies** — If you have no PAT, or the API returns **401/403**, you can complete login in a real browser (Playwright). The session is saved and reused for REST calls.
- **Same tools everywhere** — Once configured, assistants use **MCP tools** (search, get page, create page, attachments, etc.) against **your** base URL.

**Typical uses:** documentation Q&A in the IDE, drafting or updating pages from chat, finding pages by CQL, pulling diagrams or attachment metadata for review.

**Scope:** Standard Confluence REST paths (`/rest/api/...`). Use the **root URL** your organization uses (include `/wiki` in the path only if your instance requires it). If you run **multiple** Confluence deployments, add **one MCP server block per site**, each with its own **`CONFLUENCE_BASE_URL`**, and use **`confluence_health_check`** if page IDs mismatch between browser and API.

---

## How it works (short)

1. The MCP client (e.g. Cursor) **starts this Node process** and talks over **stdio** (standard input/output) using the MCP protocol.
2. The server implements **tool handlers** that call Confluence’s **REST API** (`node-fetch`, with PAT or `Cookie` header).
3. **Auth:** Prefer PAT if configured → on **401/403**, retry with **saved SSO cookies** if `confluence_login` (or `npm run login`) was run.
4. **SSO login** opens Chromium (Playwright), you sign in as usual; cookies are stored under `cookies/session.json` (local, gitignored).

```text
[ Cursor / MCP client ] --stdio--> [ this server ] --HTTPS--> [ Confluence REST API ]
                                        |
                                        +-- PAT and/or cookies/session.json
```

---

## Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js 18+** | LTS recommended. |
| **Network access** | To your Confluence base URL from the machine running the MCP. |
| **Chromium (Playwright)** | Only if you use **SSO login** (`confluence_login` or `npm run login`). Run `npm run install-browser` once per machine. |

---

## Quick start

1. **Install dependencies** (from a clone) or use **npx** (see below).
2. Set **`CONFLUENCE_BASE_URL`** (and optionally **`CONFLUENCE_PAT`**) in your MCP client config—usually **`%USERPROFILE%\.cursor\mcp.json`** on Windows.
3. **Restart** the MCP client after editing config.
4. Either set a PAT **or** run **`confluence_login`** / **`npm run login`** once so cookies exist for SSO.
5. In **Agent** chat (or equivalent), use the **Confluence** tools (search, get page, etc.).

---

## Installation

### Option A — Published package (npx)

Use the **exact package name** from [npm](https://www.npmjs.com/) (see your `package.json` `name` field). Example:

```bash
# One-time: Chromium for SSO browser login
npx playwright install chromium

# Run the MCP on stdio (set base URL first)
# Windows CMD:
set CONFLUENCE_BASE_URL=https://confluence.example.com
npx -y confluence-sso-mcp

# Windows PowerShell:
$env:CONFLUENCE_BASE_URL="https://confluence.example.com"
npx -y confluence-sso-mcp
```

### Option B — Clone this repository

```bash
git clone <your-repo-url>
cd confluence-mcp-oauth
npm install
npm run install-browser   # Chromium for SSO
npm start                 # runs the MCP on stdio; usually Cursor starts this for you
```

---

## Configuration

### Where settings live

- **Primary:** Cursor global MCP file: **`%USERPROFILE%\.cursor\mcp.json`** (Windows) or **`~/.cursor/mcp.json`** (macOS/Linux).
- **Server block name:** You can name the entry anything (e.g. `confluence`, `docs-internal`, `confluence-prod`). This project **discovers** the correct `env` by matching **`args`** to this package’s **`src/index.js`** path, with fallback to legacy keys `confluence-sso` and `mywiki-sso` for older configs.
- **PAT:** Put **`CONFLUENCE_PAT`** (or **`CONFLUENCE_API_TOKEN`**) only in **`mcp.json`** `env`—not in the project **`.env`** (those keys are ignored in `.env` by design).

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CONFLUENCE_BASE_URL` | **Yes** | Confluence root URL. Include **`/wiki`** only if your instance uses that context path. |
| `CONFLUENCE_PAT` or `CONFLUENCE_API_TOKEN` | No | Bearer token when your site supports PAT/API tokens. Recommended in `mcp.json`. |
| `CONFLUENCE_LOGIN_URL` | No | SSO entry URL (default: `{BASE}/login.action`). |
| `CONFLUENCE_LOGIN_WAIT_SECONDS` | No | Seconds to wait during browser login (default **90**). |
| `CONFLUENCE_MAX_ATTACHMENT_BYTES` | No | Max download size for attachments (default **5 MiB**). |
| `CONFLUENCE_MCP_SERVER_KEY` | No | **If you have several MCP entries that use the same `args` path** (e.g. enterprise + MyWiki both pointing at this repo’s `src/index.js`), set this to **that entry’s id** (`confluence-local`, `mywiki-local`, …). The server uses it to pick the right `mcp.json` block for merge/PAT fallback. Cursor’s injected `CONFLUENCE_BASE_URL` always wins over a wrong block. |
| `PREFER_SSO_COOKIES` | No | Default **on**: if a saved SSO cookie file exists, **only cookies are sent** (PAT is not used). Set **`0`** or **`false`** to use **PAT first** and cookies on 401/403. Delete the per-instance cookie file, or set `PREFER_SSO_COOKIES=0`, if you need PAT while a cookie file is present. |
| `CONFLUENCE_LOGIN_POLL_MS` | No | Interval (ms) to probe **`/rest/api/user/current`** during **`confluence_login`** so the tool can **finish early** when SSO succeeds (default **2000**). Max wait is still **`CONFLUENCE_LOGIN_WAIT_SECONDS`**. |

Optional non-secret overrides can go in a local **`.env`** in this repo (see **`.env.example`**); do **not** put `CONFLUENCE_PAT` or `CONFLUENCE_API_TOKEN` there.

**Multiple Confluence instances (same clone path):** In **`mcp.json`**, give each server its own **`CONFLUENCE_BASE_URL`**. Add **`CONFLUENCE_MCP_SERVER_KEY`** matching the server id (see table). Without this, the first matching block in the file could be used for fill-in merge when a variable is unset—**never** for URL once Cursor has already set it (see code: process env is not overwritten).

### Configuration reference (files & precedence)

| Topic | Detail |
|--------|--------|
| **Secrets** | **`CONFLUENCE_PAT`** / **`CONFLUENCE_API_TOKEN`** are **not** loaded from the project **`.env`** file. Use **`mcp.json`** `env` (or the host-injected process env). |
| **PAT at runtime** | Read from the discovered MCP block (see **Where settings live**), then **`process.env`**—same idea as Jira: Cursor-injected vars win. |
| **Cookie file** | **`cookies/session.json`** under this package root (gitignored), written by **`confluence_login`**. |
| **Defaults** | **`CONFLUENCE_LOGIN_URL`**: `{CONFLUENCE_BASE_URL}/login.action` · **`CONFLUENCE_LOGIN_WAIT_SECONDS`**: `90` · **`CONFLUENCE_MAX_ATTACHMENT_BYTES`**: `5242880` (5 MiB) |

### Authentication order

1. If a PAT is set, requests use **Bearer** authentication first.
2. If the response is **401** or **403** and **`cookies/session.json`** exists, the same request is **retried** with the **cookie** session.
3. If no PAT is configured, only cookies are used.
4. If neither works, tools fail until you add a PAT or complete **`confluence_login`**.

---

## Cursor: `mcp.json` examples

Restart Cursor after changes.

### Using npx (published package)

Package name on npm: **`confluence-sso-mcp`**.

```json
{
  "mcpServers": {
    "confluence-sso": {
      "command": "npx",
      "args": ["-y", "confluence-sso-mcp"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.company.com",
        "CONFLUENCE_LOGIN_WAIT_SECONDS": "90",
        "CONFLUENCE_PAT": "your-personal-access-or-api-token"
      }
    }
  }
}
```

### Using a local clone (`node` + path)

`args` must contain the **full path** to **`src/index.js`** so `npm run login` can resolve the same settings from `mcp.json`.

```json
{
  "mcpServers": {
    "confluence-sso": {
      "command": "node",
      "args": ["C:/path/to/confluence-mcp-oauth/src/index.js"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.company.com",
        "CONFLUENCE_LOGIN_WAIT_SECONDS": "90",
        "CONFLUENCE_PAT": "your-personal-access-or-api-token"
      }
    }
  }
}
```

**Repository / homepage URLs** in `package.json` may point to a template GitHub path—update them for your fork if needed.

---

## Day-to-day usage

| Goal | What to do |
|------|------------|
| **Run the server** | Normally you **do not** run `npm start` yourself; Cursor launches the MCP from `mcp.json`. |
| **SSO only (no PAT)** | Run tool **`confluence_login`** in Agent, or **`npm run login`** in the repo, complete login in the browser, wait for the wait period to finish. |
| **Use tools in chat** | Use **Agent** (or a mode that exposes MCP tools). Ask in natural language: e.g. “Search Confluence for pages about X” or call tools by name. |
| **Workspace** | Open this repo (or your project) as the **folder** workspace—not your entire user home—so MCP discovery is reliable. |

### First-time SSO login (same behavior everywhere)

- **Cursor Agent:** run the **`confluence_login`** tool.
- **Terminal:** `npm run login` from the package directory (reads `mcp.json` via `config.js`).
- **VS Code / Cursor task:** **Tasks: Run Task** → **Confluence: SSO login (save cookies)** (if configured in `.vscode/tasks.json`).

Cookies are stored in **`cookies/session.json`** (gitignored).

---

## MCP tools (reference)

### Read & search

| Tool | What it does |
|------|----------------|
| `confluence_login` | Opens the browser for SSO; saves cookies for REST (or fallback when PAT fails). |
| `confluence_search` | CQL search: `cql`, optional `limit`, `start`. |
| `confluence_list_spaces` | One page of spaces (`limit`, `start`, optional `expand` e.g. permissions). |
| `confluence_list_all_spaces` | Paginates until all spaces are fetched or `maxSpaces` (default 500); optional `expand`. |
| `confluence_spaces_create_hints` | Same listing with `expand=permissions,operations,...` plus best-effort **`canCreatePage`** per space (`true` / `null` = unknown). |
| `confluence_get_space` | One space by key with optional `expand` (permissions, operations). |
| `confluence_health_check` | Confirms REST responses match `CONFLUENCE_BASE_URL` (wrong instance detection). |
| `confluence_find_page` | Finds pages by `spaceKey` + exact `title`. |
| `confluence_get_page` | Gets a page by `pageId`; optional `expand`. |
| `confluence_list_attachments` | Lists attachments on a page. |
| `confluence_fetch_attachment` | Downloads an attachment by `pageId` + `filename` (images as MCP image content). |
| `confluence_extract_diagrams` | Extracts diagram macro text (PlantUML, Mermaid, etc.). |
| `confluence_extract_page_images` | Lists image references from `body.storage`. |

### Write (needs Confluence permissions)

| Tool | What it does |
|------|----------------|
| `confluence_create_page` | Creates a page in **`spaceKey`**: `title`, `storageHtml`, optional **`parentPageId`** (child under that parent page in the same space). |
| `confluence_update_page` | Updates a page: `pageId`, `storageHtml`, optional `title`, `versionMessage`. |

**Body format:** `storageHtml` must be **Confluence storage** HTML/XML (e.g. `<p>Hello</p>`), not arbitrary wiki markup unless your instance accepts it.

---

## Validation

| Step | Command / action |
|------|------------------|
| **Unit tests (features)** | **`npm test`** — runs **`node --test`** on **`tests/confluence-features.test.js`** (space list/get paths, **`expand`**, health-check host comparison, CQL error wrapping). |
| **Syntax + config (no Confluence calls)** | **`npm run validate`** — syntax-checks **`src/`**; with **`CONFLUENCE_BASE_URL`** set, prints resolved base and login URL. |
| **Instance / URL** | In Agent, call **`confluence_health_check`**—**`hostMatches`** should be true if **`CONFLUENCE_BASE_URL`** matches the REST host. |
| **MCP wiring** | Cursor **Settings → MCP**: server **connected**; restart after **`mcp.json`** edits. |
| **Inspector (optional)** | [MCP Inspector](https://github.com/modelcontextprotocol/inspector) with **`node path/to/confluence-mcp-oauth/src/index.js`** and the same **`env`** as Cursor. |

---

## Security

- Treat **PATs** like passwords; keep them in **`mcp.json`** (or your secret store), not in git or public **`.env`** files.
- **Cookies** are as powerful as your browser session—protect the directory that contains `cookies/`.
- **Edits** in Confluence are still attributed and audited like normal UI edits—follow your organization’s policies and compliance rules.

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| **`CONFLUENCE_BASE_URL is not set`** | Add it under your MCP server’s **`env`** in **`mcp.json`**, restart Cursor. |
| **401 / HTML instead of JSON** | PAT wrong or expired, or SSO session expired—update PAT or run **`confluence_login`** again. |
| **SSO completes in the browser but MCP still gets 401** | Set **`CONFLUENCE_PAT`** in **`mcp.json`** and **`PREFER_SSO_COOKIES=0`**, or **delete** the cookie file under **`cookies/`** (e.g. **`session-<CONFLUENCE_MCP_SERVER_KEY>.json`**) so a stale session does not override PAT. Pop-up blockers and IdP redirects can prevent Playwright from capturing cookies—the login tool response now prints the exact path and these options. |
| **403 on create/update** | Your user lacks permission on that space. |
| **404 on REST** | Wrong base URL—try adding or removing **`/wiki`** in `CONFLUENCE_BASE_URL`. |
| **Tools not listed** | Use **Agent**; open the project folder as workspace; check **Settings → MCP** shows the server **connected**. |
| **`confluence_login` hangs or times out in UI** | Chromium may still be open—check the taskbar; or run **`npm run login`** in a terminal (up to **`CONFLUENCE_LOGIN_WAIT_SECONDS`**). |
| **Browser closes right after opening** | The session probe no longer treats **200 HTML** (after redirects) as “logged in”. Update this package; if it still happens, use **PAT** + **`PREFER_SSO_COOKIES=0`**. |
| **`Execution context was destroyed` / navigation** | During SSO, **`page.evaluate`** can throw while the page redirects; the login loop now **retries** instead of failing the tool. If login still fails, use **PAT** + **`PREFER_SSO_COOKIES=0`**. |
| **`ERR_MODULE_NOT_FOUND` for `src/auth.js` (or other `src/*.js`) after `npx`** | The tarball on npm was incomplete or npx cached a bad extract. **Publish** the latest patch (package `files` lists every `src/*.js` explicitly), then **clear npx cache**: delete `%LocalAppData%\npm-cache\_npx` (or run `npx clear-npx-cache` on npm 11+). Pin a version in **`mcp.json`**, e.g. **`"args": ["-y", "confluence-sso-mcp@x.y.z"]`**. Workaround: run from a **git clone** with **`node`** + full path to **`src/index.js`**. |
| **`ENOENT` on `cookies/*.lock`** | Create a **`cookies/`** folder next to the installed **`src/`** if the lock file cannot be created (Windows `npx` cache). Prefer **`node path/to/clone/src/index.js`** with local **`npm install`**. |
| **`TAR_ENTRY_ERROR EPERM` / `*.DELETE.*` under `_npx`** | Antivirus or file locks on **`%LocalAppData%\npm-cache`** can corrupt installs. Exclude that path from real-time scanning, or use a **local clone** + **`node`** instead of **`npx`**. |

For broader Cursor MCP issues, see [Cursor forum: MCP tools](https://forum.cursor.com/search?q=mcp%20tools%20agent).

---

## License and repository

See **`package.json`** for `repository`, `homepage`, and `bugs` links once you publish or fork.

The npm package name is **`confluence-sso-mcp`** (unscoped). If you previously published under **`@svasimahmed283/confluence-sso-mcp`**, keep that version for backward compatibility or deprecate it on npm after publishing this name.
