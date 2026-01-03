---
name: browser-testing-with-screenshots
description: Use when testing web applications with visual verification - automates Chrome browser interactions, element selection, and screenshot capture for confirming UI functionality
---

# Browser Testing with Screenshots

## Overview

**Automate Chrome browser testing with visual verification using browser-tools.** Connect to Chrome DevTools Protocol for navigation, interaction, and screenshot capture to confirm application functionality.

## Prerequisites

**REQUIRED:** Install agent-tools from https://github.com/badlogic/agent-tools

```bash
# Clone and install agent-tools
git clone https://github.com/badlogic/agent-tools.git
cd agent-tools
# Follow installation instructions in the repository
# Ensure all executables (browser-start.js, browser-nav.js, etc.) are in your PATH
```

**Verify installation:**
```bash
# Check that browser tools are available
which browser-start.js
which browser-nav.js
which browser-screenshot.js
```

All browser-* commands referenced in this skill come from the agent-tools repository and must be properly installed and accessible in your system PATH.

## When to Use

**Use this skill when:**
- Testing web application UI flows
- Verifying visual changes or layouts
- Automating repetitive browser interactions
- Documenting application behavior with screenshots
- Testing localhost applications during development
- Need to interact with elements that require human-like selection

**Don't use for:**
- API testing (use direct HTTP calls)
- Headless testing where visuals don't matter
- Simple page content validation (use curl/wget)

## Quick Reference

| Task | Command | Purpose |
|------|---------|---------|
| Start browser | `browser-start.js` | Launch Chrome with debugging |
| Navigate | `browser-nav.js http://localhost:5172/dashboard` | Go to specific URL |
| Take screenshot | `browser-screenshot.js` | Capture current viewport |
| Pick elements | `browser-pick.js "Select the login button"` | Interactive element selection |
| Run JavaScript | `browser-eval.js 'document.title'` | Execute code in page context |
| Extract content | `browser-content.js` | Get readable page content |
| View cookies | `browser-cookies.js` | List session cookies |

## Setup and Basic Workflow

### 1. Start Chrome with Remote Debugging

```bash
# Launch Chrome with debugging enabled (preserves user profile)
browser-start.js

# Or start fresh (no cookies, clean state)
browser-start.js --fresh
```

**Expected Result**: Chrome opens on port 9222 with DevTools Protocol enabled

### 2. Navigate to Application

```bash
# Go to your application starting point
browser-nav.js http://localhost:5172/dashboard
```

**Verify**: Browser navigates to dashboard page

### 3. Capture Baseline Screenshot

```bash
# Take initial screenshot to confirm page loaded
browser-screenshot.js
```

**Output**: Returns path to screenshot file (e.g., `screenshot_20231203_141532.png`)

## Testing Workflow with Screenshots

### Complete Test Scenario Example

```bash
#!/bin/bash
# Test login and dashboard functionality

echo "🚀 Starting browser test..."

# 1. Launch browser
browser-start.js --fresh

# 2. Navigate to login page
browser-nav.js http://localhost:5172/login
sleep 2

# 3. Take screenshot of login page
LOGIN_SHOT=$(browser-screenshot.js)
echo "📸 Login page: $LOGIN_SHOT"

# 4. Fill login form (interactive element picking)
browser-pick.js "Click the username field"
browser-eval.js 'document.activeElement.value = "testuser"'

browser-pick.js "Click the password field"
browser-eval.js 'document.activeElement.value = "password123"'

# 5. Screenshot filled form
FORM_SHOT=$(browser-screenshot.js)
echo "📸 Filled form: $FORM_SHOT"

# 6. Submit form
browser-pick.js "Click the login button"
sleep 3

# 7. Verify dashboard loaded
browser-nav.js http://localhost:5172/dashboard
DASHBOARD_SHOT=$(browser-screenshot.js)
echo "📸 Dashboard: $DASHBOARD_SHOT"

# 8. Verify specific dashboard elements
browser-pick.js "Select the navigation menu"
browser-eval.js 'console.log("Navigation found:", !!document.querySelector(".nav"))'

echo "✅ Test complete. Screenshots saved."
```

