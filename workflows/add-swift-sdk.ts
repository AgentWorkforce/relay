/**
 * add-swift-sdk.ts
 *
 * Creates a native Swift SDK (Swift Package Manager) for the Agent Relay broker.
 *
 * The SDK gives Swift/macOS/iOS apps a first-class client without needing a
 * TypeScript/Node bridge process. It mirrors the TypeScript and Python SDK
 * surface and ships as an SPM package at packages/sdk-swift/.
 *
 * Public API shape (produced by this workflow):
 *
 *   let relay = RelayCast(apiKey: "rk_live_...")
 *   let channel = relay.channel("wf-my-workflow")
 *   channel.subscribe()
 *   channel.post("Hello from Swift")
 *   for await event in channel.events { ... }
 *
 *   let agent  = try await relay.registerOrRotate(name: "my-agent")
 *   try await agent.post(to: "general", message: "Hi")
 *   try await agent.dm(to: "other-agent", message: "...")
 *
 * Phases:
 *   1. Context: read protocol, TS relay client, Python SDK, MSD reference impl
 *   2. Plan: lead designs the full SDK API and file breakdown
 *   3. Scaffold: create dir structure + Package.swift (deterministic)
 *   4. Implement: 3 parallel workers — types, transport, API
 *   5. Verify: file existence check + swift build
 *   6. Review: lead fixes build errors and commits
 *
 * Run with:
 *   agent-relay run workflows/add-swift-sdk.ts
 */

import { workflow, createWorkflowRenderer } from '@agent-relay/sdk/workflows';

const renderer = createWorkflowRenderer();

const cwd = process.cwd(); // run from the relay repo root

