---
name: implementing-command-palettes
description: Use when building Cmd+K command palettes in React - covers keyboard navigation with arrow keys, keeping selected items in view with scrollIntoView, filtering with shortcut matching, and preventing infinite re-renders from reference instability
---

# Implementing Command Palettes

## Overview

Command palettes (Cmd+K / Ctrl+K) need precise keyboard navigation, scroll behavior, and stable references to avoid re-render loops. This skill covers the mechanical patterns that make command palettes feel responsive.

## When to Use

- Building a Cmd+K command palette in React
- Implementing arrow key navigation with visual selection
- Keeping selected items visible during keyboard navigation
- Filtering commands by label text AND keyboard shortcuts
- Experiencing infinite re-renders when commands update

## Quick Reference

| Feature | Implementation |
|---------|----------------|
| Arrow navigation | Track `selectedIndex`, clamp with `Math.min/max` |
| Keep in view | `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` |
| Shortcut matching | Strip spaces from shortcuts, match against query |
| Stable icons | Define icon elements outside component |
| Stable handlers | `useCallback` + `noop` constant for disabled states |

## Keyboard Navigation

### Index Management

```tsx
const [selectedIndex, setSelectedIndex] = useState(0);

useEffect(() => {
  if (!isOpen) return;

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        // Clamp to last item
        setSelectedIndex(prev => Math.min(prev + 1, filteredItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        // Clamp to first item
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          executeCommand(filteredItems[selectedIndex]);
          close();
        }
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [isOpen, filteredItems, selectedIndex, close]);
```

**Key patterns:**
- `e.preventDefault()` stops arrow keys from scrolling the page
- `Math.min/max` prevents index going out of bounds
- Effect depends on `filteredItems` so navigation updates when filter changes

### Reset Selection on Query Change

```tsx
<input
  value={query}
  onChange={e => {
    setQuery(e.target.value);
    setSelectedIndex(0);  // Reset to first item when query changes
  }}
/>
```

## Keeping Selected Item in View

### Using Refs Array

```tsx
const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

// Scroll effect - runs when selection changes
useEffect(() => {
  const selectedItem = itemRefs.current[selectedIndex];
  if (selectedItem) {
    selectedItem.scrollIntoView({
      block: 'nearest',    // Minimal scroll - only scroll if needed
      behavior: 'smooth'   // Smooth animation
    });
  }
}, [selectedIndex]);

// Assign refs in render
{filteredItems.map((item, index) => (
  <button
    key={index}
    ref={el => { itemRefs.current[index] = el; }}
    className={index === selectedIndex ? 'bg-blue-100' : ''}
  >
    {item.label}
  </button>
))}
```

### Alternative: Single Ref for Selected Item

```tsx
const selectedItemRef = useRef<HTMLButtonElement>(null);

useEffect(() => {
  if (isOpen && selectedItemRef.current) {
    selectedItemRef.current.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }
}, [isOpen, selectedIndex]);

// Only assign ref to selected item
<button
  ref={index === selectedIndex ? selectedItemRef : null}
>
```

**Why `block: 'nearest'`?**
- `'nearest'` only scrolls if the element is outside the visible area
- `'center'` would scroll even when item is already visible, causing jarring movement
- `'start'` or `'end'` would always align to top/bottom

## Filtering with Shortcut Matching

```tsx
const filteredCommands = commands.filter(command => {
  const q = query.toLowerCase().trim();
  if (!q) return true;

  // Standard label matching
  if (command.label.toLowerCase().includes(q)) return true;

  // Shortcut matching: "gd" matches "g d", "gb" matches "g b"
  if (command.shortcut) {
    const shortcutNoSpaces = command.shortcut.toLowerCase().replace(/\s+/g, '');
    if (shortcutNoSpaces.startsWith(q) || shortcutNoSpaces.includes(q)) {
      return true;
    }
  }

  // For numbered items (PRs, issues), match by number
  if (command.type === 'pr') {
    const numberMatch = q.match(/^#?(\d+)$/);
    if (numberMatch) {
      return String(command.pr.number).startsWith(numberMatch[1]);
    }
  }

  return false;
});
```

**Why strip spaces from shortcuts?**
Users type continuously without spaces. Shortcut `"g d"` should match when user types `"gd"`.

