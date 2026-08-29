#!/usr/bin/env python3
"""Stream a long reply into the real App on a pty of a known size; count clears.

The bug this pins: Ink writes `clearTerminal + fullStaticOutput + frame` — erase
the screen, erase the SCROLLBACK, home the cursor, replay the entire session —
whenever a frame is taller than the viewport (ink.js `shouldClearTerminalForFrame`,
`nextOutputHeight > viewportRows`). The streaming reply was the only thing in the
live region with no ceiling, and the animation tick is 80ms, so a reply longer
than ~18 lines wiped and redrew the terminal a dozen times a turn. On a 110x32
pty, before the fix:

    reply lines   16   17   18   20   24   30   40
    clearTerminal  0    0    1    2    4    7   12

The assertion is simply that the count is zero, at every size, for a reply far
longer than any viewport. Raw byte counting is enough here: `clearTerminal` is
unambiguous and there is no other reason for it to appear mid-turn.

    python3 live-region.py            # prints RESULT lines, exits 1 on failure
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
PROBE = os.path.join(HERE, "live-region-probe.mjs")
ROOT = os.path.dirname(os.path.dirname(HERE))
CLEAR = b"\x1b[2J\x1b[3J\x1b[H"

# Sizes chosen to bracket real terminals: a small default, a laptop pane, a
# maximised window, and one deliberately shorter than the chrome budget.
SIZES = [(32, 110), (24, 80), (20, 60), (16, 40), (50, 200)]
LINES = int(os.environ.get("PROBE_LINES", "120"))


def run(rows, cols):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    env = dict(os.environ, PROBE_LINES=str(LINES), PROBE_CHUNK_MS="10",
               FORCE_COLOR="1", TERM="xterm-256color")
    p = subprocess.Popen(["node", PROBE], stdin=slave, stdout=slave, stderr=slave,
                         env=env, cwd=os.path.dirname(os.path.dirname(HERE)),
                         close_fds=True)
    os.close(slave)

    buf = bytearray()

    def pump(deadline):
        while time.time() < deadline:
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

    pump(time.time() + 1.5)
    os.write(master, b"hello\r")
    pump(time.time() + LINES * 0.012 + 2.5)
    p.send_signal(signal.SIGTERM)
    pump(time.time() + 1.0)
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
    os.close(master)
    return bytes(buf)


fails = 0
for rows, cols in SIZES:
    raw = run(rows, cols)
    clears = raw.count(CLEAR)
    ran = b"@@PROBE" in raw
    if not ran:
        print(f"RESULT {cols}x{rows} DIDNOTRUN {raw[-200:]!r}")
        fails += 1
        continue
    status = "ok" if clears == 0 else "FAIL"
    print(f"RESULT {cols}x{rows} clears={clears} {status}")
    if clears:
        fails += 1

print(f"DONE fails={fails}")
sys.exit(1 if fails else 0)
