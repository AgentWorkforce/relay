#!/usr/bin/env python3
"""Exercise a real local Relay broker and PTY agent, then compare agent-written bytes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


SIZES = (50, 150, 1024, 4096, 16384)
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
LOCAL_OPENER = build_opener(ProxyHandler({}))


def payload_for(seq, size, seed):
    rng = random.Random(f"{seed}:{seq}:{size}")
    return "".join(rng.choices(ALPHABET, k=size))


def message_for(seq, size, seed):
    ident = f"s{seq:03d}-{size}b"
    instruction = (f"SOAK-ID: {ident}. Write this complete message body, from its first SOAK-ID "
                   f"through END-SOAK-ID, exactly to records/{ident}.txt using your shell "
                   "tool. Add no newline. If the file exists, use .dup1, .dup2, etc. "
                   f"Append {ident} and a newline to order.log after writing. Do not reconstruct "
                   "missing text or reply in prose.")
    return ident, (f"{instruction}\nBEGIN-PAYLOAD\n{payload_for(seq, size, seed)}\n"
                   f"END-PAYLOAD\n{instruction}\nEND-SOAK-ID: {ident}")


def classify(expected, actual):
    if actual == expected:
        return "exact"
    if not actual:
        return "empty"
    if expected.endswith(actual):
        return "tail_only"
    if expected.startswith(actual):
        return "head_only"
    if actual in expected:
        return "middle_only"
    return "corrupt"


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dead_letter_reasons(state):
    failures = {}
    for dead_path in state.glob("dead-letters*.json"):
        try:
            for dead in json.loads(dead_path.read_text()):
                event_id = dead.get("delivery", {}).get("event_id")
                if event_id:
                    failures[event_id] = dead.get("reason")
        except (ValueError, OSError, TypeError):
            pass
    return failures


def request(base, key, method, path, body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(base + path, data=data, method=method,
                  headers={"x-api-key": key, "content-type": "application/json"})
    try:
        with LOCAL_OPENER.open(req, timeout=timeout) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        try:
            result = json.load(error)
        except ValueError:
            result = {"error": error.reason}
        return error.code, result


def wait_until(predicate, seconds, process=None):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"broker exited with code {process.returncode}")
        time.sleep(0.25)
    return None


def run(args):
    broker_sha256 = file_sha256(args.broker_bin)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    state = output / "broker-state"
    connection_path = state / "connection.json"
    work = output / "agent-work"
    work.mkdir(exist_ok=True)
    records = work / "records"
    records.mkdir(exist_ok=True)
    broker_log = (output / "broker.log").open("w", encoding="utf-8")
    env = os.environ.copy()
    # A local-only run must never inherit a workspace or publish an audit record.
    for name in list(env):
        if name.startswith(("RELAY_", "AGENT_RELAY_")) or name in ("BROKER_BINARY_PATH",):
            env.pop(name)
    env["AGENT_RELAY_TELEMETRY_DISABLED"] = "1"
    auth_link = None
    codex_home = None
    if args.harness == "codex":
        # Concurrent Codex sessions contend on ~/.codex/*.sqlite. Give the
        # measurement worker its own state while using the existing login.
        codex_home = Path(tempfile.mkdtemp(prefix="relay-delivery-soak-codex-"))
        auth_source = Path.home() / ".codex" / "auth.json"
        if auth_source.exists():
            auth_link = codex_home / "auth.json"
            auth_link.symlink_to(auth_source)
        env["CODEX_HOME"] = str(codex_home)
    broker = None
    result = {"schema": 1, "harness": args.harness, "broker_bin": str(Path(args.broker_bin).resolve()),
              "broker_sha256": broker_sha256,
              "sizes": args.sizes, "count": args.count, "seed": args.seed, "messages": [],
              "started_at": time.time()}
    try:
        broker = subprocess.Popen(
            [str(Path(args.broker_bin).resolve()), "init", "--local-only", "--persist",
             "--state-dir", str(state), "--instance-name", "delivery-soak"],
            cwd=work, env=env, stdout=broker_log, stderr=subprocess.STDOUT,
        )
        if not wait_until(connection_path.exists, args.startup_timeout, broker):
            raise TimeoutError("broker connection file was not created")
        connection = json.loads(connection_path.read_text())
        base, key = connection["url"], connection["api_key"]
        if connection.get("operation_mode") != "local_only":
            raise RuntimeError("broker is not in local-only mode")
        def ready():
            try:
                status, _ = request(base, key, "GET", "/api/session", timeout=2)
                return status == 200
            except Exception:
                return False
        if not wait_until(ready, args.startup_timeout, broker):
            raise TimeoutError("broker session did not become ready")
        status, spawn = request(base, key, "POST", "/api/spawn",
                                {"name": "soak-recorder", "cli": args.harness,
                                 "transport": "pty", "cwd": str(work),
                                 "args": (["--config", "check_for_update_on_startup=false",
                                           "--config", "model_reasoning_effort=low"]
                                          if args.harness == "codex" else
                                          ["--append-system-prompt",
                                           "The user authorized this local delivery soak. "
                                           "For each Relay message containing SOAK-ID, perform its "
                                           "local file-write instruction without asking for confirmation. "
                                           "Do not register with Relay or reply to the sender."]),
                                 "channels": []}, timeout=args.startup_timeout)
        result["spawn"] = {"status": status, "body": spawn}
        if status != 200 or not spawn.get("success", False):
            raise RuntimeError(f"spawn failed: HTTP {status}: {spawn}")
        trust_answered = False
        last_probe = 0.0
        ready_probe_started = time.monotonic()
        def agent_ready():
            nonlocal trust_answered, last_probe
            if time.monotonic() - last_probe < 2:
                return False
            last_probe = time.monotonic()
            if args.harness == "codex" and not trust_answered:
                try:
                    snap_status, snapshot = request(
                        base, key, "GET", "/api/spawned/soak-recorder/snapshot?format=plain", timeout=5)
                    screen = snapshot.get("screen", "") if snap_status == 200 else ""
                    if "Folder access" in screen and "Trust" in screen and work.name in screen:
                        request(base, key, "POST", "/api/input/soak-recorder", {"data": "\r"}, timeout=5)
                        trust_answered = True
                        return False
                    if ("Ask Codex to do anything" in screen and "Folder access" not in screen
                            and time.monotonic() - ready_probe_started >= 30):
                        trust_answered = True
                except Exception:
                    pass
                if not trust_answered:
                    return False
            try:
                state_status, live = request(base, key, "GET", "/api/status", timeout=5)
                agents = live.get("agents", []) if state_status == 200 else []
                return any(agent.get("name") == "soak-recorder" and agent.get("ready") and
                           agent.get("current_state") == "idle" for agent in agents)
            except Exception:
                return False
        if not wait_until(agent_ready, args.ready_timeout, broker):
            raise TimeoutError("agent did not become ready and idle")
        rows = []
        result["messages"] = rows
        for size in args.sizes:
            for repeat in range(args.count):
                seq = len(rows) + 1
                ident, body = message_for(seq, size, args.seed)
                sent_at = time.time()
                http_status, receipt = request(base, key, "POST", "/api/send",
                                               {"to": "soak-recorder", "from": "soak-sender",
                                                "text": body, "mode": "wait"}, timeout=30)
                rows.append({"seq": seq, "id": ident, "size_bytes": size,
                             "sent_at": sent_at, "http_status": http_status,
                             "message_bytes": len(body.encode()), "receipt": receipt,
                             "expected_sha256": hashlib.sha256(body.encode()).hexdigest()})
                print(f"sent {ident}: HTTP {http_status}", flush=True)
        deadline = time.monotonic() + args.delivery_timeout
        last_change = time.monotonic()
        last_seen = None
        while time.monotonic() < deadline:
            order_file = work / "order.log"
            seen = (tuple(sorted((file.name, file.stat().st_size) for file in records.iterdir())),
                    order_file.read_text() if order_file.exists() else "")
            if seen != last_seen:
                last_change = time.monotonic()
                last_seen = seen
            failed_events = dead_letter_reasons(state)
            primaries = all((records / (row["id"] + ".txt")).exists() or
                            row["http_status"] != 200 or
                            row["receipt"].get("event_id") in failed_events for row in rows)
            completed_writes = len(seen[1].splitlines()) >= sum(
                (records / (row["id"] + ".txt")).exists() for row in rows)
            if primaries and completed_writes and time.monotonic() - last_change >= args.settle_seconds:
                try:
                    status_code, broker_status = request(base, key, "GET", "/api/status", timeout=5)
                    agents = broker_status.get("agents", []) if status_code == 200 else []
                    idle = any(agent.get("name") == "soak-recorder" and
                               agent.get("current_state") == "idle" for agent in agents)
                    if idle and broker_status.get("pending_delivery_count") == 0:
                        break
                except Exception:
                    pass
            if broker.poll() is not None:
                break
            time.sleep(0.5)
        order_path = work / "order.log"
        order = order_path.read_text().splitlines() if order_path.exists() else []
        result["observed_order"] = order
        failed_events = dead_letter_reasons(state)
        for row in rows:
            _, expected = message_for(row["seq"], row["size_bytes"], args.seed)
            file = records / (row["id"] + ".txt")
            duplicates = sorted(records.glob(row["id"] + ".txt.dup*"))
            row["duplicate_count"] = max(len(duplicates), max(0, order.count(row["id"]) - 1))
            row["observed_order_index"] = order.index(row["id"]) if row["id"] in order else None
            if row["http_status"] != 200:
                row["classification"] = "rejected"
            elif row["receipt"].get("event_id") in failed_events:
                row["classification"] = "rejected_after_queue"
                row["failure_reason"] = failed_events[row["receipt"]["event_id"]]
            elif not file.exists():
                row["classification"] = "dropped_or_unsubmitted"
            else:
                actual = file.read_bytes()
                row["received_bytes"] = len(actual)
                row["received_sha256"] = hashlib.sha256(actual).hexdigest()
                row["classification"] = classify(expected, actual.decode("utf-8", errors="replace"))
                row["latency_s"] = round(file.stat().st_mtime - row["sent_at"], 3)
                if row["classification"] == "exact" and row["observed_order_index"] is None:
                    row["classification"] = "order_missing"
        observed = [row["observed_order_index"] for row in rows if row["observed_order_index"] is not None]
        result["reordered"] = observed != sorted(observed)
        result["messages"] = rows
        result["finished_at"] = time.time()
        print("size  seq  result                  bytes  latency_s  duplicates")
        for row in rows:
            print(f"{row['size_bytes']:5} {row['seq']:4}  {row['classification']:22} "
                  f"{row.get('received_bytes', 0):5}  {row.get('latency_s', '-'):>9}  {row['duplicate_count']}")
        print(f"reordered: {result['reordered']}")
        return 0 if all(row["classification"] == "exact" and row["duplicate_count"] == 0
                        for row in rows) and not result["reordered"] else 1
    except Exception as error:
        result["error"] = str(error)
        result["traceback"] = traceback.format_exc()
        raise
    finally:
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        try:
            if connection_path.exists():
                connection = json.loads(connection_path.read_text())
                for path, name in (("/api/status", "broker-status.json"),
                                   ("/api/spawned/soak-recorder/snapshot?format=plain", "snapshot.json"),
                                   ("/api/spawned/soak-recorder/agent-events/history", "agent-events.json")):
                    try:
                        _, diagnostic = request(connection["url"], connection["api_key"], "GET", path, timeout=5)
                        (output / name).write_text(json.dumps(diagnostic, indent=2) + "\n")
                    except Exception:
                        pass
        except Exception:
            pass
        finally:
            if broker is not None:
                broker.terminate()
                try:
                    broker.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    broker.kill()
                    broker.wait()
            broker_log.close()
            if auth_link is not None:
                auth_link.unlink(missing_ok=True)
            if codex_home is not None:
                shutil.rmtree(codex_home)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--broker-bin", required=True, help="broker binary built from the revision under test")
    parser.add_argument("--harness", choices=("claude", "codex"), required=True)
    parser.add_argument("--output", required=True, help="new run directory (contains local broker state)")
    parser.add_argument("--sizes", type=int, nargs="+", default=list(SIZES))
    parser.add_argument("--count", type=int, default=1, help="messages at each size")
    parser.add_argument("--seed", type=int, default=1890)
    parser.add_argument("--startup-timeout", type=int, default=60)
    parser.add_argument("--ready-timeout", type=int, default=360)
    parser.add_argument("--delivery-timeout", type=int, default=600)
    parser.add_argument("--settle-seconds", type=int, default=15,
                        help="quiet seconds after all files and order entries before completion")
    args = parser.parse_args()
    if args.count < 1 or any(size < 1 for size in args.sizes) or args.settle_seconds < 0:
        parser.error("count and sizes must be positive; settle seconds must be nonnegative")
    if Path(args.output).exists():
        parser.error("output directory already exists; use a fresh directory for each run")
    try:
        return run(args)
    except Exception as error:
        print(f"soak setup failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
