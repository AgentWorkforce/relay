import { describe, it, expect } from 'vitest';
import {
  RelayError,
  DaemonNotRunningError,
  AgentNotFoundError,
  TimeoutError,
  ConnectionError,
  ChannelNotFoundError,
  SpawnError,
} from './errors.js';

describe('Error Classes (single source of truth)', () => {
  describe('RelayError', () => {
    it('creates error with message', () => {
      const err = new RelayError('test error');
      expect(err.message).toBe('test error');
      expect(err.name).toBe('RelayError');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RelayError);
    });
  });

  describe('DaemonNotRunningError', () => {
    it('creates error with default message', () => {
      const err = new DaemonNotRunningError();
      expect(err.message).toContain('Relay daemon is not running');
      expect(err.name).toBe('DaemonNotRunningError');
      expect(err).toBeInstanceOf(RelayError);
    });

    it('creates error with custom message', () => {
      const err = new DaemonNotRunningError('Custom msg');
      expect(err.message).toBe('Custom msg');
    });
  });

  describe('AgentNotFoundError', () => {
    it('includes agent name in message', () => {
      const err = new AgentNotFoundError('MyAgent');
      expect(err.message).toContain('MyAgent');
      expect(err.name).toBe('AgentNotFoundError');
      expect(err).toBeInstanceOf(RelayError);
    });
  });

  describe('TimeoutError', () => {
    it('includes operation and timeout in message', () => {
      const err = new TimeoutError('spawn', 5000);
      expect(err.message).toContain('5000ms');
      expect(err.message).toContain('spawn');
      expect(err.name).toBe('TimeoutError');
      expect(err).toBeInstanceOf(RelayError);
    });
  });

  describe('ConnectionError', () => {
    it('includes connection details', () => {
      const err = new ConnectionError('refused');
      expect(err.message).toContain('refused');
      expect(err.name).toBe('ConnectionError');
      expect(err).toBeInstanceOf(RelayError);
    });
  });

  describe('ChannelNotFoundError', () => {
    it('includes channel name', () => {
      const err = new ChannelNotFoundError('#general');
      expect(err.message).toContain('#general');
      expect(err.name).toBe('ChannelNotFoundError');
      expect(err).toBeInstanceOf(RelayError);
    });
  });

  describe('SpawnError', () => {
    it('includes worker name and reason', () => {
      const err = new SpawnError('Worker1', 'out of resources');
      expect(err.message).toContain('Worker1');
      expect(err.message).toContain('out of resources');
      expect(err.name).toBe('SpawnError');
      expect(err).toBeInstanceOf(RelayError);
    });
  });
});
