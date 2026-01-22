#!/usr/bin/env python3
"""
Browser Agent Bridge for Agent Relay

This script bridges browser-use with the agent-relay file-based protocol.
It watches for incoming messages and executes browser automation tasks.

Usage:
    python browser_agent.py [--name NAME] [--headless] [--model MODEL]

Environment variables:
    AGENT_RELAY_NAME - Agent name (default: Browser)
    BROWSER_USE_MODEL - LLM model to use (default: gpt-4o)
    BROWSER_USE_HEADLESS - Run headless (default: true)
    OPENAI_API_KEY - OpenAI API key
    ANTHROPIC_API_KEY - Anthropic API key (alternative)
"""

import asyncio
import json
import os
import sys
import signal
import argparse
import tempfile
import traceback
from pathlib import Path
from typing import Optional
from datetime import datetime

# Check for browser-use installation
try:
    from browser_use import Agent
    from langchain_openai import ChatOpenAI
    from langchain_anthropic import ChatAnthropic
    BROWSER_USE_AVAILABLE = True
except ImportError:
    BROWSER_USE_AVAILABLE = False
    print("Warning: browser-use not installed. Install with: pip install browser-use langchain-openai langchain-anthropic", file=sys.stderr)


class RelayProtocol:
    """File-based relay protocol handler"""

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self.outbox_dir = Path(tempfile.gettempdir()) / "relay-outbox" / agent_name
        self.outbox_dir.mkdir(parents=True, exist_ok=True)

    def send_message(self, to: str, body: str, thread: Optional[str] = None):
        """Send a message via the relay file protocol"""
        msg_file = self.outbox_dir / "msg"

        content = f"TO: {to}\n"
        if thread:
            content += f"THREAD: {thread}\n"
        content += f"\n{body}"

        msg_file.write_text(content)
        # Output the trigger that the relay wrapper watches for
        print(f"->relay-file:msg", flush=True)

    def send_ack(self, to: str, description: str):
        """Send an acknowledgment"""
        self.send_message(to, f"ACK: {description}")

    def send_done(self, to: str, summary: str, details: Optional[str] = None):
        """Send completion message"""
        body = f"DONE: {summary}"
        if details:
            body += f"\n\n{details}"
        self.send_message(to, body)

    def send_error(self, to: str, error: str):
        """Send error message"""
        self.send_message(to, f"ERROR: {error}")