const [result] = await Promise.all([
  workflow('add-swift-sdk')
    .description(
      'Create a native Swift SDK (SPM) for the Agent Relay broker — ' +
      'WebSocket transport, typed events, channel pub/sub, and agent registration. ' +
      'Mirrors the TypeScript and Python SDK surface.',
    )
    .pattern('dag')
    .channel('wf-add-swift-sdk')
    .maxConcurrency(5)
    .timeout(3600000)

    // ── Agents ──────────────────────────────────────────────────────────────

    .agent('lead', {
      cli: 'claude',
      role:
        'Swift SDK architect. Reads context, produces the API design plan, ' +
        'assigns files to workers, reviews the build output, fixes errors, and ' +
        'commits the finished package.',
    })
    .agent('types-worker', {
      cli: 'claude',
      preset: 'worker',
      role:
        'Writes Sources/AgentRelaySDK/RelayTypes.swift — ' +
        'all Codable event structs and enums matching the broker wire protocol.',
    })
    .agent('transport-worker', {
      cli: 'claude',
      preset: 'worker',
      role:
        'Writes Sources/AgentRelaySDK/RelayTransport.swift — ' +
        'URLSessionWebSocketTask connection with exponential-backoff reconnect and ping/pong.',
    })
    .agent('api-worker', {
      cli: 'claude',
      preset: 'worker',
      role:
        'Writes Sources/AgentRelaySDK/RelayCast.swift — ' +
        'the public RelayCast, Channel, and AgentClient types that apps consume.',
    })

    // ── Phase 1: Context gathering (parallel deterministic) ─────────────────

    .step('create-branch', {
      type: 'deterministic',
      command:
        'git checkout -b feature/swift-sdk 2>&1 || git checkout feature/swift-sdk 2>&1',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-protocol', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      command: 'cat packages/sdk/src/protocol.ts',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-ts-relay', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      // First 400 lines covers the WebSocket setup, event loop, and public API
      command: 'head -400 packages/sdk/src/relay.ts',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-python-sdk', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      command:
        'find packages/sdk-py -name "*.py" -not -path "*/__pycache__/*" ' +
        '| sort | xargs head -n 60 2>/dev/null | head -500',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-msd-reference', {
      type: 'deterministic',
      dependsOn: ['create-branch'],
      // MSD's RelayConnection.swift is a real working WebSocket client for the
      // same broker — invaluable reference for wire types and reconnect logic.
      command:
        'cat "/Users/khaliqgant/Projects/My Senior Dev/app/packages/desktop/' +
        'MSDReview/Sources/Data/RelayConnection.swift" 2>/dev/null',
      captureOutput: true,
      failOnError: false,
    })

    // ── Phase 2: Architecture plan ──────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-protocol', 'read-ts-relay', 'read-python-sdk', 'read-msd-reference'],
      task: `You are designing a native Swift SDK for the Agent Relay broker.

## Context

Broker wire protocol (TypeScript):
{{steps.read-protocol.output}}

TypeScript relay client (first 400 lines):
{{steps.read-ts-relay.output}}

Python SDK reference:
{{steps.read-python-sdk.output}}

Existing Swift WebSocket client (MSD project — real production code for this same broker):
{{steps.read-msd-reference.output}}

## Your task

Produce a detailed design document covering:

1. **Package structure** — files to create under packages/sdk-swift/Sources/AgentRelaySDK/
2. **RelayTypes.swift** — every Codable struct/enum needed to decode broker events
   (hello_ack, event, worker_stream, worker_exited, pong, error, deliver_relay, ok)
   and encode client messages (hello, send_message, spawn_agent, release_agent, ping)
3. **RelayTransport.swift** — URLSessionWebSocketTask connection class:
   - connect() / disconnect()
   - Exponential backoff reconnect (max 30s)
   - Ping every 20s, disconnect if pong not received in 10s
   - Inbound message stream via AsyncStream
4. **RelayCast.swift** — public API:
   - RelayCast(apiKey:baseURL:) — manages a single WebSocket connection
   - channel(_ name: String) -> Channel
   - registerOrRotate(name:) async throws -> AgentRegistration
   - Channel: subscribe(), post(_ text:), events: AsyncStream<InboundEvent>
   - AgentClient (returned by as(_ token:)): post(to:message:), dm(to:message:)
5. **Concurrency model** — Swift structured concurrency (async/await, Actor isolation)
6. **Platform targets** — macOS 13+, iOS 16+, no third-party dependencies

End your plan with the exact file list workers must create. Use the marker:
PLAN_COMPLETE`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ── Phase 3: Scaffold (deterministic) ───────────────────────────────────

    .step('scaffold-dirs', {
      type: 'deterministic',
      dependsOn: ['plan'],
      command:
        'mkdir -p packages/sdk-swift/Sources/AgentRelaySDK ' +
        'packages/sdk-swift/Tests/AgentRelaySDKTests',
      captureOutput: true,
      failOnError: true,
    })

    .step('write-package-swift', {
      type: 'deterministic',
      dependsOn: ['scaffold-dirs'],
      command: `cat > packages/sdk-swift/Package.swift << 'SWIFTEOF'
// swift-tools-version: 5.9
// AgentRelaySDK — Swift Package Manager manifest
//
// Native Swift client for the Agent Relay broker.
// No third-party dependencies — uses URLSession WebSocket and Swift Concurrency.

import PackageDescription

let package = Package(
    name: "AgentRelaySDK",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .watchOS(.v9),
        .tvOS(.v16),
    ],
    products: [
        .library(
            name: "AgentRelaySDK",
            targets: ["AgentRelaySDK"]
        ),
    ],
    targets: [
        .target(
            name: "AgentRelaySDK",
            path: "Sources/AgentRelaySDK"
        ),
        .testTarget(
            name: "AgentRelaySDKTests",
            dependencies: ["AgentRelaySDK"],
            path: "Tests/AgentRelaySDKTests"
        ),
    ]
)
SWIFTEOF`,
      captureOutput: true,
      failOnError: true,
    })

    .step('write-test-stub', {
      type: 'deterministic',
      dependsOn: ['scaffold-dirs'],
      command: `cat > packages/sdk-swift/Tests/AgentRelaySDKTests/AgentRelaySDKTests.swift << 'SWIFTEOF'
import XCTest
@testable import AgentRelaySDK

final class AgentRelaySDKTests: XCTestCase {

    func testRelayCastInit() {
        let relay = RelayCast(apiKey: "rk_test_key")
        XCTAssertNotNil(relay)
    }

    func testChannelCreation() {
        let relay = RelayCast(apiKey: "rk_test_key")
        let channel = relay.channel("test-channel")
        XCTAssertEqual(channel.name, "test-channel")
    }
}
SWIFTEOF`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 4: Parallel implementation ────────────────────────────────────

    .step('implement-types', {
      agent: 'types-worker',
      dependsOn: ['scaffold-dirs', 'plan'],
      task: `Write the file packages/sdk-swift/Sources/AgentRelaySDK/RelayTypes.swift.

Architecture plan from the lead:
{{steps.plan.output}}

Broker wire protocol reference:
{{steps.read-protocol.output}}

MSD production reference (existing working types):
{{steps.read-msd-reference.output}}

## Requirements

Write a complete Swift file containing:

1. **Inbound message types** (broker → client, Decodable):
   - InboundMessage enum with associated values for each event type
   - BrokerEvent struct (wraps event kind + payload)
   - EventKind for relay_inbound, agent_spawned, agent_released, worker_stream, worker_exited
   - HelloAck, BrokerError structs

2. **Outbound message types** (client → broker, Encodable):
   - OutboundMessage enum: hello, send_message, release_agent, ping, list_agents
   - SendMessagePayload, SpawnAgentPayload, HelloPayload structs

3. Use Swift Codable (Encodable + Decodable), snake_case CodingKeys to match broker JSON.
4. Add // MARK: - section headers for clarity.

IMPORTANT: Write the complete file to disk at
packages/sdk-swift/Sources/AgentRelaySDK/RelayTypes.swift
Do NOT output to stdout — the file must exist on disk when you finish.`,
      verification: { type: 'exit_code' },
    })

    .step('implement-transport', {
      agent: 'transport-worker',
      dependsOn: ['scaffold-dirs', 'plan'],
      task: `Write the file packages/sdk-swift/Sources/AgentRelaySDK/RelayTransport.swift.

Architecture plan from the lead:
{{steps.plan.output}}

MSD production WebSocket reference (existing working transport for this same broker):
{{steps.read-msd-reference.output}}

## Requirements

Write a complete Swift file containing the RelayTransport actor:

\`\`\`swift
actor RelayTransport {
    init(url: URL)
    func connect() async throws
    func disconnect()
    func send(_ message: Data) async throws
    var inbound: AsyncStream<Data> { get }
}
\`\`\`

Implementation details:
1. Use URLSessionWebSocketTask — no third-party dependencies
2. Reconnect with exponential backoff: 0.5s, 1s, 2s, 4s, 8s, 16s, 30s (cap)
3. Send a ping frame every 20s; treat no pong within 10s as a disconnect
4. Expose inbound messages via AsyncStream<Data> (raw frames before JSON decode)
5. Target macOS 13+, iOS 16+ — use structured concurrency (async/await, Task, actor)
6. Include a ConnectionState enum: disconnected, connecting, connected, reconnecting

IMPORTANT: Write the complete file to disk at
packages/sdk-swift/Sources/AgentRelaySDK/RelayTransport.swift
Do NOT output to stdout — the file must exist on disk when you finish.`,
      verification: { type: 'exit_code' },
    })

    .step('implement-api', {
      agent: 'api-worker',
      dependsOn: ['scaffold-dirs', 'plan'],
      task: `Write the file packages/sdk-swift/Sources/AgentRelaySDK/RelayCast.swift.

Architecture plan from the lead:
{{steps.plan.output}}

TypeScript SDK reference (API shape to mirror):
{{steps.read-ts-relay.output}}

## Requirements

Write a complete Swift file with the public API:

\`\`\`swift
// Entry point
public final class RelayCast {
    public init(apiKey: String, baseURL: URL? = nil)
    public func channel(_ name: String) -> Channel
    public func registerOrRotate(name: String) async throws -> AgentRegistration
    public func \`as\`(_ agentToken: String) -> AgentClient
}

// Channel pub/sub
public final class Channel {
    public let name: String
    public func subscribe() async throws
    public func post(_ text: String) async throws
    public var events: AsyncStream<RelayChannelEvent> { get }
}

// Agent posting
public final class AgentClient {
    public func post(to channel: String, message: String) async throws
    public func dm(to agentName: String, message: String) async throws
}

// Returned by registerOrRotate
public struct AgentRegistration {
    public let agentName: String
    public let token: String
    public func asClient() -> AgentClient
}

// Events surfaced to callers
public struct RelayChannelEvent {
    public let from: String
    public let body: String
    public let threadId: String?
    public let timestamp: Date
}
\`\`\`

Implementation notes:
- RelayCast owns the RelayTransport, shared by all Channel and AgentClient instances
- Use the broker's WebSocket at ws://{host}/ws (default: ws://localhost:3889/ws)
- Authenticate with apiKey in the hello handshake (payload.client_name + apiKey header or token)
- Channel.subscribe() sends a channel subscription message to the broker
- AgentClient.post / dm send send_message frames with from set to the agent name
- All async methods throw RelayError (define a public enum for connection/protocol errors)

IMPORTANT: Write the complete file to disk at
packages/sdk-swift/Sources/AgentRelaySDK/RelayCast.swift
Do NOT output to stdout — the file must exist on disk when you finish.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 5: Verify files + build ───────────────────────────────────────

    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['implement-types', 'implement-transport', 'implement-api', 'write-package-swift'],
      command: `missing=0
for f in \
  packages/sdk-swift/Package.swift \
  packages/sdk-swift/Sources/AgentRelaySDK/RelayTypes.swift \
  packages/sdk-swift/Sources/AgentRelaySDK/RelayTransport.swift \
  packages/sdk-swift/Sources/AgentRelaySDK/RelayCast.swift; do
  if [ ! -f "$f" ]; then
    echo "MISSING: $f"
    missing=$((missing + 1))
  else
    echo "OK: $f ($(wc -l < "$f") lines)"
  fi
done
if [ $missing -gt 0 ]; then
  echo "$missing file(s) missing — workers did not write to disk"
  exit 1
fi
echo "All files present"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('swift-build', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command:
        'cd packages/sdk-swift && swift build 2>&1 | tail -50',
      captureOutput: true,
      failOnError: false, // lead will diagnose and fix errors
    })

    // ── Phase 6: Review, fix, commit ────────────────────────────────────────

    .step('review-and-commit', {
      agent: 'lead',
      dependsOn: ['swift-build'],
      task: `Review the Swift SDK build result and leave durable repo output on this branch.

Files produced:
{{steps.verify-files.output}}

Swift build output:
{{steps.swift-build.output}}

## Non-negotiable contract

This workflow is only successful if the repository itself contains the finished SDK files.
A status update to WorkflowRunner is NOT enough.
Do not stop after sending a message. Do not remove yourself until the repo state is durable.

## Your tasks

1. **If the build failed:** read each source file, diagnose the errors, and fix them
   directly using your file-editing tools. Common issues to check:
   - Missing CodingKeys for snake_case fields
   - Actor isolation violations (mark mutating state with nonisolated(unsafe) or move to actor)
   - Missing 'public' access modifiers on exported types
   - AsyncStream continuation retention

2. **If the build still cannot be made green because the host Swift toolchain is broken:**
   - keep the generated SDK files on disk
   - write packages/sdk-swift/README.md explaining the current status
   - commit the package anyway with a message that clearly notes validation was blocked by the local environment
   - explicitly say in your final summary whether validation was blocked by environment vs source errors

3. **Write a README** at packages/sdk-swift/README.md with:
   - Installation (SPM dependency snippet)
   - Quick-start example (connect, subscribe to a channel, post a message)
   - Current validation status / known limitations

4. **Commit** all files under packages/sdk-swift/.
   Required commands:
   \`\`\`
   git add packages/sdk-swift/
   git commit -m "feat(sdk-swift): add native Swift SDK for Agent Relay broker"
   \`\`\`

5. In your final response include all of the following markers on separate lines:
   - REVIEW_COMPLETE
   - README_WRITTEN
   - COMMIT_STATUS: <committed|blocked>
   - COMMIT_SHA: <sha or none>
   - VALIDATION_STATUS: <passed|env-blocked|source-blocked>

If you cannot commit, explain exactly why and output COMMIT_STATUS: blocked.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .step('verify-readme', {
      type: 'deterministic',
      dependsOn: ['review-and-commit'],
      command: 'test -f packages/sdk-swift/README.md && echo README_OK',
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-commit', {
      type: 'deterministic',
      dependsOn: ['review-and-commit'],
      command: `set -e
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "No HEAD commit"
  exit 1
fi
if git diff --quiet HEAD -- packages/sdk-swift; then
  if git diff --cached --quiet -- packages/sdk-swift; then
    echo "SDK files are committed in HEAD"
  else
    echo "SDK changes are only staged, not committed"
    exit 1
  fi
else
  echo "SDK changes are still uncommitted after review-and-commit"
  exit 1
fi`,
      captureOutput: true,
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10000 })
    .run({
      onEvent: renderer.onEvent,
      cwd,
    }),

  renderer.start(),
]);

renderer.unmount();

console.log(`\nSwift SDK workflow: ${result.status}`);
if (result.status === 'completed') {
  console.log('Package location: packages/sdk-swift/');
  console.log('Run: cd packages/sdk-swift && swift build');
}
