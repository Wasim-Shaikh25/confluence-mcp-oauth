import fs from "fs";
import path from "node:path";
import fetch from "node-fetch";
import { CONFIG } from "./config.js";
import { withCookieFileLockSync } from "./cookie-lock.js";
import {
  appendCqlContextToError,
  buildGetSpacePath,
  buildListSpacesPath,
  healthCheckHosts,
} from "./confluence-paths.js";
import { summarizeSpaceForPageCreate } from "./confluence-space-hints.js";

function readCookieFileSync(filePath) {
  return withCookieFileLockSync(filePath, () => {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) {
      throw new Error(
        `Invalid cookie file; delete ${filePath} and run confluence_login again.`
      );
    }
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  });
}

function loadCookieHeader() {
  const primary = readCookieFileSync(CONFIG.COOKIE_FILE);
  if (primary) return primary;
  const legacy = path.join(CONFIG.PROJECT_ROOT, "cookies", "session.json");
  if (legacy !== CONFIG.COOKIE_FILE && fs.existsSync(legacy)) {
    return readCookieFileSync(legacy);
  }
  return null;
}

const jsonHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Atlassian-Token": "no-check",
};

function authHeadersForCookie() {
  const cookie = loadCookieHeader();
  if (!cookie) return null;
  return { Cookie: cookie };
}

function authHeadersForPat() {
  const pat = CONFIG.getPatToken();
  if (!pat) return null;
  return { Authorization: `Bearer ${pat}` };
}

function shouldRetryWithCookie(status) {
  return status === 401 || status === 403;
}

/**
 * Default: if SSO cookies exist on disk, use **only** cookies (PAT is not sent). If cookies return 401/403, fail with a clear message (re-login or PREFER_SSO_COOKIES=0 + PAT).
 * If PREFER_SSO_COOKIES=0: PAT first, then cookies on 401/403 (legacy).
 * If no cookies: PAT if set, else error.
 */
async function fetchWithAuth(url, init = {}) {
  const patHeaders = authHeadersForPat();
  const cookieHeaders = authHeadersForCookie();

  const merge = (extra) => ({
    ...init,
    headers: {
      ...init.headers,
      ...extra,
    },
  });

  if (CONFIG.preferSsoCookies && cookieHeaders) {
    const res = await fetch(url, merge(cookieHeaders));
    if (res.ok) return res;
    if (shouldRetryWithCookie(res.status)) {
      const text = await res.text();
      throw new Error(
        `Confluence HTTP ${res.status}: ${text.slice(0, 400)} SSO session expired, rejected, or never captured (browser automation/IdP). Run confluence_login again, or set CONFLUENCE_PAT + PREFER_SSO_COOKIES=0 in mcp.json, or delete the cookie file at ${CONFIG.COOKIE_FILE} to use PAT.`
      );
    }
    return res;
  }

  if (patHeaders) {
    const res = await fetch(url, merge(patHeaders));
    if (res.ok || !cookieHeaders || !shouldRetryWithCookie(res.status)) {
      return res;
    }
    return fetch(url, merge(cookieHeaders));
  }

  if (cookieHeaders) {
    return fetch(url, merge(cookieHeaders));
  }

  throw new Error(
    "Not authenticated. Set CONFLUENCE_PAT (or CONFLUENCE_API_TOKEN), or run confluence_login once to save cookies."
  );
}

function hintForConfluenceStatus(status) {
  if (status === 401) {
    return " Unauthorized: SSO session expired, missing, or unusable — run confluence_login, or set CONFLUENCE_PAT and PREFER_SSO_COOKIES=0 (stale cookie file at cookies/session-*.json can block PAT until deleted).";
  }
  if (status === 403) {
    return " Forbidden: you are signed in but lack permission for this space or action (e.g. create page). Try another space or request access.";
  }
  if (status === 404) {
    return " Not found: wrong CONFLUENCE_BASE_URL/instance, missing content ID, or no browse permission.";
  }
  if (status >= 500) {
    return " Server error: invalid CQL, Confluence fault, or proxy issue—check the query and instance logs.";
  }
  return "";
}

