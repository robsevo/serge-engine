#!/usr/bin/env python3
"""Drive a real session on a pty, resize it repeatedly, assert the screen holds.

Resize corruption is invisible to every other kind of test. Ink counts STRING
lines, not terminal rows (log-update.js:47), so once a reflow wraps a line the
erase is short and the top of the old frame is stranded above the new one. The
process exits 0, the tests pass, and the screen is wrong.

Three invariants, each one a bug that actually shipped:

  1. exactly one header on the final screen   — stacked mascots
  2. every rule is one width, <= the terminal — a 129-col rule wrapping at 95
  3. no gap above the footer                  — the repaint spacer sticking

Page count is NOT a fit test and neither is the raw byte stream: `overflow:
hidden` clips the excess and the process still reports success. That is why this
renders the screen (screen.py) and asserts against what the user would see.

    python3 resize-check.py [widths]     default: 110,70,130,88
    SERGE_BIN=/path/to/sergio python3 resize-check.py 150,95
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('SERGE_BIN', os.path.expanduser('~/programs/serge-full/sergio'))
ROWS = int(os.environ.get('PTY_ROWS', '32'))
PROMPT = os.environ.get('PROMPT', 'hi')
MAX_GAP = 4          # blank rows above the footer that are still normal

widths = [int(x) for x in (sys.argv[1] if len(sys.argv) > 1 else '110,70,130,88').split(',')]
if not os.path.exists(BIN):
    print(f'  no serge binary at {BIN} — set SERGE_BIN', file=sys.stderr)
    raise SystemExit(2)

pid, fd = pty.fork()
if pid == 0:
    os.execvp('/bin/bash', ['/bin/bash', '-lc', f'cd {os.getcwd()} && {BIN}'])


def setsize(cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, cols, 0, 0))
    try:
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass


setsize(widths[0])
out = b''
t0 = time.time()
sent = False
i = 1
# The resizes must land WHILE a turn is running — that is when the live region
# is animating and the erase arithmetic is actually exercised.
while time.time() - t0 < 34:
    r, _, _ = select.select([fd], [], [], 0.12)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if not sent and time.time() - t0 > 4.5:
        os.write(fd, PROMPT.encode() + b'\r')
        sent = True
    if sent and i < len(widths) and time.time() - t0 > 6.5 + (i - 1) * 1.4:
        setsize(widths[i])
        i += 1
    if i >= len(widths) and time.time() - t0 > 6.5 + len(widths) * 1.4 + 3:
        break

os.write(fd, b'\x03\x03')
time.sleep(0.3)
try:
    os.kill(pid, 9)
except OSError:
    pass

final = widths[-1]
screen = subprocess.run(
    [sys.executable, os.path.join(HERE, 'screen.py'), str(final)],
    input=out.decode('utf-8', 'replace'), capture_output=True, text=True,
).stdout
lines = screen.split('\n')

headers = screen.count('Hive-mode with')
rules = [len(m) for m in re.findall('─+', screen)]
rule_widths = sorted(set(rules))

footer_at = max((n for n, l in enumerate(lines) if 'shift+tab to cycle' in l), default=-1)
gap = 0
if footer_at > 0:
    above = [n for n, l in enumerate(lines[:footer_at]) if l.strip()]
    if above:
        gap = footer_at - max(above) - 1

bad = []
if headers != 1:
    bad.append(f'{headers} headers on screen (expected 1) — frames are stacking')
if len(rule_widths) > 1:
    bad.append(f'rules at {rule_widths} — a stale frame is still on screen')
if rule_widths and rule_widths[0] > final:
    bad.append(f'a {rule_widths[0]}-column rule on a {final}-column terminal — it will wrap')
if gap > MAX_GAP:
    bad.append(f'{gap} blank rows above the footer — the repaint spacer stuck')

print(f'  widths           : {" → ".join(map(str, widths))}')
print(f'  headers          : {headers}')
print(f'  rule widths      : {rule_widths or "none"}')
print(f'  gap above footer : {gap}')
print(f'  RESULT           : {"FAIL" if bad else "PASS"}')
for b in bad:
    print(f'    - {b}')
raise SystemExit(1 if bad else 0)
