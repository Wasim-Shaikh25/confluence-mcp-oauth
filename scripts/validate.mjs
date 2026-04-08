#!/usr/bin/env node
/**
 * Local validation without hitting Confluence:
 * 1. Syntax-check every .js under src/
 * 2. If CONFLUENCE_BASE_URL is set, load config (no network).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(root, "src")).filter((f) => f.endsWith(".js"));
let failed = false;
for (const f of srcFiles) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || `Failed: ${f}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`OK: syntax check (${srcFiles.length} files under src/)`);

if (!process.env.CONFLUENCE_BASE_URL?.trim()) {
  console.log(
    "Skip config load (set CONFLUENCE_BASE_URL to validate config module without calling Confluence)."
  );
  process.exit(0);
}

const { CONFIG } = await import("../src/config.js");
console.log("OK: config loaded");
console.log(
  JSON.stringify(
    {
      CONFLUENCE_BASE_URL: CONFIG.CONFLUENCE_BASE_URL,
      LOGIN_URL: CONFIG.LOGIN_URL,
      hasPat: CONFIG.hasPat(),
    },
    null,
    2
  )
);
