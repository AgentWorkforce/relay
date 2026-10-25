import Foundation

public enum SessionNavigation {
    /// The Cloud detail URL for an uploaded session. Session identifiers are
    /// encoded as one path component because providers may use `/` in an id.
    public static func cloudURL(siteURL: String, sessionId: String) -> URL? {
        guard !sessionId.isEmpty, var components = URLComponents(string: siteURL),
              components.scheme == "https" || components.scheme == "http",
              components.host != nil else { return nil }
        let pathSegment = sessionId.addingPercentEncoding(
            withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        )
        guard let pathSegment else { return nil }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        components.percentEncodedPath = "/cloud/dashboard/sessions/\(pathSegment)"
        return components.url
    }

    /// The Cloud detail URL of a session that has finished uploading; Cloud
    /// has no page for one that hasn't.
    public static func cloudURL(siteURL: String, session: UploadSession) -> URL? {
        session.status == .uploaded ? cloudURL(siteURL: siteURL, sessionId: session.sessionId) : nil
    }
}
