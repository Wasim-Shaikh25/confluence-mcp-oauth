import path from "node:path";

/**
 * @param {string} safeLabel e.g. MCP server id or hostname
 */
export function sanitizeSessionLabel(label) {
  return String(label || "default")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 96);
}

/**
 * Per-instance cookie file: avoids clobbering when multiple MCP servers use one clone.
 * @param {string} projectRoot
 * @param {string} baseUrl CONFLUENCE_BASE_URL
 * @param {string | undefined} mcpServerKey CONFLUENCE_MCP_SERVER_KEY from mcp.json
 */
export function resolveConfluenceCookiePath(projectRoot, baseUrl, mcpServerKey) {
  let name = "session";
  const key = typeof mcpServerKey === "string" && mcpServerKey.trim();
  if (key) {
    name = `session-${sanitizeSessionLabel(mcpServerKey)}`;
  } else {
    try {
      const host = new URL(baseUrl).hostname;
      name = `session-${sanitizeSessionLabel(host)}`;
    } catch {
      name = "session";
    }
  }
  return path.join(projectRoot, "cookies", `${name}.json`);
}
