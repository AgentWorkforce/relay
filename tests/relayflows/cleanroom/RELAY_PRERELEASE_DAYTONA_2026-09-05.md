# Relay prerelease clean-install proof — 2026-09-05

This is the immutable operator summary for the checkout-packed Relay candidate
lane. It proves that the same candidate can be built, installed, identified,
and tested in two clean Daytona sandboxes. It is deliberately **not** a claim
that live Fleet orchestration is green: the candidate snapshot and ephemeral
Cloud/Relayfile data-plane contracts are still blocked by Cloud issues #3349
and #3351.

## Candidate identity

- branch: `qualification/relay-11.10.4-cleanroom.1`
- source commit: `1f724244c72c5f7867e764c255a12817f36bd6f0`
- candidate version: `11.10.4-cleanroom.20260905.2`
- all ten candidate npm package names/versions were checked and were
  unpublished before the run
- Daytona snapshot ID:
  `3c6c055a-5ff1-4bad-a0c3-751eca8c75bb`
- snapshot display name:
  `relay-orchestrator-sdk-11.8.2-relayfile-v0.10.50-runtime-4.1.52`

The stale snapshot display name is recorded because it is part of the
qualification gap. The candidate was installed into the running sandboxes;
the run did not assert that this production snapshot itself contains the
candidate.

## Clean topology

| Role | Exact sandbox ID                       | Name                                |
| ---- | -------------------------------------- | ----------------------------------- |
| A    | `25b98abd-f9a9-47bd-8b41-839ed27ace58` | `relay-cleanroom-prerelease-a-0905` |
| B    | `e97f2b90-53fb-4068-b33f-5a257ebc48fb` | `relay-cleanroom-prerelease-b-0905` |

Both sandboxes started with the snapshot's stock Node 25.6 environment. The
run installed and selected exact Node 22.22 and npm 10.9.7 in each sandbox so
the build used the repository's declared engine floor. `npm ci` completed in
both without `EBADENGINE`.

## Results proven independently in A and B

- the Rust musl broker built from the candidate in both sandboxes;
- the two native binaries had the same SHA-256:
  `33cd60b57052f86d1a0783901c50fb1f2e4f86868dac9b8b1cb55561b20f74e6`;
- the installed JS CLI and installed native broker both reported exact version
  `11.10.4-cleanroom.20260905.2`;
- candidate package prepare and verification completed after a clean install;
- the candidate attestation SHA-256 was identical in both sandboxes:
  `1755bf35c03f038c3849fe2d488494002a3cddc3df625b1375374da56df48287`;
- all 16 changed-surface test files passed in each sandbox: 266 tests per
  sandbox;
- installed help proved the bounded `agent get` command, paired Fleet snapshot
  and manifest-digest flags, and Cloud workspace create/delete lifecycle flags.

These checks bind the package result to the exact version, source commit,
native binary digest, attestation digest, sandbox IDs, and snapshot ID. A
passing host checkout or globally installed Relay was not substituted for the
installed candidate.

## Cleanup proof

Both exact sandboxes were deleted. `daytona sandbox info` returned `Not Found`
for each ID after deletion, and a full inventory filter for both owned names
returned an empty array.

## Remaining acceptance boundary

This lane proves candidate build and clean installation only. It does not prove
the 95-operation Fleet board against that candidate because the current Cloud
ensure path selects the production snapshot and global Relayfile data plane.
Qualification remains fail-closed until the system can:

1. select an immutable candidate snapshot through a scoped manifest digest;
2. create and idempotently delete a canonical ephemeral Cloud workspace;
3. bind that workspace to an attested candidate Relayfile deployment; and
4. run the complete Fleet board twice, in separate clean workspaces, with exact
   cleanup and independent signoff.
