#!/usr/bin/env python3
"""Run a command under a real PTY and tee its raw output to a file.

The attach clients (`view` / `drive`) behave differently when stdout is a TTY:
the status line is only painted on a TTY, the input-report filter only matters
when a real terminal would act on the reports, and `resetLocalTerminalOnDetach`
is TTY-gated. Driving them through a pipe therefore exercises a different code
path than the one a human sees, which is exactly the path the tic-tac-toe E2E
needs to assert on.

Usage:
    pty-run.py --out capture.bin [--cols 120] [--rows 40] -- cmd [args...]

Bytes written to this process's stdin are forwarded to the child PTY, so the
orchestrator can send keystrokes (Ctrl+C to detach, Ctrl+] to toggle delivery).
Every byte the child writes is appended to `--out` verbatim — no decoding, no
newline translation — so a terminal emulator can replay it faithfully.
"""

import argparse
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def reap(pid: int) -> "tuple[int, int]":
    """Wait for `pid` and translate its status to a shell-style exit code.

    Returns `(exit_code, remaining_pid)`; `remaining_pid` is 0 once reaped, so
    the caller's cleanup knows not to signal it again.
    """
    try:
        waited, status = os.waitpid(pid, 0)
    except ChildProcessError:
        return 0, 0
    if waited != pid:
        return 0, pid
    code = (
        os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
    )
    return code, 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("cmd", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    cmd = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not cmd:
        print("pty-run: no command given", file=sys.stderr)
        return 2

    pid, master = pty.fork()
    if pid == 0:
        # Child: a fresh session already owns the slave pty as its controlling
        # terminal. Advertise a capable terminal so TUIs emit the full escape
        # repertoire the filters are supposed to handle.
        os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
        os.environ["COLUMNS"] = str(args.cols)
        os.environ["LINES"] = str(args.rows)
        try:
            os.execvp(cmd[0], cmd)
        except OSError as exc:
            print(f"pty-run: exec {cmd[0]}: {exc}", file=sys.stderr)
            os._exit(127)

    set_winsize(master, args.rows, args.cols)

    out = open(args.out, "wb", buffering=0)
    stdin_fd = sys.stdin.fileno()
    stdin_open = True
    exit_code = 0

    try:
        while True:
            watch = [master] + ([stdin_fd] if stdin_open else [])
            try:
                readable, _, _ = select.select(watch, [], [], 0.25)
            except InterruptedError:
                continue

            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    # EIO is the normal "child closed the slave side" signal.
                    if exc.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    # EOF/EIO means the child closed the slave side. Reap it
                    # here so its status is not lost — otherwise a crashed
                    # attach client reports a clean exit and `finally` SIGTERMs
                    # an already-dead pid.
                    exit_code, pid = reap(pid)
                    break
                out.write(data)

            if stdin_open and stdin_fd in readable:
                try:
                    keys = os.read(stdin_fd, 65536)
                except OSError:
                    keys = b""
                if not keys:
                    stdin_open = False
                else:
                    os.write(master, keys)

            # Reap without blocking so a child that exits while we still have
            # buffered output does not strand the loop.
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                # Drain whatever is still sitting in the pty buffer. `os.read`
                # on the master only reports EOF once every slave fd is closed
                # — a grandchild that inherited the slave keeps it open, so an
                # unguarded read would park here instead of finishing the run.
                # Poll with a short timeout and stop as soon as it goes quiet.
                while True:
                    if not select.select([master], [], [], 0.1)[0]:
                        break
                    try:
                        rest = os.read(master, 65536)
                    except OSError:
                        break
                    if not rest:
                        break
                    out.write(rest)
                exit_code = (
                    os.WEXITSTATUS(status)
                    if os.WIFEXITED(status)
                    else 128 + os.WTERMSIG(status)
                )
                pid = 0
                break

    finally:
        out.close()
        if pid:
            # SIGTERM then a bounded wait: a child that ignores the signal must
            # not hang the E2E run, so escalate to SIGKILL after ~2s. Only the
            # post-SIGKILL reap is allowed to block — nothing survives that.
            try:
                os.kill(pid, signal.SIGTERM)
                for _ in range(20):
                    if os.waitpid(pid, os.WNOHANG)[0] == pid:
                        break
                    time.sleep(0.1)
                else:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except OSError:
                pass
        try:
            os.close(master)
        except OSError:
            pass

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
