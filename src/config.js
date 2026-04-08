import fs from "fs";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { findMcpServerEnvForEntryScript } from "./mcp-server-discovery.js";
import { resolveConfluenceCookiePath } from "./session-path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENTRY_SCRIPT = path.join(PROJECT_ROOT, "src", "index.js");

/** PAT must come only from Cursor MCP config (mcp.json), not from a project .env file. */
const PAT_ENV_KEYS = new Set(["CONFLUENCE_PAT", "CONFLUENCE_API_TOKEN"]);

const mcpServerEntry = findMcpServerEnvForEntryScript(ENTRY_SCRIPT);

function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (PAT_ENV_KEYS.has(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Merge env from the mcp.json server entry that points at this project's src/index.js.
 * **Never overwrites keys already set on `process.env`** — Cursor injects the active server's
 * `env` before Node starts. Without this, the first matching block in mcp.json (e.g. enterprise
 * Confluence) would overwrite `CONFLUENCE_BASE_URL` for a second server that uses the same
 * `args` path (e.g. MyWiki).
 * Fills only missing keys so `npm run login` still picks up URL from a discovered block when unset.
 */
function applyConfluenceMcpEnvFromUserConfig() {
  const env = mcpServerEntry?.env;
  if (!env || typeof env !== "object") return;
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string" && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();
applyConfluenceMcpEnvFromUserConfig();

/**
 * PAT: prefer Cursor-injected process.env (correct server when multiple entries share one script path),
 * then discovered mcp.json block (never from project .env file for PAT keys).
 */
function readPatFromMcpConfigOnly() {
  const fromProcess =
    (typeof process.env.CONFLUENCE_PAT === "string" && process.env.CONFLUENCE_PAT.trim()) ||
    (typeof process.env.CONFLUENCE_API_TOKEN === "string" && process.env.CONFLUENCE_API_TOKEN.trim()) ||
    "";
  if (fromProcess) return fromProcess;
  const block = mcpServerEntry?.env;
  if (block && typeof block === "object") {
    const p =
      (typeof block.CONFLUENCE_PAT === "string" && block.CONFLUENCE_PAT.trim()) ||
      (typeof block.CONFLUENCE_API_TOKEN === "string" && block.CONFLUENCE_API_TOKEN.trim()) ||
      "";
    if (p) return p;
  }
  return "";
}

const baseRaw = process.env.CONFLUENCE_BASE_URL?.replace(/\/$/, "").trim();
if (!baseRaw) {
  throw new Error(
    "CONFLUENCE_BASE_URL is not set. Add it under your Cursor MCP server env in %USERPROFILE%\\.cursor\\mcp.json (the server entry whose args point to this project's src/index.js), then restart Cursor."
  );
}
const base = baseRaw;
const loginDefault = `${base}/login.action`;

const cookieFile = resolveConfluenceCookiePath(PROJECT_ROOT, base, process.env.CONFLUENCE_MCP_SERVER_KEY);

/** When true (default): if a saved SSO cookie file exists, use only cookies (do not send PAT). After 401, prompt to re-login or delete cookie file / set PREFER_SSO_COOKIES=0 to use PAT. */
const preferSsoCookies =
  process.env.PREFER_SSO_COOKIES !== "0" && String(process.env.PREFER_SSO_COOKIES).toLowerCase() !== "false";

export const CONFIG = {
  CONFLUENCE_BASE_URL: base,
  LOGIN_URL: process.env.CONFLUENCE_LOGIN_URL || loginDefault,
  COOKIE_FILE: cookieFile,
  /** Prefer saved SSO session over PAT when cookie file has a session (default true). */
  preferSsoCookies,
  LOGIN_WAIT_MS: Math.max(
    30_000,
    (parseInt(process.env.CONFLUENCE_LOGIN_WAIT_SECONDS || "90", 10) || 90) * 1000
  ),
  /** How often to probe /rest/api/user/current during browser login (early exit when session works). */
  LOGIN_POLL_MS: Math.max(500, parseInt(process.env.CONFLUENCE_LOGIN_POLL_MS || "2000", 10) || 2000),
  PROJECT_ROOT,
  /** MCP server key in mcp.json if discovered (whatever label you used for this server). */
  mcpServerKey: mcpServerEntry?.key ?? null,
  /** Returns PAT if set in mcp.json (discovered block) or injected by Cursor (Bearer for Atlassian REST). */
  getPatToken: readPatFromMcpConfigOnly,
  hasPat: () => Boolean(readPatFromMcpConfigOnly()),
  maxAttachmentBytes: (() => {
    const raw = parseInt(process.env.CONFLUENCE_MAX_ATTACHMENT_BYTES || "5242880", 10);
    const n = Number.isFinite(raw) ? raw : 5_242_880;
    return Math.min(50 * 1024 * 1024, Math.max(256 * 1024, n));
  })(),
};
