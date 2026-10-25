import SwiftUI
import UserNotifications

@MainActor final class RelayPushState {
    static let shared = RelayPushState()
    var token: String?
    var pendingConversationID: String?
    /// A tapped channel notification, opened once the channel list loads.
    var pendingChannelName: String?
    /// The channel on screen, whose pushes update it in place.
    var openChannelName: String?

    /// Keep a notification pending until roster or person enrichment makes
    /// its peer available. Consume it once, before starting navigation work.
    func takePendingConversation(resolve: (String) -> RelayAgent?) -> RelayAgent? {
        guard let id = pendingConversationID, let agent = resolve(id) else { return nil }
        pendingConversationID = nil
        return agent
    }
    static let tokenDidChange = Notification.Name("relay.pushTokenDidChange")
    static let openConversation = Notification.Name("relay.openConversation")
    static let messageArrived = Notification.Name("relay.messageArrived")
    static let openChannel = Notification.Name("relay.openChannel")
    static let channelMessageArrived = Notification.Name("relay.channelMessageArrived")
}

final class RelayAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        notifyMessageArrival(userInfo)
        // A message in the open channel already appears in the chat.
        let channel = userInfo["channel_name"] as? String
        let isOpenChannel = channel != nil && MainActor.assumeIsolated { RelayPushState.shared.openChannelName == channel }
        completionHandler(isOpenChannel ? [] : [.banner, .sound, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        if let conversationID = userInfo["conversation_id"] as? String {
            Task { @MainActor in
                RelayPushState.shared.pendingConversationID = conversationID
                NotificationCenter.default.post(name: RelayPushState.openConversation, object: conversationID)
            }
        } else if let channel = userInfo["channel_name"] as? String {
            Task { @MainActor in
                RelayPushState.shared.pendingChannelName = channel
                NotificationCenter.default.post(name: RelayPushState.openChannel, object: channel)
            }
        }
        completionHandler()
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        notifyMessageArrival(userInfo)
        completionHandler(userInfo["conversation_id"] == nil && userInfo["channel_name"] == nil ? .noData : .newData)
    }

    private func notifyMessageArrival(_ userInfo: [AnyHashable: Any]) {
        if let channel = userInfo["channel_name"] as? String, userInfo["conversation_id"] == nil {
            Task { @MainActor in
                NotificationCenter.default.post(name: RelayPushState.channelMessageArrived, object: channel)
            }
            return
        }
        guard let conversationID = userInfo["conversation_id"] as? String else { return }
        Task { @MainActor in
            NotificationCenter.default.post(name: RelayPushState.messageArrived, object: conversationID)
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            RelayPushState.shared.token = token
            NotificationCenter.default.post(name: RelayPushState.tokenDidChange, object: token)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("Agent Relay push registration failed: %@", error.localizedDescription)
    }
}

@main struct AgentRelayiPadApp: App {
    @UIApplicationDelegateAdaptor(RelayAppDelegate.self) private var appDelegate
    var body: some Scene {
        WindowGroup { RelayWorkspaceView() }
    }
}
