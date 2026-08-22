/**
 * Tool registry.
 *
 * Names are not ours to choose: serge's hooks match on them literally
 * (`"matcher": "Edit|Write|MultiEdit"`), so a rename silently unwires a gate.
 * See docs/ENGINE-CONTRACT.md.
 */
import { bash } from './bash.mjs'
import { read } from './read.mjs'
import { write } from './write.mjs'
import { edit } from './edit.mjs'
import { multiEdit } from './multiedit.mjs'
import { glob, grep } from './search.mjs'
import { task } from './task.mjs'
import { exitPlanMode } from './plan.mjs'
import { notebookEdit } from './notebook.mjs'

export const TOOLS = {
  Bash: bash,
  Read: read,
  Write: write,
  Edit: edit,
  MultiEdit: multiEdit,
  NotebookEdit: notebookEdit,
  Glob: glob,
  Grep: grep,
  Task: task,
  ExitPlanMode: exitPlanMode,
}

/** A subagent gets read + search only: no mutations, no nested delegation. */
export const SUBAGENT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']

/**
 * OpenAI-compatible function schemas.
 *
 * @param only    restrict the built-in set (subagents get a reduced one)
 * @param extra   session-scoped tools: the Skill tool and anything MCP exposes.
 *                They are passed in rather than registered globally because
 *                which skills exist and which MCP servers answered are
 *                properties of THIS session, not of the process.
 */
export function toolSchemas(only = null, extra = []) {
  const names = only ?? Object.keys(TOOLS)
  const builtin = names
    .filter((n) => TOOLS[n])
    .map((n) => ({
      type: 'function',
      function: { name: TOOLS[n].name, description: TOOLS[n].description, parameters: TOOLS[n].parameters },
    }))
  return builtin.concat(extra)
}

export async function runTool(name, input, ctx) {
  // MCP tools are namespaced mcp__<server>__<tool> and dispatch to the client
  // rather than the registry, so a server exposing `Read` cannot shadow ours.
  if (name.startsWith('mcp__')) {
    if (!ctx?.mcp?.call) return { content: `No MCP client for ${name}`, isError: true }
    return ctx.mcp.call(name, input ?? {})
  }
  const t = TOOLS[name] || ctx?.sessionTools?.[name]
  if (!t) return { content: `Unknown tool: ${name}`, isError: true }
  try {
    return await t.run(input ?? {}, ctx)
  } catch (e) {
    return { content: `${name} failed: ${e?.message ?? e}`, isError: true }
  }
}