async function parseResponse(res) {
  const text = await res.text();
  if (!res.ok) {
    const hint = hintForConfluenceStatus(res.status);
    throw new Error(`Confluence HTTP ${res.status}: ${text.slice(0, 800)}${hint}`);
  }
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from Confluence; got: ${text.slice(0, 200)}`);
  }
}

/** GET JSON */
export async function requestJson(pathAndQuery) {
  const url = `${CONFIG.CONFLUENCE_BASE_URL}${pathAndQuery}`;
  const res = await fetchWithAuth(url, {
    headers: { ...jsonHeaders },
  });
  return parseResponse(res);
}

/** POST / PUT JSON */
async function requestJsonWithBody(method, pathAndQuery, body) {
  const url = `${CONFIG.CONFLUENCE_BASE_URL}${pathAndQuery}`;
  const res = await fetchWithAuth(url, {
    method,
    headers: { ...jsonHeaders },
    body: JSON.stringify(body),
  });
  return parseResponse(res);
}

/** GET binary (attachments). Respects CONFLUENCE_MAX_ATTACHMENT_BYTES. */
export async function requestBinary(pathAndQuery) {
  const url = `${CONFIG.CONFLUENCE_BASE_URL}${pathAndQuery}`;
  const res = await fetchWithAuth(url, {
    headers: { Accept: "*/*" },
  });
  if (!res.ok) {
    const text = await res.text();
    const hint = hintForConfluenceStatus(res.status);
    throw new Error(`Confluence HTTP ${res.status}: ${text.slice(0, 800)}${hint}`);
  }
  const len = res.headers.get("content-length");
  if (len && Number(len) > CONFIG.maxAttachmentBytes) {
    throw new Error(
      `Attachment too large (${len} bytes). Increase CONFLUENCE_MAX_ATTACHMENT_BYTES or pick a smaller file.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > CONFIG.maxAttachmentBytes) {
    throw new Error(
      `Attachment too large (${buf.length} bytes). Max is ${CONFIG.maxAttachmentBytes}.`
    );
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer: buf, contentType };
}

// --- Read / search ---

