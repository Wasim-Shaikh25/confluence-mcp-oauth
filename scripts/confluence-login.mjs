/**
 * SSO login helper — same code path as the confluence_login MCP tool.
 * Run: npm run login  (uses .env in project root; no PowerShell $env: needed)
 */
import { loginWithSSO } from "../src/auth.js";

await loginWithSSO();