## Preventing Re-Render Loops

Command palettes often suffer from infinite re-renders when command objects are recreated every render.

### Problem: Unstable References

```tsx
// BAD: Icons recreated every render
function usePageCommands() {
  const commands = useMemo(() => [{
    label: 'Sync',
    icon: <RefreshCw size={16} />,  // New element every render!
    action: () => onSync(),          // New function every render!
  }], [onSync]);  // Even with deps, icon is new

  useRegisterCommands(commands);  // Triggers re-registration → re-render loop
}
```

### Solution: Stable References

```tsx
// GOOD: Icons defined OUTSIDE component
const refreshIcon = <RefreshCw size={16} />;
const refreshSpinIcon = <RefreshCw size={16} className="animate-spin" />;
const noop = () => {};

function usePageCommands({ onSync, isSyncing }: Props) {
  // Memoize handlers
  const handleSync = useCallback(() => onSync?.(), [onSync]);

  const commands = useMemo(() => [{
    label: isSyncing ? 'Syncing...' : 'Sync',
    icon: isSyncing ? refreshSpinIcon : refreshIcon,  // Stable references
    action: isSyncing ? noop : handleSync,             // noop, not undefined
  }], [isSyncing, handleSync]);

  useRegisterCommands(commands);
}
```

### Label-Based Change Detection

Instead of comparing object references, compare by labels:

```tsx
export function useRegisterCommands(commands: CommandItem[]) {
  const { registerCommands, unregisterCommands } = useCommandPalette();

  // Create stable ID based on LABELS, not object references
  const commandIds = useMemo(
    () => commands.map(c => {
      if (c.type === 'nav') return `nav:${c.path}`;
      return `action:${c.label}`;
    }).sort().join('|'),
    [commands]
  );

  const commandsRef = useRef<CommandItem[]>(commands);
  useEffect(() => { commandsRef.current = commands; });

  const prevIdsRef = useRef<string>('');

  useEffect(() => {
    // Only register if structure actually changed
    if (commandIds !== prevIdsRef.current) {
      registerCommands(commandsRef.current);
      prevIdsRef.current = commandIds;
      return () => unregisterCommands(commandsRef.current);
    }
  }, [commandIds, registerCommands, unregisterCommands]);
}
```

## Command Type Patterns

```tsx
type CommandItem =
  | { type: 'action'; label: string; icon?: React.ReactNode; action: () => void; shortcut?: string }
  | { type: 'nav'; label: string; icon?: React.ReactNode; path: string; shortcut?: string }
  | { type: 'file'; file: FileType; label: string; icon?: React.ReactNode }
  | { type: 'pr'; pr: PRType; label: string; icon?: React.ReactNode };

// Execute based on type
function executeCommand(command: CommandItem) {
  switch (command.type) {
    case 'action':
      command.action();
      break;
    case 'nav':
      navigate(command.path);
      break;
    case 'file':
      onFileSelect(command.file);
      break;
    case 'pr':
      navigate(`/repos/${command.owner}/${command.repo}/pulls/${command.pr.number}`);
      break;
  }
}
```

## Common Mistakes

| Mistake | Why It Fails | Fix |
|---------|--------------|-----|
| Icons inside useMemo | New icon element every render | Define icons as constants outside component |
| Not resetting index on filter | Arrow keys start from wrong position | `setSelectedIndex(0)` in onChange |
| `block: 'center'` in scrollIntoView | Jarring scroll when item already visible | Use `block: 'nearest'` |
| Missing `e.preventDefault()` | Arrow keys scroll page AND move selection | Add preventDefault for ArrowUp/Down |
| Forgetting cleanup in useEffect | Event listeners accumulate | Return cleanup function |
| `undefined` for disabled action | Type error or click does nothing | Use `noop` constant |

## Testing Checklist

- [ ] Cmd+K opens palette, Escape closes
- [ ] Arrow Down moves to next item (stops at last)
- [ ] Arrow Up moves to previous item (stops at first)
- [ ] Enter executes selected command and closes palette
- [ ] Selected item scrolls into view when navigating long lists
- [ ] Typing resets selection to first matching item
- [ ] Shortcuts like "gd" match commands with shortcut "g d"
- [ ] No console errors about re-renders or maximum update depth
