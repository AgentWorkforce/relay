//! Fixed navigation destinations shared by the native apps.

vocabulary!(
    /// A fixed UI destination. Never a title, search query, endpoint or path.
    TelemetrySurface {
        Sessions = "sessions",
        Agents = "agents",
        Team = "team",
        Messages = "messages",
        Projects = "projects",
        SettingsGeneral = "settings_general",
        SettingsTools = "settings_tools",
        SettingsOpening = "settings_opening",
        SettingsRelay = "settings_relay",
        SettingsSharing = "settings_sharing",
        SettingsAccount = "settings_account",
        SettingsAbout = "settings_about",
        SettingsDiagnostics = "settings_diagnostics",
    }
);
