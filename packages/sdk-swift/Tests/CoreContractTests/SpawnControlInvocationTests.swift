import Foundation
import XCTest

/// `released` was added to `SpawnControlInvocation` within bridge version 2,
/// so a core older than the app omits it. Every spawn reply must still decode:
/// only a literal JSON `true` reads as `true`; a missing key, `null` or a
/// value of another type reads as `false`. Encoding always writes the flag.
final class SpawnControlInvocationTests: XCTestCase {
    /// One successful reply per spawn method, without `released`, as the
    /// members of a JSON object.
    private let replies: [(method: String, members: String)] = [
        (
            CoreMethod.spawnInvoke,
            #""id":"inv_1","status":"dispatched","node_id":"n","name":"worker_1","spawned":true,"ready":false,"task_unconfirmed":false"#
        ),
        (
            CoreMethod.spawnStatus,
            #""id":"inv_1","agent_id":"a_1","status":"completed","node_id":"n","name":"worker_1","spawned":true,"ready":true,"task_unconfirmed":false,"error_code":null"#
        ),
        (
            CoreMethod.spawnRelease,
            #""id":"inv_2","status":"completed","node_id":"n","name":"worker_1","spawned":false,"ready":false,"task_unconfirmed":false"#
        ),
    ]

    /// The JSON `released` is sent as (nil: not sent), and what it reads as.
    private let cases: [(released: String?, expected: Bool)] = [
        (nil, false),
        ("null", false),
        ("false", false),
        ("true", true),
        (#""true""#, false),
        ("1", false),
        ("0", false),
        (#"{"ok":true}"#, false),
    ]

    private func body(_ members: String, released: String?) -> Data {
        var json = "{" + members
        if let released = released {
            json += #","released":"# + released
        }
        json += "}"
        return Data(json.utf8)
    }

    func testEverySpawnReplyDecodesReleasedOnlyFromALiteralTrue() throws {
        for reply in replies {
            for item in cases {
                let data = body(reply.members, released: item.released)
                let label = "\(reply.method) released=\(item.released ?? "absent")"
                let invocation = try JSONDecoder().decode(SpawnControlInvocation.self, from: data)
                XCTAssertEqual(invocation.released, item.expected, label)
                XCTAssertEqual(invocation.name, "worker_1", label)
            }
        }
    }

    func testEncodingAlwaysWritesAConcreteReleasedFlag() throws {
        for reply in replies {
            for item in cases {
                let data = body(reply.members, released: item.released)
                let label = "\(reply.method) released=\(item.released ?? "absent")"
                let invocation = try JSONDecoder().decode(SpawnControlInvocation.self, from: data)
                let encoded = try JSONEncoder().encode(invocation)
                let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
                XCTAssertNotNil(object, label)
                XCTAssertNotNil(object?["released"], label)
                XCTAssertEqual(object?["released"] as? Bool, item.expected, label)
                let again = try JSONDecoder().decode(SpawnControlInvocation.self, from: encoded)
                XCTAssertEqual(again, invocation, label)
            }
        }
    }

    func testTheMemberwiseInitDefaultsReleasedToFalse() {
        let invocation = SpawnControlInvocation(
            id: "inv_1",
            ready: false,
            spawned: false,
            status: "completed",
            taskUnconfirmed: false
        )
        XCTAssertFalse(invocation.released)
    }

    /// The leniency is only `released`'s: the other fields stay strict.
    func testAMistypedRequiredFieldStillFailsToDecode() {
        let data = body(
            #""id":"inv_1","status":"completed","spawned":false,"ready":"yes","task_unconfirmed":false"#,
            released: "true"
        )
        XCTAssertThrowsError(try JSONDecoder().decode(SpawnControlInvocation.self, from: data))
    }
}
