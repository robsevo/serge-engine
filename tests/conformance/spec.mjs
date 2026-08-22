/**
 * spec.mjs — the Serge engine contract, as a data structure.
 *
 * This is not invented. Every entry below is derived from what the serge-public
 * brain actually consumes:
 *
 *   - events + matchers  → serge-public/dot-serge/settings.json.template
 *                          (13 events, 50 wired hook entries)
 *   - tool names         → the `matcher` fields of those same hook entries
 *   - payload fields     → grep of the 65 hook scripts in dot-serge/*.sh for
 *                          the JSON keys they read off stdin
 *   - transcript shape   → the JSONL keys those hooks parse out of
 *                          $transcript_path (claims-gate.sh, stop-checks.sh)
 *   - engine layout      → serge-public/install.sh lines 92-117
 *
 * TIERS
 *   core     — serge cannot function without it. A missing core event fails the run.
 *   extended — a real serge install wires it; absence degrades behaviour but the
 *              agent still runs. Reported, not fatal.
 *
 * Keep this file honest: if you add an entry here, cite where the brain uses it.
 */

/** Engine directory layout — install.sh:92-117. */
export const LAYOUT = {
  // install.sh:117 — searched IN THIS ORDER. The first hit becomes ~/.local/bin/serge.
  // The bash launcher must win over bin/*, because the launcher is what exports
  // CLAUDE_CODE_USE_OPENAI / OPENAI_BASE_URL / OPENAI_MODEL and boots the router.
  // A bare node wrapper in bin/ sets none of that and silently falls back to the
  // engine's built-in default model.
  launcherCandidates: ['serge', 'bin/serge', 'claude', 'bin/claude'],
  // install.sh:105 — `node dist/cli.mjs --version` must answer.
  entrypoint: 'dist/cli.mjs',
  // install.sh:92-95 — deps installed from here on first run.
  manifest: 'package.json',
}

/** Fields every hook payload carries, whatever the event. */
export const COMMON_FIELDS = ['session_id', 'cwd', 'hook_event_name', 'transcript_path']

/**
 * The 13 events. `matcher` is the value the brain uses in settings.json, so the
 * engine must accept that syntax (`|` alternation, `*` wildcard) when deciding
 * whether a hook applies.
 */
export const EVENTS = [
  { name: 'SessionStart', tier: 'core',
    matcher: 'startup|resume|clear|compact',
    fields: [...COMMON_FIELDS, 'source'],
    note: '10 hooks wired: memory-load, repo-card, reasoning-overlay, progress-load…' },

  { name: 'UserPromptSubmit', tier: 'core',
    matcher: '*',
    fields: [...COMMON_FIELDS, 'prompt'],
    note: '16 hooks — the heaviest event. Directives inject context here.' },

  { name: 'PreToolUse', tier: 'core',
    matcher: '*',   // real installs also use 'Bash', 'Edit|Write|MultiEdit' etc.
    matchersAlsoUsed: ['Bash', 'Edit|Write|MultiEdit', 'Agent|Task', 'Write|Edit|MultiEdit|NotebookEdit'],
    fields: [...COMMON_FIELDS, 'tool_name', 'tool_input'],
    note: 'Must support blocking — vague-delete-gate and path-reality-gate deny here.' },

  { name: 'PostToolUse', tier: 'core',
    matcher: '*',   // real installs also use 'Edit|Write|MultiEdit', 'ExitPlanMode'
    matchersAlsoUsed: ['Edit|Write|MultiEdit', 'ExitPlanMode'],
    fields: [...COMMON_FIELDS, 'tool_name', 'tool_input', 'tool_response'],
    note: 'algo-gate, doc-reality-gate, semgrep-scan read tool_response here.' },

  { name: 'Stop', tier: 'core',
    matcher: '*',
    fields: [...COMMON_FIELDS, 'last_assistant_message', 'stop_hook_active'],
    note: 'stop-checks.sh → claims-gate.sh. stop_hook_active MUST be set on re-invoke '
        + 'after a block, or a blocking gate traps the agent in a loop.' },

  { name: 'PostToolUseFailure', tier: 'extended',
    matcher: '*', fields: [...COMMON_FIELDS, 'tool_name', 'tool_input'],
    note: 'tool-dedupe-guard.' },
  { name: 'SubagentStart', tier: 'extended',
    matcher: '*', fields: [...COMMON_FIELDS],
    note: 'repo-card, seat-notes, swarm-doctrine brief the subagent.' },
  { name: 'SubagentStop', tier: 'extended',
    matcher: 'scout|researcher|Explore|*', fields: [...COMMON_FIELDS],
    note: 'subagent-refs-gate checks the subagent cited real files.' },
  { name: 'PreCompact', tier: 'extended',
    matcher: 'manual|auto', fields: [...COMMON_FIELDS, 'trigger'],
    note: 'compact-survival writes state that must outlive the compaction.' },
  { name: 'PostCompact', tier: 'extended',
    matcher: 'manual|auto', fields: [...COMMON_FIELDS, 'trigger'],
    note: 'compact-survival reads it back.' },
  { name: 'StopFailure', tier: 'extended',
    matcher: '', fields: [...COMMON_FIELDS], note: 'on-stop-failure.' },
  { name: 'TaskCompleted', tier: 'extended',
    matcher: '', fields: [...COMMON_FIELDS], note: 'task-evidence-gate.' },
  { name: 'Notification', tier: 'extended',
    matcher: 'permission_prompt|agent_needs_input|idle_prompt|agent_completed',
    fields: [...COMMON_FIELDS], note: 'notify-desk desktop notifications.' },
]

/** Tools the brain names in matchers, so the engine must expose them by these names. */
export const TOOLS = {
  core: ['Bash', 'Read', 'Write', 'Edit'],
  extended: ['MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'Task', 'Agent', 'Explore', 'ExitPlanMode'],
}

/**
 * Transcript contract. Hooks re-read $transcript_path to check what a turn
 * really did — claims-gate.sh walks it for tool_use/tool_result pairs, which is
 * the only reason a false "I ran the tests" claim is catchable at all.
 */
export const TRANSCRIPT = {
  format: 'JSONL — one JSON object per line, appended as the turn progresses',
  entryFields: ['type', 'message'],
  types: ['user', 'assistant'],
  contentBlocks: {
    text: ['type', 'text'],
    tool_use: ['type', 'id', 'name', 'input'],
    tool_result: ['type', 'tool_use_id', 'content', 'is_error'],
  },
  rules: [
    'A `user` entry carrying tool_result blocks is a TOOL RESULT, not a new user '
    + 'prompt. Hooks split "this turn" on real user prompts; conflating the two '
    + 'makes every turn look like it started fresh.',
    'tool_result.tool_use_id must match the id of the tool_use it answers.',
    'is_error must be true on a failed tool call — gates use it to tell a clean '
    + 'run from a failed one.',
  ],
}

/** Hook control protocol. */
export const CONTROL = {
  block: {
    exitCode2: 'stderr is fed back to the model, the action is blocked',
    json: '{"decision":"block","reason":"..."} on stdout',
  },
  pass: 'exit 0, stdout ignored (or injected as context on UserPromptSubmit)',
  note: 'claims-gate.sh and stop-checks.sh emit the JSON form; vague-delete-gate '
      + 'uses it on PreToolUse. Both paths must work.',
}
