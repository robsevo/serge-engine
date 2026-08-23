# TUI checks

Two different things, because one cannot cover the other.

## `resize-check.py` — what the user sees

Drives a real session on a pty, resizes it mid-turn, and asserts against the
**rendered screen** rather than the byte stream.

```bash
python3 tests/tui/resize-check.py               # 110,70,130,88
python3 tests/tui/resize-check.py 150,95
SERGE_BIN=/path/to/serge python3 tests/tui/resize-check.py
```

It needs a working install (it starts a session), so it is not in `npm test`.

**Catches:** stacked frames after a resize, a stale rule left at the old width,
a spacer that never cleared. All three shipped; this is what found them.

**Does not catch:** the stuck-spacer *cause*. The spacer is viewport+1 rows by
design, so it overflows, Ink full-clears anyway, and the final screen looks
correct even when the revert is broken. That regression is pinned by
`tests/resize-effect.test.mjs`, which tests the React behaviour directly. This
was verified, not assumed — the bug was reintroduced and this harness passed.

Grepping the raw pty stream does not work either: two frames both containing the
mascot might be one redrawn in place or two stacked, and the bytes are the same.
`screen.py` replays the stream onto a buffer — cursor moves, erases, and the
column wrap that is the root of the corruption — so the assertions run against
what is actually on screen.

## `../resize-effect.test.mjs` — why it breaks

Runs in `npm test`. Pins the mechanism: the repaint must re-arm on **every**
resize event. `setState(true)` on an already-true boolean is a React no-op, so
the effect that clears the spacer never re-ran and it stuck permanently.