class BrowserAgentBridge:
    """Bridge between relay messages and browser-use"""

    def __init__(
        self,
        agent_name: str = "Browser",
        model: str = "gpt-4o",
        headless: bool = True,
        timeout: int = 300
    ):
        self.agent_name = agent_name
        self.model = model
        self.headless = headless
        self.timeout = timeout
        self.relay = RelayProtocol(agent_name)
        self.running = False
        self._current_task: Optional[asyncio.Task] = None

        # Initialize LLM
        self.llm = self._create_llm()

    def _create_llm(self):
        """Create the LLM instance based on available API keys"""
        if os.environ.get("ANTHROPIC_API_KEY"):
            return ChatAnthropic(model="claude-sonnet-4-20250514")
        elif os.environ.get("OPENAI_API_KEY"):
            return ChatOpenAI(model=self.model)
        else:
            raise ValueError(
                "No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY"
            )

    async def execute_task(self, task: str, sender: str, thread: Optional[str] = None) -> str:
        """Execute a browser automation task"""
        if not BROWSER_USE_AVAILABLE:
            return "ERROR: browser-use is not installed"

        try:
            # Create browser-use agent
            agent = Agent(
                task=task,
                llm=self.llm,
            )

            # Run the task with timeout
            result = await asyncio.wait_for(
                agent.run(),
                timeout=self.timeout
            )

            # Extract the final result
            if hasattr(result, 'final_result'):
                return result.final_result()
            return str(result)

        except asyncio.TimeoutError:
            return f"ERROR: Task timed out after {self.timeout} seconds"
        except Exception as e:
            return f"ERROR: {str(e)}\n{traceback.format_exc()}"

    def parse_message(self, raw_input: str) -> tuple[Optional[str], Optional[str], str]:
        """Parse incoming relay message

        Returns: (sender, thread, body)
        """
        lines = raw_input.strip().split('\n')
        sender = None
        thread = None
        body_start = 0

        # Parse headers
        for i, line in enumerate(lines):
            if line.startswith("FROM: "):
                sender = line[6:].strip()
            elif line.startswith("THREAD: "):
                thread = line[8:].strip()
            elif line == "":
                body_start = i + 1
                break
            else:
                # No more headers
                body_start = i
                break

        body = '\n'.join(lines[body_start:]).strip()
        return sender, thread, body

    async def handle_message(self, raw_input: str):
        """Handle an incoming message"""
        sender, thread, task = self.parse_message(raw_input)

        if not sender:
            print(f"Warning: Message without sender, using 'Unknown'", file=sys.stderr)
            sender = "Unknown"

        if not task:
            self.relay.send_error(sender, "Empty task received")
            return

        # Send acknowledgment
        self.relay.send_ack(sender, f"Starting browser task: {task[:50]}...")

        # Execute the task
        print(f"[{datetime.now().isoformat()}] Executing task from {sender}: {task[:100]}...", file=sys.stderr)
        result = await self.execute_task(task, sender, thread)

        # Send result
        if result.startswith("ERROR:"):
            self.relay.send_error(sender, result[7:])
        else:
            self.relay.send_done(sender, "Browser task completed", result)

    async def run_interactive(self):
        """Run in interactive mode, reading from stdin"""
        print(f"Browser agent '{self.agent_name}' ready.", file=sys.stderr)
        print(f"Model: {self.model}, Headless: {self.headless}", file=sys.stderr)
        print("Waiting for tasks via stdin or relay messages...", file=sys.stderr)

        self.running = True

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._handle_shutdown)

        # Read from stdin
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        buffer = ""
        while self.running:
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=1.0)
                if not line:
                    # EOF
                    break

                line = line.decode('utf-8')

                # Check for relay message format (injected by wrapper)
                if line.startswith("Relay message from "):
                    # Parse: "Relay message from Alice [abc123]: <content>"
                    # Extract sender and content
                    import re
                    match = re.match(r"Relay message from (\w+) \[([^\]]+)\](?:\s*\[#[^\]]+\])?: (.*)", line)
                    if match:
                        sender = match.group(1)
                        # msg_id = match.group(2)
                        content = match.group(3)
                        # Wrap in relay format
                        raw_msg = f"FROM: {sender}\n\n{content}"
                        await self.handle_message(raw_msg)
                elif line.strip():
                    # Accumulate for multi-line input
                    buffer += line

                    # Check if we have a complete message (empty line terminates)
                    if buffer.endswith("\n\n") or (buffer.strip() and not line.strip()):
                        await self.handle_message(buffer)
                        buffer = ""

            except asyncio.TimeoutError:
                continue
            except Exception as e:
                print(f"Error reading input: {e}", file=sys.stderr)

    def _handle_shutdown(self):
        """Handle shutdown signal"""
        print("\nShutting down browser agent...", file=sys.stderr)
        self.running = False
        if self._current_task:
            self._current_task.cancel()


def main():
    parser = argparse.ArgumentParser(description="Browser Agent for Agent Relay")
    parser.add_argument(
        "--name", "-n",
        default=os.environ.get("AGENT_RELAY_NAME", "Browser"),
        help="Agent name (default: Browser)"
    )
    parser.add_argument(
        "--model", "-m",
        default=os.environ.get("BROWSER_USE_MODEL", "gpt-4o"),
        help="LLM model to use (default: gpt-4o)"
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=os.environ.get("BROWSER_USE_HEADLESS", "true").lower() == "true",
        help="Run browser in headless mode"
    )
    parser.add_argument(
        "--timeout", "-t",
        type=int,
        default=int(os.environ.get("BROWSER_USE_TIMEOUT", "300")),
        help="Task timeout in seconds (default: 300)"
    )

    args = parser.parse_args()

    if not BROWSER_USE_AVAILABLE:
        print("Error: browser-use is not installed.", file=sys.stderr)
        print("Install with: pip install browser-use langchain-openai langchain-anthropic", file=sys.stderr)
        sys.exit(1)

    bridge = BrowserAgentBridge(
        agent_name=args.name,
        model=args.model,
        headless=args.headless,
        timeout=args.timeout
    )

    asyncio.run(bridge.run_interactive())


if __name__ == "__main__":
    main()
