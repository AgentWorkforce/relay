import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum RelayError: Error, Sendable {
    case invalidBaseURL(String)
    case connectionFailed(String)
    case handshakeFailed(String)
    case protocolError(code: String, message: String, retryable: Bool)
    case encodingFailed(String)
    case decodingFailed(String)
    case notConnected
    case unsupported(String)
    case timeout(String)
}

protocol RelayHTTPClient: Sendable {
    func post(path: String, body: Data?) async throws -> Data
    func delete(path: String, body: Data?) async throws -> Data
    func get(path: String) async throws -> Data
}

/// Minimal HTTP client for the local broker REST API.
actor RelayHTTP: RelayHTTPClient {
    private let baseURL: URL
    private let apiKey: String
    private let session: URLSession

    init(baseURL: URL, apiKey: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
    }

    func post(path: String, body: Data?) async throws -> Data {
        try await request(method: "POST", path: path, body: body)
    }

    func delete(path: String, body: Data?) async throws -> Data {
        try await request(method: "DELETE", path: path, body: body)
    }

    func get(path: String) async throws -> Data {
        try await request(method: "GET", path: path, body: nil)
    }

    private func request(method: String, path: String, body: Data?) async throws -> Data {
        guard let url = Self.resolveAPIURL(baseURL: baseURL, path: path) else {
            throw RelayError.invalidBaseURL("Could not resolve URL for path \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 10
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw RelayError.connectionFailed(String(describing: error))
        }

        guard let http = response as? HTTPURLResponse else {
            throw RelayError.connectionFailed("Non-HTTP response from broker")
        }

        if !(200..<300).contains(http.statusCode) {
            let (code, message) = decodeErrorBody(data, fallbackStatus: http.statusCode)
            throw RelayError.protocolError(
                code: code,
                message: message,
                retryable: http.statusCode >= 500
            )
        }

        return data
    }

    static func resolveAPIURL(baseURL: URL, path: String) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        if components.scheme == "ws" { components.scheme = "http" }
        if components.scheme == "wss" { components.scheme = "https" }

        var basePath = components.path
        while basePath.hasSuffix("/") { basePath = String(basePath.dropLast()) }
        if basePath.hasSuffix("/v1/ws") {
            basePath = String(basePath.dropLast("/v1/ws".count))
        } else if basePath.hasSuffix("/ws") {
            basePath = String(basePath.dropLast("/ws".count))
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/" + path
        components.path = basePath + normalizedPath
        components.query = nil
        components.fragment = nil
        return components.url
    }

    private func decodeErrorBody(_ data: Data, fallbackStatus: Int) -> (code: String, message: String) {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let code = (json["code"] as? String) ?? "http_\(fallbackStatus)"
            let message =
                (json["message"] as? String)
                ?? (json["error"] as? String)
                ?? "HTTP \(fallbackStatus)"
            return (code, message)
        }
        return ("http_\(fallbackStatus)", "HTTP \(fallbackStatus)")
    }
}
