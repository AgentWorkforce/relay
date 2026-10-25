import Darwin
import Foundation
import XCTest
@testable import RelayDesktopCore

final class CoreBridgeMemoryTests: XCTestCase {
    /// Keep both socket readers alive throughout measurement: closing them
    /// would drain their thread pools and hide the original retention bug.
    func testRepeatedRepliesAndEventsKeepMemoryBounded() async throws {
        let core = FakeCore()
        let client = CoreClient(socketPath: core.path)
        defer {
            client.reset()
            core.stop()
        }
        let payload = String(repeating: "relay-memory-", count: 256)
        let rows = (0..<32).map { ["id": String($0), "body": payload] }
        core.on("memory.echo") { _ in ["rows": rows] }
        let (_, events) = try await client.subscribe(topics: [.notify])
        var iterator = events.makeAsyncIterator()
        guard case .status? = await iterator.next() else { return XCTFail("missing initial snapshot") }

        struct Reply: Decodable { let rows: [[String: String]] }
        // More batches can be requested for a sustained local soak without
        // making the normal test suite unnecessarily expensive.
        let batches = max(5, Int(ProcessInfo.processInfo.environment["RELAY_MEMORY_BATCHES"] ?? "") ?? 5)
        var samples: [UInt64] = []
        for batch in 0...batches {
            for _ in 0..<200 {
                let reply: Reply = try await client.call("memory.echo", NoParams())
                XCTAssertEqual(reply.rows.count, rows.count)
                XCTAssertEqual(reply.rows.last?["body"], payload)
                autoreleasepool {
                    core.publish("notify", ["title": "Memory test", "body": payload, "link": NSNull()])
                }
                guard case .notify(let note)? = await iterator.next() else { return XCTFail("missing notification") }
                XCTAssertEqual(note.body, payload)
            }
            // A reply resumes its caller before the reader finishes the
            // iteration, so let that last iteration drain before sampling.
            try await Task.sleep(nanoseconds: 20_000_000)
            let footprint = try physicalFootprint()
            samples.append(footprint)
            print("Core bridge memory: \((batch + 1) * 200) replies + events, footprint \(footprint / 1_024) KiB")
        }
        let baseline = samples[0] // Warm allocators and decoding metadata first.
        let peak = samples.dropFirst().max()!
        // Generous headroom for allocator/XCTest noise; the unfixed bridge
        // retains hundreds of MiB across this traffic volume.
        XCTAssertLessThan(peak, baseline + 32 * 1_024 * 1_024,
                          "Memory kept growing while the same connections processed repeated traffic: \(samples)")
    }

    private func physicalFootprint() throws -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { throw NSError(domain: NSMachErrorDomain, code: Int(result)) }
        return info.phys_footprint
    }
}
