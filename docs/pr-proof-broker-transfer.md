# Broker artifacts in Cloud PR proof

The trusted dispatcher verifies exact base/head build manifests, then stages
only the validated proof input for code sync. Raw binaries stay on the GitHub
runner and enter authenticated run storage after the prepared-run ID arrives.

Each artifact is limited to 100 MiB, the pair to 200 MiB, and each raw part to
2 MiB (at most 3 MiB as JSON). Each part binds run ID, nonce, arm, source SHA,
final build SHA-256, total byte length, index/count, and part checksum.
Exclusive `If-None-Match: *` writes reject collisions. The readiness manifest
is published only after all parts for that arm are acknowledged. Lost upload
acknowledgments fail the proof without replaying writes or creating a new run.

The isolated arm waits at most 60 seconds for the manifest, reads each part
once with bounded response sizes, and verifies the final raw build hash.
Requests time out after 15 seconds with a 120-second transfer lifetime that
starts with the first upload or download request, not at preparation.
Missing, duplicated, misbound, oversized, or corrupt parts fail closed. Only
verified bytes enter the existing private mode-0500 executable, isolation,
and post-execution attestation checks. Broker requirements and red/green
outcomes remain unchanged.

The existing Cloud storage contract was checked at revision `2ca32360`: CI
prepared-run-grant PUT, sandbox-scoped GET, and exclusive creation are present.
No new endpoint is required. CI credentials stay in the GitHub environment;
case processes receive neither credentials nor transfer authorization headers.

Each arm consumes and tombstones its manifest/parts immediately after bounded
assembly while its sandbox token is live. Only then may the verified bytes
reach the private executable. Private executable cleanup remains in the arm's
`finally` block. On submission failure, timeout, or interruption, CI
tombstones its nonce's objects before cancellation revokes the prepared-run
write grant. Successful proof releases only local buffers because both arms
already consumed storage. Cleanup failures are reported without replacing
the original download or dispatcher failure. Cloud has no general
object-delete or prepared-grant-revocation route; this change does not invent
one or revoke shared CI credentials. Existing cancellation revokes run API
sessions. Forced runner termination or independent remote token revocation
can prevent cleanup; remaining objects contain public binaries, remain
run-scoped, and follow platform storage lifecycle and token expiry.

This prerequisite must be admitted to the trusted base before rerunning another
PR's `pull_request_target` proof. A change on that PR's head cannot repair the
base dispatcher. Resolve and attest both exact binaries again after admission.
Local mocked transfer checks do not establish a successful Cloud proof.

Bearer transport requires HTTPS except literal loopback IP addresses for local
tests. Hostnames that merely resemble loopback addresses are refused.
