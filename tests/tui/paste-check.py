#!/usr/bin/env python3
"""Paste into the real prompt on a pty and assert it does not run off with it.

THE BUG. `useInput` receives a chunk of text and looks for a newline inside it,
because piped input arrives that way. A terminal WITHOUT bracketed paste mode
delivers a paste through the very same channel, so the two were
indistinguishable: pasting six lines submitted the first and DISCARDED the other
five, silently. Paste a function and ask for a review, and the model answers
about the sentence, having never seen the function.

`usePaste` turns bracketed paste mode on (ESC[?2004h). The terminal then wraps a
paste in ESC[200~ … ESC[201~ and Ink routes it to the paste channel instead of
to `useInput`, which is what makes them distinguishable at last.

Three things have to hold at once:

  wrapped  a real paste lands in the box and submits NOTHING; Enter then sends
           the whole thing, newlines intact
  raw      an unwrapped chunk still submits, or piped and scripted input breaks
  big      a 400-line paste does not make the live region taller than the
           viewport, which is what makes Ink wipe the terminal every frame
           (see live-region.py)

    python3 paste-check.py
"""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PROBE = os.path.join(HERE, "paste-probe.mjs")
CLEAR = b"\x1b[2J\x1b[3J\x1b[H"
ROWS, COLS = 32, 110

SMALL = ("please review this function\n"
         "def f(xs):\n"
         "    total = 0\n"
         "    for x in xs:\n"
         "        total += x\n"
         "    return total\n")
BIG = "".join(f"line {i:04d} of a long pasted stack trace\n" for i in range(400))


def session(text, wrapped, press_enter=True):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(os.environ, FORCE_COLOR="1", TERM="xterm-256color")
    p = subprocess.Popen(["node", PROBE], stdin=slave, stdout=slave, stderr=slave,
                         env=env, cwd=ROOT, close_fds=True)
    os.close(slave)

    buf = bytearray()

    def pump(secs):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.05)
            if not r:
                continue
            try:
                d = os.read(master, 65536)
            except OSError:
                return
            if not d:
                return
            buf.extend(d)

    pump(1.5)
    mark = len(buf)
    payload = text.encode()
    if wrapped:
        payload = b"\x1b[200~" + payload + b"\x1b[201~"
    os.write(master, payload)
    pump(1.5)
    on_paste = bytes(buf[mark:])

    on_enter = b""
    if press_enter:
        mark2 = len(buf)
        os.write(master, b"\r")
        pump(1.2)
        on_enter = bytes(buf[mark2:])

    enabled = b"\x1b[?2004h" in bytes(buf)
    p.send_signal(signal.SIGTERM)
    pump(0.6)
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
    os.close(master)
    return on_paste, on_enter, enabled, bytes(buf)


def submissions(chunk):
    return [l for l in chunk.decode("utf8", "replace").split("\n") if "SUBMITTED:" in l]


fails = 0

# 1. a real terminal paste
on_paste, on_enter, enabled, _ = session(SMALL, wrapped=True)
sub_p, sub_e = submissions(on_paste), submissions(on_enter)
print(f"RESULT wrapped bracketed={enabled} on_paste={len(sub_p)} on_enter={len(sub_e)}")
if not enabled:
    print("FAIL the app never enabled bracketed paste mode")
    fails += 1
if sub_p:
    print(f"FAIL a paste submitted on its own: {sub_p[0].strip()[:90]}")
    fails += 1
if len(sub_e) != 1:
    print("FAIL Enter after a paste did not submit exactly once")
    fails += 1
else:
    body = sub_e[0]
    for needle in ("def f(xs):", "return total", "\\n"):
        if needle not in body:
            print(f"FAIL the submitted text lost {needle!r}: {body.strip()[:110]}")
            fails += 1

# 2. piped / scripted input must still submit on its newline
on_paste, _, _, _ = session(SMALL, wrapped=False, press_enter=False)
sub_p = submissions(on_paste)
print(f"RESULT raw on_paste={len(sub_p)}")
if len(sub_p) != 1:
    print("FAIL an unwrapped chunk no longer submits — piped input is broken")
    fails += 1

# 3. a big paste must not overflow the viewport
_, _, _, raw = session(BIG, wrapped=True, press_enter=False)
clears = raw.count(CLEAR)
print(f"RESULT big lines=400 clears={clears}")
if clears:
    print(f"FAIL a 400-line paste made Ink clear the terminal {clears} time(s)")
    fails += 1

print(f"DONE fails={fails}")
sys.exit(1 if fails else 0)
