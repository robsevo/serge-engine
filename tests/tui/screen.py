"""Replay a pty byte stream onto a screen buffer.

A TUI test that greps the raw stream is testing what was WRITTEN, not what the
user sees — and those differ by exactly the thing worth testing: erases, cursor
moves, and wrapping. Two frames both containing the mascot might be one redrawn
in place or two stacked on screen, and the bytes look the same either way.

So this implements the subset of terminal behaviour Ink actually emits — cursor
up/down/column, erase line/display, newline, and the column wrap that is the
root of the resize corruption — and prints the resulting screen.

    python3 screen.py <cols> < raw-pty-bytes
"""
import re
import sys

CSI = re.compile(r'\x1b\[([0-9;?]*)([a-zA-Z])')


def render(data, cols=100, rows=200):
    grid = [[' '] * cols for _ in range(rows)]
    cy = cx = 0
    i = 0
    n = len(data)

    def scroll():
        grid.pop(0)
        grid.append([' '] * cols)

    while i < n:
        c = data[i]

        if c == '\x1b':
            m = CSI.match(data, i)
            if not m:
                i += 1
                continue
            args, cmd = m.group(1), m.group(2)
            nums = [int(x) for x in args.split(';') if x.isdigit()]
            a = nums[0] if nums else 0

            if cmd == 'A':                      # cursor up
                cy = max(0, cy - max(1, a))
            elif cmd == 'B':
                cy = min(rows - 1, cy + max(1, a))
            elif cmd == 'C':
                cx = min(cols - 1, cx + max(1, a))
            elif cmd == 'D':
                cx = max(0, cx - max(1, a))
            elif cmd == 'G':                    # cursor to column
                cx = max(0, (a or 1) - 1)
            elif cmd == 'H':                    # cursor position
                cy = max(0, (nums[0] if nums else 1) - 1)
                cx = max(0, (nums[1] if len(nums) > 1 else 1) - 1)
            elif cmd == 'K':                    # erase in line
                if a == 0:
                    grid[cy][cx:] = [' '] * (cols - cx)
                elif a == 1:
                    grid[cy][:cx + 1] = [' '] * (cx + 1)
                else:
                    grid[cy] = [' '] * cols
            elif cmd == 'J':                    # erase in display
                if a == 0:
                    grid[cy][cx:] = [' '] * (cols - cx)
                    for r in range(cy + 1, rows):
                        grid[r] = [' '] * cols
                elif a == 2:
                    for r in range(rows):
                        grid[r] = [' '] * cols
            i += m.end() - i
            continue

        if c == '\n':
            cy += 1
            cx = 0
            if cy >= rows:
                scroll()
                cy = rows - 1
            i += 1
            continue

        if c == '\r':
            cx = 0
            i += 1
            continue

        if ord(c) < 32:
            i += 1
            continue

        # The wrap that matters: a line longer than the terminal occupies two
        # ROWS while Ink counts it as one, which is what strands the top of an
        # old frame after the window narrows.
        if cx >= cols:
            cx = 0
            cy += 1
            if cy >= rows:
                scroll()
                cy = rows - 1

        grid[cy][cx] = c
        cx += 1
        i += 1

    return [''.join(r).rstrip() for r in grid]


if __name__ == '__main__':
    width = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    lines = render(sys.stdin.read(), cols=width)
    while lines and not lines[-1]:
        lines.pop()
    print('\n'.join(lines))
