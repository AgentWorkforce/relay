---
paths:
  - "src/dashboard/**/*.tsx"
  - "src/dashboard/**/*.ts"
---

# React Dashboard Conventions

## Component Structure

- Use functional components with hooks exclusively
- Export named components (not default exports)
- Include JSDoc comment at top of component file describing purpose
- Props interface should be named `{ComponentName}Props` and defined above the component

## Styling

- Use Tailwind CSS classes directly in JSX
- Follow the project's design tokens from `tailwind.config.js`:
  - Colors: `bg-bg-deep`, `bg-bg-primary`, `text-text-primary`, `text-text-muted`, `accent-cyan`
  - Border: `border-border-subtle`, `border-sidebar-border`
  - Shadows: `shadow-glow-cyan`
- Group related Tailwind classes logically (layout, spacing, colors, states)
- Use template literals for conditional classes

## Hooks

- Custom hooks live in `./hooks/` directory
- Hook files should export a single hook as named export
- Hook names must start with `use` prefix
- Return object with descriptive property names for multiple values

## State Management

- Use `useState` for local component state
- Use `useCallback` for handlers passed to child components
- Use `useMemo` for expensive computations
- Use `useRef` for DOM references and values that shouldn't trigger re-renders

## Event Handlers

- Name handlers with `handle` prefix: `handleClick`, `handleSubmit`, `handleAgentSelect`
- Use `useCallback` for handlers to prevent unnecessary re-renders

## Types

- Import types from `../types` directory
- Use `type` imports: `import type { Agent, Message } from '../types'`
- Define component-specific types in the same file above the component

## API Calls

- Use the `api` module from `../lib/api` for HTTP requests
- Handle loading and error states appropriately
- Use `try/catch` for async operations

## Next.js App Router

- Pages using `useSearchParams()` MUST be wrapped in a `<Suspense>` boundary for static generation
- Pattern: Create a `{Page}Content` component that uses the hook, wrap it in `<Suspense>` in the default export
- Always provide a loading fallback component

```tsx
// Required pattern for useSearchParams
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function PageLoading() {
  return <div>Loading...</div>;
}

function PageContent() {
  const searchParams = useSearchParams();
  const param = searchParams.get('param');
  // ... component logic
}

export default function Page() {
  return (
    <Suspense fallback={<PageLoading />}>
      <PageContent />
    </Suspense>
  );
}
```

- See `app/cloud/link/page.tsx` and `app/login/page.tsx` for examples

## Common Patterns

```tsx
// Component structure example
import React, { useState, useCallback } from 'react';
import type { Agent } from '../types';

export interface MyComponentProps {
  agents: Agent[];
  onSelect: (agent: Agent) => void;
}

export function MyComponent({ agents, onSelect }: MyComponentProps) {
  const [selected, setSelected] = useState<Agent | null>(null);

  const handleSelect = useCallback((agent: Agent) => {
    setSelected(agent);
    onSelect(agent);
  }, [onSelect]);

  return (
    <div className="flex flex-col gap-2 p-4 bg-bg-primary">
      {/* Component JSX */}
    </div>
  );
}
```