export async function searchContent(cql, limit = 25, start = 0) {
  const cqlParam = encodeURIComponent(cql);
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 25;
  const st = Number.isFinite(start) ? Math.max(0, start) : 0;
  try {
    return await requestJson(
      `/rest/api/content/search?cql=${cqlParam}&limit=${lim}&start=${st}`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const wrapped = appendCqlContextToError(msg, cql);
    if (wrapped !== msg) throw new Error(wrapped);
    throw e;
  }
}

export async function getPage(pageId, expand = "body.storage,version,space") {
  const id = encodeURIComponent(pageId);
  const exp = encodeURIComponent(expand);
  return requestJson(`/rest/api/content/${id}?expand=${exp}`);
}

/**
 * List spaces (browse / pick a space key).
 * @param {number} limit
 * @param {number} start
 * @param {string} [expand] e.g. "permissions,operations,description,icon" — helps see create/browse rights where supported
 */
export async function listSpaces(limit = 25, start = 0, expand) {
  return requestJson(buildListSpacesPath(limit, start, expand));
}

const LIST_SPACES_PAGE = 100;

/**
 * Paginate GET /rest/api/space until no more results or maxSpaces reached.
 * @param {number} [maxSpaces]
 * @param {string} [expand]
 */
export async function listAllSpaces(maxSpaces = 500, expand) {
  const cap = Math.min(Math.max(1, maxSpaces), 2000);
  const out = [];
  let start = 0;
  while (out.length < cap) {
    const pageSize = Math.min(LIST_SPACES_PAGE, cap - out.length);
    const data = await listSpaces(pageSize, start, expand);
    const results = data?.results ?? [];
    if (results.length === 0) break;
    for (const sp of results) {
      out.push(sp);
      if (out.length >= cap) break;
    }
    if (out.length >= cap) break;
    if (results.length < pageSize) break;
    start += results.length;
  }
  return {
    totalFetched: out.length,
    truncated: out.length >= cap,
    spaces: out,
  };
}

/**
 * List all spaces with expand, then add best-effort "can create page?" hints per space.
 * @param {number} [maxSpaces]
 */
export async function listSpacesWithCreateHints(maxSpaces = 500) {
  const expand = "permissions,operations,description,homepage";
  const { spaces, totalFetched, truncated } = await listAllSpaces(maxSpaces, expand);
  const hints = spaces.map((sp) => summarizeSpaceForPageCreate(sp));
  const likelyYes = hints.filter((h) => h.canCreatePage === true).length;
  const unknown = hints.filter((h) => h.canCreatePage === null).length;
  return {
    note:
      "canCreatePage is inferred from REST expand=permissions,operations when your site returns them. null means unknown — use confluence_get_space for one space or try confluence_create_page with a test title.",
    totalFetched,
    truncated,
    summary: { likelyCanCreatePage: likelyYes, unknown },
    hints,
  };
}

/**
 * Get one space by key (optionally expanded with permissions / operations).
 * @param {string} spaceKey
 * @param {string} [expand]
 */
export async function getSpace(spaceKey, expand = "permissions,operations,description,homepage") {
  return requestJson(buildGetSpacePath(spaceKey, expand));
}

/**
 * Verify CONFLUENCE_BASE_URL matches the REST API host (catches pointing MCP at the wrong Confluence instance).
 */
export async function healthCheck() {
  const data = await requestJson(`/rest/api/space?limit=1`);
  const first = data?.results?.[0];
  const self = first?._links?.self || first?.self || "";
  const hosts = healthCheckHosts(CONFIG.CONFLUENCE_BASE_URL, self);
  return {
    configuredBaseUrl: CONFIG.CONFLUENCE_BASE_URL,
    configuredHost: hosts.configuredHost,
    sampleContentSelfLink: self || null,
    responseHost: hosts.responseHost,
    hostMatches: hosts.hostMatches,
    hint: hosts.hint,
  };
}

/** Find a page by space key + exact title (read helper). */
export async function findPageByTitle(spaceKey, title) {
  const cql = `type = page AND space = "${spaceKey.replace(/"/g, '\\"')}" AND title = "${title.replace(/"/g, '\\"')}"`;
  return searchContent(cql, 5, 0);
}

/**
 * List page attachments (REST child/attachment).
 * @param {string} pageId
 * @param {number} [limit]
 * @param {number} [start]
 */
export async function listAttachments(pageId, limit = 50, start = 0) {
  const id = encodeURIComponent(pageId);
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 50;
  const st = Number.isFinite(start) ? Math.max(0, start) : 0;
  const expand = encodeURIComponent("metadata,version");
  return requestJson(
    `/rest/api/content/${id}/child/attachment?limit=${lim}&start=${st}&expand=${expand}`
  );
}

/**
 * Download an attachment by relative download path (from attachment _links.download).
 * Supports same-origin absolute URLs.
 */
export async function downloadAttachmentByPath(downloadPath) {
  if (/^https?:\/\//i.test(downloadPath)) {
    const u = new URL(downloadPath);
    const baseUrl = new URL(CONFIG.CONFLUENCE_BASE_URL);
    if (u.hostname !== baseUrl.hostname) {
      throw new Error("Attachment download URL must be on the configured Confluence host.");
    }
    return requestBinary(`${u.pathname}${u.search}`);
  }
  const path = downloadPath.startsWith("/") ? downloadPath : `/${downloadPath}`;
  return requestBinary(path);
}

/**
 * Resolve download path for a filename on a page (uses attachment list).
 */
export async function fetchAttachmentByFilename(pageId, filename) {
  const data = await listAttachments(pageId, 100, 0);
  const results = data?.results ?? [];
  const want = filename.trim().toLowerCase();
  const hit = results.find(
    (r) => (r.title || "").toLowerCase() === want || (r.title || "") === filename
  );
  if (!hit) {
    const names = results.map((r) => r.title).filter(Boolean);
    throw new Error(
      `Attachment not found: "${filename}". Known on page: ${names.slice(0, 20).join(", ") || "(none)"}`
    );
  }
  let link = hit._links?.download;
  if (!link && hit.title) {
    const enc = encodeURIComponent(hit.title);
    link = `/download/attachments/${encodeURIComponent(pageId)}/${enc}`;
  }
  if (!link) {
    throw new Error("Attachment has no download link in API response.");
  }
  const rel = link.startsWith("http") ? new URL(link).pathname + new URL(link).search : link;
  return downloadAttachmentByPath(rel);
}

const DIAGRAM_MACRO_NAMES = new Set([
  "uml-sequence",
  "plantuml",
  "mermaid",
  "drawio",
  "gliffy",
  "lucidchart",
]);

/**
 * Extract plain-text bodies from storage-format macros (sequence diagrams, PlantUML, etc.).
 * @param {string} storageXml
 * @param {{ onlyDiagrams?: boolean }} [opts]
 */
export function extractDiagramMacrosFromStorage(storageXml, opts = {}) {
  const only = opts.onlyDiagrams !== false;
  const out = [];
  if (!storageXml || typeof storageXml !== "string") return out;

  const macroRe = /<ac:structured-macro\b[^>]*?>/gi;
  let m;
  while ((m = macroRe.exec(storageXml)) !== null) {
    const openTag = m[0];
    const nameMatch = /ac:name="([^"]+)"/.exec(openTag);
    const macroName = nameMatch ? nameMatch[1] : "";
    if (only && !DIAGRAM_MACRO_NAMES.has(macroName)) continue;

    const start = m.index;
    const close = "</ac:structured-macro>";
    const endIdx = storageXml.indexOf(close, start);
    if (endIdx === -1) continue;
    const block = storageXml.slice(start, endIdx + close.length);

    const cdata = block.match(
      /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/i
    );
    if (cdata) {
      out.push({ macro: macroName, format: "plain-text", body: cdata[1].trim() });
      continue;
    }
    const escaped = block.match(
      /<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/i
    );
    if (escaped) {
      let inner = escaped[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
      inner = inner.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      if (inner) {
        out.push({ macro: macroName, format: "plain-text-escaped", body: inner });
      }
    }
  }
  return out;
}

