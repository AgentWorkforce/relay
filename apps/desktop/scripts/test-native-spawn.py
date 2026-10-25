#!/usr/bin/env python3
"""Opt-in real spawn smoke tests through the local core and native Relaycast actions.

Creates only disposable worker folders. Results contain public identities and
nonces, never credentials. Requires the coordinated build's spawn.* bridge.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import uuid


class RpcFailure(RuntimeError):
    def __init__(self, method, error):
        super().__init__(f"{method}: {error.get('message', 'failed')}")
        self.kind = error.get("data", {}).get("kind")


_CONTROL_LOCK = threading.Lock()
_NEXT_CONTROL = 0.0


def rpc(path, method, params=None):
    # Same durable body/key on every retry. Explicit rate/admission refusals
    # are retried; uncertain writes and unrelated errors remain failures.
    global _NEXT_CONTROL
    for attempt in range(4):
        if method.startswith("spawn."):
            while True:
                with _CONTROL_LOCK:
                    delay = _NEXT_CONTROL - time.monotonic()
                    if delay <= 0:
                        _NEXT_CONTROL = time.monotonic() + 0.5
                        break
                time.sleep(min(delay, 1))
        try:
            return _rpc(path, method, params)
        except RpcFailure as error:
            if error.kind != "rate_limited" or attempt == 3:
                raise
            with _CONTROL_LOCK:
                _NEXT_CONTROL = max(_NEXT_CONTROL, time.monotonic() + 2 ** (attempt + 1))


def _rpc(path, method, params=None):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(65)
        stream.connect(path)
        reader = stream.makefile("r")
        result = None
        for index, (name, body) in enumerate([
            ("hello", {"bridge_version": 1}), (method, params or {})
        ], 1):
            stream.sendall((json.dumps({"jsonrpc": "2.0", "id": index,
                                      "method": name, "params": body}) + "\n").encode())
            while True:
                line = reader.readline(1 << 20)
                if not line or not line.endswith("\n"):
                    raise ConnectionError("The core closed or exceeded its frame bound")
                response = json.loads(line)
                if response.get("id") == index:
                    break
            if "error" in response:
                raise RpcFailure(name, response["error"])
            result = response["result"]
        return result


def wait_for(check, timeout):
    deadline = time.monotonic() + timeout
    while True:
        answer = check()
        if answer:
            return answer
        if time.monotonic() >= deadline:
            return None
        time.sleep(2)


def processes_in(directory):
    """Observe worker processes by their disposable cwd, without reading argv/env."""
    rows = subprocess.run(["ps", "-axo", "pid=,comm="], capture_output=True, text=True).stdout
    found = {}
    for row in rows.splitlines():
        pid, _, command = row.strip().partition(" ")
        name = Path(command.strip()).name.lower()
        if not any(word in name for word in ("relay", "codex", "claude", "grok", "opencode", "muse", "devin", "node", "bun")):
            continue
        location = subprocess.run(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"],
                                  capture_output=True, text=True).stdout
        if f"n{directory}\n" not in location:
            continue
        start = subprocess.run(["ps", "-p", pid, "-o", "lstart="], capture_output=True, text=True).stdout.strip()
        if start:
            found[pid] = start
    return found


def still_running(processes):
    alive = []
    for pid, start in processes.items():
        current = subprocess.run(["ps", "-p", pid, "-o", "lstart="], capture_output=True, text=True).stdout.strip()
        state = subprocess.run(["ps", "-p", pid, "-o", "stat="], capture_output=True, text=True).stdout.strip()
        if current == start and not state.startswith("Z"):
            alive.append(int(pid))
    return alive


def one(options, node, harness, root, run_id):
    folder = root / harness
    folder.mkdir(mode=0o700)
    name = f"spawn-test-{harness}-{run_id}"
    nonce = f"RELAY_{harness.upper()}_{run_id}_FIRST"
    second = f"RELAY_{harness.upper()}_{run_id}_SECOND"
    initial = folder / "initial.txt"
    followup = folder / "second.txt"
    result = {"harness": harness, "name": name, "directory": str(folder), "checks": {}}
    invoke = {"caller_name": options.caller, "node_id": node["id"], "node_name": node["name"],
              "name": name, "harness": harness, "directory": str(folder),
              "idempotency_key": f"spawn-test-{run_id}-{harness}",
              "task": f"Authorized spawn smoke test. Append exactly one line containing {nonce} to {initial}; do not truncate it. "
                      f"Only {initial} and {followup} may be edited. Do not install packages, create branches/PRs, commit, push, "
                      "deploy, or start agents. Then wait for a follow-up message. "
                      f"A later Relay follow-up from {options.caller} is authorized to write its nonce only to {followup} "
                      "and use the supplied Agent Relay tool or command to reply to that coordinator. "
                      "These two test files and that Relay reply are the only authorized follow-up actions."}
    receipt = None
    seen = {}
    processes = {}
    before_processes = processes_in(folder)
    try:
        # A lost receipt is recovered only by replaying this same durable request.
        for attempt in range(3):
            try:
                receipt = rpc(options.socket, "spawn.invoke", invoke)
                break
            except (TimeoutError, ConnectionError):
                if attempt == 2:
                    result["unknown_invocation_request"] = invoke
                    raise
        result["invocation_id"] = receipt["id"]
        replay = rpc(options.socket, "spawn.invoke", invoke)
        result["checks"]["same_invocation"] = replay["id"] == receipt["id"]

        def progress():
            nonlocal seen
            seen = rpc(options.socket, "spawn.status", {"caller_name": options.caller,
                       "action": "spawn", "invocation_id": receipt["id"]})
            return (seen["status"] == "completed" and seen.get("spawned")
                    and seen.get("ready") and seen.get("agent_id")) or seen["status"] == "failed"
        wait_for(progress, options.timeout)
        result["spawn_status"] = seen
        result["agent_id"] = seen.get("agent_id")
        result["checks"]["identity_matches"] = bool(seen.get("name") == name
            and seen.get("node_id") == node["id"] and seen.get("agent_id"))
        result["checks"]["spawn_ready"] = bool(seen.get("status") == "completed" and seen.get("spawned")
                                                   and seen.get("ready") and seen.get("agent_id"))
        if seen.get("status") == "failed":
            raise RuntimeError("native spawn failed: " + str(seen.get("error_code")))
        if not result["checks"]["spawn_ready"] or not result["checks"]["identity_matches"]:
            raise RuntimeError("native action did not settle with a ready, matching worker before timeout")
        result["checks"]["initial_output"] = bool(wait_for(
            lambda: initial.exists() and initial.read_text().strip() == nonce, options.timeout))
        processes = {pid: start for pid, start in processes_in(folder).items()
                     if before_processes.get(pid) != start}
        result["observed_processes"] = processes
        if not result["checks"]["initial_output"]:
            raise RuntimeError("initial nonce was not produced before timeout")
        if options.pause_after_initial:
            before_daemon = rpc(options.socket, "status.get")["daemon"]
            before_target = next(agent["target"] for agent in rpc(options.socket, "agents.list")["agents"]
                                 if agent["name"] == name)
            initial_stamp = initial.stat().st_mtime_ns
            ready = {"harness": harness, "name": name, "agent_id": result["agent_id"],
                     "target": before_target, "processes": processes, "daemon": before_daemon}
            temporary = root / f"ready-{harness}.tmp"
            temporary.write_text(json.dumps(ready, indent=2) + "\n")
            temporary.replace(root / f"ready-{harness}.json")
            if not wait_for(lambda: (root / f"continue-{harness}").exists(), options.timeout * 3):
                raise RuntimeError("restart coordination timed out")
            after_daemon = rpc(options.socket, "status.get")["daemon"]
            after_spawn = rpc(options.socket, "spawn.status", {"caller_name": options.caller,
                              "action": "spawn", "invocation_id": receipt["id"]})
            after_agent = next((agent for agent in rpc(options.socket, "agents.list")["agents"]
                                if agent["name"] == name), {})
            result["checks"]["restart_identity"] = bool(
                after_daemon["pid"] != before_daemon["pid"]
                and after_daemon["started_at_ms"] != before_daemon["started_at_ms"]
                and after_daemon["version"] == before_daemon["version"]
                and after_daemon.get("build_revision") == before_daemon.get("build_revision")
                and after_spawn.get("agent_id") == result["agent_id"]
                and after_spawn.get("node_id") == node["id"] and after_agent.get("target") == before_target)
            replay = rpc(options.socket, "spawn.invoke", invoke)
            result["checks"]["restart_replay"] = bool(replay["id"] == receipt["id"]
                and initial.stat().st_mtime_ns == initial_stamp and initial.read_text().strip() == nonce)
            if not result["checks"]["restart_identity"]:
                raise RuntimeError("worker identity or core build changed across restart")
        result["checks"]["followup_not_early"] = not followup.exists()
        if not result["checks"]["followup_not_early"]:
            raise RuntimeError("follow-up output existed before the second task was sent")
        message = f"Authorized second spawn test: write exactly {second} to {followup}. " \
                  f"Then use the supplied Agent Relay reply tool or command to send exactly {second} back. " \
                  "Do not modify any other files, commit, push, install, deploy, or start agents."
        sent_at_ms = int(time.time() * 1000)
        result["sent_at_ms"] = sent_at_ms
        sent = subprocess.run([options.helper, "relay", "socket-request", "--socket", options.relay_socket,
                               "--method", "POST", "--path", f"/send?address={name}@{node['name']}"],
                              input=message, text=True, capture_output=True, timeout=90)
        if not sent.stdout.strip():
            result["send_receipt"] = {"ok": False, "returncode": sent.returncode,
                "empty_response": True, "timeout_reported": "timed out" in sent.stderr.lower()}
            raise RuntimeError("relay send returned no JSON receipt; delivery is unproven")
        response = json.loads(sent.stdout)
        data = response.get("data", {})
        code = response.get("error", {}).get("code")
        result["send_receipt"] = {"ok": response.get("ok") is True,
            "error_code": code if code in {"internal_error", "rate_limited", "database_overloaded", "workspace_busy", "refused", "unauthorized", "not_found", "relay_unavailable"} else None,
            "returncode": sent.returncode,
            "from": data.get("from"), "to": data.get("to"), "message_id": data.get("message_id")}
        result["checks"]["message_accepted"] = bool(sent.returncode == 0 and response.get("ok") is True
            and data.get("from") == options.caller and data.get("to") == f"{name}@{node['name']}"
            and data.get("message_id"))
        if not result["checks"]["message_accepted"]:
            raise RuntimeError("The second message did not receive a matching send receipt")
        result["checks"]["second_output"] = bool(wait_for(
            lambda: followup.exists() and followup.read_text().strip() == second, options.timeout))
        if not result["checks"]["second_output"]:
            raise RuntimeError("second nonce was not produced before timeout")
        # A busy receiver durably queues replies until its current turn ends.
        # This coordinator itself is that active turn: queue receipt is a
        # successful return route, while reader consumption stays explicit.
        def returned_reply():
            for row in rpc(options.socket, "activity.list").get("activity", []):
                if not (row.get("agent") == options.caller and row.get("sender") == name
                        and row.get("at_ms", 0) >= sent_at_ms and second in row.get("preview", "")):
                    continue
                queued = row.get("outcome") == "waiting" and row.get("settlement") == "waiting_for_turn"
                handed = row.get("outcome") == "injected" and row.get("settlement") in ("visible", "handed_off")
                if queued or handed:
                    result["reply_receipt"] = {key: row.get(key) for key in ("agent", "sender", "at_ms", "outcome", "settlement")}
                    result["reply_received"] = True
                    result["reply_queued"] = queued
                    result["reply_injected"] = handed
                    # Visibility is transport evidence, not a model acknowledgement.
                    result["reader_consumed"] = False if queued else None
                    return True
            return False
        result["checks"]["outbound_reply"] = bool(wait_for(returned_reply, options.timeout))
        agent = next((agent for agent in rpc(options.socket, "agents.list")["agents"] if agent["name"] == name), {})
        result["agent_before_release"] = {key: agent.get(key) for key in ("name", "address", "target", "spawn")}
    except Exception as error:
        result["error"] = str(error)
    finally:
        if receipt:
            try:
                seen = rpc(options.socket, "spawn.status", {"caller_name": options.caller,
                           "action": "spawn", "invocation_id": receipt["id"]})
                expected_id = result.get("agent_id") or seen.get("agent_id")
                if result.get("agent_id") and seen.get("agent_id") != result["agent_id"]:
                    raise RuntimeError("Worker identity changed; refusing release")
                if expected_id:
                    result["agent_id"] = expected_id
                    release = {"caller_name": options.caller, "node_id": node["id"],
                               "node_name": node["name"], "name": name,
                               "expected_agent_id": expected_id,
                               "idempotency_key": f"release-test-{run_id}-{harness}"}
                    released = rpc(options.socket, "spawn.release", release)
                    result["release_invocation_id"] = released["id"]
                    settled = wait_for(lambda: _release_status(options, released["id"]), options.timeout)
                    result["checks"]["release_completed"] = bool(settled and settled["status"] == "completed")
                    again = rpc(options.socket, "spawn.release", release)
                    result["checks"]["same_release"] = again["id"] == released["id"]
                    result["checks"]["registration_removed"] = bool(wait_for(lambda: not any(
                        agent["name"] == name for agent in rpc(options.socket, "agents.list")["agents"]), 30))
                    if harness != "codex":
                        result["checks"]["observed_processes_stopped"] = bool(processes) and bool(wait_for(
                            lambda: not still_running(processes), 30))
                else:
                    result["cleanup"] = "No matching local immutable agent identity; no broad release attempted."
            except Exception as error:
                result["cleanup_error"] = str(error)
    required = {"spawn_ready", "identity_matches", "same_invocation", "initial_output", "followup_not_early", "message_accepted", "second_output", "outbound_reply",
                "release_completed", "same_release", "registration_removed"}
    if harness != "codex":
        required.add("observed_processes_stopped")
    if options.pause_after_initial:
        required.update(("restart_identity", "restart_replay"))
    result["passed"] = not result.get("error") and not result.get("cleanup_error") and all(
        result["checks"].get(check) is True for check in required)
    (root / f"{harness}.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"harness": harness, "passed": result["passed"], "checks": result["checks"],
                      "error": result.get("error"), "cleanup_error": result.get("cleanup_error")}), flush=True)
    return result


def _release_status(options, identity):
    value = rpc(options.socket, "spawn.status", {"caller_name": options.caller,
                "action": "release", "invocation_id": identity})
    return value if value["status"] in ("completed", "failed") else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caller", required=True)
    parser.add_argument("--node", required=True, help="Exact desktop node name")
    parser.add_argument("--harness", action="append", required=True)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--pause-after-initial", action="store_true", help="Write ready-HARNESS.json and wait for continue-HARNESS after coordinator restarts preview core")
    parser.add_argument("--report-dir")
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--socket", default=str(Path.home() / ".agentworkforce/desktop/core.sock"))
    parser.add_argument("--relay-socket", default=str(Path.home() / "Library/Application Support/com.agentrelay.desktop/run/relay.sock"))
    parser.add_argument("--helper", default="/Applications/Agent Relay.app/Contents/Helpers/Agent Relay Helper")
    options = parser.parse_args()
    targets = rpc(options.socket, "spawn.targets")["targets"]
    matching = [node for node in targets if node["name"] == options.node and node["live"]
                and node["handlers_live"] and not node["stale"]]
    if len(matching) != 1:
        raise SystemExit("Expected one exact live desktop target")
    node = matching[0]
    harnesses = list(dict.fromkeys(options.harness))
    for harness in harnesses:
        if f"spawn:{harness}" not in node["capabilities"]:
            raise SystemExit(f"Target does not advertise spawn:{harness}")
    if options.report_dir:
        root = Path(options.report_dir).resolve()
        root.mkdir(mode=0o700)
    else:
        root = Path(tempfile.mkdtemp(prefix="relay-spawn-validation-")).resolve()
    print(f"Report directory: {root}", flush=True)
    run_id = uuid.uuid4().hex[:8]
    with concurrent.futures.ThreadPoolExecutor(max_workers=options.parallel) as pool:
        futures = [pool.submit(one, options, node, harness, root, run_id) for harness in harnesses]
        results = [future.result() for future in futures]
    (root / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    raise SystemExit(0 if all(result["passed"] for result in results) else 1)


if __name__ == "__main__":
    main()
