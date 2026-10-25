import Foundation

/// The core's settings as they will read once a change the person made is
/// saved: what Settings shows while `settings.set` is on its way. The Linux
/// app's `models::apply_settings_change` matches it.
public extension SettingsValues {
    /// Keys a change carries that are not settings of their own: one edits
    /// a watched folder in place, the other is a first-run default.
    static let overlaySkippedKeys: Set<String> = ["claude_config_dir", "direct_delivery_default"]

    /// These values with `change`'s fields written over them. A value the
    /// change does not name is kept; `spawn_harnesses` merges per harness.
    func applying(_ change: SettingsChange) -> SettingsValues {
        guard var values = Self.object(self), let fields = Self.object(change) else { return self }
        for (key, value) in fields where !Self.overlaySkippedKeys.contains(key) {
            if key == "spawn_harnesses", var current = values[key] as? [String: Any],
               let changed = value as? [String: Any] {
                for (harness, settings) in changed {
                    var merged = current[harness] as? [String: Any] ?? [:]
                    for (field, value) in settings as? [String: Any] ?? [:] { merged[field] = value }
                    current[harness] = merged
                }
                values[key] = current
            } else {
                values[key] = value
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: values),
              let applied = try? JSONDecoder().decode(SettingsValues.self, from: data) else { return self }
        return applied
    }

    private static func object<T: Encodable>(_ value: T) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

public extension SettingsChange {
    /// The settings this change sets, by their JSON key, in key order: what
    /// a pending marker and a row's error are kept under.
    var fields: [String] {
        guard let data = try? JSONEncoder().encode(self),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        return object.keys.sorted()
    }
}
