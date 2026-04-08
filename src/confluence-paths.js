/**
 * Pure URL/path builders for Confluence REST (testable without config or network).
 */

export function buildListSpacesPath(limit, start, expand) {
  const lim = Number.isFinite(limit) ? Math.min(Math.max(1, limit), 100) : 25;
  const st = Number.isFinite(start) ? Math.max(0, start) : 0;
  const q = [`limit=${lim}`, `start=${st}`];
  if (expand && String(expand).trim()) {
    q.push(`expand=${encodeURIComponent(String(expand).trim())}`);
  }
  return `/rest/api/space?${q.join("&")}`;
}

export function buildGetSpacePath(spaceKey, expand) {
  const key = encodeURIComponent(spaceKey);
  const exp = encodeURIComponent(expand);
  return `/rest/api/space/${key}?expand=${exp}`;
}

/**
 * @param {string} configuredBaseUrl
 * @param {string} sampleSelfLink URL from API _links.self
 */
export function healthCheckHosts(configuredBaseUrl, sampleSelfLink) {
  let responseHost = "";
  try {
    responseHost = sampleSelfLink ? new URL(sampleSelfLink).hostname : "";
  } catch {
    responseHost = "";
  }
  let configuredHost = "";
  try {
    configuredHost = new URL(configuredBaseUrl).hostname;
  } catch {
    configuredHost = "";
  }
  const hostMatches =
    !responseHost || !configuredHost ? null : responseHost.toLowerCase() === configuredHost.toLowerCase();
  const hint =
    responseHost && configuredHost && responseHost.toLowerCase() !== configuredHost.toLowerCase()
      ? "REST links point at a different host than CONFLUENCE_BASE_URL — set the env for this MCP server to the same instance your browser uses."
      : null;
  return { configuredHost, responseHost, hostMatches, hint };
}

export function appendCqlContextToError(message, cql) {
  if (message.includes("Confluence HTTP")) {
    return `${message}\n(Request context: CQL was ${JSON.stringify(cql)})`;
  }
  return message;
}
