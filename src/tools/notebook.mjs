import { resolvePath } from '../paths.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * NotebookEdit — edit one cell of a Jupyter notebook.
 *
 * A notebook is JSON, so a plain text Edit against one is a trap: it can produce
 * a file that still parses but no longer opens, because the source array, the
 * cell ids and the outputs have to stay consistent. This tool reads the document,
 * mutates one cell, and writes it back whole.
 *
 * Outputs are dropped on any edit to a code cell. Stale output next to changed
 * source is worse than no output — it reads as a result the new code produced.
 */
export const notebookEdit = {
  name: 'NotebookEdit',
  description: 'Replace, insert, or delete a single cell in a Jupyter notebook (.ipynb).',
  parameters: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
      cell_number: { type: 'number', description: '0-indexed cell position.' },
      new_source: { type: 'string', description: 'New cell source (not needed for delete).' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Type for an inserted cell.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default replace.' },
    },
    required: ['notebook_path'],
  },
  run(input, ctx) {
    const p = resolvePath(ctx.cwd, input.notebook_path)
    if (!existsSync(p)) return { content: `Notebook does not exist: ${p}`, isError: true }

    let nb
    try {
      nb = JSON.parse(readFileSync(p, 'utf8'))
    } catch (e) {
      return { content: `NotebookEdit: ${p} is not valid JSON — ${e.message}`, isError: true }
    }
    if (!Array.isArray(nb.cells)) {
      return { content: `NotebookEdit: ${p} has no cells array; is it a notebook?`, isError: true }
    }

    const mode = input.edit_mode || 'replace'
    const n = Number(input.cell_number)
    const lines = (s) => String(s ?? '').split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))

    if (mode === 'insert') {
      const at = Number.isInteger(n) ? Math.max(0, Math.min(n, nb.cells.length)) : nb.cells.length
      const type = input.cell_type || 'code'
      const cell = { cell_type: type, metadata: {}, source: lines(input.new_source) }
      if (type === 'code') { cell.outputs = []; cell.execution_count = null }
      nb.cells.splice(at, 0, cell)
      writeFileSync(p, JSON.stringify(nb, null, 1))
      return { content: `Inserted ${type} cell at index ${at} (${nb.cells.length} cells total)`, isError: false }
    }

    if (!Number.isInteger(n) || n < 0 || n >= nb.cells.length) {
      return {
        content: `NotebookEdit: cell_number ${input.cell_number} is out of range — `
          + `the notebook has ${nb.cells.length} cells (0-${nb.cells.length - 1})`,
        isError: true,
      }
    }

    if (mode === 'delete') {
      const [gone] = nb.cells.splice(n, 1)
      writeFileSync(p, JSON.stringify(nb, null, 1))
      return { content: `Deleted ${gone.cell_type} cell ${n} (${nb.cells.length} remain)`, isError: false }
    }

    if (typeof input.new_source !== 'string') {
      return { content: 'NotebookEdit: new_source is required to replace a cell', isError: true }
    }
    const cell = nb.cells[n]
    cell.source = lines(input.new_source)
    if (input.cell_type) cell.cell_type = input.cell_type
    if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null }
    writeFileSync(p, JSON.stringify(nb, null, 1))
    return {
      content: `Replaced ${cell.cell_type} cell ${n}`
        + (cell.cell_type === 'code' ? ' (outputs cleared — they no longer match the source)' : ''),
      isError: false,
    }
  },
}