/**
 * List image references in storage (attachments and external URLs).
 */
export function extractImageReferencesFromStorage(storageXml) {
  const refs = [];
  if (!storageXml) return refs;

  const attRe = /<ri:attachment\b[^>]*?ri:filename="([^"]+)"/gi;
  let am;
  while ((am = attRe.exec(storageXml)) !== null) {
    refs.push({ kind: "attachment", filename: am[1] });
  }

  const urlRe = /<ri:url\b[^>]*?ri:value="([^"]+)"/gi;
  let um;
  while ((um = urlRe.exec(storageXml)) !== null) {
    refs.push({ kind: "url", url: um[1] });
  }
  return refs;
}

// --- Write (requires Confluence edit permission) ---

/**
 * Create a new page. storageHtml is Confluence storage format (XHTML subset).
 */
export async function createPage({ spaceKey, title, storageHtml, parentPageId }) {
  const payload = {
    type: "page",
    title,
    space: { key: spaceKey },
    body: {
      storage: {
        value: storageHtml,
        representation: "storage",
      },
    },
  };
  if (parentPageId) {
    payload.ancestors = [{ id: parentPageId }];
  }
  return requestJsonWithBody("POST", "/rest/api/content", payload);
}

/**
 * Update page body (and optional title). Fetches current version, increments for PUT.
 */
export async function updatePage({
  pageId,
  storageHtml,
  title,
  versionMessage = "Updated via MCP",
}) {
  const current = await getPage(pageId, "body.storage,version,space");
  const nextVersion = (current.version?.number ?? 0) + 1;
  const payload = {
    id: current.id,
    type: current.type || "page",
    title: title ?? current.title,
    version: {
      number: nextVersion,
      message: versionMessage,
    },
    body: {
      storage: {
        value: storageHtml,
        representation: "storage",
      },
    },
  };
  const id = encodeURIComponent(pageId);
  return requestJsonWithBody("PUT", `/rest/api/content/${id}`, payload);
}
