import fs from "fs";
import os from "node:os";
import path from "path";
import { fileURLToPath } from "url";
import { findMcpServerEnvForEntryScript } from "./mcp-server-discovery.js";

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
 * Merge env from the mcp.json server entry that points at this project's src/index.js
 * (any server name: confluence-sso, mywiki-sso, etc.). Same values Cursor injects at MCP start.
 * Applied after .env so `npm run login` matches MCP without duplicating URLs in .env.
 */
function applyConfluenceMcpEnvFromUserConfig() {
  const env = mcpServerEntry?.env;
  if (!env || typeof env !== "object") return;
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string") process.env[key] = val;
  }
}

loadEnvFile();
applyConfluenceMcpEnvFromUserConfig();

/**
 * PAT: prefer the discovered mcp.json env block; else Cursor-injected process.env (never from .env file).
 */
function readPatFromMcpConfigOnly() {
  const block = mcpServerEntry?.env;
  if (block && typeof block === "object") {
    const p =
      (typeof block.CONFLUENCE_PAT === "string" && block.CONFLUENCE_PAT.trim()) ||
      (typeof block.CONFLUENCE_API_TOKEN === "string" && block.CONFLUENCE_API_TOKEN.trim()) ||
      "";
    if (p) return p;
  }
  const fromProcess =
    (typeof process.env.CONFLUENCE_PAT === "string" && process.env.CONFLUENCE_PAT.trim()) ||
    (typeof process.env.CONFLUENCE_API_TOKEN === "string" && process.env.CONFLUENCE_API_TOKEN.trim()) ||
    "";
  return fromProcess;
}

const baseRaw = process.env.CONFLUENCE_BASE_URL?.replace(/\/$/, "").trim();
if (!baseRaw) {
  throw new Error(
    "CONFLUENCE_BASE_URL is not set. Add it under your Cursor MCP server env in %USERPROFILE%\\.cursor\\mcp.json (the server entry whose args point to this project's src/index.js), then restart Cursor."
  );
}
const base = baseRaw;
const loginDefault = `${base}/login.action`;

export const CONFIG = {
  CONFLUENCE_BASE_URL: base,
  LOGIN_URL: process.env.CONFLUENCE_LOGIN_URL || loginDefault,
  COOKIE_FILE: path.join(PROJECT_ROOT, "cookies", "session.json"),
  LOGIN_WAIT_MS: Math.max(
    30_000,
    (parseInt(process.env.CONFLUENCE_LOGIN_WAIT_SECONDS || "90", 10) || 90) * 1000
  ),
  PROJECT_ROOT,
  /** MCP server key in mcp.json if discovered (e.g. confluence-sso, mywiki-sso). */
  mcpServerKey: mcpServerEntry?.key ?? null,
  /** Returns PAT if set in mcp.json (discovered block) or injected by Cursor (Bearer for DC REST). */
  getPatToken: readPatFromMcpConfigOnly,
  hasPat: () => Boolean(readPatFromMcpConfigOnly()),
  maxAttachmentBytes: (() => {
    const raw = parseInt(process.env.CONFLUENCE_MAX_ATTACHMENT_BYTES || "5242880", 10);
    const n = Number.isFinite(raw) ? raw : 5_242_880;
    return Math.min(50 * 1024 * 1024, Math.max(256 * 1024, n));
  })(),
};
