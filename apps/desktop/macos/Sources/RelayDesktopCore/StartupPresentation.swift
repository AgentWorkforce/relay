import Foundation

public enum StartupPresentation {
    public static let title = "Rounding up your agents"
    public static let messages = [
        "Herding cats, but the cats can code.",
        "Convincing everyone to use the same group chat.",
        "Untangling a few very ambitious to-do lists.",
        "Making room for one more agent. There’s always one more."
    ]
    public static let interval: TimeInterval = 4
    public static let timeoutMessage = "Your agents are taking longer to gather than expected. Try reconnecting the background service."
}
