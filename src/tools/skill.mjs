import { readSkill } from '../brain.mjs'

/**
 * Skill — load a packaged procedure from the brain, on demand.
 *
 * The index (name + trigger) is in context from session start; the body is not,
 * because 22 skill bodies would spend most of a context window on instructions
 * for work this turn is not doing. This tool is how the body arrives when the
 * model decides the turn is one of the cases.
 *
 * It returns the skill's text rather than "doing" anything — the skill IS the
 * instruction. That is why the result reads as guidance rather than as data.
 */
export function makeSkillTool(skills) {
  const names = [...skills.keys()]
  return {
    name: 'Skill',
    description:
      'Load a skill from this workspace. A skill is a packaged set of instructions for a '
      + 'particular kind of task, written by whoever configured this agent. Call it when '
      + 'the task matches a skill listed at session start, BEFORE starting the work — the '
      + 'skill carries procedures and constraints a general answer will miss.'
      + (names.length ? ` Available: ${names.join(', ')}.` : ''),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, exactly as listed.', enum: names.length ? names : undefined },
      },
      required: ['name'],
    },
    run(input) {
      const want = String(input.name ?? '').trim()
      if (!want) return { content: 'Skill: name is required', isError: true }

      const hit = skills.get(want)
        // Case-insensitive fallback: the model is quoting a name it read once,
        // and refusing over capitalisation teaches it to stop asking.
        || [...skills.values()].find((s) => s.name.toLowerCase() === want.toLowerCase())
      if (!hit) {
        return {
          content: `Unknown skill "${want}". Available: ${names.join(', ') || '(none)'}`,
          isError: true,
        }
      }

      const body = readSkill(hit)
      return {
        content: `# Skill: ${hit.name}\n\n${body}`,
        isError: false,
      }
    },
  }
}
