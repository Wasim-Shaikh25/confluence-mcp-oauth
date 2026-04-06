import fs from "fs";
import os from "node:os";
import path from "path";

/**
 * Finds the mcpServers entry that launches a given entry script (e.g. this repo's src/index.js).
 * Cursor may name the server anything (confluence-sso, mywiki-sso, etc.); we match by path.
 *
 * @param {string} entryScriptAbsolute - Absolute path to the MCP entry file (e.g. .../src/index.js)
 * @param {string[]} [legacyServerKeys] - If no path match, try these keys in order (optional env blocks).
 * @returns {{ key: string, env: Record<string, string> } | null}
 */
export function findMcpServerEnvForEntryScript(
  entryScriptAbsolute,
  legacyServerKeys = ["confluence-sso", "mywiki-sso"]
) {
  const markerNorm = path.normalize(path.resolve(entryScriptAbsolute)).toLowerCase();

  const mcpPath = path.join(os.homedir(), ".cursor", "mcp.json");
  if (!fs.existsSync(mcpPath)) return null;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch {
    return null;
  }

  const servers = data?.mcpServers;
  if (!servers || typeof servers !== "object") return null;

  const matchesPath = (arg) => {
    if (typeof arg !== "string" || !arg.trim()) return false;
    try {
      const resolved = path.resolve(arg.trim());
      return path.normalize(resolved).toLowerCase() === markerNorm;
    } catch {
      return false;
    }
  };

  for (const [serverKey, server] of Object.entries(servers)) {
    const args = server?.args;
    if (!Array.isArray(args)) continue;
    if (args.some(matchesPath)) {
      const env = server.env && typeof server.env === "object" ? server.env : {};
      return { key: serverKey, env: /** @type {Record<string, string>} */ (env) };
    }
  }

  for (const legacyKey of legacyServerKeys) {
    const env = servers[legacyKey]?.env;
    if (env && typeof env === "object") {
      return { key: legacyKey, env: /** @type {Record<string, string>} */ (env) };
    }
  }

  return null;
}
