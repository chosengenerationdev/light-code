// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileEditor, type FileEditorProps } from './FileEditor.js'

/** The panel's editor for skills and tools where the host has none (Fire Code, the browser). */

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const file = { path: 'D:/w/.lightcode/skills/standing-instructions.md', name: 'standing-instructions.md', content: '# Rules\n', mtimeMs: 100 }

function render(props: Partial<FileEditorProps> = {}): { saves: [string, number][]; closes: number[] } {
  const saves: [string, number][] = []
  const closes: number[] = []
  act(() =>
    root.render(<FileEditor file={file} onSave={(content, mtimeMs) => saves.push([content, mtimeMs])} onClose={() => closes.push(1)} {...props} />),
  )
  return { saves, closes }
}

const box = (): HTMLTextAreaElement => container.querySelector('textarea')!
const button = (label: string): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!
function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(box(), value)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the panel editor', () => {
  it('saves only once something changed, with the version it was opened at', () => {
    const { saves } = render()
    expect(button('Save').disabled).toBe(true)
    expect(button('Save').title).toContain('Nothing has changed')
    type('# Rules\n- be brief\n')
    expect(button('Save').disabled).toBe(false)
    act(() => button('Save').click())
    expect(saves).toEqual([['# Rules\n- be brief\n', 100]])
  })

  it('saves with Ctrl+S', () => {
    const { saves } = render()
    type('changed')
    act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })) })
    expect(saves).toHaveLength(1)
  })

  it('says why a save was refused, on the page', () => {
    render({ saved: { ok: false, conflict: true, message: 'standing-instructions.md was changed on disk after you opened it.' } })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed on disk')
  })

  it('asks before closing with unsaved changes', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { closes } = render()
    type('changed')
    act(() => button('Close').click())
    expect(confirm).toHaveBeenCalled()
    expect(closes).toEqual([])
    confirm.mockRestore()
  })

  it('previews Markdown', () => {
    render()
    act(() => button('Preview').click())
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('Rules')
  })
})
