"""Type into a real session on a narrow pty and assert the line is drawn intact.

The prompt line used to render as four sibling <Text> nodes, and Ink wraps each
sibling on its own: on a narrow terminal the character sitting on the wrap point
was consumed and the text after the cursor was displaced. This types a string
that is guaranteed to wrap at the given width and compares the RENDERED SCREEN
(via screen.py) against what was typed.

Nothing is submitted — no model call, no network. The prompt line is the subject.

    python3 tests/tui/typing-check.py            # 44 cols
    python3 tests/tui/typing-check.py 44,60,34
    SERGE_BIN=/path/to/sergio python3 tests/tui/typing-check.py
"""
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get('SERGE_BIN', os.path.expanduser('~/.local/bin/sergio'))
ROWS = int(os.environ.get('PTY_ROWS', '30'))
TEXT = os.environ.get('TYPE_TEXT', '"fdd sdfsffd and more words to force a wrap here')

widths = [int(x) for x in (sys.argv[1] if len(sys.argv) > 1 else '44').split(',')]
if not os.path.exists(BIN):
    print(f'  no binary at {BIN} — set SERGE_BIN', file=sys.stderr)
    raise SystemExit(2)

fails = []
for cols in widths:
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp('/bin/bash', ['/bin/bash', '-lc', f'cd {os.getcwd()} && {BIN}'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, cols, 0, 0))

    out, t0, typed = b'', time.time(), False
    while time.time() - t0 < 14:
        r, _, _ = select.select([fd], [], [], 0.12)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        # Type one character at a time, as a person does: a paste arrives as one
        # chunk and would not exercise the per-keystroke redraw at all.
        if not typed and time.time() - t0 > 5.0:
            for ch in TEXT:
                os.write(fd, ch.encode())
                time.sleep(0.02)
            typed = True
        if typed and time.time() - t0 > 8.5:
            break

    os.write(fd, b'\x03\x03')
    time.sleep(0.25)
    try:
        os.kill(pid, 9)
    except OSError:
        pass

    screen = subprocess.run(
        [sys.executable, os.path.join(HERE, 'screen.py'), str(cols)],
        input=out.decode('utf-8', 'replace'), capture_output=True, text=True,
    ).stdout
    lines = [l.rstrip() for l in screen.split('\n')]

    # The prompt line and its continuations: from the ❯ row to the rule under it.
    start = next((i for i, l in enumerate(lines) if l.lstrip().startswith('❯')), None)
    if start is None:
        fails.append(f'{cols} cols: no prompt line on screen')
        print(f'  FAIL  {cols} cols — no prompt line found'); continue
    block = []
    for l in lines[start:]:
        if block and (set(l.strip()) <= {'─', ''} or not l.strip()):
            break
        block.append(l)

    shown = ''.join(block).replace('❯', '', 1)
    dense_shown = re.sub(r'\s', '', shown)
    dense_typed = re.sub(r'\s', '', TEXT)
    ok = dense_typed in dense_shown
    print(f'  {"ok  " if ok else "FAIL"}  {cols} cols — typed text drawn intact')
    for l in block:
        print(f'        │{l}')
    if not ok:
        fails.append(f'{cols} cols')
        print(f'        typed {TEXT!r}')
        print(f'        shown {shown.strip()!r}')

print(f'\n  {len(widths) - len(fails)}/{len(widths)} widths clean')
raise SystemExit(1 if fails else 0)
