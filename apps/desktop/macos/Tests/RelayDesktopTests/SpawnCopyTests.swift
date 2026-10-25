import Foundation
import RelayDesktopCore
import XCTest

final class SpawnCopyTests: XCTestCase {
    func testOptionalCapInputAndUnlimitedCopy() {
        XCTAssertEqual(SpawnCopy.noLimit, "No limit")
        for text in ["", "  "] { XCTAssertEqual(SpawnCopy.maxAgentsInput(text), 0) }
        XCTAssertEqual(SpawnCopy.maxAgentsInput("12"), 12)
        XCTAssertEqual(SpawnCopy.maxAgentsInput("32"), 32)
        for text in ["0", "33", "-1", "1.5", "abc", "+2"] { XCTAssertNil(SpawnCopy.maxAgentsInput(text)) }
        XCTAssertEqual(SpawnCopy.places(SpawnSlots(held: 42, max: 0, reserved: 3)), "42 places in use. No limit.")
    }

    /// What the core publishes in `SpawnStatus.harness_descriptors`
    /// (`relay::harness::published`, pinned by the core's own test).
    private static let coreDescriptors = """
    [
      {"id": "codex", "label": "Codex", "billing": true,
       "full_access": {"detail": "Full access removes the sandbox for spawned Codex. Approval requests can be answered remotely; off keeps Codex in its workspace folder.", "default_on": true}},
      {"id": "claude", "label": "Claude", "billing": true,
       "full_access": {"detail": "Spawned Claude runs with --dangerously-skip-permissions. Off lets it edit files; anything else that would ask can be answered remotely.", "default_on": true}},
      {"id": "muse", "label": "Muse", "billing": true,
       "full_access": {"detail": "Spawned Muse runs with --yolo. Off keeps Muse's sandbox and refuses actions that would ask for approval.", "default_on": false}},
      {"id": "devin", "label": "Devin", "billing": true,
       "full_access": {"detail": "Spawned Devin uses dangerous permission mode. Off uses accept-edits and permits only the private Agent Relay send tool; other approval requests are refused.", "default_on": false}}
    ]
    """

    private func descriptors() throws -> [HarnessDescriptor] {
        try JSONDecoder().decode([HarnessDescriptor].self, from: Data(Self.coreDescriptors.utf8))
    }

    private func descriptor(_ id: String) throws -> HarnessDescriptor {
        try XCTUnwrap(try descriptors().first { $0.id == id })
    }

    func testMuseDescriptorUsesTheCoreAccessDefaultAndLabel() throws {
        let muse = try descriptor("muse")
        XCTAssertEqual(muse.label, "Muse")
        XCTAssertEqual(muse.fullAccess?.defaultOn, false)
        XCTAssertEqual(SpawnCopy.list(["muse"], in: try descriptors()), "Muse")
    }

    func testWordingMatchesLinux() throws {
        XCTAssertEqual(SpawnCopy.title, "Spawned agents")
        XCTAssertEqual(
            SpawnCopy.description,
            "Agent Relay can start agents on this computer, headless, with the agent command lines installed here. You message them like any other agent here."
        )
        XCTAssertEqual(SpawnCopy.acceptTitle, "Accept spawns from Agent Relay")
        XCTAssertEqual(
            SpawnCopy.acceptDetail,
            "Let your workspace start agents here. They run in the background as you, in the folder the spawn names, and stop when they are released."
        )
        XCTAssertEqual(SpawnCopy.fullAccessTitle(try descriptor("codex")), "Codex: full access")
        XCTAssertEqual(
            SpawnCopy.fullAccessDetail(try descriptor("codex")),
            "Full access removes the sandbox for spawned Codex. Approval requests can be answered remotely; off keeps Codex in its workspace folder."
        )
        XCTAssertEqual(SpawnCopy.fullAccessTitle(try descriptor("claude")), "Claude: full access")
        XCTAssertEqual(
            SpawnCopy.fullAccessDetail(try descriptor("claude")),
            "Spawned Claude runs with --dangerously-skip-permissions. Off lets it edit files; anything else that would ask can be answered remotely."
        )
        XCTAssertFalse(SpawnCopy.description.contains("Codex"))
        XCTAssertEqual(SpawnCopy.maxAgentsTitle, "Max spawned agents")
        XCTAssertEqual(
            SpawnCopy.maxAgentsDetail,
            "Leave empty for no limit. An optional cap limits how many spawned agents may run here at once. An idle agent keeps its place until it is released; a spawn beyond the cap is refused, never queued."
        )
        XCTAssertEqual(SpawnCopy.teammatesTitle, "Allow teammates to spawn here")
        XCTAssertEqual(
            SpawnCopy.teammatesDetail,
            "Off: only you can start agents on this computer. On: workspace owners and admins can too."
        )
        XCTAssertEqual(SpawnCopy.maxAgentsRange, 1...32)
        XCTAssertEqual(SpawnCopy.maxAgentsDefault, 0)
    }

