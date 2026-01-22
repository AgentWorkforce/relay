# Browser Agent (browser-use integration)

This module integrates [browser-use](https://github.com/browser-use/browser-use) into agent-relay,
allowing any relay agent to request web automation tasks.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│   Agent A   │────>│   Relay     │────>│  BrowserAgent   │
│             │     │   Daemon    │     │  (this module)  │
└─────────────┘     └─────────────┘     └────────┬────────┘
                                                  │
                                         ┌────────┴────────┐
                                         │  browser-use    │
                                         │  (Python)       │
                                         └────────┬────────┘
                                                  │
                                         ┌────────┴────────┐
                                         │   Chromium      │
                                         └─────────────────┘
```

## Setup

1. Install Python dependencies:
   ```bash
   # Using uv (recommended)
   uv add browser-use
   uvx browser-use install

   # Or using pip
   pip install browser-use
   playwright install chromium
   ```

2. Set your LLM API key:
   ```bash
   export OPENAI_API_KEY=sk-...
   # or
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

## Usage

### Start a browser agent:

```bash
# Start the relay with a browser agent
agent-relay browser

# Or start standalone
agent-relay create-agent --name Browser python src/browser/python/browser_agent.py
```

### Send tasks from other agents:

Any relay agent can send tasks to the browser agent:

```
TO: Browser

Navigate to https://news.ycombinator.com and get the titles of the top 5 posts
```

### Message Format

**Request:**
```
TO: Browser
THREAD: optional-thread-id

<natural language task description>
```

**Response:**
```
DONE: <result summary>

<detailed results or extracted data>
```

## Configuration

Environment variables:
- `BROWSER_USE_MODEL` - LLM model to use (default: gpt-4o)
- `BROWSER_USE_HEADLESS` - Run browser headless (default: true)
- `BROWSER_USE_TIMEOUT` - Task timeout in seconds (default: 300)

## Examples

### Web scraping
```
TO: Browser

Go to https://example.com/products and extract all product names and prices into a JSON array
```

### Form filling
```
TO: Browser

Go to https://example.com/contact, fill in the form with:
- Name: John Doe
- Email: john@example.com
- Message: Hello, I have a question about your services
Then submit the form.
```

### Multi-step workflow
```
TO: Browser

1. Go to https://github.com
2. Search for "agent-relay"
3. Click on the first repository result
4. Get the star count and description
```
