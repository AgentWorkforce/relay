/**
 * Cloud Message Bus - Event-based message delivery for cloud users.
 *
 * This module provides a simple pub/sub mechanism for delivering messages
 * to users connected via the cloud dashboard. The daemons API publishes
 * messages here, and the presence WebSocket handler subscribes to deliver them.
 */

import { EventEmitter } from 'events';

export interface CloudMessage {
  from: {
    daemonId: string;
    daemonName: string;
    agent: string;
  };
  to: string;
  body: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

class CloudMessageBus extends EventEmitter {
  /**
   * Send a message to a cloud user
   */
  sendToUser(username: string, message: CloudMessage): void {
    this.emit('user-message', { username, message });
  }
}

// Singleton instance
export const cloudMessageBus = new CloudMessageBus();
