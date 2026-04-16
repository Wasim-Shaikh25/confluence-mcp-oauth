import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractOutboundLinksFromStorage,
  listCqlPresetKeys,
} from "../src/confluence.js";

describe("confluence outbound links", () => {
  it("extracts ri:page and ri:url from storage", () => {
    const storage = `
      <p><ac:link><ri:page ri:content-id="123" ri:space-key="ABC" ri:content-title="Hello" /></ac:link></p>
      <p><ri:url ri:value="https://example.com/doc" /></p>
    `;
    const links = extractOutboundLinksFromStorage(storage);
    assert.equal(links.length, 2);
    assert.equal(links[0].kind, "page");
    assert.equal(links[0].contentId, "123");
    assert.equal(links[0].spaceKey, "ABC");
    assert.equal(links[0].title, "Hello");
    assert.equal(links[1].kind, "url");
    assert.equal(links[1].url, "https://example.com/doc");
  });
});

describe("CQL presets", () => {
  it("lists known preset keys", () => {
    const keys = listCqlPresetKeys().map((k) => k.key);
    assert.ok(keys.includes("recent_pages"));
    assert.ok(keys.includes("pages_in_space"));
    assert.ok(keys.includes("stale_pages_90d"));
    assert.ok(keys.includes("pages_i_contributed"));
  });
});
