import { describe, it, expect } from 'vitest';
import {
  parseAgentHierarchy,
  getAgentPrefix,
  getAgentColor,
  getAgentInitials,
  groupAgentsByPrefix,
  sortAgentsByHierarchy,
  STATUS_COLORS,
} from './colors.js';

describe('colors', () => {
  describe('parseAgentHierarchy', () => {
    it('parses single-level name', () => {
      expect(parseAgentHierarchy('Lead')).toEqual(['lead']);
    });

    it('parses two-level name', () => {
      expect(parseAgentHierarchy('backend-api')).toEqual(['backend', 'api']);
    });

    it('parses three-level name', () => {
      expect(parseAgentHierarchy('frontend-ui-components')).toEqual([
        'frontend',
        'ui',
        'components',
      ]);
    });

    it('handles uppercase names', () => {
      expect(parseAgentHierarchy('Backend-API')).toEqual(['backend', 'api']);
    });

    it('handles empty string', () => {
      expect(parseAgentHierarchy('')).toEqual([]);
    });
  });

  describe('getAgentPrefix', () => {
    it('returns first segment for hyphenated name', () => {
      expect(getAgentPrefix('backend-api-auth')).toBe('backend');
    });

    it('returns lowercase name for single segment', () => {
      expect(getAgentPrefix('Lead')).toBe('lead');
    });

    it('handles empty string', () => {
      expect(getAgentPrefix('')).toBe('');
    });
  });

  describe('getAgentColor', () => {
    it('returns predefined color for known prefix', () => {
      const color = getAgentColor('backend-api');
      expect(color.primary).toBe('#1264a3'); // Blue for backend
    });

    it('returns predefined color for frontend prefix', () => {
      const color = getAgentColor('frontend-ui');
      expect(color.primary).toBe('#7c3aed'); // Purple for frontend
    });

    it('returns predefined color for lead prefix', () => {
      const color = getAgentColor('lead-main');
      expect(color.primary).toBe('#2bac76'); // Green for lead
    });

    it('returns consistent fallback color for unknown prefix', () => {
      const color1 = getAgentColor('custom-agent');
      const color2 = getAgentColor('custom-other');
      // Same prefix should get same color
      expect(color1).toEqual(color2);
    });

    it('returns different colors for different unknown prefixes', () => {
      const color1 = getAgentColor('alpha-agent');
      const color2 = getAgentColor('beta-agent');
      // Different prefixes should likely get different colors
      // (not guaranteed due to hash collisions, but likely)
      expect(color1.primary).not.toBe(color2.primary);
    });

    it('includes all required color properties', () => {
      const color = getAgentColor('any-agent');
      expect(color).toHaveProperty('primary');
      expect(color).toHaveProperty('light');
      expect(color).toHaveProperty('dark');
      expect(color).toHaveProperty('text');
    });
  });

  describe('getAgentInitials', () => {
    it('returns first two letters for single segment', () => {
      expect(getAgentInitials('Lead')).toBe('LE');
    });

    it('returns first letter of each segment for two segments', () => {
      expect(getAgentInitials('backend-api')).toBe('BA');
    });

    it('returns first letter of first two segments for three segments', () => {
      expect(getAgentInitials('frontend-ui-components')).toBe('FU');
    });

    it('handles single character segments', () => {
      expect(getAgentInitials('a-b-c')).toBe('AB');
    });
  });

  describe('groupAgentsByPrefix', () => {
    it('groups agents by their prefix', () => {
      const agents = [
        { name: 'backend-api' },
        { name: 'backend-db' },
        { name: 'frontend-ui' },
        { name: 'Lead' },
      ];

      const groups = groupAgentsByPrefix(agents);

      expect(groups.get('backend')).toHaveLength(2);
      expect(groups.get('frontend')).toHaveLength(1);
      expect(groups.get('lead')).toHaveLength(1);
    });

    it('handles empty array', () => {
      const groups = groupAgentsByPrefix([]);
      expect(groups.size).toBe(0);
    });
  });

  describe('sortAgentsByHierarchy', () => {
    it('sorts agents by prefix then by name', () => {
      const agents = [
        { name: 'frontend-ui' },
        { name: 'backend-db' },
        { name: 'backend-api' },
        { name: 'Lead' },
      ];

      const sorted = sortAgentsByHierarchy(agents);

      expect(sorted.map((a) => a.name)).toEqual([
        'backend-api',
        'backend-db',
        'frontend-ui',
        'Lead',
      ]);
    });

    it('does not mutate original array', () => {
      const agents = [{ name: 'z-agent' }, { name: 'a-agent' }];
      const original = [...agents];

      sortAgentsByHierarchy(agents);

      expect(agents).toEqual(original);
    });
  });

  describe('STATUS_COLORS', () => {
    it('has all required status colors', () => {
      expect(STATUS_COLORS.online).toBeDefined();
      expect(STATUS_COLORS.offline).toBeDefined();
      expect(STATUS_COLORS.busy).toBeDefined();
      expect(STATUS_COLORS.error).toBeDefined();
      expect(STATUS_COLORS.attention).toBeDefined();
    });

    it('uses green for online status', () => {
      expect(STATUS_COLORS.online).toBe('#22c55e');
    });
  });
});
