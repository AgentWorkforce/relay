#!/usr/bin/env python3
"""Scoped outgoing Relaycast helper installed inside an existing replica."""
import argparse
import json
from pathlib import Path
import urllib.request
import urllib.error


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    send = commands.add_parser("send")
    send.add_argument("--to", required=True)
    send.add_argument("--text", required=True)
    args = parser.parse_args()
    config = json.loads((Path.home() / ".config/agent-relay-replicas/credentials.json").read_text())
    body = {"to": args.to, "text": args.text}
    req = urllib.request.Request(
        config["relay_url"] + "/v1/dm",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + config["agent_token"],
                 "Content-Type": "application/json", "User-Agent": "AgentRelay-Replicas/0.1"})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
            result = json.load(response)
        print(json.dumps(result))
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Relaycast returned HTTP {error.code}") from None
    except urllib.error.URLError:
        raise SystemExit("Relaycast could not be reached") from None


if __name__ == "__main__":
    main()
