/**
 * Task — run a subagent on a scoped brief and return only its conclusion.
 *
 * WHY IT EXISTS: a broad search ("which of these 40 files touches auth?") costs
 * the parent context every file it reads to find out. A subagent pays that cost
 * in its own context and hands back the answer, so the parent spends one result
 * instead of forty reads. That is the entire economics of it.
 *
 * ARCHITECTURE NOTE: this tool does not import the agent loop. The loop injects
 * `spawnSubagent` through ctx. Importing it directly would be a cycle
 * (loop → tools/index → task → loop), and cycles in ESM resolve to partially
 * initialised modules whose failure mode is an undefined export at runtime,
 * a long way from the line that caused it.
 *
 * The subagent gets a REDUCED tool set: no Task of its own. Recursive spawning
 * turns one bad brief into an unbounded tree, and nothing in a subagent's
 * context tells it how deep it already is.
 */
/**
 * Built with the session's agent roster so the enum lists what actually exists —
 * a model offered `subagent_type` values it cannot use will pick one anyway.
 */
export function makeTaskTool(agents) {
  // Sorted, not readdir order: the enum ends up in the prompt, and a list whose
  // order changes with the filesystem defeats prompt caching and makes two runs
  // on the same config differ for no reason.
  const names = [...agents.keys()].sort()
  const roster = names.length
    ? names.map((n) => `${n}: ${(agents.get(n).description || '').replace(/\s+/g, ' ').slice(0, 130)}`)
    : []
  return {
    ...task,
    description: task.description
      + (roster.length
        ? '\n\nAvailable specialists (each runs on its own model seat):\n' + roster.join('\n')
          + '\nOmit subagent_type for a general-purpose subagent.'
        : ''),
    parameters: {
      ...task.parameters,
      properties: {
        ...task.parameters.properties,
        subagent_type: {
          type: 'string',
          description: 'Which specialist to use. Omit for a general-purpose subagent.',
          ...(names.length ? { enum: names } : {}),
        },
      },
    },
  }
}

export const task = {
  name: 'Task',
  description:
    'Delegate a scoped investigation to a subagent and receive only its conclusion. '
    + 'Use when finding the answer would cost many tool calls whose intermediate output you do not need.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short label for the task (3-6 words).' },
      prompt: {
        type: 'string',
        description:
          'The complete brief. The subagent sees NOTHING of this conversation — state the goal, '
          + 'the constraints, and exactly what to return.',
      },
      subagent_type: { type: 'string', description: 'Which specialist to use, if any.' },
    },
    required: ['prompt'],
  },
  async run(input, ctx) {
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) return { content: 'Task: prompt is required', isError: true }
    if (typeof ctx.spawnSubagent !== 'function') {
      return { content: 'Task: subagents are not available in this session', isError: true }
    }
    if (ctx.depth >= 1) {
      // See ARCHITECTURE NOTE. Refused explicitly rather than silently dropped,
      // so the parent can do the work itself instead of assuming it was done.
      return {
        content: 'Task: a subagent may not spawn further subagents. Do this work directly in your own turn.',
        isError: true,
      }
    }

    const label = String(input.description ?? input.subagent_type ?? 'subagent').slice(0, 60)
    const res = await ctx.spawnSubagent({
      prompt, label, agentType: input.subagent_type || null,
    })
    if (res.error) return { content: `Task (${label}) failed: ${res.error}`, isError: true }
    return { content: res.text || `Task (${label}) returned no output.`, isError: false }
  },
}
