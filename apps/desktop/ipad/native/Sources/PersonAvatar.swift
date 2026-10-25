import Foundation
import ImageIO
import SwiftUI

/// The image session cannot send the Cloud bearer token, saved credentials or
/// cookies to a profile provider. An unsafe redirect is declined as well.
final class PersonPhotoRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, PersonPhotoURL.parse(url.absoluteString) != nil else {
            completionHandler(nil)
            return
        }
        // Build a fresh request rather than carrying headers across origins.
        var anonymous = URLRequest(url: url)
        anonymous.timeoutInterval = 15
        completionHandler(anonymous)
    }
}

/// One-shot download of URLSession data chunks without per-byte iteration. The
/// lock covers cancellation as well as delegate callbacks; no task is canceled
/// and no continuation is resumed while the lock is held.
final class PersonPhotoDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let redirectPolicy = PersonPhotoRedirectPolicy()
    private var continuation: CheckedContinuation<Data?, Never>?
    private var session: URLSession?
    private var buffer = Data()
    private var acceptedResponse = false
    private var finished = false

    func data(from url: URL, configuration: URLSessionConfiguration) async -> Data? {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                start(url, configuration: configuration, continuation: continuation)
            }
        } onCancel: {
            self.cancel()
        }
    }

    private func start(_ url: URL, configuration: URLSessionConfiguration,
                       continuation: CheckedContinuation<Data?, Never>) {
        lock.lock()
        // The cancellation handler may run before continuation registration.
        guard !finished, self.continuation == nil else {
            lock.unlock()
            continuation.resume(returning: nil)
            return
        }
        self.continuation = continuation
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: url)
        lock.unlock()
        // Cancellation between unlock and resume invalidates this same session.
        task.resume()
    }

    func cancel() { finish(acceptData: false) }

    private func finish(acceptData: Bool) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let result = acceptData && acceptedResponse ? buffer : nil
        let continuation = self.continuation
        let session = self.session
        self.continuation = nil
        self.session = nil
        buffer = Data()
        lock.unlock()
        session?.invalidateAndCancel()
        continuation?.resume(returning: result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let valid: Bool
        if let http = response as? HTTPURLResponse, let url = http.url {
            valid = (200..<300).contains(http.statusCode) &&
                PersonPhotoURL.parse(url.absoluteString) != nil &&
                http.mimeType?.hasPrefix("image/") == true &&
                http.expectedContentLength <= Int64(PersonPhotoLoader.maximumBytes)
        } else {
            valid = false
        }
        lock.lock()
        let accept = !finished && valid
        acceptedResponse = accept
        lock.unlock()
        // Reject oversized declared bodies before allowing any data callbacks.
        completionHandler(accept ? .allow : .cancel)
        if !accept { finish(acceptData: false) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        guard acceptedResponse, data.count <= PersonPhotoLoader.maximumBytes - buffer.count else {
            acceptedResponse = false
            lock.unlock()
            finish(acceptData: false)
            return
        }
        buffer.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(acceptData: error == nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        redirectPolicy.urlSession(session, task: task, willPerformHTTPRedirection: response,
                                  newRequest: request, completionHandler: completionHandler)
    }
}

enum PersonPhotoLoader {
    static let maximumBytes = 5 * 1_024 * 1_024

    static func load(_ url: URL, configuration: URLSessionConfiguration = .ephemeral) async -> UIImage? {
        guard !Task.isCancelled, PersonPhotoURL.parse(url.absoluteString) != nil else { return nil }
        #if DEBUG
        if let fixtureProtocols = RelayUITestFixture.photoProtocolClasses {
            configuration.protocolClasses = fixtureProtocols
        }
        #endif
        configuration.httpAdditionalHeaders = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        guard let data = await PersonPhotoDownload().data(from: url, configuration: configuration),
              !Task.isCancelled,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 256,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: thumbnail)
    }
}

struct PersonAvatar: View {
    let displayName: String
    let handle: String
    let url: URL?
    let size: CGFloat
    let accent: Color
    let accessibilityID: String
    @State private var photo: UIImage?

    var body: some View {
        Group {
            if let photo {
                Image(uiImage: photo).resizable().scaledToFill()
            } else {
                Text(PersonIdentity.initials(displayName: displayName, handle: handle))
                    .font(.system(size: size * 0.38, weight: .semibold)).foregroundStyle(accent)
                    .frame(width: size, height: size)
                    .background(accent.opacity(0.16), in: Circle())
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(displayName.isEmpty ? handle : displayName)
        .accessibilityIdentifier(accessibilityID)
        .accessibilityValue(photo == nil ? "Initials" : "Profile photo")
        .task(id: url) {
            photo = nil
            guard let url else { return }
            let loaded = await PersonPhotoLoader.load(url)
            guard !Task.isCancelled else { return }
            photo = loaded
        }
    }
}
