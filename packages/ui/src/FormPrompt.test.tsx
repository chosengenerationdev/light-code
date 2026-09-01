// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FormPrompt, type PendingForm } from './FormPrompt.js'

/**
 * The form is the one control in the transcript that produces data rather than a decision, so
 * what matters is that nothing leaves it half-answered and nothing leaves it mistyped. Both are
 * failures a person would only notice much later, in whatever the assistant did next.
 */
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom has no layout, and Select scrolls its active option into view when it opens.
  Element.prototype.scrollIntoView = () => undefined
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const form: PendingForm = {
  id: 'form-1',
  title: 'Release details',
  fields: [
    { name: 'version', label: 'Version', type: 'string' },
    { name: 'builds', label: 'Builds', type: 'number' },
    { name: 'draft', label: 'Publish as a draft', type: 'boolean' },
    {
      name: 'channel',
      label: 'Channel',
      type: 'choice',
      options: [{ value: 'stable' }, { value: 'beta', label: 'Beta (early access)' }],
    },
  ],
}

function render(overrides: Partial<Parameters<typeof FormPrompt>[0]> = {}): {
  onSubmit: ReturnType<typeof vi.fn>
  onDismiss: ReturnType<typeof vi.fn>
} {
  const onSubmit = vi.fn()
  const onDismiss = vi.fn()
  act(() => {
    root.render(<FormPrompt form={form} onSubmit={onSubmit} onDismiss={onDismiss} {...overrides} />)
  })
  return { onSubmit, onDismiss }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

const type = (id: string, value: string): void => {
  const field = container.querySelector<HTMLInputElement>(`#${id}`)
  if (field === null) throw new Error(`no field ${id}`)
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the form the assistant asks with', () => {
  it('renders one control per field, of the right kind', () => {
    render()
    expect(container.querySelector('#lc-form-version')?.tagName).toBe('INPUT')
    expect(container.querySelector<HTMLInputElement>('#lc-form-builds')?.inputMode).toBe('decimal')
    expect(container.querySelector<HTMLInputElement>('[type="checkbox"]')).not.toBeNull()
    // The choice is the custom Select, not a native element — CLAUDE.md forbids reintroducing one.
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).toContain('Channel')
  })

  /**
   * The failure this prevents: submitting with an empty required field, so the assistant
   * receives a blank where it asked for a version and carries on as though that were an answer.
   */
  it('refuses to submit while a required field is empty, and says which', () => {
    const { onSubmit } = render()
    act(() => button('Submit').click())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Required.')
  })

  it('refuses a number field holding something that is not a number', () => {
    const { onSubmit } = render()
    type('lc-form-version', '1.2.0')
    type('lc-form-builds', 'twelve')
    act(() => button('Submit').click())

    expect(onSubmit).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enter a number.')
  })

  /** Errors appear on the attempt, not while typing — flagging an untouched field is nagging. */
  it('does not accuse a field the user has not reached yet', () => {
    render()
    expect(container.textContent).not.toContain('Required.')
  })

  it('submits every answer, including the ones left at their defaults', () => {
    const { onSubmit } = render({
      form: {
        ...form,
        fields: [
          { name: 'version', label: 'Version', type: 'string', defaultValue: '2.0.0' },
          { name: 'draft', label: 'Draft', type: 'boolean' },
          { name: 'note', label: 'Note', type: 'string', required: false },
        ],
      },
    })
    act(() => button('Submit').click())

    expect(onSubmit).toHaveBeenCalledWith('form-1', { version: '2.0.0', draft: false, note: '' })
  })

  it('reports a skip as its own outcome rather than as empty answers', () => {
    const { onSubmit, onDismiss } = render()
    act(() => button('Skip').click())

    expect(onDismiss).toHaveBeenCalledWith('form-1')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  /** One option is not a choice. Making someone open a dropdown to find that out is a wasted click. */
  it('preselects a dropdown that offers only one option', () => {
    const { onSubmit } = render({
      form: { id: 'form-1', title: 'One way', fields: [{ name: 'env', label: 'Environment', type: 'choice', options: [{ value: 'prod' }] }] },
    })
    act(() => button('Submit').click())

    expect(onSubmit).toHaveBeenCalledWith('form-1', { env: 'prod' })
  })

  it('marks an optional field so it does not look like an omission', () => {
    render({ form: { id: 'form-1', title: 'T', fields: [{ name: 'note', label: 'Note', type: 'string', required: false }] } })
    expect(container.textContent).toContain('(optional)')
  })
})
