import RelayDesktopCore
import SwiftUI

/// The upload pipeline as a compact vertical checklist, shown in the status popover.
struct UploadStagesView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(stages) { stage in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: symbol(stage.state))
                        .foregroundStyle(color(stage.state))
                        .frame(width: 16)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(stage.title).font(.callout.weight(.medium))
                            Spacer(minLength: 8)
                            if stage.state == .active {
                                Group {
                                    if let fraction = stage.fraction {
                                        ProgressView(value: fraction)
                                    } else {
                                        ProgressView()
                                    }
                                }
                                .progressViewStyle(.linear)
                                .controlSize(.small)
                                .frame(width: 80)
                                .accessibilityLabel(stage.title)
                            }
                        }
                        Text(stage.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if stage.action == .compact {
                            Button("Compact now") {
                                Task { await model.compactJournal() }
                            }
                            .controlSize(.small)
                            .disabled(model.isWorking)
                            .help("Remove consumed records from the upload journal so capture and uploads can continue")
                            if let error = model.uploadActionError {
                                Label(error, systemImage: "exclamationmark.triangle")
                                    .font(.caption).foregroundStyle(.red)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if stage.action == .retry {
                            Button("Retry uploads") {
                                Task { await model.retryUploads() }
                            }
                            .controlSize(.small)
                            .disabled(model.isWorking)
                            .help("Send the queued records again. Nothing queued is lost.")
                            if let error = model.uploadActionError {
                                Label(error, systemImage: "exclamationmark.triangle")
                                    .font(.caption).foregroundStyle(.red)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
        }
    }

    private var stages: [UploadStage] {
        UploadStages.make(
            catalogReady: !model.sessions.isEmpty || model.lastSessionsRefresh != nil,
            loadedSessions: model.sessions.count,
            enabledSessions: model.sessions.filter(\.included).count,
            preparingHistory: model.isPreparingSessionList,
            capture: model.captureProgress,
            status: model.statusViewModel,
            summary: model.sessionUploadSummary,
            pending: model.pendingUploadAction
        )
    }

    private func symbol(_ state: UploadStage.State) -> String {
        switch state {
        case .waiting: return "circle"
        case .active: return "arrow.triangle.2.circlepath"
        case .complete: return "checkmark.circle.fill"
        case .paused: return "pause.circle"
        case .blocked: return "exclamationmark.circle"
        }
    }

    private func color(_ state: UploadStage.State) -> Color {
        switch state {
        case .waiting: return .secondary
        case .active: return .accentColor
        case .complete: return .green
        case .paused, .blocked: return .orange
        }
    }
}
