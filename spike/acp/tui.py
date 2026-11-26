#!/usr/bin/env python3
"""Launch an interactive MCode TUI in a pty, type one prompt, wait for the turn
to finish, then exit.

Used by spike/acp/spike.mjs to create a *manually launched* TUI session.
`script` is not installed on this machine, python3's pty module is used instead.

The screen is only used to know *when* to act: the prompt is typed once the
composer is there, and the wait ends when the turn is over. Whether the answer
is really there is proven by the log of the persisted session, never by the
screen.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

text = os.environ.get("TUI_TEXT", "Reply with exactly: TUI-PONG")
seconds = float(os.environ.get("TUI_SECONDS", "120"))
# the composer of the TUI: the prompt is typed once it is there
composer_marker = os.environ.get("TUI_COMPOSER_MARKER", "Ask Mcode to do anything")
# the TUI prints it when a turn is over
done_marker = os.environ.get("TUI_DONE_MARKER", "Completed in")

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp("mcode", ["mcode"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))

start = time.time()
sent = False
done = False
out = b""
while time.time() - start < seconds:
    readable, _, _ = select.select([fd], [], [], 0.5)
    if readable:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if done_marker.encode() in out:
            done = True
    elapsed = time.time() - start
    # the prompt is typed once the composer is there — a prompt typed into a
    # TUI that is still loading is lost
    if not sent and (composer_marker.encode() in out or elapsed > 20):
        os.write(fd, (text + "\r").encode())
        sent = True
    if done:
        # the turn is over: give the runtime a moment to persist the session
        time.sleep(2)
        break

# the TUI is quit the way a user quits it, so that the session is persisted
os.write(fd, b"\x03")
time.sleep(0.4)
os.write(fd, b"\x03")
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass

sys.stdout.write(out.decode("utf8", "replace"))
