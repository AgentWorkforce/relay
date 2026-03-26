# @agent-relay/brand

Shared brand tokens, CSS variables, and color system for Agent Relay and associated properties.

This is a pure CSS package — no build step required.

## Usage

### Import in CSS (with a bundler)

```css
@import '@agent-relay/brand/brand.css';
```

### Link directly (HTML)

```html
<link rel="stylesheet" href="node_modules/@agent-relay/brand/brand.css">
```

### Static sites without a bundler

Copy `brand.css` into your project, or reference it via a CDN.

## Tokens

The file exposes CSS custom properties on `:root` for light mode and `:root[data-theme='dark']` for dark mode. Key token groups:

- **Logo** — `--logo-primary`, `--logo-secondary`
- **Brand accents** — `--accent-warm`, `--accent-ink`, `--accent-stone`
- **Status** — `--status-red`, `--status-yellow`, `--status-green`
- **Console / terminal** — `--console-bg`, `--console-fg`, etc.
- **Primary scale** — `--primary-50` through `--primary-950`
- **Secondary scale** — `--secondary-50` through `--secondary-950`
- **Neutral scale** — `--neutral-50` through `--neutral-950`
- **Semantic tokens** — `--bg`, `--fg`, `--primary`, `--card-bg`, `--nav-*`, `--footer-*`, etc.
