/**
 * ExitPlanMode — the model presents a plan and asks to start executing.
 *
 * This tool does almost nothing on its own, and that is deliberate: its value is
 * that it exists as a NAMED, GATEABLE moment between "I have a plan" and "I am
 * changing files". Serge's brain already hangs `persist-plan.sh` off it
 * (PostToolUse), and it is the correct attachment point for a PreToolUse gate
 * that inspects a plan BEFORE the user is asked to approve it.
 *
 * The engine's own contribution is the mode transition: until this fires,
 * permissions are in `plan` mode and every mutation is refused. Approving flips
 * the session to the mode it will execute under.
 */
export const exitPlanMode = {
  name: 'ExitPlanMode',
  description:
    'Present a completed implementation plan and request approval to begin executing it. '
    + 'Call this only after the plan is complete — it is the boundary between planning and changing files.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The full plan, in markdown.' },
    },
    required: ['plan'],
  },
  run(input, ctx) {
    const plan = String(input.plan ?? '').trim()
    if (!plan) return { content: 'ExitPlanMode: plan is empty', isError: true }

    // The tool itself never approves. It records the request; the PreToolUse
    // gate decides whether the plan was good enough to show, and the session
    // decides what mode execution runs under.
    ctx.onPlanApproved?.(plan)
    return {
      content: `Plan accepted (${plan.split('\n').length} lines). Execution may begin.`,
      isError: false,
    }
  },
}
