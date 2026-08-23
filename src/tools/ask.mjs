/**
 * AskUserQuestion — ask the person a question with concrete options.
 *
 * The alternative is guessing, then discovering the guess was wrong after the
 * work is done. This exists for the narrow case where that actually happens:
 * a decision the model cannot resolve from the request or the code, where
 * different answers lead to materially different work.
 *
 * HEADLESS. There is nobody to ask, so the call fails and says why, naming the
 * options. It does NOT pick one: silently choosing an answer and continuing is
 * how a scripted run produces work nobody asked for, and it makes the tool a
 * liar about what the user decided.
 */
export const askUserQuestion = {
  name: 'AskUserQuestion',
  description:
    'Ask the user a question with a short list of options, when the answer changes what you '
    + 'do next and you cannot resolve it from the request, the code, or a sensible default. '
    + 'Do not use it for choices with an obvious default or facts you can check yourself — '
    + 'make those calls and say what you assumed.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, ending in a question mark.' },
      header: { type: 'string', description: 'A short label for the decision (max ~12 chars).' },
      options: {
        type: 'array',
        description: '2 to 4 distinct options. Put your recommendation first.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The choice, 1-5 words.' },
            description: { type: 'string', description: 'What picking it means or implies.' },
          },
          required: ['label'],
        },
      },
    },
    required: ['question', 'options'],
  },

  async run(input, ctx) {
    const question = String(input?.question ?? '').trim()
    if (!question) return { content: 'AskUserQuestion requires a question.', isError: true }

    const options = (Array.isArray(input?.options) ? input.options : [])
      .map((o) => ({ label: String(o?.label ?? '').trim(), description: String(o?.description ?? '').trim() }))
      .filter((o) => o.label)

    if (options.length < 2) {
      // A single option is not a question — it is a statement wearing a prompt.
      return { content: 'AskUserQuestion needs at least 2 distinct options.', isError: true }
    }
    if (options.length > 4) options.length = 4

    if (typeof ctx?.onQuestion !== 'function') {
      const list = options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`)
      return {
        content: `Cannot ask: this session has no one at the terminal.\n\n${question}\n${list.join('\n')}\n\n`
          + 'Pick the option you would recommend, say in your answer which one you assumed and why, '
          + 'and continue. Do not stop for an answer that cannot arrive.',
        isError: true,
      }
    }

    const answer = await ctx.onQuestion({
      question,
      header: String(input?.header ?? '').slice(0, 12),
      options,
    })

    if (answer === null || answer === undefined) {
      return { content: 'The user dismissed the question without answering.', isError: true }
    }
    return { content: `The user chose: ${answer}` }
  },
}
