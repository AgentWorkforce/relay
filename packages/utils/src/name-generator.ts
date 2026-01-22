/**
 * Auto-generate memorable agent names using adjective+noun combinations.
 * Inspired by mcp_agent_mail's approach.
 */

const ADJECTIVES = [
  'Blue', 'Green', 'Red', 'Purple', 'Golden', 'Silver', 'Crystal', 'Amber',
  'Coral', 'Jade', 'Ruby', 'Sapphire', 'Emerald', 'Onyx', 'Pearl', 'Copper',
  'Bronze', 'Iron', 'Steel', 'Velvet', 'Silk', 'Cotton', 'Linen', 'Marble',
  'Granite', 'Cobalt', 'Crimson', 'Azure', 'Indigo', 'Scarlet', 'Violet',
  'Olive', 'Teal', 'Cyan', 'Magenta', 'Ochre', 'Rustic', 'Misty', 'Stormy',
  'Sunny', 'Frosty', 'Dusty', 'Mossy', 'Rocky', 'Sandy', 'Snowy', 'Windy',
  'Swift', 'Calm', 'Bold', 'Brave', 'Clever', 'Eager', 'Gentle', 'Happy',
  'Jolly', 'Kind', 'Lively', 'Merry', 'Noble', 'Proud', 'Quick', 'Quiet',
];

const NOUNS = [
  'Mountain', 'River', 'Forest', 'Ocean', 'Valley', 'Canyon', 'Desert', 'Island',
  'Lake', 'Meadow', 'Prairie', 'Glacier', 'Volcano', 'Waterfall', 'Creek', 'Pond',
  'Hill', 'Peak', 'Ridge', 'Cliff', 'Cave', 'Reef', 'Marsh', 'Grove',
  'Fox', 'Wolf', 'Bear', 'Eagle', 'Hawk', 'Owl', 'Deer', 'Elk',
  'Falcon', 'Raven', 'Swan', 'Crane', 'Heron', 'Otter', 'Beaver', 'Badger',
  'Castle', 'Tower', 'Bridge', 'Harbor', 'Haven', 'Shelter', 'Beacon', 'Anchor',
  'Stone', 'Pebble', 'Boulder', 'Crystal', 'Gem', 'Prism', 'Spark', 'Ember',
  'Star', 'Moon', 'Sun', 'Comet', 'Cloud', 'Storm', 'Thunder', 'Lightning',
];

/**
 * Generate a random agent name (AdjectiveNoun format).
 */
export function generateAgentName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}${noun}`;
}

/**
 * Generate a unique agent name, checking against existing names.
 */
export function generateUniqueAgentName(existingNames: Set<string>, maxAttempts = 100): string {
  for (let i = 0; i < maxAttempts; i++) {
    const name = generateAgentName();
    if (!existingNames.has(name)) {
      return name;
    }
  }
  // Fallback: append random suffix
  return `${generateAgentName()}${Math.floor(Math.random() * 1000)}`;
}

/**
 * Validate an agent name (must be alphanumeric, 2-32 chars).
 */
export function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/.test(name);
}
