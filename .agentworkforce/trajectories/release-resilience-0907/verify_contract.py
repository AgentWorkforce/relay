"""Read-only release wire-contract audit; uses pinned upstream source, no live agents.

This is a source-contract red/green comparison, not proof of a broker fix or
server deployment. Execute the actual route's input projection with Node.
Only a boolean about field retention is printed; no credentials are used.
"""

import json
import re
import subprocess


def source(ref, path):
    return subprocess.check_output(
        [
            "gh", "api",
            f"repos/AgentWorkforce/relaycast/contents/{path}?ref={ref}",
            "-H", "Accept: application/vnd.github.raw+json",
        ],
        text=True,
    )


def check_projection(label, ref, expected_exit):
    route = source(ref, "packages/engine/src/routes/agent.ts")
    release = route[route.index("// POST /v1/agents/release"):]
    projection = re.search(
        r"const \{ name, reason, delete_agent[^\n]*\} = parsed.data;"
        r"\s+const input = \{.*?\n      \};",
        release,
        re.S,
    )
    assert projection, "release route projection not found"
    fixture = {
        "name": "audit-fixture",
        "reason": "read-only contract fixture",
        "delete_agent": True,
        "expected_token_hash": "0" * 64,
    }
    program = (
        "const parsed = {data: " + json.dumps(fixture) + "};\n"
        + projection.group(0)
        + "\nconst retained = input.expected_token_hash === parsed.data.expected_token_hash;\n"
        + "console.log('release route retains generation guard: ' + retained);\n"
        + "if (!retained) { console.error('FAIL: conditional release becomes unconditional'); process.exit(1); }\n"
        + "console.log('PASS: release route forwards generation guard');\n"
    )
    result = subprocess.run(["node"], input=program, text=True, capture_output=True)
    print(f"{label} ({ref})", flush=True)
    print(result.stdout, end="", flush=True)
    print(result.stderr, end="", flush=True)
    print(f"exit code: {result.returncode}", flush=True)
    assert result.returncode == expected_exit


check_projection("RED: pre-guard route", "234ca1cabd964d3c2171e96abd990f7bf4e4b60b", 1)
check_projection("GREEN: current upstream route", "04fc9bc602c99388ffc0f8e2db8062ba8918a6f5", 0)
sdk = source("04fc9bc602c99388ffc0f8e2db8062ba8918a6f5", "packages/sdk-rust/src/relay.rs")
assert "pub async fn release_agent_if_token_hash(" in sdk
print("Current upstream Rust source contains release_agent_if_token_hash.")
print("This audit does not demonstrate a broker fix, server rollout, or live cleanup.")
