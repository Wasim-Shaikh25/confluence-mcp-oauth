# Confluence SSO MCP

A **[Model Context Protocol (MCP)](https://modelcontextprotocol.io/)** server for **Atlassian Confluence Data Center**. It connects **Cursor**, **Claude Desktop**, and other MCP clients to your Confluence instance so assistants can **search spaces**, **read and create pages**, **work with attachments**, and more—using the same REST API your browser uses.

---

## What this project does

Many teams use **SSO** (SAML, OIDC, etc.) for Confluence. Classic API tokens do not always fit every policy, and interactive login is often required. This server bridges that gap:

- **Optional Personal Access Token (PAT)** — If your org issues Data Center PATs, set one in config; the server sends `Authorization: Bearer` on each request.
- **Browser SSO via cookies** — If you have no PAT, or the API returns **401/403**, you can complete login in a real browser (Playwright). The session is saved and reused for REST calls.
- **Same tools for humans and agents** — Once configured, the AI sees Confluence operations as **MCP tools** (search, get page, create page, attachments, etc.) instead of you copying URLs and text by hand.

**Typical uses:** documentation Q&A in the IDE, drafting or updating pages from chat, finding pages by CQL, pulling diagrams or attachment metadata for review.

**Scope:** Confluence **Data Center / Server** style URLs and REST (`/rest/api/...`). This is **not** the Atlassian Cloud-only hosted integration; your base URL is your company’s Confluence host.

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
npx -y @your-scope/confluence-sso-mcp

# Windows PowerShell:
$env:CONFLUENCE_BASE_URL="https://confluence.example.com"
npx -y @your-scope/confluence-sso-mcp
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
- **Server block name:** You can name the entry anything (`confluence-sso`, `mywiki-sso`, …). This project **discovers** the correct `env` by matching **`args`** to this package’s **`src/index.js`** path, with fallback to legacy keys `confluence-sso` and `mywiki-sso`.
- **PAT:** Put **`CONFLUENCE_PAT`** (or **`CONFLUENCE_API_TOKEN`**) only in **`mcp.json`** `env`—not in the project **`.env`** (those keys are ignored in `.env` by design).

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CONFLUENCE_BASE_URL` | **Yes** | Confluence root URL. Include **`/wiki`** only if your instance uses that context path. |
| `CONFLUENCE_PAT` or `CONFLUENCE_API_TOKEN` | No | Data Center PAT (`Authorization: Bearer`). Recommended in `mcp.json`. |
| `CONFLUENCE_LOGIN_URL` | No | SSO entry URL (default: `{BASE}/login.action`). |
| `CONFLUENCE_LOGIN_WAIT_SECONDS` | No | Seconds to wait during browser login (default **90**). |
| `CONFLUENCE_MAX_ATTACHMENT_BYTES` | No | Max download size for attachments (default **5 MiB**). |

Optional non-secret overrides can go in a local **`.env`** (see **`.env.example`**); do **not** put `CONFLUENCE_PAT` there.

### Authentication order

1. If a PAT is set, requests use **Bearer** authentication first.
2. If the response is **401** or **403** and **`cookies/session.json`** exists, the same request is **retried** with the **cookie** session.
3. If no PAT is configured, only cookies are used.
4. If neither works, tools fail until you add a PAT or complete **`confluence_login`**.

---

## Cursor: `mcp.json` examples

Restart Cursor after changes.

### Using npx (published package)

Replace `@your-scope/confluence-sso-mcp` with your real npm package name.

```json
{
  "mcpServers": {
    "confluence-sso": {
      "command": "npx",
      "args": ["-y", "@your-scope/confluence-sso-mcp"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.company.com",
        "CONFLUENCE_LOGIN_WAIT_SECONDS": "90",
        "CONFLUENCE_PAT": "your-datacenter-personal-access-token"
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
        "CONFLUENCE_PAT": "your-datacenter-personal-access-token"
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
| `confluence_list_spaces` | Lists spaces (`limit`, `start`). |
| `confluence_find_page` | Finds pages by `spaceKey` + exact `title`. |
| `confluence_get_page` | Gets a page by `pageId`; optional `expand`. |
| `confluence_list_attachments` | Lists attachments on a page. |
| `confluence_fetch_attachment` | Downloads an attachment by `pageId` + `filename` (images as MCP image content). |
| `confluence_extract_diagrams` | Extracts diagram macro text (PlantUML, Mermaid, etc.). |
| `confluence_extract_page_images` | Lists image references from `body.storage`. |

### Write (needs Confluence permissions)

| Tool | What it does |
|------|----------------|
| `confluence_create_page` | Creates a page: `spaceKey`, `title`, `storageHtml`, optional `parentPageId`. |
| `confluence_update_page` | Updates a page: `pageId`, `storageHtml`, optional `title`, `versionMessage`. |

**Body format:** `storageHtml` must be **Confluence storage** HTML/XML (e.g. `<p>Hello</p>`), not arbitrary wiki markup unless your instance accepts it.

---

## Security

- Treat **PATs** like passwords; keep them in **`mcp.json`** (or your secret store), not in git or public **`.env`** files.
- **Cookies** are as powerful as your browser session—protect the directory that contains `cookies/`.
- **Edits** in Confluence are still attributed and audited like normal UI edits—follow your org’s policies.

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| **`CONFLUENCE_BASE_URL is not set`** | Add it under your MCP server’s **`env`** in **`mcp.json`**, restart Cursor. |
| **401 / HTML instead of JSON** | PAT wrong or expired, or SSO session expired—update PAT or run **`confluence_login`** again. |
| **403 on create/update** | Your user lacks permission on that space. |
| **404 on REST** | Wrong base URL—try adding or removing **`/wiki`** in `CONFLUENCE_BASE_URL`. |
| **Tools not listed** | Use **Agent**; open the project folder as workspace; check **Settings → MCP** shows the server **connected**. |
| **`confluence_login` hangs or times out in UI** | Chromium may still be open—check the taskbar; or run **`npm run login`** in a terminal (up to **`CONFLUENCE_LOGIN_WAIT_SECONDS`**). |

For broader Cursor MCP issues, see [Cursor forum: MCP tools](https://forum.cursor.com/search?q=mcp%20tools%20agent).

---

## License and repository

See **`package.json`** for `repository`, `homepage`, and `bugs` links once you publish or fork.
