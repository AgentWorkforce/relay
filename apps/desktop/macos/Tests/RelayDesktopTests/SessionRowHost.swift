import SwiftUI
@testable import RelayDesktop
import RelayDesktopCore

/// One Sessions table row driven by live models, as the table drives it.
struct SessionRowHost: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayModel
    let row: LocalSessionRow
    @Binding var selected: Bool
    var open: () -> Void = {}

    var body: some View {
        LocalSessionTableRow(state: SessionRowIndex(model: model, relay: relay).state(for: row),
            columns: model.sessionColumns, selected: selected, now: Date(),
            actions: SessionRowActions(open: open, toggleSelected: { selected.toggle() }, toggleRelay: {},
                setHidden: { _ in }, openInCloud: { _ in }))
            .equatable()
            .environmentObject(model)
    }
}
