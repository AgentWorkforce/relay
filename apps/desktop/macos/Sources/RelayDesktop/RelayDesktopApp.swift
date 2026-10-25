import AppKit
import RelayDesktopCore
import OSLog
import SwiftUI
import UserNotifications

/// Closing the window keeps the core and the menu-bar controls running.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: AppModel
    let updater: AppUpdater
    private var automaticUpdateTask: Task<Void, Never>?

    override init() {
        model = AppModel(capyInstalled: CapySetup.isInstalled(home: FileManager.default.homeDirectoryForCurrentUser))
        updater = .shared
        super.init()
    }

    init(model: AppModel) {
        self.model = model
        updater = .shared
        super.init()
    }

    // Fallback for URLs delivered through AppKit rather than a SwiftUI scene.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { model.openConnection(url) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // A visible menu-bar panel is not a substitute for the main window.
        model.showMainWindow()
        return false
    }

    private let logger = Logger(subsystem: AppInfo.subsystem, category: "app")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        AppAppearance.stored.apply()
        if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().delegate = self }
        logger.info("Agent Relay started")
        Task { await model.bootstrapIfNeeded() }
        automaticUpdateTask = Task { [updater] in await updater.runAutomaticChecks() }
    }

    /// The core is launchd's LaunchAgent and keeps running after the app
    /// quits; this only closes the app's connections to it.
    func applicationWillTerminate(_ notification: Notification) {
        automaticUpdateTask?.cancel()
        model.shutdown()
    }

    /// A `notify` event's link (a provider's connect page, say) opens when
    /// its notification is clicked.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let link = response.notification.request.content.userInfo["link"] as? String
        Task { @MainActor in
            if let link, let url = URL(string: link), ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            completionHandler()
        }
    }

    /// Shown while Agent Relay is in front, too.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

@main
struct RelayDesktopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Window("Agent Relay", id: AppInfo.mainWindowID) {
            MainWindowView()
                .environmentObject(appDelegate.model)
        }
        .defaultSize(width: SessionColumnLayout.defaultWindowSize.width, height: SessionColumnLayout.defaultWindowSize.height)
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Agent Relay Settings…") {
                    appDelegate.model.showSettingsWindow()
                }
                .keyboardShortcut(",")
            }
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    appDelegate.model.showSettingsWindow(.about)
                    Task { await appDelegate.updater.checkForUpdates() }
                }
            }
        }

        MenuBarExtra {
            MenuPanelView(relay: appDelegate.model.relay).environmentObject(appDelegate.model)
        } label: {
            MenuBarLabel(relay: appDelegate.model.relay).environmentObject(appDelegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}