    func testHarnessesAreListedByName() throws {
        let descriptors = try descriptors()
        XCTAssertEqual(SpawnCopy.list([], in: descriptors), "agents")
        XCTAssertEqual(SpawnCopy.list(["codex"], in: descriptors), "Codex")
        XCTAssertEqual(SpawnCopy.list(["codex", "claude"], in: descriptors), "Codex and Claude")
        // One the core does not describe is capitalized.
        XCTAssertEqual(SpawnCopy.list(["codex", "claude", "droid"], in: descriptors), "Codex, Claude and Droid")
        XCTAssertEqual(SpawnCopy.label("droid"), "Droid")
        XCTAssertEqual(SpawnCopy.label("codex"), "Codex")
    }

    /// OpenCode, as the core describes it (`harness::opencode::DESCRIPTOR`):
    /// drawn from its descriptor like any other harness, with no OpenCode
    /// code in the app.
    func testOpenCodeIsDrawnFromItsDescriptor() throws {
        let json = """
        {"id": "opencode", "label": "OpenCode", "billing": true,
         "full_access": {"detail": "Spawned OpenCode runs with every permission set to allow. Off lets it read and edit files in its folder and refuses everything else, shell commands included.", "default_on": true}}
        """
        let opencode = try JSONDecoder().decode(HarnessDescriptor.self, from: Data(json.utf8))
        let descriptors = try descriptors() + [opencode]
        XCTAssertEqual(SpawnCopy.fullAccessTitle(opencode), "OpenCode: full access")
        XCTAssertEqual(
            SpawnCopy.fullAccessDetail(opencode),
            "Spawned OpenCode runs with every permission set to allow. Off lets it read and edit files in its folder and refuses everything else, shell commands included."
        )
        XCTAssertTrue(SpawnCopy.fullAccess(nil, opencode))
        XCTAssertEqual(SpawnCopy.list(["codex", "claude", "opencode"], in: descriptors), "Codex, Claude and OpenCode")
        let status = SpawnStatus(harnessDescriptors: descriptors, harnesses: ["opencode", "codex"], state: .live)
        XCTAssertEqual(SpawnCopy.fullAccessHarnesses(status).map(\.id), ["codex", "opencode"])
    }

    func testAFullAccessRowShowsForEachOfferedHarnessWithTheSetting() throws {
        let descriptors = try descriptors()
        let ids = { (status: SpawnStatus?) in SpawnCopy.fullAccessHarnesses(status).map(\.id) }
        XCTAssertEqual(ids(nil), [])
        XCTAssertEqual(ids(SpawnStatus(harnessDescriptors: descriptors, harnesses: ["codex", "claude"], state: .live)), ["codex", "claude"])
        // In the core's order, whatever order the node lists them in.
        XCTAssertEqual(ids(SpawnStatus(harnessDescriptors: descriptors, harnesses: ["claude", "codex"], state: .live)), ["codex", "claude"])
        XCTAssertEqual(ids(SpawnStatus(harnessDescriptors: descriptors, harnesses: ["codex"], state: .live)), ["codex"])
        // An older core describes none: no rows.
        XCTAssertEqual(ids(SpawnStatus(harnesses: ["codex", "claude"], state: .live)), [])
        // A harness without the setting has no row.
        let without = [descriptors[0], HarnessDescriptor(billing: true, id: "claude", label: "Claude")]
        XCTAssertEqual(ids(SpawnStatus(harnessDescriptors: without, harnesses: ["codex", "claude"], state: .live)), ["codex"])
    }

    func testFullAccessIsTheChoiceMadeElseTheHarnessDefault() throws {
        XCTAssertFalse(SpawnCopy.fullAccess(nil, try descriptor("devin")))
        XCTAssertEqual(SpawnCopy.fullAccessTitle(try descriptor("devin")), "Devin: full access")
        let claude = try descriptor("claude")
        XCTAssertTrue(SpawnCopy.fullAccess(nil, claude))
        let settings = try JSONDecoder().decode(SettingsValues.self, from: Data("""
        {"allow_self_registration": true, "auto_activate": true,
         "spawn_harnesses": {"claude": {"full_access": false, "billing": "api"}}}
        """.utf8))
        XCTAssertFalse(SpawnCopy.fullAccess(settings, claude))
        XCTAssertTrue(SpawnCopy.fullAccess(settings, try descriptor("codex")))
        let change = try JSONSerialization.jsonObject(with: JSONEncoder().encode(SpawnCopy.fullAccessChange("claude", false))) as? NSDictionary
        XCTAssertEqual(change, ["spawn_harnesses": ["claude": ["full_access": false]]] as NSDictionary)
    }

