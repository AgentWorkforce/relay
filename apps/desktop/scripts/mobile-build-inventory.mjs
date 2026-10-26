// Read-only App Store Connect inventory. Credentials and JWTs never leave
// memory except for an Authorization header sent to Apple's fixed API host.
import { createPrivateKey, sign } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://api.appstoreconnect.apple.com";
const BUNDLE = "com.agentworkforce.relayipad";
const GROUP = "Internal Devices";
const MAX_PAGES = 50;
class InventoryError extends Error {}

function allowed(path) {
  return ["/v1/apps", "/v1/builds", "/v1/betaGroups"].includes(path) ||
    /^\/v1\/betaGroups\/[A-Za-z0-9_-]+\/relationships\/builds$/.test(path);
}

export function readOnlyToken(credentials, path, now = Math.floor(Date.now() / 1000)) {
  const target = new URL(path, ORIGIN);
  if (target.origin !== ORIGIN || target.username || target.password || target.hash || !allowed(target.pathname)) {
    throw new InventoryError("Unsupported inventory endpoint.");
  }
  const request = `${target.pathname}${target.search}`;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", kid: credentials.keyId, typ: "JWT" });
  const payload = encode({ iss: credentials.issuer, iat: now, exp: now + 300,
    aud: "appstoreconnect-v1", scope: [`GET ${request}`] });
  const unsigned = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: credentials.key, dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${unsigned}.${signature}`;
}

function url(path, query) {
  const result = new URL(path, ORIGIN);
  result.search = new URLSearchParams(query).toString();
  return result.href;
}

export async function inventory({ fetchImpl = fetch, tokenFor }) {
  async function pages(first) {
    const path = new URL(first).pathname;
    let next = first;
    const visited = new Set();
    const data = [];
    const included = [];
    while (next) {
      const target = new URL(next, ORIGIN);
      if (target.origin !== ORIGIN || target.username || target.password || target.hash ||
          target.pathname !== path || !allowed(path) || visited.has(target.href) || visited.size >= MAX_PAGES) {
        throw new InventoryError("Refused unsafe or excessive inventory pagination.");
      }
      visited.add(target.href);
      let response;
      try {
        response = await fetchImpl(target.href, { method: "GET", redirect: "error",
          headers: { Authorization: `Bearer ${tokenFor(`${target.pathname}${target.search}`)}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30000) });
      } catch { throw new InventoryError("Apple's build inventory could not be reached."); }
      if (!response.ok) throw new InventoryError(`Apple's build inventory returned HTTP ${response.status} at ${path}.`);
      let value;
      try { value = await response.json(); }
      catch { throw new InventoryError("Apple returned an unreadable build inventory."); }
      if (!Array.isArray(value.data)) throw new InventoryError("Apple returned an incomplete build inventory.");
      data.push(...value.data);
      included.push(...(Array.isArray(value.included) ? value.included : []));
      next = value.links?.next;
      if (next != null && typeof next !== "string") throw new InventoryError("Apple returned invalid inventory pagination.");
    }
    return { data, included };
  }

  const apps = await pages(url("/v1/apps", { "filter[bundleId]": BUNDLE, "fields[apps]": "bundleId", limit: "200" }));
  const matching = apps.data.filter((app) => app.attributes?.bundleId === BUNDLE);
  if (matching.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(matching[0].id)) {
    throw new InventoryError("The exact mobile app could not be identified uniquely.");
  }
  const app = matching[0].id;
  const groups = await pages(url("/v1/betaGroups", { "filter[app]": app,
    "filter[name]": GROUP, "fields[betaGroups]": "name,isInternalGroup,hasAccessToAllBuilds", limit: "200" }));
  const matchingGroups = groups.data.filter((group) => group.attributes?.name === GROUP);
  if (matchingGroups.length > 1) throw new InventoryError("Internal Devices is not a unique beta group.");
  const group = matchingGroups[0];
  let assigned = new Set();
  if (group) {
    if (!/^[A-Za-z0-9_-]+$/.test(group.id)) throw new InventoryError("Apple returned an invalid beta group identifier.");
    const membership = await pages(url(`/v1/betaGroups/${group.id}/relationships/builds`, { limit: "200" }));
    assigned = new Set(membership.data.filter((item) => item.type === "builds").map((item) => item.id));
  }
  const builds = await pages(url("/v1/builds", { "filter[app]": app, sort: "-uploadedDate", limit: "200",
    include: "preReleaseVersion,buildBetaDetail",
    "fields[builds]": "version,uploadedDate,processingState,expired,preReleaseVersion,buildBetaDetail",
    "fields[preReleaseVersions]": "version", "fields[buildBetaDetails]": "internalBuildState" }));
  const related = new Map(builds.included.map((item) => [`${item.type}:${item.id}`, item.attributes ?? {}]));
  const relation = (build, name) => {
    const ref = build.relationships?.[name]?.data;
    return related.get(`${ref?.type}:${ref?.id}`) ?? {};
  };
  const version = (value) => typeof value === "string" && /^[A-Za-z0-9.+-]{1,64}$/.test(value) ? value : "unknown";
  const state = (value) => typeof value === "string" && /^[A-Z_]{1,64}$/.test(value) ? value : "UNKNOWN";
  return {
    bundleId: BUNDLE,
    internalDevices: { found: Boolean(group), isInternalGroup: group?.attributes?.isInternalGroup === true,
      hasAccessToAllBuilds: group?.attributes?.hasAccessToAllBuilds === true },
    builds: builds.data.map((build) => ({
      version: version(relation(build, "preReleaseVersion").version),
      build: version(build.attributes?.version),
      uploadedDate: typeof build.attributes?.uploadedDate === "string" &&
        /^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]{1,32}$/.test(build.attributes.uploadedDate) ? build.attributes.uploadedDate : "unknown",
      processingState: state(build.attributes?.processingState),
      internalBuildState: state(relation(build, "buildBetaDetail").internalBuildState),
      expired: typeof build.attributes?.expired === "boolean" ? build.attributes.expired : null,
      internalDevicesAssigned: assigned.has(build.id),
    })),
  };
}

async function main() {
  const names = ["APPLE_MOBILE_API_KEY_BASE64", "APPLE_MOBILE_API_KEY_ID", "APPLE_MOBILE_API_ISSUER"];
  if (names.some((name) => !process.env[name])) throw new InventoryError("Required App Store Connect credentials are unavailable.");
  let key;
  try { key = createPrivateKey(Buffer.from(process.env.APPLE_MOBILE_API_KEY_BASE64, "base64")); }
  catch { throw new InventoryError("The App Store Connect signing key could not be loaded."); }
  const credentials = { key, keyId: process.env.APPLE_MOBILE_API_KEY_ID, issuer: process.env.APPLE_MOBILE_API_ISSUER };
  const report = JSON.stringify(await inventory({ tokenFor: (path) => readOnlyToken(credentials, path) }), null, 2);
  process.stdout.write(`${report}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Mobile build inventory\n\n\`\`\`json\n${report}\n\`\`\`\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // All operational errors above are fixed, credential-free descriptions.
    process.stderr.write(`${error instanceof InventoryError ? error.message : "Build inventory failed without exposing request details."}\n`);
    process.exitCode = 1;
  });
}
