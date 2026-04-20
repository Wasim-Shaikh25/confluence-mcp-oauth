#!/usr/bin/env node
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loginWithSSO, loginToolResultText } from "./auth.js";
import {
  searchContent,
  getPage,
  listSpaces,
  listAllSpaces,
  listSpacesWithCreateHints,
  getSpace,
  healthCheck,
  findPageByTitle,
  createPage,
  updatePage,
  listAttachments,
  fetchAttachmentByFilename,
  extractDiagramMacrosFromStorage,
  extractImageReferencesFromStorage,
  listCqlPresetKeys,
  searchWithPreset,
  extractOutboundLinksFromStorage,
  listDiagramLikeAttachments,
  listChildPages,
  listPageComments,
  listPageLabels,
  addPageLabel,
  removePageLabel,
  listPageVersions,
  getPageStorageAtVersion,
  diffPageStorageVersions,
  getPagesBatch,
  describeAttachmentWithVision,
  getPageAncestors,
} from "./confluence.js";

const server = new Server(
  { name: "confluence-oauth-mcp", version: "0.1.8" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "confluence_login",
      description:
        "SSO login in a browser (Playwright); saves cookies for REST. If IdP redirects or automation block a session, use CONFLUENCE_PAT + PREFER_SSO_COOKIES=0 in mcp.json or delete the reported cookie file. Optional when PAT is configured and preferred.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "confluence_search",
      description:
        "Search Confluence with CQL. Supports pagination via start offset.",
      inputSchema: {
        type: "object",
        properties: {
          cql: {
            type: "string",
            description:
              'CQL query, e.g. type = page AND space = "TEAM" order by lastModified desc',
          },
          limit: { type: "number", description: "Max results (default 25, max 100)." },
          start: { type: "number", description: "Pagination offset (default 0)." },
        },
      },
    },
    {
      name: "confluence_list_spaces",
      description:
        "List one page of Confluence spaces (keys and names). Optional expand (e.g. permissions, operations). For every space without manual pagination, use confluence_list_all_spaces or confluence_spaces_create_hints.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max spaces (default 25, max 100)." },
          start: { type: "number", description: "Pagination offset (default 0)." },
          expand: {
            type: "string",
            description:
              'Comma-separated API expand, e.g. "permissions,operations,description" (instance-dependent).',
          },
        },
      },
    },
    {
      name: "confluence_list_all_spaces",
      description:
        "List spaces across all pages (paginates GET /rest/api/space) until empty or maxSpaces. Optional expand. Use to enumerate every space key/name the current user can list.",
      inputSchema: {
        type: "object",
        properties: {
          maxSpaces: {
            type: "number",
            description: "Stop after this many spaces (default 500, max 2000).",
          },
          expand: {
            type: "string",
            description:
              'Comma-separated expand, e.g. "permissions,operations,description,homepage".',
          },
        },
      },
    },
    {
      name: "confluence_spaces_create_hints",
      description:
        "List spaces with best-effort canCreatePage hints from REST expand=permissions,operations (Cloud/DC shapes differ; null means unknown). Prefer confluence_create_page with spaceKey + parentPageId for a page under a parent in that space. Not a substitute for Confluence permission rules—use confluence_get_space or a test create if unsure.",
      inputSchema: {
        type: "object",
        properties: {
          maxSpaces: {
            type: "number",
            description: "Max spaces to scan (default 500, max 2000).",
          },
        },
      },
    },
    {
      name: "confluence_get_space",
      description:
        "Get a single space by key with optional permission/operation details (helps before create_page).",
      inputSchema: {
        type: "object",
        properties: {
          spaceKey: { type: "string", description: "Space key, e.g. TEAM" },
          expand: {
            type: "string",
            description:
              'Comma-separated expand (default: permissions,operations,description,homepage).',
          },
        },
        required: ["spaceKey"],
      },
    },
    {
      name: "confluence_health_check",
      description:
        "Verify CONFLUENCE_BASE_URL matches the REST API host. Use when page IDs work in the browser but REST returns 404—often a second Confluence deployment or wrong base URL in MCP config.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "confluence_find_page",
      description: "Find page(s) by space key and exact title (read helper).",
      inputSchema: {
        type: "object",
        properties: {
          spaceKey: { type: "string", description: "Space key, e.g. TEAM" },
          title: { type: "string", description: "Exact page title" },
        },
        required: ["spaceKey", "title"],
      },
    },
    {
      name: "confluence_get_page",
      description: "Read a page by content ID (includes body.storage when expand allows).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Confluence content ID" },
          expand: {
            type: "string",
            description:
              "Comma-separated expand, default body.storage,version,space",
          },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_list_attachments",
      description:
        "List attachments on a page (filenames, sizes, download paths). Use before fetch_attachment.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Confluence page content ID" },
          limit: { type: "number", description: "Max attachments (default 50, max 100)." },
          start: { type: "number", description: "Pagination offset (default 0)." },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_fetch_attachment",
      description:
        "Download a page attachment by filename (PNG/JPEG/etc.). Returns an image for image/* types, otherwise base64 text. Auth: CONFLUENCE_PAT first, then SSO cookies.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Confluence page content ID" },
          filename: {
            type: "string",
            description: "Exact attachment title/filename as shown in Confluence",
          },
        },
        required: ["pageId", "filename"],
      },
    },
    {
      name: "confluence_extract_diagrams",
      description:
        "Parse page body.storage and extract diagram source text (uml-sequence, plantuml, mermaid, drawio, gliffy). Does not render images.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Confluence page content ID" },
          includeNonDiagramMacros: {
            type: "boolean",
            description:
              "If true, include all structured macros with plain-text bodies (default false).",
          },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_extract_page_images",
      description:
        "Parse body.storage for ri:attachment and ri:url image references (filenames to use with fetch_attachment).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Confluence page content ID" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_create_page",
      description:
        "Create a new page (requires edit permission). Body is Confluence storage HTML.",
      inputSchema: {
        type: "object",
        properties: {
          spaceKey: { type: "string", description: "Target space key" },
          title: { type: "string", description: "Page title" },
          storageHtml: {
            type: "string",
            description: "Storage format HTML, e.g. <p>Hello</p>",
          },
          parentPageId: {
            type: "string",
            description: "Optional parent page content ID",
          },
        },
        required: ["spaceKey", "title", "storageHtml"],
      },
    },
    {
      name: "confluence_update_page",
      description:
        "Update an existing page body (and optional title). Uses version bump via API.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID to update" },
          storageHtml: {
            type: "string",
            description: "New storage format HTML body",
          },
          title: { type: "string", description: "Optional new title" },
          versionMessage: {
            type: "string",
            description: "Optional version comment (default: Updated via MCP)",
          },
        },
        required: ["pageId", "storageHtml"],
      },
    },
    {
      name: "confluence_get_ancestors",
      description:
        "Return page title, space, version, and ancestor pages (expand=ancestors).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_get_page_rendered",
      description:
        "Read a page including body.view (HTML) plus body.storage and metadata. Use for tables, panels, and layout closer to the Confluence UI.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Confluence content ID" },
          expand: {
            type: "string",
            description:
              'Optional expand (default: "body.view,body.storage,version,space").',
          },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_list_child_pages",
      description: "List direct child pages of a page (GET child/page).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Parent page content ID" },
          limit: { type: "number", description: "Page size (default 25, max 100)" },
          start: { type: "number", description: "Offset (default 0)" },
          expand: { type: "string", description: 'e.g. "version,space"' },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_list_page_comments",
      description: "List comments on a page (body.view expand when supported).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          limit: { type: "number", description: "Max comments (default 25, max 100)" },
          start: { type: "number", description: "Offset (default 0)" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_list_labels",
      description: "List labels on a page.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_add_label",
      description: "Add a global label to a page (requires edit permission).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          labelName: { type: "string", description: "Label text (no spaces restriction depends on site)" },
        },
        required: ["pageId", "labelName"],
      },
    },
    {
      name: "confluence_remove_label",
      description: "Remove a label from a page (requires edit permission).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          labelName: { type: "string", description: "Label to remove" },
        },
        required: ["pageId", "labelName"],
      },
    },
    {
      name: "confluence_list_versions",
      description: "List historical versions of a page.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          limit: { type: "number", description: "Max versions (default 50, max 200)" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_get_page_version",
      description: "Fetch page body at a specific historical version number.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          version: { type: "number", description: "Version number from list_versions" },
          expand: {
            type: "string",
            description: 'Optional expand (default: "body.storage,version,space")',
          },
        },
        required: ["pageId", "version"],
      },
    },
    {
      name: "confluence_diff_page_versions",
      description:
        "Unified diff of body.storage between two version numbers (uses npm diff; patch may truncate).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          versionA: { type: "number", description: "Older or first version" },
          versionB: { type: "number", description: "Newer or second version" },
        },
        required: ["pageId", "versionA", "versionB"],
      },
    },
    {
      name: "confluence_get_pages_batch",
      description:
        "Fetch up to 20 pages in one call (sequential). Each result is ok+page or ok=false+error.",
      inputSchema: {
        type: "object",
        properties: {
          pageIds: {
            type: "array",
            items: { type: "string" },
            description: "Up to 20 content IDs",
          },
          expand: {
            type: "string",
            description: 'Optional expand (default: "body.storage,version,space")',
          },
        },
        required: ["pageIds"],
      },
    },
    {
      name: "confluence_extract_page_links",
      description:
        "Parse body.storage for outbound ri:page and ri:url links (not backlinks).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_list_diagram_attachments",
      description:
        "List attachments whose filenames look like diagrams (drawio, gliffy, vsdx, plantuml, mermaid).",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
        },
        required: ["pageId"],
      },
    },
    {
      name: "confluence_list_cql_presets",
      description: "List built-in CQL preset keys and descriptions (use confluence_search_preset to run one).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "confluence_search_preset",
      description:
        "Run confluence_search using a named preset (recent_pages, pages_in_space, stale_pages_90d, pages_i_contributed).",
      inputSchema: {
        type: "object",
        properties: {
          preset: { type: "string", description: "Preset key from list_cql_presets" },
          spaceKey: {
            type: "string",
            description: "Required for pages_in_space; optional filter for stale_pages_90d",
          },
          limit: { type: "number", description: "Result limit (default 25)" },
          start: { type: "number", description: "Offset (default 0)" },
        },
        required: ["preset"],
      },
    },
    {
      name: "confluence_describe_attachment",
      description:
        "Optional vision summary for an image attachment (OpenAI-compatible API). Set CONFLUENCE_VISION_API_KEY or OPENAI_API_KEY.",
      inputSchema: {
        type: "object",
        properties: {
          pageId: { type: "string", description: "Page content ID" },
          filename: { type: "string", description: "Attachment filename" },
          instructions: {
            type: "string",
            description: "Optional prompt for the vision model",
          },
        },
        required: ["pageId", "filename"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === "confluence_login") {
    const result = await loginWithSSO();
    return {
      content: [
        {
          type: "text",
          text: loginToolResultText(result),
        },
      ],
    };
  }

  if (name === "confluence_search") {
    const cql = args.cql || "type = page order by lastModified desc";
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const start = typeof args.start === "number" ? args.start : 0;
    const data = await searchContent(cql, limit, start);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_spaces") {
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const start = typeof args.start === "number" ? args.start : 0;
    const expand = typeof args.expand === "string" ? args.expand : undefined;
    const data = await listSpaces(limit, start, expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_all_spaces") {
    const maxSpaces = typeof args.maxSpaces === "number" ? args.maxSpaces : 500;
    const expand = typeof args.expand === "string" ? args.expand : undefined;
    const data = await listAllSpaces(maxSpaces, expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_spaces_create_hints") {
    const maxSpaces = typeof args.maxSpaces === "number" ? args.maxSpaces : 500;
    const data = await listSpacesWithCreateHints(maxSpaces);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_get_space") {
    const expand =
      typeof args.expand === "string"
        ? args.expand
        : "permissions,operations,description,homepage";
    const data = await getSpace(String(args.spaceKey), expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_health_check") {
    const data = await healthCheck();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_find_page") {
    const data = await findPageByTitle(String(args.spaceKey), String(args.title));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_get_page") {
    const pageId = args.pageId;
    if (!pageId) {
      throw new Error("pageId is required");
    }
    const expand =
      typeof args.expand === "string"
        ? args.expand
        : "body.storage,version,space";
    const data = await getPage(String(pageId), expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_attachments") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const start = typeof args.start === "number" ? args.start : 0;
    const data = await listAttachments(String(pageId), limit, start);
    const slim = (data?.results ?? []).map((r) => ({
      title: r.title,
      mediaType: r.metadata?.mediaType,
      fileSize: r.extensions?.fileSize,
      version: r.version?.number,
      download: r._links?.download,
      webui: r._links?.webui,
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ size: data?.size, results: slim }, null, 2),
        },
      ],
    };
  }

  if (name === "confluence_fetch_attachment") {
    const pageId = args.pageId;
    const filename = args.filename;
    if (!pageId || !filename) throw new Error("pageId and filename are required");
    const { buffer, contentType } = await fetchAttachmentByFilename(
      String(pageId),
      String(filename)
    );
    const base64 = buffer.toString("base64");
    const isImage = /^image\//i.test(contentType);
    if (isImage) {
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: contentType.split(";")[0].trim(),
          },
          {
            type: "text",
            text: `Attachment "${filename}" (${contentType}, ${buffer.length} bytes).`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              filename,
              contentType,
              byteLength: buffer.length,
              base64,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "confluence_extract_diagrams") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const page = await getPage(String(pageId), "body.storage");
    const storage = page?.body?.storage?.value ?? "";
    const includeAll = args.includeNonDiagramMacros === true;
    const diagrams = extractDiagramMacrosFromStorage(storage, {
      onlyDiagrams: !includeAll,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pageId: String(pageId),
              title: page?.title,
              diagramMacroCount: diagrams.length,
              diagrams,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "confluence_extract_page_images") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const page = await getPage(String(pageId), "body.storage");
    const storage = page?.body?.storage?.value ?? "";
    const imageRefs = extractImageReferencesFromStorage(storage);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pageId: String(pageId),
              title: page?.title,
              imageReferences: imageRefs,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "confluence_create_page") {
    const data = await createPage({
      spaceKey: String(args.spaceKey),
      title: String(args.title),
      storageHtml: String(args.storageHtml),
      parentPageId: args.parentPageId ? String(args.parentPageId) : undefined,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_update_page") {
    const data = await updatePage({
      pageId: String(args.pageId),
      storageHtml: String(args.storageHtml),
      title: args.title != null ? String(args.title) : undefined,
      versionMessage:
        typeof args.versionMessage === "string"
          ? args.versionMessage
          : "Updated via MCP",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_get_ancestors") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const data = await getPageAncestors(String(pageId));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_get_page_rendered") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const expand =
      typeof args.expand === "string"
        ? args.expand
        : "body.view,body.storage,version,space";
    const data = await getPage(String(pageId), expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_child_pages") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const start = typeof args.start === "number" ? args.start : 0;
    const expand = typeof args.expand === "string" ? args.expand : "version";
    const data = await listChildPages(String(pageId), limit, start, expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_page_comments") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const start = typeof args.start === "number" ? args.start : 0;
    const data = await listPageComments(String(pageId), limit, start);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_labels") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const data = await listPageLabels(String(pageId));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_add_label") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const data = await addPageLabel(String(pageId), String(args.labelName));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_remove_label") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const data = await removePageLabel(String(pageId), String(args.labelName));
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
    };
  }

  if (name === "confluence_list_versions") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const data = await listPageVersions(String(pageId), limit);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_get_page_version") {
    const pageId = args.pageId;
    const version = args.version;
    if (!pageId || version == null) throw new Error("pageId and version are required");
    const expand =
      typeof args.expand === "string"
        ? args.expand
        : "body.storage,version,space";
    const data = await getPageStorageAtVersion(String(pageId), Number(version), expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_diff_page_versions") {
    const pageId = args.pageId;
    if (!pageId || args.versionA == null || args.versionB == null) {
      throw new Error("pageId, versionA, and versionB are required");
    }
    const data = await diffPageStorageVersions(
      String(pageId),
      Number(args.versionA),
      Number(args.versionB)
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_get_pages_batch") {
    const pageIds = args.pageIds;
    if (!Array.isArray(pageIds) || pageIds.length === 0) {
      throw new Error("pageIds array is required");
    }
    const expand =
      typeof args.expand === "string"
        ? args.expand
        : "body.storage,version,space";
    const data = await getPagesBatch(pageIds.map(String), expand);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_extract_page_links") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const page = await getPage(String(pageId), "body.storage,space,title");
    const storage = page?.body?.storage?.value ?? "";
    const links = extractOutboundLinksFromStorage(storage);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pageId: String(pageId),
              title: page?.title,
              linkCount: links.length,
              links,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "confluence_list_diagram_attachments") {
    const pageId = args.pageId;
    if (!pageId) throw new Error("pageId is required");
    const data = await listDiagramLikeAttachments(String(pageId));
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_list_cql_presets") {
    const data = listCqlPresetKeys();
    return {
      content: [{ type: "text", text: JSON.stringify({ presets: data }, null, 2) }],
    };
  }

  if (name === "confluence_search_preset") {
    const preset = String(args.preset || "");
    if (!preset) throw new Error("preset is required");
    const spaceKey =
      typeof args.spaceKey === "string" && args.spaceKey.trim()
        ? args.spaceKey.trim()
        : undefined;
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const start = typeof args.start === "number" ? args.start : 0;
    const data = await searchWithPreset(preset, { spaceKey, limit, start });
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  if (name === "confluence_describe_attachment") {
    const pageId = args.pageId;
    const filename = args.filename;
    if (!pageId || !filename) throw new Error("pageId and filename are required");
    const instructions =
      typeof args.instructions === "string" ? args.instructions : undefined;
    const data = await describeAttachmentWithVision(
      String(pageId),
      String(filename),
      instructions
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", async () => {
  await transport.close();
  process.exit(0);
});