    func testStatusLineFollowsTheNode() throws {
        let descriptors = try descriptors()
        XCTAssertNil(SpawnCopy.statusLine(nil))
        XCTAssertNil(SpawnCopy.statusLine(SpawnStatus(harnesses: [], state: .off)))
        XCTAssertEqual(
            SpawnCopy.statusLine(SpawnStatus(error: "No agent command line Agent Relay can spawn is installed on this computer.", harnesses: [], state: .off)),
            "No agent command line Agent Relay can spawn is installed on this computer."
        )
        XCTAssertEqual(
            SpawnCopy.statusLine(SpawnStatus(harnessDescriptors: descriptors, harnesses: ["codex", "claude"], nodeName: "mac-desktop", state: .live)),
            "Agent Relay can spawn Codex and Claude here as mac-desktop. Spawned agents are addressed name@mac-desktop."
        )
        XCTAssertEqual(
            SpawnCopy.statusLine(SpawnStatus(harnessDescriptors: descriptors, harnesses: ["codex"], nodeName: "mac-desktop", slots: SpawnSlots(held: 2, max: 8, reserved: 1), state: .live)),
            "Agent Relay can spawn Codex here as mac-desktop. Spawned agents are addressed name@mac-desktop. 2 of 8 places in use."
        )
        XCTAssertEqual(
            SpawnCopy.statusLine(SpawnStatus(harnesses: ["codex"], state: .connecting)),
            "Connecting to Agent Relay…"
        )
        XCTAssertEqual(
            SpawnCopy.statusLine(SpawnStatus(error: "Could not reach Agent Relay.", harnesses: ["codex"], state: .waiting)),
            "Not connected: Could not reach Agent Relay. Trying again."
        )
        let owned = "This computer's spawn node belongs to another account. It takes no spawns until that account, or an owner of your workspace, releases it in Agent Relay."
        let blocked = SpawnStatus(
            claim: SpawnClaim(note: owned, state: .ownedByOther),
            error: owned,
            harnesses: ["codex"],
            nodeName: "mac-desktop",
            state: .live
        )
        XCTAssertEqual(SpawnCopy.statusLine(blocked), owned)
        XCTAssertFalse(SpawnCopy.statusIsHealthy(blocked))
        XCTAssertTrue(SpawnCopy.statusIsHealthy(SpawnStatus(harnesses: ["codex"], state: .live)))
        XCTAssertFalse(SpawnCopy.statusIsHealthy(SpawnStatus(harnesses: ["codex"], state: .waiting)))
        XCTAssertFalse(SpawnCopy.statusIsHealthy(nil))
    }

    func testClaimLineSaysWhoseTheNodeIs() {
        XCTAssertNil(SpawnCopy.claimLine(nil))
        XCTAssertEqual(SpawnCopy.claimLine(SpawnClaim(state: .claimed)), "Claimed by you in Agent Relay Cloud.")
        XCTAssertEqual(
            SpawnCopy.claimLine(SpawnClaim(note: SpawnCopy.claimLine(nil), state: .ownedByOther)),
            "Claimed by another account in Agent Relay Cloud."
        )
        XCTAssertEqual(
            SpawnCopy.claimLine(SpawnClaim(state: .pending)),
            "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is."
        )
        XCTAssertEqual(
            SpawnCopy.claimLine(SpawnClaim(note: "Sign in to Agent Relay to record this computer's spawn node as yours.", state: .signedOut)),
            "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is. Sign in to Agent Relay to record this computer's spawn node as yours."
        )
        XCTAssertEqual(
            SpawnCopy.claimLine(SpawnClaim(note: "Agent Relay could not be reached.", state: .failed)),
            "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is. Agent Relay could not be reached."
        )
        XCTAssertTrue(SpawnCopy.claimCanRetry(SpawnClaim(note: "Agent Relay could not be reached.", state: .failed)))
        XCTAssertFalse(SpawnCopy.claimCanRetry(SpawnClaim(state: .signedOut)))
        XCTAssertFalse(SpawnCopy.claimCanRetry(SpawnClaim(state: .claimed)))
        XCTAssertFalse(SpawnCopy.claimCanRetry(nil))
        XCTAssertEqual(SpawnCopy.claimRetry, "Retry")
        // Until it is claimed, Cloud spawns nothing here.
        let unclaimed = SpawnStatus(claim: SpawnClaim(state: .pending), harnesses: ["codex"], nodeName: "mac-desktop", state: .live)
        XCTAssertEqual(
            SpawnCopy.statusLine(unclaimed),
            "Connected to Agent Relay as mac-desktop. No agent can be spawned on this computer through Agent Relay Cloud until its spawn node is claimed."
        )
        XCTAssertFalse(SpawnCopy.statusIsHealthy(unclaimed))
        let claimed = SpawnStatus(claim: SpawnClaim(state: .claimed), harnesses: ["codex"], nodeName: "mac-desktop", state: .live)
        XCTAssertTrue(SpawnCopy.statusIsHealthy(claimed))
        XCTAssertEqual(
            SpawnCopy.statusLine(claimed),
            "Agent Relay can spawn Codex here as mac-desktop. Spawned agents are addressed name@mac-desktop."
        )
    }
}
