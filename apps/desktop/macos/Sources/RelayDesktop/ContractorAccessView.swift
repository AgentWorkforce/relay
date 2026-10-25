import RelayDesktopCore
import SwiftUI

/// The menu panel's "Team access" section (#51). Renders nothing while the
/// feature is dormant, so it can sit in the panel unconditionally.
struct ContractorAccessSection: View {
    @ObservedObject var access: ContractorsModel

    var body: some View {
        if access.isVisible {
            VStack(alignment: .leading, spacing: 8) {
                Divider()
                if access.isOwner {
                    OwnerAccessView(access: access)
                } else if let grant = access.status?.grant, grant.scopes.contains(where: { $0.access != .none }) {
                    ContractorGrantView(grant: grant, names: access.serviceNames,
                                        provisioned: access.status?.provisioning.grantId == grant.id)
                }
                if let error = access.error ?? (access.status?.provisioning.failed == true
                    ? "Your access could not be set up yet." : nil) {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.system(size: 11)).foregroundStyle(.orange).lineLimit(2).help(error)
                }
            }
            .task { await access.refresh() }
        }
    }
}

private struct SectionTitle: View {
    var text: String
    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            .textCase(.uppercase)
    }
}

// MARK: Owner

private struct OwnerAccessView: View {
    @ObservedObject var access: ContractorsModel

    var body: some View {
        if let flow = access.flow {
            OnboardingFlowView(access: access, flow: flow)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                SectionTitle(text: "Team access")
                ForEach(access.pendingSeats.prefix(3)) { seat in
                    NewSeatRow(seat: seat,
                               onboard: { access.startOnboarding(seat) },
                               dismiss: { access.dismiss(seat) })
                }
                if access.grants.isEmpty && access.pendingSeats.isEmpty {
                    Text("When someone joins your workspace, set up what their agents can use here.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(access.grants) { grant in
                    GrantRow(grant: grant, summary: grant.summary(names: access.serviceNames),
                             revoking: access.revoking.contains(grant.id)) {
                        Task { await access.revoke(grant) }
                    }
                }
            }
        }
    }
}

private struct NewSeatRow: View {
    var seat: PendingSeat
    var onboard: () -> Void
    var dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.badge.plus").foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(seat.name) joined").font(.system(size: 12, weight: .medium)).lineLimit(1)
                Text("What should their agents have access to?")
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button("Set up", action: onboard)
                .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 26))
                .frame(width: 64)
                .help("Choose what \(seat.name)'s agents can use")
            Button(action: dismiss) { Image(systemName: "xmark") }
                .buttonStyle(MenuPanelButtonStyle(kind: .quiet, controlHeight: 26))
                .frame(width: 28)
                .accessibilityLabel("Not now")
                .help("Hide without granting anything")
        }
    }
}

private struct GrantRow: View {
    var grant: AccessGrant
    var summary: String
    var revoking: Bool
    var revoke: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "key.horizontal").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(grant.displayName ?? grant.userId).font(.system(size: 12, weight: .medium)).lineLimit(1)
                Text(summary).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    .help(grant.description.isEmpty ? summary : "\(grant.description)\n\(summary)")
            }
            Spacer(minLength: 4)
            Button(action: revoke) {
                if revoking { ProgressView().controlSize(.mini) } else { Text("Revoke") }
            }
            .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 26))
            .frame(width: 72)
            .disabled(revoking)
            .accessibilityLabel("Revoke access for \(grant.displayName ?? grant.userId)")
            .help("Revoke now. Their agents lose access at the next token refresh.")
        }
    }
}

private struct OnboardingFlowView: View {
    @ObservedObject var access: ContractorsModel
    var flow: ContractorsModel.Flow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionTitle(text: "Onboard \(flow.seat.name)")
                Spacer()
                Button(action: access.cancelOnboarding) { Image(systemName: "xmark") }
                    .buttonStyle(MenuPanelButtonStyle(kind: .quiet, controlHeight: 24))
                    .frame(width: 28)
                    .disabled(access.isBusy)
                    .accessibilityLabel("Close")
            }
            switch flow.step {
            case .describe:
                describe
            case .proposing:
                progress("Working out what they need…")
            case .review(let rationale, let scopes):
                review(rationale: rationale, scopes: scopes)
            case .approving:
                progress("Granting access…")
            case .done(let grant):
                done(grant)
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                Button("Back", action: access.retry)
                    .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 30))
            }
        }
    }

    private var describe: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What is \(flow.seat.name) working on?")
                .font(.system(size: 12, weight: .medium))
            TextEditor(text: Binding(get: { flow.description }, set: access.setDescription))
                .font(.system(size: 12))
                .frame(height: 64)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))
                .accessibilityLabel("Describe the contractor's work")
            Button {
                Task { await access.propose() }
            } label: {
                Text("Suggest access").frame(maxWidth: .infinity)
            }
            .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 30))
            .disabled(!flow.canPropose)
        }
    }

    private func review(rationale: String?, scopes: [Scope]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let rationale {
                Text(rationale).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView(.vertical) {
                VStack(spacing: 4) {
                    ForEach(scopes, id: \.service) { scope in
                        ScopeRow(scope: scope, service: access.service(named: scope.service)) {
                            access.setAccess($0, for: scope.service)
                        }
                    }
                }
            }
            .frame(maxHeight: 180)
            Button {
                Task { await access.approve() }
            } label: {
                Text("Approve access").frame(maxWidth: .infinity)
            }
            .buttonStyle(MenuPanelButtonStyle(kind: .primary, controlHeight: 30))
            .disabled(!flow.canApprove)
            .help("They get short-lived, scoped access on their next sign-in. No keys are shared.")
        }
    }

    private func done(_ grant: AccessGrant) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("\(flow.seat.name) is set up", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(.green)
            Text(grant.summary(names: access.serviceNames)).font(.system(size: 11)).foregroundStyle(.secondary)
            Text("Their agents get this access as soon as they sign in to Agent Relay. They never see a key.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Done", action: access.cancelOnboarding)
                .buttonStyle(MenuPanelButtonStyle(kind: .secondary, controlHeight: 30))
        }
    }

    private func progress(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 12)
    }
}

private struct ScopeRow: View {
    var scope: Scope
    var service: Service?
    var set: (Access) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(service?.name ?? scope.service).font(.system(size: 12)).lineLimit(1)
            if service?.sensitivity == .high {
                Image(systemName: "lock.shield").font(.system(size: 10)).foregroundStyle(.secondary)
                    .help("Sensitive: always used through Agent Relay Cloud, never on their computer.")
            }
            Spacer(minLength: 4)
            Picker("Access to \(service?.name ?? scope.service)", selection: Binding(get: { scope.access }, set: set)) {
                ForEach(Access.allCases, id: \.self) { Text($0 == .none ? "Off" : $0.label).tag($0) }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .controlSize(.small)
            .frame(width: 150)
        }
    }
}

// MARK: Contractor

private struct ContractorGrantView: View {
    var grant: AccessGrant
    var names: [String: String]
    var provisioned: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionTitle(text: "Your access")
            HStack(spacing: 8) {
                Image(systemName: provisioned ? "checkmark.shield" : "hourglass")
                    .foregroundStyle(provisioned ? Color.green : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(grant.summary(names: names)).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Text(grant.grantedBy.map { "Granted by \($0) · your agents use it; no keys stored locally" }
                         ?? "Your agents use it; no keys stored locally")
                        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }
}
