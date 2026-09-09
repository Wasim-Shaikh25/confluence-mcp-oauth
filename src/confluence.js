import fs from "fs";
import path from "node:path";
import fetch from "node-fetch";
import { createTwoFilesPatch } from "diff";
import { CONFIG } from "./config.js";

export function enforceAllowlistOnSpaceKey(spaceKey) {
  const allowed = CONFIG.allowedSpaceKeys;
  if (!allowed || !spaceKey) return;
  const k = String(spaceKey).toUpperCase();
  if (!allowed.has(k)) {
    throw new Error(
      `Operation blocked: space "${spaceKey}" is not in CONFLUENCE_ALLOWED_SPACE_KEYS (${[...allowed].join(", ")}).`
    );
  }
}

function enforceAllowlistOnPageJson(data) {
  if (!data || typeof data !== "object") return;
  const sk = data.space?.key;
  if (sk) enforceAllowlistOnSpaceKey(sk);
}
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

/**
 * Cookie-only auth. Complete confluence_login once to save SSO cookies.
 * If cookies return 401/403, fail with a clear message to re-login.
 */
async function fetchWithAuth(url, init = {}) {
  const cookieHeaders = authHeadersForCookie();
  if (!cookieHeaders) {
    throw new Error(
      "Not authenticated. Run the confluence_login tool once to complete SSO and save cookies."
    );
  }
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, ...cookieHeaders },
  });
  if (res.status === 401 || res.status === 403) {
    const text = await res.text();
    throw new Error(
      `Confluence HTTP ${res.status}: ${text.slice(0, 400)} SSO session expired, rejected, or never captured (browser automation/IdP). Run confluence_login again, or delete the cookie file at ${CONFIG.COOKIE_FILE} and re-login.`
    );
  }
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry on 429 / 502 / 503 with Retry-After or exponential backoff.
 */
async function fetchWithRetry(url, init) {
  let res;
  for (let attempt = 0; attempt <= CONFIG.httpMaxRetries; attempt++) {
    res = await fetchWithAuth(url, init);
    const s = res.status;
    if (s !== 429 && s !== 503 && s !== 502) return res;
    if (attempt >= CONFIG.httpMaxRetries) return res;
    const ra = parseInt(res.headers.get("retry-after") || "0", 10);
    const backoff = CONFIG.httpRetryBaseMs * 2 ** attempt;
    const waitMs = Math.min(
      30_000,
      Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff
    );
    await sleep(waitMs);
  }
  return res;
}

