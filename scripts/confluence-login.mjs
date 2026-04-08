/**
 * SSO login helper — same code path as the confluence_login MCP tool.
 * Run: npm run login  (uses .env in project root; no PowerShell $env: needed)
 */
import { loginWithSSO, loginToolResultText } from "../src/auth.js";

const result = await loginWithSSO();
console.log(loginToolResultText(result));
