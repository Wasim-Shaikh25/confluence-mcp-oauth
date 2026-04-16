/** Ensures confluence.js can load when tests import it (config requires CONFLUENCE_BASE_URL). */
if (!process.env.CONFLUENCE_BASE_URL?.trim()) {
  process.env.CONFLUENCE_BASE_URL = "https://confluence.test.invalid";
}