function hintForConfluenceStatus(status) {
  if (status === 401) {
    return " Unauthorized: SSO session expired, missing, or unusable — run confluence_login again to refresh your cookies.";
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
  const res = await fetchWithRetry(url, {
    headers: { ...jsonHeaders },
  });
  return parseResponse(res);
}

/** POST / PUT JSON */
async function requestJsonWithBody(method, pathAndQuery, body) {
  const url = `${CONFIG.CONFLUENCE_BASE_URL}${pathAndQuery}`;
  const init = {
    method,
    headers: { ...jsonHeaders },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetchWithRetry(url, init);
  return parseResponse(res);
}

async function requestJsonDelete(pathAndQuery) {
  const url = `${CONFIG.CONFLUENCE_BASE_URL}${pathAndQuery}`;
  const res = await fetchWithRetry(url, {
    method: "DELETE",
    headers: { ...jsonHeaders },
  });
  return parseResponse(res);
}

/** GET binary (attachments). Respects CONFLUENCE_MAX_ATTACHMENT_BYTES. */
export async function requestBinary(pathAndQuery) {
  const url = `${CONFIG.CONFLUENCE_BASE_URL}${pathAndQuery}`;
  const res = await fetchWithRetry(url, {
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
  let data;
  try {
    data = await requestJson(
      `/rest/api/content/search?cql=${cqlParam}&limit=${lim}&start=${st}`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const wrapped = appendCqlContextToError(msg, cql);
    if (wrapped !== msg) throw new Error(wrapped);
    throw e;
  }
  if (CONFIG.allowedSpaceKeys && Array.isArray(data?.results)) {
    const allowed = CONFIG.allowedSpaceKeys;
    const filtered = data.results.filter((r) => {
      const sk = r.space?.key;
      return sk && allowed.has(String(sk).toUpperCase());
    });
    return {
      ...data,
      results: filtered,
      size: filtered.length,
      _mcpAllowlistFiltered: true,
    };
  }
  return data;
}

export async function getPage(pageId, expand = "body.storage,version,space") {
  const id = encodeURIComponent(pageId);
  const exp = encodeURIComponent(expand);
  const data = await requestJson(`/rest/api/content/${id}?expand=${exp}`);
  enforceAllowlistOnPageJson(data);
  return data;
}

/** Page metadata plus ancestor chain (expand=ancestors). */
export async function getPageAncestors(pageId) {
  return getPage(pageId, "ancestors,version,space,title");
}

/**
 * List spaces (browse / pick a space key).
 * @param {number} limit
 * @param {number} start
 * @param {string} [expand] e.g. "permissions,operations,description,icon" — helps see create/browse rights where supported
 */
export async function listSpaces(limit = 25, start = 0, expand) {
  const data = await requestJson(buildListSpacesPath(limit, start, expand));
  if (CONFIG.allowedSpaceKeys && Array.isArray(data?.results)) {
    const allowed = CONFIG.allowedSpaceKeys;
    const filtered = data.results.filter((sp) =>
      allowed.has(String(sp.key || "").toUpperCase())
    );
    return { ...data, results: filtered, size: filtered.length, _mcpAllowlistFiltered: true };
  }
  return data;
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
  enforceAllowlistOnSpaceKey(spaceKey);
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
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 50;
  const st = Number.isFinite(start) ? Math.max(0, start) : 0;
  const expand = encodeURIComponent("metadata,version");
  return requestJson(
    `/rest/api/content/${id}/child/attachment?limit=${lim}&start=${st}&expand=${expand}`
  );
}

/**
 * Download an attachment by its attachment ID via the REST child endpoint
 * (/rest/api/content/{pageId}/child/attachment/{attachmentId}/download). More precise
 * than by-filename when a page has duplicate attachment names.
 * @param {string} pageId
 * @param {string} attachmentId
 */
export async function downloadAttachmentByRest(pageId, attachmentId) {
  const pid = encodeURIComponent(pageId);
  const aid = encodeURIComponent(attachmentId);
  return requestBinary(`/rest/api/content/${pid}/child/attachment/${aid}/download`);
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

function escCqlString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Named CQL templates for `confluence_search_preset`. */
export const CQL_SEARCH_PRESETS = {
  recent_pages: {
    description: "Pages ordered by last modified (newest first).",
    build: () => "type = page order by lastModified desc",
  },
  pages_in_space: {
    description: "Pages in a single space (requires spaceKey).",
    build: (spaceKey) => {
      if (!spaceKey) throw new Error("spaceKey is required for pages_in_space");
      return `type = page AND space = "${escCqlString(spaceKey)}" order by title`;
    },
  },
  stale_pages_90d: {
    description: "Pages not modified in the last 90 days.",
    build: (spaceKey) => {
      const base = `type = page AND lastModified < now("-90d")`;
      return spaceKey
        ? `${base} AND space = "${escCqlString(spaceKey)}" order by lastModified`
        : `${base} order by lastModified`;
    },
  },
  pages_i_contributed: {
    description: "Pages where current user is contributor (Cloud/DC dependent).",
    build: () => "type = page AND contributor = currentUser() order by lastModified desc",
  },
};

export function listCqlPresetKeys() {
  return Object.entries(CQL_SEARCH_PRESETS).map(([key, v]) => ({
    key,
    description: v.description,
  }));
}

export async function searchWithPreset(presetKey, { spaceKey, limit = 25, start = 0 } = {}) {
  const preset = CQL_SEARCH_PRESETS[presetKey];
  if (!preset) {
    const keys = Object.keys(CQL_SEARCH_PRESETS).join(", ");
    throw new Error(`Unknown preset "${presetKey}". Known: ${keys}`);
  }
  const cql = preset.build(spaceKey);
  return searchContent(cql, limit, start);
}

/**
 * Outbound links from storage: Confluence `ri:page`, `ri:blog-post`, space refs, and `ri:url`.
 */
export function extractOutboundLinksFromStorage(storageXml) {
  const out = [];
  if (!storageXml || typeof storageXml !== "string") return out;

  const pageTags = storageXml.match(/<ri:page\b[^>]*\/?>/gi) ?? [];
  for (const block of pageTags) {
    const idM = /ri:content-id="([^"]+)"/.exec(block);
    const skM = /ri:space-key="([^"]+)"/.exec(block);
    const titleM = /ri:content-title="([^"]+)"/.exec(block);
    out.push({
      kind: "page",
      contentId: idM ? idM[1] : undefined,
      spaceKey: skM ? skM[1] : undefined,
      title: titleM ? titleM[1] : undefined,
    });
  }

  const urlRe = /<ri:url\b[^>]*?ri:value="([^"]+)"/gi;
  let um;
  while ((um = urlRe.exec(storageXml)) !== null) {
    out.push({ kind: "url", url: um[1] });
  }
  return out;
}

const DIAGRAM_FILE_RE = /\.(drawio|dio|gliffy|vsdx?|puml|plantuml|mmd|mermaid)$/i;

export async function listDiagramLikeAttachments(pageId) {
  const data = await listAttachments(pageId, 100, 0);
  const results = data?.results ?? [];
  const hits = results.filter((r) => DIAGRAM_FILE_RE.test(r.title || ""));
  return { pageId, count: hits.length, attachments: hits };
}

export async function listChildPages(pageId, limit = 25, start = 0, expand = "version") {
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 25;
  const st = Number.isFinite(start) ? Math.max(0, start) : 0;
  const exp = encodeURIComponent(expand);
  const data = await requestJson(
    `/rest/api/content/${id}/child/page?limit=${lim}&start=${st}&expand=${exp}`
  );
  if (CONFIG.allowedSpaceKeys && Array.isArray(data?.results)) {
    const allowed = CONFIG.allowedSpaceKeys;
    const filtered = data.results.filter((r) =>
      allowed.has(String(r.space?.key || "").toUpperCase())
    );
    return { ...data, results: filtered, size: filtered.length };
  }
  return data;
}

