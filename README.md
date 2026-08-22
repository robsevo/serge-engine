# serge-engine

An MIT-licensed, Claude Code–compatible agent engine for
[serge-public](https://github.com/robsevo/serge-brain).

## Why this exists

serge-public ships a brain with no body. Its installer says so directly:

```
install.sh:70   # The engine is deliberately not in this repo — it is a Claude
                # Code derivative.
install.sh:72   [ -n "$ENGINE" ] || die "--engine is required."
```

So every user must supply `--engine /path/to/engine`, and the only thing that has
ever satisfied that slot is Anthropic's proprietary CLI — which serge-public
cannot redistribute. The result: a public repo nobody but its author can run.

This repo fills the slot. It plugs into the existing `--engine` interface, so
**serge-public needs no changes.**

The model layer is already solved and is not Anthropic's: serge routes through
LiteLLM on `localhost:4000/v1` across ~23 free-tier seats (Mistral, Gemini,
Cerebras, Z.AI), with paid seats reachable only by explicit name. This engine
talks OpenAI-compatible HTTP to that router. It never calls Anthropic.

## Status

**M1 — a working headless engine.** It runs real turns against the LiteLLM
router, calls tools, writes a conforming transcript, and fires Serge's hooks.
It passes the same conformance suite as the reference Claude Code–derived
engine: **16 ok, 0 fail**.

| milestone | state |
|---|---|
| **M0** conformance harness + captured contract | ✅ done |
| **M1** agent loop — OpenAI-compatible streaming, Bash/Read/Write/Edit, JSONL transcript, core hook events | ✅ done |
| **M2** permission system — modes, allow/deny rules, workspace boundary, hook `permissionDecision` | ✅ done |
| **M3** all 13 events, MultiEdit/Grep/Glob/Task/ExitPlanMode, subagents, compaction | ✅ done |
| M4 interactive session, plan-mode UX | not started |
| M5 commands / skills / agents loading, MCP | not started |

### Permissions (M2)

Tools no longer execute just because the model asked. Precedence, first match wins:

1. a PreToolUse hook's `permissionDecision` — `deny` stops it, `allow` vouches for it
2. `settings.permissions.deny` — beats every mode, `fullAccess` included
3. `plan` mode — no mutations at all
4. `settings.permissions.allow` — `Tool`, `Tool(prefix)`, `Tool(glob/**)`
5. dangerous-command heuristics — `rm -rf`, `sudo`, pipe-to-shell, force push,
   raw device writes. A mode does not excuse these; only an explicit allow rule
   or `fullAccess` does
6. bypass modes (`bypassPermissions` respects `allowBypassPermissionsMode`)
7. workspace boundary — `cwd` plus `permissions.additionalDirectories`
8. the mode default

Modes: `default`, `acceptEdits`, `plan`, `bypassPermissions`, `fullAccess`
(`--yolo`/`--auto` map to `fullAccess`, as serge's launcher does).

**Headless resolution:** there is no TTY, so anything that would prompt is
**denied**, with a message naming the rule that would permit it. Auto-approving
instead would make `default` mode a lie.

`hookSpecificOutput.permissionDecision` matters more than it looks: the four
real PreToolUse gates — `path-reality-gate`, `vague-delete-gate`,
`gate-on-constitution-edit`, `tool-dedupe-guard` — deny **only** that way and
never `exit 2`. An engine honouring just exit codes silently bypasses all four
while appearing fully gated. The conformance suite now tests for it.

### What M1 actually does

- streams `chat/completions` from any OpenAI-compatible endpoint (LiteLLM in a
  Serge install) — it never calls Anthropic
- multi-turn tool loop with `Bash`, `Read`, `Write`, `Edit`
- JSONL transcript matching `docs/ENGINE-CONTRACT.md`, written as the turn
  happens
- fires all 13 hook events, with three deny protocols (exit 2,
  `{"decision":"block"}`, and `hookSpecificOutput.permissionDecision`) plus
  `UserPromptSubmit` context injection
- `Bash Read Write Edit MultiEdit Glob Grep Task ExitPlanMode`
- subagents (`Task`) on a reduced tool set, no recursive spawning
- context compaction that preserves the first prompt and the working set, and
  refuses to drop anything if the summary comes back empty
- `stop_hook_active` on Stop re-invocation, so a blocking gate can stand down
  instead of trapping the session

Verified against Serge's own hardened `claims-gate.sh`: given a serge-engine
transcript, the real gate correctly passes a turn that mutated something and
blocks a turn that claims a change it never made. Engine and brain agree about
what happened — which is the whole point of the transcript contract.

### What M1 does NOT do

Stated plainly so nobody has to discover it:

- **no interactive TUI** — `-p/--print` only; anything else exits with a message
- 9 tools — no `NotebookEdit`, no `Explore`
- no MCP, no skills/commands/agents loading, no session resume

## The harness, and why it is built this way

This project began after a session produced ~1,600 lines of "engine" that was a
hardcoded simulator, three test scripts that could only pass, and documentation
asserting it all worked. Nothing was connected to anything.

So the harness is built so that cannot happen here:

1. **It never asks the engine what it supports.** It builds a throwaway
   `SERGE_HOME`, wires `probe.mjs` into all 13 hook slots, drives the real
   binary, and reports only what actually arrived on a hook's stdin.
2. **Claims are checked against side effects.** "The Bash tool fired" is only
   accepted if a sentinel file the tool was told to create actually exists.
3. **It is validated against a known-good engine first.** Run it against a
   working Claude Code–derived engine; whatever it reports there *is* the
   contract. A green run means something because it went green on a system that
   demonstrably works.
4. **It must be able to fail.** `--self-test` builds a deliberately inert engine
   that satisfies the static layout checks and nothing else, then asserts the
   harness **rejects** it. A suite that cannot fail is not a suite.

Point 4 has already earned its keep: the first self-test run passed the deny
check against an engine that does nothing — because an absent sentinel looks the
same whether the hook blocked the tool or the engine never ran at all. That
check now requires the hook to have actually fired.

## Usage

```bash
# capture the contract from a working engine
node tests/conformance/run.mjs --engine /path/to/engine --out docs/ENGINE-CONTRACT.md

# prove the harness can still detect a non-conforming engine
node tests/conformance/run.mjs --self-test

# flags: --keep (keep the run dir)  --timeout <sec>  --router <url>
```

Requires Node ≥ 22 and a reachable OpenAI-compatible router. Zero dependencies —
the harness is plain ESM so it runs against any engine without a build step.

Exit code is `0` when no required check failed, `1` otherwise. Under
`--self-test` the meaning inverts: `0` means the inert engine was correctly
rejected.

## Layout

```
serge                    bash launcher — install.sh finds this FIRST. Exports
                         CLAUDE_CONFIG_DIR / CLAUDE_CODE_USE_OPENAI /
                         OPENAI_BASE_URL and boots the router before exec.
src/
├── cli.mjs              arg parsing, --version, --doctor, -p
├── config.mjs           CLAUDE_CONFIG_DIR, settings.json, router config
├── provider.mjs         OpenAI-compatible streaming + tool-call assembly
├── loop.mjs             the agent loop
├── hooks.mjs            13-event dispatcher, matcher syntax, block protocol
├── transcript.mjs       JSONL writer
└── tools/               Bash, Read, Write, Edit
scripts/build.mjs        copies src/ → dist/ (no bundler, no dependencies)
tests/conformance/
├── spec.mjs             the contract as data, each entry citing its source
├── probe.mjs            the observer installed into every hook slot
└── run.mjs              tiered harness; emits the contract
docs/ENGINE-CONTRACT.md  generated
```

## Build and run

```bash
npm run build                 # copies src/ → dist/
./serge --doctor              # config dir, router, model, reachability
./serge -p "your prompt"
npm run conformance -- --engine .   # 17 checks against a real engine
npm test                            # 28-case permission matrix
npm run test:self-test              # proves the matrix catches a removed gate
npm run conformance:self-test       # proves the harness catches an inert engine
```

## Contributing

If you add an entry to `spec.mjs`, cite where the brain uses it. The spec is
only worth something because it is derived from real consumption rather than
from what an engine happens to implement.

## License

MIT — see [LICENSE](LICENSE).

The brain it serves ([serge-public](https://github.com/robsevo/serge-brain)) is
also MIT. Neither contains nor requires Anthropic's proprietary engine once this
one is complete.
