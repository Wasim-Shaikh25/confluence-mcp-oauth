/**
 * Ensures npm pack would ship all modules under src/ (prevents incomplete publishes).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const required = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => `src/${f}`)
  .sort();

const out = execSync("npm pack --dry-run 2>&1", { cwd: root, encoding: "utf8" });
const missing = required.filter((rel) => !out.includes(rel.replace(/\//g, path.sep)) && !out.includes(rel));

if (missing.length) {
  console.error("verify-pack-includes-src: these files must appear in npm pack --dry-run:", missing);
  console.error(out.slice(0, 4000));
  process.exit(1);
}

console.log("verify-pack-includes-src: ok (%s files under src/)", required.length);