export async function listPageComments(pageId, limit = 25, start = 0) {
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 25;
  const st = Number.isFinite(start) ? Math.max(0, start) : 0;
  const exp = encodeURIComponent("body.view,version,history");
  return requestJson(
    `/rest/api/content/${id}/child/comment?limit=${lim}&start=${st}&expand=${exp}`
  );
}

export async function listPageLabels(pageId) {
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  return requestJson(`/rest/api/content/${id}/label`);
}

export async function addPageLabel(pageId, labelName) {
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  const name = String(labelName).trim();
  if (!name) throw new Error("labelName is required");
  const body = [{ prefix: "global", name }];
  return requestJsonWithBody("POST", `/rest/api/content/${id}/label`, body);
}

export async function removePageLabel(pageId, labelName) {
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  const name = encodeURIComponent(String(labelName).trim());
  return requestJsonDelete(
    `/rest/api/content/${id}/label?name=${name}&prefix=global`
  );
}

export async function listPageVersions(pageId, limit = 50) {
  if (CONFIG.allowedSpaceKeys) {
    await getPage(pageId, "space");
  }
  const id = encodeURIComponent(pageId);
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 200) : 50;
  return requestJson(`/rest/api/content/${id}/version?limit=${lim}`);
}

export async function getPageStorageAtVersion(pageId, version, expand = "body.storage,version,space") {
  const id = encodeURIComponent(pageId);
  const v = encodeURIComponent(String(version));
  const exp = encodeURIComponent(expand);
  const data = await requestJson(`/rest/api/content/${id}?expand=${exp}&version=${v}`);
  enforceAllowlistOnPageJson(data);
  return data;
}

export async function diffPageStorageVersions(pageId, versionA, versionB) {
  const a = await getPageStorageAtVersion(pageId, versionA, "body.storage,version");
  const b = await getPageStorageAtVersion(pageId, versionB, "body.storage,version");
  const left = a?.body?.storage?.value ?? "";
  const right = b?.body?.storage?.value ?? "";
  const patch = createTwoFilesPatch(
    `v${versionA}`,
    `v${versionB}`,
    left,
    right,
    "",
    ""
  );
  return {
    pageId: String(pageId),
    title: a?.title ?? b?.title,
    versionA: Number(versionA),
    versionB: Number(versionB),
    patchChars: patch.length,
    patch: patch.slice(0, 200_000),
    truncated: patch.length > 200_000,
  };
}

export async function getPagesBatch(pageIds, expand = "body.storage,version,space") {
  const ids = Array.isArray(pageIds) ? pageIds.map(String) : [];
  if (!ids.length) return { results: [] };
  if (ids.length > 20) {
    throw new Error("getPagesBatch supports at most 20 page IDs per call.");
  }
  const results = [];
  for (const id of ids) {
    try {
      results.push({ pageId: id, ok: true, page: await getPage(id, expand) });
    } catch (e) {
      results.push({
        pageId: id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { count: results.length, results };
}

/**
 * Optional vision summary for an image attachment (OpenAI-compatible chat API).
 */
export async function describeAttachmentWithVision(pageId, filename, instructions) {
  const key = CONFIG.visionApiKey;
  if (!key) {
    throw new Error(
      "Set CONFLUENCE_VISION_API_KEY or OPENAI_API_KEY to use confluence_describe_attachment."
    );
  }
  if (CONFIG.allowedSpaceKeys) {
    await getPage(String(pageId), "space");
  }
  const { buffer, contentType } = await fetchAttachmentByFilename(String(pageId), String(filename));
  if (!/^image\//i.test(contentType)) {
    throw new Error(
      `Vision describe supports image attachments only; "${filename}" is ${contentType}.`
    );
  }
  const b64 = buffer.toString("base64");
  const model = CONFIG.visionModel;
  const url = `${CONFIG.visionApiBase}/chat/completions`;
  const prompt =
    typeof instructions === "string" && instructions.trim()
      ? instructions.trim()
      : "Describe this diagram or screenshot for a software engineer: list main systems, flows, and any readable labels.";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:${contentType.split(";")[0]};base64,${b64}` },
            },
          ],
        },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Vision API HTTP ${res.status}: ${raw.slice(0, 800)}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Vision API returned non-JSON: ${raw.slice(0, 400)}`);
  }
  const text = data?.choices?.[0]?.message?.content ?? "";
  return {
    pageId: String(pageId),
    filename,
    model,
    description: text,
  };
}

// --- Write (requires Confluence edit permission) ---

/**
 * Create a new page. storageHtml is Confluence storage format (XHTML subset).
 */
export async function createPage({ spaceKey, title, storageHtml, parentPageId }) {
  enforceAllowlistOnSpaceKey(spaceKey);
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
