/**
 * Best-effort interpretation of Confluence REST space payloads (Cloud + Data Center differ).
 * Used by confluence_spaces_create_hints; not a security guarantee — final check is create_page or UI.
 */

/**
 * @param {unknown} space Raw space object from GET /space or list results[]
 * @returns {{
 *   spaceKey: string;
 *   name: string;
 *   canCreatePage: boolean | null;
 *   signals: string[];
 *   homepageId: string | null;
 * }}
 */
export function summarizeSpaceForPageCreate(space) {
  const s = space && typeof space === "object" ? /** @type {Record<string, unknown>} */ (space) : {};
  const spaceKey = typeof s.key === "string" ? s.key : "";
  const name = typeof s.name === "string" ? s.name : "";
  const signals = [];

  const homepage = s.homepage;
  let homepageId = null;
  if (homepage && typeof homepage === "object" && "id" in homepage) {
    homepageId = String(/** @type {{ id?: unknown }} */ (homepage).id ?? "");
  }

  let canCreatePage = null;

  const ops = s.operations;
  if (Array.isArray(ops)) {
    for (const o of ops) {
      if (typeof o === "string") {
        const low = o.toLowerCase();
        if (low.includes("createpage") || low === "create" || low.includes("create_page")) {
          canCreatePage = true;
          signals.push(`operations:string:${o}`);
        }
      } else if (o && typeof o === "object") {
        const op = String(
          /** @type {Record<string, unknown>} */ (o).operation ??
            /** @type {Record<string, unknown>} */ (o).name ??
            ""
        ).toLowerCase();
        const target = String(
          /** @type {Record<string, unknown>} */ (o).targetType ??
            /** @type {Record<string, unknown>} */ (o).target ??
            ""
        ).toLowerCase();
        if (target === "page" && (op.includes("create") || op === "create")) {
          canCreatePage = true;
          signals.push(`operations:object:${op}:${target}`);
        }
      }
    }
    if (ops.length === 0) {
      signals.push("operations:empty-array");
    }
  } else if (ops !== undefined && ops !== null) {
    signals.push(`operations:unexpected-type:${typeof ops}`);
  }

  const perms = s.permissions;
  if (perms != null && typeof perms === "object") {
    const j = JSON.stringify(perms).toLowerCase();
    if (j.includes("createpage")) {
      if (canCreatePage !== true) {
        canCreatePage = true;
        signals.push("permissions:json-hint");
      }
    }
  }

  if (canCreatePage === null && !signals.some((x) => x.startsWith("operations:"))) {
    signals.push("insufficient-hint:use-confluence_get_space-or-try-confluence_create_page");
  }

  return {
    spaceKey,
    name,
    canCreatePage,
    signals,
    homepageId,
  };
}
