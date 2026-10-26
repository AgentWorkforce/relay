import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { inventory, readOnlyToken } from "./mobile-build-inventory.mjs";

const app = { id: "app-1", type: "apps", attributes: { bundleId: "com.agentworkforce.relayipad" } };
const group = { id: "group-1", type: "betaGroups", attributes: { name: "Internal Devices", isInternalGroup: true, hasAccessToAllBuilds: false } };
function build(id, version = "38", state = "VALID") {
  return { id, type: "builds", attributes: { version, processingState: state, uploadedDate: "2026-10-25T01:00:00Z", expired: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "version-1" } },
      buildBetaDetail: { data: { type: "buildBetaDetails", id: "details-1" } } } };
}
const related = [
  { type: "preReleaseVersions", id: "version-1", attributes: { version: "1.1" } },
  { type: "buildBetaDetails", id: "details-1", attributes: { internalBuildState: "IN_BETA_TESTING" } },
  { type: "betaTesters", id: "private", attributes: { email: "must-not-print@example.test" } },
];
function stub(overrides = {}) {
  const calls = [];
  return { calls, tokenFor: (path) => `test-token:${path}`, fetchImpl: async (input, options) => {
    const target = new URL(input);
    calls.push({ target, options });
    assert.equal(target.origin, "https://api.appstoreconnect.apple.com");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.body, undefined);
    let value = {
      "/v1/apps": { data: [app] },
      "/v1/betaGroups": { data: [group] },
      "/v1/betaGroups/group-1/relationships/builds": { data: [{ type: "builds", id: "build-1" }] },
      "/v1/builds": { data: [build("build-1")], included: related },
    }[target.pathname];
    if (target.pathname in overrides) value = await overrides[target.pathname](target, options);
    assert.ok(value, `unexpected endpoint ${target.pathname}`);
    return { ok: true, status: 200, json: async () => value };
  } };
}

test("inventory reports processing and explicit Internal Devices membership without personal data", async () => {
  const transport = stub();
  const report = await inventory(transport);
  assert.deepEqual(report.internalDevices, { found: true, isInternalGroup: true, hasAccessToAllBuilds: false });
  assert.deepEqual(report.builds[0], { version: "1.1", build: "38", uploadedDate: "2026-10-25T01:00:00Z",
    processingState: "VALID", internalBuildState: "IN_BETA_TESTING", expired: false, internalDevicesAssigned: true });
  assert.equal(JSON.stringify(report).includes("must-not-print"), false);
  assert.equal(JSON.stringify(report).includes("test-token"), false);
  assert.equal(transport.calls[0].target.searchParams.get("filter[bundleId]"), "com.agentworkforce.relayipad");
  assert.equal(transport.calls.find((call) => call.target.pathname === "/v1/builds").target.searchParams.get("filter[app]"), "app-1");
});

test("all inventory pages and membership pages are read before deciding a build is absent", async () => {
  const transport = stub({
    "/v1/builds": async (url) => url.searchParams.has("cursor")
      ? { data: [build("build-2", "37", "PROCESSING")], included: related }
      : { data: [build("build-1")], included: related, links: { next: "/v1/builds?cursor=next" } },
    "/v1/betaGroups/group-1/relationships/builds": async (url) => url.searchParams.has("cursor")
      ? { data: [{ type: "builds", id: "build-2" }] }
      : { data: [], links: { next: "/v1/betaGroups/group-1/relationships/builds?cursor=next" } },
  });
  const report = await inventory(transport);
  assert.equal(report.builds.length, 2);
  assert.equal(report.builds[0].internalDevicesAssigned, false);
  assert.equal(report.builds[1].internalDevicesAssigned, true);
  assert.equal(report.builds[1].processingState, "PROCESSING");
});

test("missing Internal Devices and all-build access are reported separately from explicit membership", async () => {
  const missing = await inventory(stub({ "/v1/betaGroups": async () => ({ data: [] }) }));
  assert.equal(missing.internalDevices.found, false);
  assert.equal(missing.builds[0].internalDevicesAssigned, false);
  const inherited = await inventory(stub({
    "/v1/betaGroups": async () => ({ data: [{ ...group, attributes: { ...group.attributes, hasAccessToAllBuilds: true } }] }),
    "/v1/betaGroups/group-1/relationships/builds": async () => ({ data: [] }),
  }));
  assert.equal(inherited.internalDevices.hasAccessToAllBuilds, true);
  assert.equal(inherited.builds[0].internalDevicesAssigned, false);
});

test("pagination cannot redirect credentials off Apple or into another endpoint", async () => {
  for (const next of ["https://untrusted.test/v1/apps", "https://user:pass@api.appstoreconnect.apple.com/v1/apps", "/v1/betaTesters", "/v1/apps?loop=1#fragment"]) {
    const transport = stub({ "/v1/apps": async () => ({ data: [app], links: { next } }) });
    await assert.rejects(inventory(transport), /unsafe/);
    assert.equal(transport.calls.length, 1);
  }
});

test("a signed JWT permits only one GET endpoint for five minutes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const token = readOnlyToken({ key: privateKey, keyId: "key-id", issuer: "issuer" }, "/v1/builds", 1000);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iss: "issuer", iat: 1000, exp: 1300, aud: "appstoreconnect-v1", scope: ["GET /v1/builds"],
  });
  assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "ES256");
  assert.equal(Buffer.from(signature, "base64url").length, 64);
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
  assert.throws(() => readOnlyToken({ key: privateKey }, "/v1/betaTesters"), /Unsupported/);
});

test("transport errors and API error bodies cannot expose credentials in reports", async () => {
  await assert.rejects(inventory({ tokenFor: () => "secret", fetchImpl: async () => { throw new Error("Authorization: secret"); } }),
    (error) => error.message === "Apple's build inventory could not be reached.");
  await assert.rejects(inventory({ tokenFor: () => "secret", fetchImpl: async () => ({ ok: false, status: 403,
    json: async () => ({ error: "secret" }) }) }), /returned HTTP 403/);
});


test("each scoped token includes the exact filters and fields of its read request", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const transport = stub();
  const underlying = transport.fetchImpl;
  transport.tokenFor = (path) => readOnlyToken({ key: privateKey, keyId: "test", issuer: "test" }, path);
  transport.fetchImpl = async (input, options) => {
    const target = new URL(input);
    const jwt = options.headers.Authorization.slice("Bearer ".length);
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
    assert.deepEqual(claims.scope, [`GET ${target.pathname}${target.search}`]);
    return underlying(input, options);
  };
  await inventory(transport);
  assert.equal(transport.calls.length, 4);
  assert.ok(transport.calls[0].target.searchParams.has("filter[bundleId]"));
});