### Element Interaction Pattern

```bash
# Interactive element selection (best for dynamic content)
browser-pick.js "Select the submit button"
# User clicks element in browser → returns CSS selector

# Use returned selector for automation
SELECTOR=$(browser-pick.js "Select the submit button" | grep "selector:")
browser-eval.js "document.querySelector('$SELECTOR').click()"

# Take screenshot to verify action
browser-screenshot.js
```

## Advanced Usage

### JavaScript Evaluation for Complex Interactions

```bash
# Check if element exists before interaction
browser-eval.js 'document.querySelector("#login-form") !== null'

# Wait for dynamic content
browser-eval.js '
  new Promise(resolve => {
    const check = () => {
      if (document.querySelector(".loaded")) resolve(true);
      else setTimeout(check, 100);
    };
    check();
  })
'

# Extract form data
browser-eval.js 'JSON.stringify(Object.fromEntries(new FormData(document.querySelector("form"))))'
```

### Screenshot with Timing

```bash
# Navigate and wait before screenshot
browser-nav.js http://localhost:5172/slow-page
sleep 5  # Wait for animations/loading
browser-screenshot.js
```

### Content Extraction for Verification

```bash
# Get page title
PAGE_TITLE=$(browser-eval.js 'document.title')
echo "Current page: $PAGE_TITLE"

# Extract readable content
browser-content.js > page_content.md

# Check for specific text
browser-eval.js 'document.body.textContent.includes("Welcome to Dashboard")'
```

## Common Mistakes

| Mistake | Problem | Solution |
|---------|---------|----------|
| No sleep after navigation | Screenshots of loading page | Add `sleep 2-5` after nav |
| Hardcoded selectors | Breaks when UI changes | Use `browser-pick.js` for selection |
| Missing Chrome setup | "Connection refused" errors | Run `browser-start.js` first |
| Wrong localhost port | Navigation fails | Verify application is running on correct port |
| Screenshot timing | Captures before content loads | Wait for page load or specific elements |
| Not preserving state | Login lost between commands | Use default profile, not `--fresh` |

## Error Handling

```bash
# Check if Chrome is running
if ! browser-eval.js 'true' 2>/dev/null; then
  echo "❌ Chrome not connected. Running browser-start.js..."
  browser-start.js
fi

# Verify navigation succeeded
if browser-eval.js 'location.href.includes("dashboard")'; then
  echo "✅ Navigation successful"
else
  echo "❌ Navigation failed"
  exit 1
fi
```

## File Output Patterns

- **Screenshots**: `screenshot_YYYYMMDD_HHMMSS.png` in current directory
- **Content**: Markdown format via stdout from `browser-content.js`
- **Selectors**: CSS selectors from `browser-pick.js` interaction
- **JavaScript results**: JSON or string values from `browser-eval.js`

## Integration with Testing Frameworks

```bash
# Create test evidence directory
mkdir -p test-results/$(date +%Y%m%d_%H%M%S)
cd test-results/$(date +%Y%m%d_%H%M%S)

# Run tests with organized screenshots
browser-start.js
for page in login dashboard profile; do
  browser-nav.js "http://localhost:5172/$page"
  sleep 2
  screenshot=$(browser-screenshot.js)
  mv "$screenshot" "${page}_page.png"
  echo "✅ $page page tested"
done
```

## Real-World Impact

**Benefits:**
- **Visual verification**: Screenshots provide immediate feedback on UI state
- **Interactive debugging**: Element picker works with dynamic/complex selectors
- **State preservation**: Maintains login sessions between commands
- **Evidence collection**: Automated screenshot capture for test documentation
- **Development workflow**: Quick verification of localhost changes

**Results:**
- Faster UI testing iteration (visual confirmation vs manual checking)
- Reliable element selection (human picks, automation uses)
- Test documentation with visual proof
- Catches visual regressions immediately

---

**Key principle:** Combine automated navigation with human element selection for robust, maintainable browser testing.
