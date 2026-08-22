/**
 * Explore — read-only fan-out search that answers a question about a codebase.
 *
 * The economics are the same as Task's, sharpened. Finding "which files touch
 * auth" costs a dozen greps and reads whose intermediate output the caller never
 * wants; run them here and the parent spends one answer instead of twelve
 * excerpts. What makes this distinct from Task is the guarantee: Explore CANNOT
 * write. Its subagent gets Read, Grep and Glob and nothing else, so it can be
 * pointed at unfamiliar code without asking whether the brief was tight enough.
 *
 * NOT a code reviewer. It locates and explains; it does not judge quality. Asking
 * it "is this good" gets you a summary of what the code does, which is a worse
 * answer than either question deserves.
 *
 * `breadth` maps to a turn budget rather than a parallel fan-out: one subagent
 * that greps four ways in sequence beats four that each read the same files, and
 * the sequential version is the one whose cost is predictable.
 */
export const explore = {
  name: 'Explore',
  description:
    'Search a codebase read-only and return the conclusion, not the excerpts. Use when '
    + 'answering would take many greps and reads you do not want in your own context — '
    + '"where is X handled", "what calls Y", "which files touch Z", "how does W work". '
    + 'It locates and explains; it cannot edit and does not review code quality.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The question, stated fully. The explorer sees nothing of this conversation — '
          + 'say what you are looking for and what you want back.',
      },
      breadth: {
        type: 'string',
        enum: ['quick', 'medium', 'thorough'],
        description:
          'quick: one obvious place. medium: a few naming conventions. '
          + 'thorough: several locations and conventions, for unfamiliar code.',
      },
      path: { type: 'string', description: 'Restrict the search to this directory.' },
    },
    required: ['query'],
  },
  async run(input, ctx) {
    const query = String(input.query ?? '').trim()
    if (!query) return { content: 'Explore: query is required', isError: true }
    if (typeof ctx.spawnSubagent !== 'function') {
      return { content: 'Explore: subagents are not available in this session', isError: true }
    }
    if (ctx.depth >= 1) {
      return {
        content: 'Explore: an explorer may not spawn another. Search directly with Grep and Glob.',
        isError: true,
      }
    }

    const breadth = ['quick', 'medium', 'thorough'].includes(input.breadth)
      ? input.breadth : 'medium'
    const turns = { quick: 6, medium: 12, thorough: 20 }[breadth]
    const scope = input.path ? `\nSearch under: ${input.path}` : ''

    const brief = [
      'You are exploring a codebase to answer one question. You are READ-ONLY: you have',
      'Read, Grep and Glob, and nothing that can change a file.',
      '',
      `Question: ${query}${scope}`,
      '',
      'How to search well:',
      '- Grep for the concept, not just the exact word — the code may name it differently.',
      `- Try ${breadth === 'quick' ? 'the most likely location' : 'several naming conventions and locations'};`,
      '  a single failed grep is not evidence of absence.',
      '- Read excerpts around the hits, not whole files.',
      '- Follow imports when the answer is one hop away.',
      '',
      'Return: the answer in a few sentences, then the specific `file:line` references that',
      'support it. If you could not find it, say so plainly and list where you looked —',
      'that is a useful answer; a confident guess is not.',
    ].join('\n')

    const res = await ctx.spawnSubagent({
      prompt: brief,
      label: `explore:${query.slice(0, 40)}`,
      tools: ['Read', 'Grep', 'Glob'],
      maxTurns: turns,
    })
    if (res.error) return { content: `Explore failed: ${res.error}`, isError: true }
    return { content: res.text || 'Explore returned no findings.', isError: false }
  },
}
