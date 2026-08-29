#!/usr/bin/env python3
"""What one keystroke costs on screen. Uses the stub probe — no model, no network.

Ink's default renderer (log-update.js `createStandard`) writes
`eraseLines(previousLineCount) + theWholeFrame` for every frame. The live region
here is about nine rows — mascot, identity, two rules, the input line, the status
bar — so typing ONE character erased and redrew all nine, ~5KB a keystroke. That
is the flicker in the input box, and the same repaint runs on every 80ms
animation tick while a turn is in flight.

Ink ships an incremental renderer that rewrites only the lines that differ, and
leaves it off by default. `incrementalRendering: true` in ink-repl.mjs turns it
on. Measured on a 110x32 pty, typing "hello world":

    standard      55,968 bytes    99 rows erased   (9.0 per keystroke)
    incremental    1,067 bytes     0 rows erased   (0.0 per keystroke)

`eraseLines(n)` is (n-1) repetitions of ESC[2K ESC[1A then ESC[2K ESC[G, so
counting ESC[1A gives rows erased directly. Bytes are reported too, but rows are
the number that corresponds to what the eye sees.

    python3 typing-cost.py            # asserts; exits 1 on regression
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
PROBE = os.path.join(HERE, "live-region-probe.mjs")
ROWS, COLS = 32, 110
CHARS = b"hello world"

# Generous: the standard renderer erased 9 rows per keystroke here, and the
# incremental one erases none. Anything at or above this means the whole live
# region is being repainted again.
MAX_ROWS_PER_KEY = 2.0
MAX_BYTES_PER_KEY = 900


def run():
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    env = dict(os.environ, PROBE_LINES="0", FORCE_COLOR="1", TERM="xterm-256color")
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
    if not buf:
        p.kill()
        return None
    mark = len(buf)
    for ch in CHARS:                        # one at a time, the way a person types
        os.write(master, bytes([ch]))
        pump(0.12)
    typed = bytes(buf[mark:])

    p.send_signal(signal.SIGTERM)
    pump(0.6)
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
    os.close(master)
    return typed


typed = run()
if typed is None:
    print("RESULT DIDNOTRUN")
    sys.exit(1)

rows = typed.count(b"\x1b[1A")
per_row = rows / len(CHARS)
per_byte = len(typed) / len(CHARS)
print(f"RESULT keystrokes={len(CHARS)} bytes={len(typed)} rows_erased={rows} "
      f"rows_per_key={per_row:.1f} bytes_per_key={per_byte:.0f}")

fails = 0
if per_row >= MAX_ROWS_PER_KEY:
    print(f"FAIL {per_row:.1f} rows erased per keystroke — the whole live region "
          f"is being repainted (incrementalRendering off?)")
    fails += 1
if per_byte > MAX_BYTES_PER_KEY:
    print(f"FAIL {per_byte:.0f} bytes per keystroke, over {MAX_BYTES_PER_KEY}")
    fails += 1

print(f"DONE fails={fails}")
sys.exit(1 if fails else 0)
