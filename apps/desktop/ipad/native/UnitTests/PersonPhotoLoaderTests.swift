import XCTest
import UIKit
@testable import AgentRelayiPad

final class PersonPhotoLoaderTests: XCTestCase {
    private func download(_ path: String, using download: PersonPhotoDownload = PersonPhotoDownload()) async -> Data? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfilePhotoURLProtocol.self]
        return await download.data(from: URL(string: "https://profiles.example/" + path)!, configuration: configuration)
    }

    private func load(_ path: String) async -> UIImage? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfilePhotoURLProtocol.self]
        configuration.httpAdditionalHeaders = ["Authorization": "Bearer must-not-leak", "Cookie": "must-not-leak=true"]
        return await PersonPhotoLoader.load(URL(string: "https://profiles.example/" + path)!, configuration: configuration)
    }

    func testLoadsHTTPSImageWithoutCredentials() async {
        let photo = await load("image.png")
        XCTAssertNotNil(photo)
        XCTAssertEqual(photo?.size.width, 2)
    }

    func testLoadsImageDeliveredInMultipleChunks() async {
        let photo = await load("chunked-image")
        XCTAssertNotNil(photo)
        XCTAssertEqual(photo?.size.width, 2)
    }

    func testCumulativeLimitWithMissingOrUnderstatedContentLength() async {
        for path in ["oversized-chunks", "understated-length"] {
            let data = await download(path)
            XCTAssertNil(data, path)
        }
        let exactLimit = await download("exact-limit")
        XCTAssertEqual(exactLimit?.count, PersonPhotoLoader.maximumBytes)
    }

    func testOversizedHeaderCompletesWithoutWaitingForBody() async {
        let finished = expectation(description: "Reject the headers before waiting for a body")
        let task = Task {
            let data = await self.download("oversized-header-stall")
            XCTAssertNil(data)
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 3)
        task.cancel()
    }

    func testCancellationDuringDownloadStopsRequestAndCompletes() async {
        let started = expectation(forNotification: ProfilePhotoURLProtocol.stalled, object: nil) {
            ($0.object as? URL)?.lastPathComponent == "stall"
        }
        let stopped = expectation(forNotification: ProfilePhotoURLProtocol.stopped, object: nil) {
            ($0.object as? URL)?.lastPathComponent == "stall"
        }
        let finished = expectation(description: "Canceled download finishes once")
        let task = Task {
            let data = await self.download("stall")
            XCTAssertNil(data)
            finished.fulfill()
        }
        await fulfillment(of: [started], timeout: 3)
        task.cancel()
        await fulfillment(of: [finished, stopped], timeout: 3)
    }

    func testCancellationBeforeContinuationRegistration() async {
        let request = PersonPhotoDownload()
        request.cancel()
        request.cancel()
        let data = await download("image.png", using: request)
        XCTAssertNil(data)
    }

    func testLateCompletionAndCancellationDoNotResumeTwice() async {
        let request = PersonPhotoDownload()
        let data = await download("image.png", using: request)
        XCTAssertNotNil(data)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: URL(string: "https://profiles.example/image.png")!)
        request.urlSession(session, task: task, didCompleteWithError: nil)
        request.cancel()
        request.urlSession(session, task: task, didCompleteWithError: URLError(.cancelled))
    }

    func testNetworkErrorDoesNotReturnPartialData() async {
        let data = await download("partial-error")
        XCTAssertNil(data)
    }

    func testFailureAndInvalidImageReturnInitialsFallback() async {
        for path in ["missing", "unauthorized", "wrong-type", "invalid-image", "oversized-header", "oversized-body"] {
            let photo = await load(path)
            XCTAssertNil(photo, path)
        }
    }

    func testCancellationDoesNotProducePhoto() async {
        let task = Task { await self.load("image.png") }
        task.cancel()
        let photo = await task.value
        XCTAssertNil(photo)
    }

    func testUnsafeURLIsRejectedBeforeNetwork() async {
        let photo = await PersonPhotoLoader.load(URL(string: "http://profiles.example/image.png")!)
        XCTAssertNil(photo)
    }

    func testRedirectDropsHeadersAndRejectsHTTPAndUserInfo() {
        let policy = PersonPhotoDownload()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let url = URL(string: "https://profiles.example/image.png")!
        let task = session.dataTask(with: url)
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: nil)!
        var request = URLRequest(url: URL(string: "https://cdn.example/photo.png")!)
        request.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
        request.setValue("secret=value", forHTTPHeaderField: "Cookie")
        var redirected: URLRequest?
        policy.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: request) {
            redirected = $0
        }
        XCTAssertEqual(redirected?.url, request.url)
        XCTAssertNil(redirected?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(redirected?.value(forHTTPHeaderField: "Cookie"))
        for unsafe in ["http://cdn.example/photo.png", "https://secret@cdn.example/photo.png"] {
            request.url = URL(string: unsafe)!
            policy.urlSession(session, task: task, willPerformHTTPRedirection: response, newRequest: request) {
                redirected = $0
            }
            XCTAssertNil(redirected)
        }
    }
}

private final class ProfilePhotoURLProtocol: URLProtocol {
    static let stalled = Notification.Name("ProfilePhotoURLProtocol.stalled")
    static let stopped = Notification.Name("ProfilePhotoURLProtocol.stopped")
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "profiles.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAALHwEDmIWXfgAAAABJRU5ErkJggg==")!
        var status = 200
        var type = "image/png"
        var body = png
        var headers: [String: String] = [:]
        switch url.lastPathComponent {
        case "missing": status = 404
        case "unauthorized": status = 401
        case "wrong-type": type = "text/html"
        case "invalid-image": body = Data("not an image".utf8)
        case "oversized-header": headers["Content-Length"] = String(PersonPhotoLoader.maximumBytes + 1)
        case "oversized-body": body = Data(repeating: 0, count: PersonPhotoLoader.maximumBytes + 1)
        case "oversized-header-stall": headers["Content-Length"] = String(PersonPhotoLoader.maximumBytes + 1)
        case "oversized-chunks": body = Data(repeating: 0, count: PersonPhotoLoader.maximumBytes + 1)
        case "understated-length":
            headers["Content-Length"] = "16"
            body = Data(repeating: 0, count: PersonPhotoLoader.maximumBytes + 1)
        case "exact-limit": body = Data(repeating: 0, count: PersonPhotoLoader.maximumBytes)
        default: break
        }
        if request.value(forHTTPHeaderField: "Authorization") != nil ||
            request.value(forHTTPHeaderField: "Cookie") != nil { status = 400 }
        headers["Content-Type"] = type
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if url.lastPathComponent == "oversized-header-stall" { return }
        if url.lastPathComponent == "stall" || url.lastPathComponent == "partial-error" {
            client?.urlProtocol(self, didLoad: Data(body.prefix(8)))
            if url.lastPathComponent == "stall" {
                NotificationCenter.default.post(name: Self.stalled, object: url)
            } else {
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            }
            return
        }
        if ["chunked-image", "oversized-chunks", "understated-length", "exact-limit"].contains(url.lastPathComponent) {
            let chunkSize = url.lastPathComponent == "chunked-image" ? 16 : 64 * 1_024
            for offset in stride(from: 0, to: body.count, by: chunkSize) {
                client?.urlProtocol(self, didLoad: body.subdata(in: offset..<min(offset + chunkSize, body.count)))
            }
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        NotificationCenter.default.post(name: Self.stopped, object: request.url)
    }
}
