import AppKit
import RelayDesktopCore
import SwiftUI

/// Compact upload state, with its full wording available on hover and to accessibility.
struct SessionStatusCell: View {
    let state: SessionUploadState
    let stopping: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let title = stopping ? "Deleting…" : state.iconTitle
        let detail = stopping ? "Deleting the cloud copy and stopping future uploads" : state.detail
        Group {
            if state == .uploading && !stopping {
                AnimatedUploadActivityGlyph(reduceMotion: reduceMotion)
                    .frame(width: 16, height: 16)
            } else {
                Image(systemName: stopping ? "stop.circle" : state.symbol)
                    .foregroundStyle(color)
            }
        }
        .font(.system(size: 14, weight: .medium))
        .frame(width: 28, height: 28)
        .contentShape(Rectangle())
        .help(title)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(detail)
    }

    private var color: Color {
        if stopping { return CloudTheme.secondary }
        switch state {
        case .uploaded: return CloudTheme.secondary.opacity(0.8)
        case .local: return CloudTheme.secondary.opacity(0.45)
        case .uploading, .preparing, .queued: return CloudTheme.primary
        case .paused, .blocked, .stopped, .unknown: return CloudTheme.warning
        case .discovering, .checking: return CloudTheme.secondary
        }
    }
}

struct UploadActivityGlyph: View {
    let frame: UploadActivityFrame

    var body: some View {
        Image(systemName: "arrow.up.circle.fill")
            .foregroundStyle(CloudTheme.secondary.opacity(0.35))
            .overlay {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(CloudTheme.primary.opacity(frame.opacity))
                    .mask(alignment: .bottom) {
                        GeometryReader { geometry in
                            Rectangle().frame(height: geometry.size.height * frame.fill)
                                .frame(maxHeight: .infinity, alignment: .bottom)
                        }
                    }
            }
    }
}

/// Message availability uses both a symbol and a label, independent of color.
struct MessageAvailabilityButton: View {
    let title: String
    let presence: RelayPresence
    let enabled: Bool
    let help: String
    let action: () -> Void

    private var color: Color {
        switch presence {
        case .online: return CloudTheme.success
        case .joining, .connecting: return CloudTheme.messageConnecting
        case .off, .offline, .leaving: return CloudTheme.secondary.opacity(0.45)
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: presence.messageSymbol).foregroundStyle(color)
                    .frame(width: 14)
                Text(presence.messageStatus).font(.system(size: 11, weight: .medium)).lineLimit(1)
                    .foregroundStyle(CloudTheme.foreground)
            }
            .padding(.horizontal, 8).frame(height: 30)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(color.opacity(0.3)))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(HoverPlainButtonStyle(shape: RoundedRectangle(cornerRadius: 6)))
        .disabled(!enabled)
        .help(help)
        .accessibilityLabel("Receive messages: \(title)")
        .accessibilityValue(presence.messageStatus)
    }
}
