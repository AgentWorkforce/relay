/**
 * Settings Types
 *
 * Dashboard settings types for appearance, notifications, display, and connection preferences.
 */

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  notifications: {
    enabled: boolean;
    sound: boolean;
    desktop: boolean;
    mentionsOnly: boolean;
  };
  display: {
    compactMode: boolean;
    showTimestamps: boolean;
    showAvatars: boolean;
    animationsEnabled: boolean;
  };
  messages: {
    autoScroll: boolean;
  };
  connection: {
    autoReconnect: boolean;
    reconnectDelay: number;
    keepAliveInterval: number;
  };
}

export const defaultSettings: Settings = {
  theme: 'system',
  notifications: {
    enabled: true,
    sound: true,
    desktop: false,
    mentionsOnly: false,
  },
  display: {
    compactMode: false,
    showTimestamps: true,
    showAvatars: true,
    animationsEnabled: true,
  },
  messages: {
    autoScroll: true,
  },
  connection: {
    autoReconnect: true,
    reconnectDelay: 3000,
    keepAliveInterval: 30000,
  },
};
