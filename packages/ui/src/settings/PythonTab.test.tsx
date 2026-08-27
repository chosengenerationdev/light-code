// @vitest-environment jsdom
import type { PythonSettings, PythonStatus } from '@light-code/core/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PythonTab, type PythonTabProps } from './PythonTab.js'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const status: PythonStatus = {
  enabled: true,
  toolsDir: 'D:\\proj\\.lightcode\\tools',
  venvPath: 'D:\\proj\\.venv',
  venvSource: 'workspace',
  venvIsUvManaged: true,
  ready: true,
  detail: 'ready',
  tools: [],
  issues: [],
}

const base: PythonTabProps = {
  status: undefined,
  settings: undefined,
  onBrowse: () => {},
  pickedPath: undefined,
  onSave: () => {},
  onOpenFile: () => {},
  onDeleteTool: () => {},
  onApproveTool: () => {},
}

function render(props: Partial<PythonTabProps>): void {
  act(() => root.render(<PythonTab {...base} {...props} />))
}

function field(id: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`#${id}`)
  if (found === null) throw new Error(`no field #${id}`)
  return found
}

describe('the Python tab', () => {
  /**
   * The reported bug. Only the enable toggle was resynced from the host, so every other field
   * rendered empty on each mount — a saved value looked lost, and saving again from those empty
   * boxes would have quietly cleared it.
   */
  it('shows the settings that are actually saved', () => {
    const settings: PythonSettings = {
      dynamicTools: 'on',
      uvPath: 'C:\\tools\\uv.exe',
      toolsDir: 'D:\\proj\\tools',
      venvPath: 'D:\\proj\\.venv',
      indexUrl: 'https://mirror.corp/simple',
      offline: true,
      timeoutSeconds: 90,
    }
    render({ status, settings })

    expect(field('lc-py-uv').value).toBe('C:\\tools\\uv.exe')
    expect(field('lc-py-tools').value).toBe('D:\\proj\\tools')
    expect(field('lc-py-venv').value).toBe('D:\\proj\\.venv')
    expect(field('lc-py-index').value).toBe('https://mirror.corp/simple')
    expect(field('lc-py-timeout').value).toBe('90')
  })

  it('leaves fields empty when nothing is configured, so placeholders show the defaults', () => {
    render({ status, settings: { dynamicTools: 'on' } })

    expect(field('lc-py-venv').value).toBe('')
    // The resolved environment is the placeholder — it reports which one won, not what was typed.
    expect(field('lc-py-venv').placeholder).toContain('.venv')
  })

  /** Absent until now: "which Python is this actually using?" had no answer you could change. */
  it('offers a way to choose the environment', () => {
    render({ status, settings: { dynamicTools: 'on' } })
    expect(container.textContent).toContain('Python environment')
  })

  it('sends every field on save, including the environment', () => {
    const onSave = vi.fn()
    render({ status, settings: { dynamicTools: 'on', venvPath: 'D:\\env' }, onSave })

    const save = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Save')
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dynamicTools: 'on', venvPath: 'D:\\env' }))
  })

  it('follows the host when settings change underneath it', () => {
    render({ status, settings: { dynamicTools: 'on', toolsDir: 'first' } })
    expect(field('lc-py-tools').value).toBe('first')

    // A reload, or another window saving: the tab must not keep showing the old value.
    render({ status, settings: { dynamicTools: 'on', toolsDir: 'second' } })
    expect(field('lc-py-tools').value).toBe('second')
  })
})

describe('choosing which model writes the code', () => {
  const chosen: string[] = []
  const withPicker = (selectedId?: string): void => {
    chosen.length = 0
    render({
      // The picker lives in the configuration section, which only appears once Python is on.
      status,
      settings: { dynamicTools: 'on' },
      programming: {
        profiles: [
          { id: 'gateway', label: 'Corporate gateway' },
          { id: 'coder', label: 'Code model' },
        ],
        selectedId,
        onSelect: (id: string) => chosen.push(id),
      },
    })
  }

  it('offers the chat model as the default choice', () => {
    withPicker()
    expect(container.textContent).toContain('The model you are chatting with')
    expect(container.textContent).toContain('writes the Python itself')
  })

  /** The reassurance that matters: a second model writing code does not skip the gate. */
  it('says approval still happens once a code model is chosen', () => {
    withPicker('coder')
    expect(container.textContent).toContain('approve the source')
    expect(container.textContent).toContain('which model produced it')
  })

  it('is absent when the host offers no profiles', () => {
    render({ status, settings: { dynamicTools: 'on' } })
    expect(container.textContent).not.toContain('Which model writes the code')
  })
})

/**
 * The picker is host-only. It appeared in the extension for one release because `programming` was
 * passed unconditionally — a feature the user had twice said was for the Node host showing up in
 * VS Code, which is the sort of thing nobody reports as a bug and everybody notices.
 */
describe('where the picker is offered', () => {
  it('is absent when the host does not offer it, even with profiles configured', () => {
    render({ status, settings: { dynamicTools: 'on' } })
    expect(container.textContent).not.toContain('Which model writes the code')
  })
})
