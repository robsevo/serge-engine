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
export const task = {
  name: 'Task',
  description:
    'Delegate a scoped, read-heavy investigation to a subagent and receive only its conclusion. '
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

    const label = String(input.description ?? 'subagent').slice(0, 60)
    const res = await ctx.spawnSubagent({ prompt, label })
    if (res.error) return { content: `Task (${label}) failed: ${res.error}`, isError: true }
    return { content: res.text || `Task (${label}) returned no output.`, isError: false }
  },
}
