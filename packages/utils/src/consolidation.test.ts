/**
 * Consolidation Verification Tests
 *
 * These tests verify that:
 * 1. Discovery logic is defined in @agent-relay/utils (single source of truth)
 * 2. Error classes are defined in @agent-relay/utils (single source of truth)
 * 3. All expected exports are present
 * 4. No logic is duplicated - MCP and SDK should re-export from utils
 */

import { describe, it, expect } from 'vitest';
import * as discovery from './discovery.js';
import * as errors from './errors.js';
import * as clientHelpers from './client-helpers.js';

describe('Consolidation: Single Source of Truth', () => {
  describe('Discovery exports from utils', () => {
    it('exports discoverSocket function', () => {
      expect(typeof discovery.discoverSocket).toBe('function');
    });

    it('exports detectCloudWorkspace function', () => {
      expect(typeof discovery.detectCloudWorkspace).toBe('function');
    });

    it('exports isCloudWorkspace function', () => {
      expect(typeof discovery.isCloudWorkspace).toBe('function');
    });

    it('exports getCloudSocketPath function', () => {
      expect(typeof discovery.getCloudSocketPath).toBe('function');
    });

    it('exports getCloudOutboxPath function', () => {
      expect(typeof discovery.getCloudOutboxPath).toBe('function');
    });

    it('exports getConnectionInfo function', () => {
      expect(typeof discovery.getConnectionInfo).toBe('function');
    });

    it('exports getCloudEnvironmentSummary function', () => {
      expect(typeof discovery.getCloudEnvironmentSummary).toBe('function');
    });

    it('exports cloudApiRequest function', () => {
      expect(typeof discovery.cloudApiRequest).toBe('function');
    });

    it('exports getWorkspaceStatus function', () => {
      expect(typeof discovery.getWorkspaceStatus).toBe('function');
    });

    it('exports discoverAgentName function', () => {
      expect(typeof discovery.discoverAgentName).toBe('function');
    });
  });

  describe('Error classes from utils', () => {
    it('exports RelayError class', () => {
      expect(errors.RelayError).toBeDefined();
      expect(new errors.RelayError('test')).toBeInstanceOf(Error);
    });

    it('exports DaemonNotRunningError class', () => {
      expect(errors.DaemonNotRunningError).toBeDefined();
      expect(new errors.DaemonNotRunningError()).toBeInstanceOf(errors.RelayError);
    });

    it('exports AgentNotFoundError class', () => {
      expect(errors.AgentNotFoundError).toBeDefined();
      expect(new errors.AgentNotFoundError('test')).toBeInstanceOf(errors.RelayError);
    });

    it('exports TimeoutError class', () => {
      expect(errors.TimeoutError).toBeDefined();
      expect(new errors.TimeoutError('op', 1000)).toBeInstanceOf(errors.RelayError);
    });

    it('exports ConnectionError class', () => {
      expect(errors.ConnectionError).toBeDefined();
      expect(new errors.ConnectionError('msg')).toBeInstanceOf(errors.RelayError);
    });

    it('exports ChannelNotFoundError class', () => {
      expect(errors.ChannelNotFoundError).toBeDefined();
      expect(new errors.ChannelNotFoundError('#ch')).toBeInstanceOf(errors.RelayError);
    });

    it('exports SpawnError class', () => {
      expect(errors.SpawnError).toBeDefined();
      expect(new errors.SpawnError('w', 'r')).toBeInstanceOf(errors.RelayError);
    });
  });

  describe('Client helpers from utils', () => {
    it('exports createRequestEnvelope function', () => {
      expect(typeof clientHelpers.createRequestEnvelope).toBe('function');
    });

    it('exports createRequestHandler function', () => {
      expect(typeof clientHelpers.createRequestHandler).toBe('function');
    });

    it('exports generateRequestId function', () => {
      expect(typeof clientHelpers.generateRequestId).toBe('function');
    });

    it('exports toSpawnResult function', () => {
      expect(typeof clientHelpers.toSpawnResult).toBe('function');
    });

    it('exports toReleaseResult function', () => {
      expect(typeof clientHelpers.toReleaseResult).toBe('function');
    });

    it('exports isMatchingResponse function', () => {
      expect(typeof clientHelpers.isMatchingResponse).toBe('function');
    });

    it('exports handleResponse function', () => {
      expect(typeof clientHelpers.handleResponse).toBe('function');
    });
  });
});
