import AppKit
import SwiftUI
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

@MainActor final class SavedSessionViewsTests: XCTestCase {
    func testRestoreAllSettingsAndDefaultOnRestart() throws {
        let suite = "saved-views-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        func model() -> AppModel { AppModel(manageSystemServices: false, defaults: defaults) }
        let app = model()
        app.sessionSearch = "updated:>=2026-10-08 project:cloud"
        app.sessionGrouping = .harness
        app.sessionSort.select(.session)
        app.sessionColumns.setWidth(640, for: .session)
        app.sessionColumns.setVisible(false, for: .project)
        app.sessionColumns.move(.updated, to: .session)
        app.showHiddenSessions = true
        let expected = app.sessionViewConfiguration
        let id = try XCTUnwrap(app.savedSessionViews.save(name: " Last week ", configuration: expected, makeDefault: true))
        app.sessionSearch = "other"
        app.sessionGrouping = .none
        app.sessionSort = LocalSessionSort()
        app.sessionColumns = SessionColumnLayout()
        app.showHiddenSessions = false
        app.applySessionView(try XCTUnwrap(app.savedSessionViews.defaultView))
        XCTAssertEqual(app.sessionSearch, expected.search)
        XCTAssertEqual(app.sessionGrouping, .harness)
        XCTAssertEqual(app.sessionSort, expected.sort)
        XCTAssertEqual(app.sessionColumns, SessionColumnLayout(data: expected.columns))
        XCTAssertTrue(app.showHiddenSessions)
        XCTAssertEqual(app.sessionViewConfiguration, expected)
        let restarted = model()
        XCTAssertEqual(restarted.savedSessionViews.defaultID, id)
        XCTAssertEqual(restarted.sessionViewConfiguration, expected)
        restarted.savedSessionViews.delete(id)
        let afterDeletion = model()
        XCTAssertTrue(afterDeletion.savedSessionViews.views.isEmpty)
        XCTAssertNil(afterDeletion.savedSessionViews.defaultID)
        XCTAssertEqual(afterDeletion.sessionSearch, "")
        XCTAssertEqual(afterDeletion.sessionGrouping, .none)
    }

    func testBookmarkTracksConfigurationRatherThanLastOpenedView() throws {
        let suite = "bookmark-state-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(manageSystemServices: false, defaults: defaults)
        app.sessionSearch = "updated:>=2026-10-08"
        app.sessionGrouping = .harness
        XCTAssertNil(app.currentSavedSessionView)
        let id = try XCTUnwrap(app.savedSessionViews.save(name: "Last week", configuration: app.sessionViewConfiguration, makeDefault: false))
        let view = try XCTUnwrap(app.currentSavedSessionView)
        XCTAssertEqual(view.id, id)
        let changes: [() -> Void] = [
            { app.sessionSearch = "project:other" },
            { app.sessionGrouping = .project },
            { app.sessionSort.select(.session) },
            { app.sessionColumns.setWidth(600, for: .session) },
            { app.showHiddenSessions = true }
        ]
        for change in changes {
            change()
            XCTAssertNil(app.currentSavedSessionView)
            app.applySessionView(view)
            XCTAssertEqual(app.currentSavedSessionView?.id, id)
        }
        app.sessionGrouping = .none
        XCTAssertNil(app.currentSavedSessionView)
        app.sessionGrouping = .harness
        XCTAssertEqual(app.currentSavedSessionView?.id, id)
        app.savedSessionViews.delete(id)
        XCTAssertNil(app.currentSavedSessionView)
    }

    func testNamesDefaultsAndCorruptStorage() throws {
        let configuration = SessionViewConfiguration(search: "", grouping: .none, sort: LocalSessionSort(), columns: SessionColumnLayout(), showHidden: false)
        var views = SavedSessionViews()
        XCTAssertNil(views.save(name: " \n ", configuration: configuration, makeDefault: true))
        let first = try XCTUnwrap(views.save(name: "Work", configuration: configuration, makeDefault: true))
        XCTAssertNil(views.save(name: " work ", configuration: configuration, makeDefault: false))
        let second = try XCTUnwrap(views.save(name: "Personal", configuration: configuration, makeDefault: false))
        XCTAssertEqual(views.defaultID, first)
        views.setDefault(second)
        XCTAssertEqual(SavedSessionViews(data: views.data).defaultID, second)
        views.delete(first)
        XCTAssertEqual(views.defaultID, second)
        views.setDefault(nil)
        XCTAssertNil(SavedSessionViews(data: views.data).defaultView)
        XCTAssertEqual(views.views.count, 1)
        views.setDefault(UUID())
        XCTAssertNil(views.defaultID)
        XCTAssertTrue(SavedSessionViews(data: Data("broken".utf8)).views.isEmpty)
    }

    func testSavingWithoutDefaultPreservesExistingStartupBehavior() throws {
        let suite = "saved-views-no-default-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(manageSystemServices: false, defaults: defaults)
        app.sessionSearch = "project:cloud"
        app.sessionGrouping = .project
        app.savedSessionViews.save(name: "Cloud", configuration: app.sessionViewConfiguration, makeDefault: false)
        let restarted = AppModel(manageSystemServices: false, defaults: defaults)
        XCTAssertEqual(restarted.savedSessionViews.views.count, 1)
        XCTAssertEqual(restarted.sessionSearch, "")
        XCTAssertEqual(restarted.sessionGrouping, .none)
    }

    func testSaveFormRendersWithKeyboardFocus() async throws {
        let suite = "saved-views-render-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(manageSystemServices: false, defaults: defaults)
        let host = NSHostingView(rootView: SaveSessionViewForm(close: {}).environmentObject(app)
            .environment(\.colorScheme, .dark).background(CloudTheme.background))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 260), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        host.layoutSubtreeIfNeeded()
        let bitmap = try SessionRenderFixture.bitmap(for: host)
        XCTAssertGreaterThan(bitmap.pixelsWide, 300)
        if let path = ProcessInfo.processInfo.environment["SAVED_VIEWS_PREVIEW"] {
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
        }
        XCTAssertTrue(window.firstResponder is NSTextView, "Naming starts with keyboard focus in the field")
    }
}
