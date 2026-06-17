import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

protocol HostedHTTPClient: Sendable {
    func get(path: String, query: [String: String]?) async throws -> Data
    func post(path: String, body: Data?) async throws -> Data
    func delete(path: String) async throws -> Data
}

actor HostedHTTP: HostedHTTPClient {
    private let baseURL: URL
    private let apiKey: String
    private let session: URLSession

    init(baseURL: URL, apiKey: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
    }

    func get(path: String, query: [String: String]? = nil) async throws -> Data {
        try await request(method: "GET", path: path, query: query, body: nil)
    }

    func post(path: String, body: Data?) async throws -> Data {
        try await request(method: "POST", path: path, query: nil, body: body)
    }

    func delete(path: String) async throws -> Data {
        try await request(method: "DELETE", path: path, query: nil, body: nil)
    }

    private func request(method: String, path: String, query: [String: String]?, body: Data?) async throws -> Data {
        guard let url = Self.resolveAPIURL(baseURL: baseURL, path: path, query: query) else {
            throw RelayError.invalidBaseURL("Could not resolve URL for path \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("agent-relay-swift", forHTTPHeaderField: "X-Relaycast-Origin-Client")
        request.setValue("swift-sdk-split", forHTTPHeaderField: "X-Relaycast-Origin-Version")
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
            throw RelayError.connectionFailed("Non-HTTP response from Relaycast")
        }

        if !(200..<300).contains(http.statusCode) {
            let (code, message) = decodeErrorBody(data, fallbackStatus: http.statusCode)
            throw RelayError.protocolError(
                code: code,
                message: message,
                retryable: http.statusCode == 429 || http.statusCode >= 500
            )
        }

        return data
    }

    static func resolveAPIURL(baseURL: URL, path: String, query: [String: String]? = nil) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        if components.scheme == "ws" { components.scheme = "http" }
        if components.scheme == "wss" { components.scheme = "https" }

        var basePath = components.path
        while basePath.hasSuffix("/") { basePath = String(basePath.dropLast()) }
        if basePath.hasSuffix("/v1/ws") {
            basePath = String(basePath.dropLast("/v1/ws".count))
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/" + path
        components.path = basePath + normalizedPath
        components.queryItems = query?.map { URLQueryItem(name: $0.key, value: $0.value) }
        components.fragment = nil
        return components.url
    }

    private func decodeErrorBody(_ data: Data, fallbackStatus: Int) -> (code: String, message: String) {
        if let envelope = try? JSONDecoder().decode(APIEnvelope<EmptyAPIData>.self, from: data),
           let error = envelope.error {
            return (error.code, error.message)
        }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let error = json["error"] as? [String: Any]
            let code = (error?["code"] as? String) ?? (json["code"] as? String) ?? "http_\(fallbackStatus)"
            let message =
                (error?["message"] as? String)
                ?? (json["message"] as? String)
                ?? "HTTP \(fallbackStatus)"
            return (code, message)
        }
        return ("http_\(fallbackStatus)", "HTTP \(fallbackStatus)")
    }
}

struct APIEnvelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: APIErrorPayload?
}

struct APIErrorPayload: Decodable {
    let code: String
    let message: String
}

struct EmptyAPIData: Decodable {}

func decodeAPIData<T: Decodable>(_ data: Data, as type: T.Type = T.self) throws -> T {
    do {
        let envelope = try JSONDecoder().decode(APIEnvelope<T>.self, from: data)
        if envelope.ok, let value = envelope.data {
            return value
        }
        if envelope.ok, T.self == EmptyAPIData.self {
            return EmptyAPIData() as! T
        }
        if let error = envelope.error {
            throw RelayError.protocolError(code: error.code, message: error.message, retryable: false)
        }
        throw RelayError.decodingFailed("Relay API response did not include data")
    } catch let error as RelayError {
        throw error
    } catch {
        throw RelayError.decodingFailed(String(describing: error))
    }
}
