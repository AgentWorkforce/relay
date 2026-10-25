import Foundation

/// The saved session brief that Agent Relay Cloud generates. Both apps read the
/// same Cloud analysis response; generation and storage remain in Cloud.
public struct SessionOverview: Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case idle, loading, queued, running, completed, failed
    }

    public let status: Status
    public let title: String
    public let description: String
    public let error: String?

    public init(status: Status, title: String = "", description: String = "", error: String? = nil) {
        self.status = status
        self.title = title
        self.description = description
        self.error = error
    }

    public var hasBrief: Bool { !title.isEmpty && !description.isEmpty }
    public var pending: Bool { status == .queued || status == .running }

    public static func decode(_ data: Data, sessionID: String, source: String? = nil) throws -> SessionOverview {
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.sessionId == sessionID else { throw OverviewError.wrongSession }
        let analyses = response.analyses.filter { $0.sessionId == sessionID && (source == nil || $0.sourceProvider == source) }
        let request = response.requests.first
        let current = request.flatMap { request in analyses.first { $0.id == request.analysisId } } ?? analyses.first
        let completed = ([current].compactMap { $0 } + analyses).first {
            $0.status == .completed && $0.result?.brief?.isValid == true
        }
        let brief = completed?.result?.brief
        let status = request?.status ?? current?.status ?? .idle
        return SessionOverview(
            status: status,
            title: brief?.title ?? "",
            description: brief?.description ?? "",
            error: status == .failed ? failure(request?.error ?? current?.error) : nil
        )
    }

    private static func failure(_ code: String?) -> String {
        switch code {
        case "session_evidence_incomplete": "History could not collect a complete conversation. Sync the session and try again."
        case "session_analysis_ineligible": "This session has no supported conversation to summarize."
        case "session_not_found": "This session is no longer available in History."
        case "model_unavailable": "The summary service is temporarily unavailable. Try again later."
        default: "Could not generate this summary. Please try again."
        }
    }
}

public enum OverviewError: LocalizedError {
    case wrongSession
    public var errorDescription: String? { "Cloud returned a summary for another session." }
}

private struct Response: Decodable {
    let sessionId: String
    let requests: [Request]
    let analyses: [Analysis]
}

private struct Request: Decodable {
    let status: SessionOverview.Status
    let analysisId: String?
    let error: String?
}

private struct Analysis: Decodable {
    let id: String
    let sessionId: String
    let sourceProvider: String?
    let status: SessionOverview.Status
    let result: AnalysisResult?
    let error: String?
}

private struct AnalysisResult: Decodable {
    let brief: Brief?
}

private struct Brief: Decodable {
    let title: String
    let description: String
    var isValid: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// A small, source-backed fallback when no generated brief exists. The first
/// substantive user event states why the session was started; it is labeled as
/// the original request so later changes are not mistaken for current work.
public enum SessionGoal {
    public static func decode(_ data: Data, sessionID: String) throws -> String? {
        let response = try JSONDecoder().decode(EventResponse.self, from: data)
        guard response.sessionId == sessionID else { throw OverviewError.wrongSession }
        for event in response.events {
            guard event.actorRole == "user" || event.kind == "prompt" || event.kind == "user",
                  let content = event.content.map(withoutPreamble) else { continue }
            let oneLine = content.components(separatedBy: .whitespacesAndNewlines)
                .filter { !$0.isEmpty }.joined(separator: " ")
            guard oneLine.count >= 30,
                  !oneLine.hasPrefix("<system-reminder"),
                  !oneLine.hasPrefix("<task-notification") else { continue }
            return String(oneLine.prefix(300))
        }
        return nil
    }
}

/// The blocks a harness puts before a person's first prompt: Conductor's
/// `<system_instruction>` and Codex's `<recommended_plugins>`,
/// `<environment_context>` and `<user_instructions>`, and Grok's
/// `<user_info>` and `<rules>`. Only these are
/// skipped, so a prompt a person starts with their own tag keeps it. The
/// core's `conductor::PREAMBLE_TAGS`.
let preambleTags: Set<Substring> = [
    "system_instruction", "recommended_plugins", "environment_context", "user_instructions",
    "user_info", "rules",
]

/// `text` after the closed `preambleTags` blocks that lead it, each through
/// its closing tag, repeated. An unclosed block is left as it is. The core's
/// `conductor::without_preamble`.
func withoutPreamble(_ text: String) -> String {
    var rest = Substring(text).drop(while: { $0.isWhitespace })
    while rest.first == "<", let close = rest.firstIndex(of: ">") {
        let tag = rest[rest.index(after: rest.startIndex)..<close]
        guard preambleTags.contains(tag), let end = rest.range(of: "</\(tag)>") else { break }
        rest = rest[end.upperBound...].drop(while: { $0.isWhitespace })
    }
    return String(rest)
}

private struct EventResponse: Decodable {
    let sessionId: String
    let events: [GoalEvent]
}

private struct GoalEvent: Decodable {
    let kind: String?
    let actorRole: String?
    let content: String?
}
