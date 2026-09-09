import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendCqlContextToError,
  buildGetSpacePath,
  buildListSpacesPath,
  healthCheckHosts,
} from "../src/confluence-paths.js";
import { summarizeSpaceForPageCreate } from "../src/confluence-space-hints.js";
import { buildLoginToolResultText } from "../src/sso-login-messages.js";

describe("confluence-paths", () => {
  it("buildListSpacesPath adds expand when set", () => {
    const p = buildListSpacesPath(25, 0, "permissions,operations");
    assert.ok(p.startsWith("/rest/api/space?"));
    assert.ok(p.includes("limit=25"));
    assert.ok(p.includes("expand=" + encodeURIComponent("permissions,operations")));
  });
  it("buildListSpacesPath omits expand when empty", () => {
    const p = buildListSpacesPath(10, 5, undefined);
    assert.ok(!p.includes("expand="));
    assert.ok(p.includes("start=5"));
  });
  it("buildGetSpacePath encodes key and expand", () => {
    assert.equal(
      buildGetSpacePath("TEAM", "permissions,operations"),
      "/rest/api/space/TEAM?expand=" + encodeURIComponent("permissions,operations")
    );
  });
  it("healthCheckHosts matches when hosts equal", () => {
    const h = healthCheckHosts(
      "https://wiki.example.com",
      "https://wiki.example.com/rest/api/space/TEAM"
    );
    assert.equal(h.hostMatches, true);
    assert.equal(h.hint, null);
  });
  it("healthCheckHosts hints when hosts differ", () => {
    const h = healthCheckHosts(
      "https://wiki.example.com",
      "https://other.atlassian.net/rest/api/space/TEAM"
    );
    assert.equal(h.hostMatches, false);
    assert.ok(h.hint);
  });
  it("appendCqlContextToError appends for Confluence HTTP errors", () => {
    const out = appendCqlContextToError('Confluence HTTP 500: oops', 'space = FOO');
    assert.ok(out.includes("CQL"));
    assert.ok(out.includes("space = FOO"));
  });
  it("appendCqlContextToError leaves other messages", () => {
    const out = appendCqlContextToError("network down", "space = FOO");
    assert.equal(out, "network down");
  });
});

describe("sso-login-messages", () => {
  it("buildLoginToolResultText includes the cookie path and count (SSO-only)", () => {
    const t = buildLoginToolResultText({
      cookieFile: "C:/app/cookies/session-x.json",
      cookieCount: 2,
      sessionProbeOk: true,
    });
    assert.ok(t.includes("session-x.json"));
    assert.ok(t.includes("Cookies captured: 2"));
    // SSO-only: no token guidance should remain.
    assert.ok(!t.includes("CONFLUENCE_PAT"));
    assert.ok(!t.includes("PREFER_SSO_COOKIES"));
  });
});

describe("confluence-space-hints", () => {
  it("summarizeSpaceForPageCreate detects create + page operation", () => {
    const h = summarizeSpaceForPageCreate({
      key: "TEAM",
      name: "Team",
      operations: [{ operation: "create", targetType: "page" }],
    });
    assert.equal(h.canCreatePage, true);
    assert.equal(h.spaceKey, "TEAM");
  });
  it("summarizeSpaceForPageCreate reads createpage string op", () => {
    const h = summarizeSpaceForPageCreate({
      key: "X",
      name: "X",
      operations: ["createpage"],
    });
    assert.equal(h.canCreatePage, true);
  });
  it("summarizeSpaceForPageCreate returns null when no signals", () => {
    const h = summarizeSpaceForPageCreate({ key: "Z", name: "Z" });
    assert.equal(h.canCreatePage, null);
    assert.ok(h.signals.some((s) => s.includes("insufficient-hint")));
  });
});
