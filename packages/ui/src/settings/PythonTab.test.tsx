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

    const save = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === 'Save',
    )
    act(() => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicTools: 'on', venvPath: 'D:\\env' }),
    )
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

describe('environment variables for every tool', () => {
  function rows(): HTMLInputElement[] {
    return [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')]
  }

  function valueBox(index: number): HTMLInputElement {
    const found = [
      ...container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable value"]'),
    ][index]
    if (found === undefined) throw new Error(`no value box at ${String(index)}`)
    return found
  }

  function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function click(label: string, at = 0): void {
    const button = [...container.querySelectorAll('button')].filter((b) => b.textContent === label)[
      at
    ]
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  function save(): void {
    click('Save')
  }

  it('shows what is saved, and never a stored secret value', () => {
    render({
      status,
      settings: {
        dynamicTools: 'on',
        env: [
          { name: 'API_HOST', value: 'https://internal', secret: false },
          { name: 'API_TOKEN', secret: true, hasValue: true },
        ],
      },
    })

    expect(rows().map((input) => input.value)).toEqual(['API_HOST', 'API_TOKEN'])
    expect(valueBox(0).value).toBe('https://internal')
    // Invariant 7: the host never sent it, so there is nothing here to show.
    expect(valueBox(1).value).toBe('')
    expect(valueBox(1).placeholder).toContain('Set')
    expect(valueBox(1).type).toBe('password')
  })

  /**
   * The rule that would otherwise destroy a token on the way past.
   *
   * The secret box is blank because a stored value cannot cross toward the UI, not because the
   * user emptied it. Sending that blank would clear the secret on every save from this tab —
   * including a save about the timeout, which is how it would actually happen.
   */
  it('omits a secret the user did not retype, so saving something else keeps it', () => {
    const onSave = vi.fn()
    render({
      status,
      settings: { dynamicTools: 'on', env: [{ name: 'API_TOKEN', secret: true, hasValue: true }] },
      onSave,
    })
    save()

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ env: [{ name: 'API_TOKEN', secret: true }] }),
    )
  })

  it('sends a secret the user did retype', () => {
    const onSave = vi.fn()
    render({
      status,
      settings: { dynamicTools: 'on', env: [{ name: 'API_TOKEN', secret: true, hasValue: true }] },
      onSave,
    })
    type(valueBox(0), 'new-token')
    save()

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ env: [{ name: 'API_TOKEN', value: 'new-token', secret: true }] }),
    )
  })

  it('adds and removes, and a removal actually reaches the host', () => {
    const onSave = vi.fn()
    render({
      status,
      settings: {
        dynamicTools: 'on',
        env: [
          { name: 'ONE', value: '1', secret: false },
          { name: 'TWO', value: '2', secret: false },
        ],
      },
      onSave,
    })

    click('Remove', 0)
    expect(rows().map((input) => input.value)).toEqual(['TWO'])

    click('Add variable')
    type(rows()[1] as HTMLInputElement, 'THREE')
    type(valueBox(1), '3')
    save()

    // The whole set, not a delta — which is what makes the removal expressible at all.
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        env: [
          { name: 'TWO', value: '2', secret: false },
          { name: 'THREE', value: '3', secret: false },
        ],
      }),
    )
  })

  /*
   * Ticking the box is about to send what was typed to secret storage, so the field must stop
   * showing it — otherwise a plaintext token sits visible in a box that claims to be secret.
   */
  it('clears the box when a variable becomes a secret', () => {
    render({
      status,
      settings: { dynamicTools: 'on', env: [{ name: 'T', value: 'plain', secret: false }] },
    })

    const secretToggle = [
      ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ].find((box) => box.parentElement?.textContent?.includes('Secret'))
    if (secretToggle === undefined) throw new Error('no Secret checkbox')
    act(() => secretToggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(valueBox(0).value).toBe('')
    expect(valueBox(0).type).toBe('password')
  })

  /** A credential error inside somebody's tool points at the tool. This points at the variable. */
  it('names a secret variable with nothing stored behind it', () => {
    render({ status: { ...status, missingEnv: ['API_TOKEN'] }, settings: { dynamicTools: 'on' } })
    expect(container.textContent).toContain('No value is stored for API_TOKEN')
  })
})

/**
 * Reported as "when I click delete they are not being deleted". Delete on a not-loaded tool set a
 * confirmation that was only ever drawn in the Registered tools list — which a tool that did not
 * load is never in — so the click did nothing. And the host deleted `<tools folder>/<name>`
 * whichever row was clicked, so the panel must now name the exact file.
 */
describe('a tool that did not load', () => {
  const settings: PythonSettings = { dynamicTools: 'on' }
  const withIssues = (issues: PythonStatus['issues']): PythonStatus => ({ ...status, issues })
  const button = (text: string): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)

  it('can be deleted from the folder this machine writes to, naming the exact file', () => {
    const onDeleteTool = vi.fn()
    render({
      status: withIssues([
        {
          detail: 'broken_tool: does not import.',
          name: 'broken_tool',
          filePath: 'D:\\proj\\.lightcode\\tools\\broken_tool.py',
          recoverable: false,
          kind: 'invalid',
        },
      ]),
      settings,
      onDeleteTool,
    })

    const del = button('Delete')
    expect(del, [...container.querySelectorAll('button')].map((b) => b.textContent).join('|')).toBeDefined()
    act(() => del?.click())
    // The confirmation has to appear where the click was, or the button does nothing at all.
    expect(container.textContent).toContain('Delete this file?')
    const confirm = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Delete').at(-1)
    act(() => confirm?.click())
    expect(onDeleteTool).toHaveBeenCalledWith('broken_tool', 'D:\\proj\\.lightcode\\tools\\broken_tool.py')
  })

  it('offers Decline, not Delete, for a copy from a bucket folder the next sync would restore', () => {
    render({
      status: withIssues([
        {
          detail: 'team_tool: new, not yet approved.',
          name: 'team_tool',
          filePath: 'C:\\Users\\me\\storage\\s3\\team\\tools-abc\\team_tool.py',
          recoverable: true,
          kind: 'unapproved',
        },
      ]),
      settings,
      onDeclineTool: () => {},
    })

    expect(button('Delete')).toBeUndefined()
    expect(button('Decline')).toBeDefined()
  })

  it('does not paint a declined copy as an error', () => {
    render({
      status: withIssues([
        {
          detail: 'old_tool: declined.',
          name: 'old_tool',
          filePath: 'C:\\Users\\me\\storage\\s3\\team\\tools-abc\\old_tool.py',
          recoverable: false,
          kind: 'declined',
        },
      ]),
      settings,
    })
    expect(container.textContent).toContain('ⓘ')
    expect(container.textContent).not.toContain('⚠')
  })
})
