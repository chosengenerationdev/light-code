// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { VariablesTab, type VariablesTabProps } from './VariablesTab.js'

/**
 * The administrator's half belongs to a shared server only.
 *
 * Reported from Sun Light Code, where every codebase runs a single-user Node host: a tab offering
 * "Everyone's" variables and a list of administrators, on a machine with one person on it, read as
 * something added by mistake. A render test because the fix is which sections are drawn.
 */

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

const base: VariablesTabProps = {
  user: [{ name: 'JAVA_HOME', value: 'C:\\jdk' }],
  admin: [],
  resolved: [{ name: 'JAVA_HOME', value: 'C:\\jdk', scope: 'user' }],
  adminIds: [],
  canEditAdmin: true,
  onSaveUser: () => {},
  onSaveAdmin: () => {},
  onSaveAdminIds: () => {},
}

const render = (props: Partial<VariablesTabProps>): string => {
  act(() => root.render(<VariablesTab {...base} {...props} />))
  return container.textContent ?? ''
}

describe('VariablesTab', () => {
  it('on a single-user host shows only your own variables', () => {
    const text = render({ shared: false })
    expect(text).toContain('Yours')
    expect(text).not.toContain("Everyone's")
    expect(text).not.toContain('Administrators')
    expect(text).not.toContain("server's own")
  })

  it('on a shared server keeps both halves and the administrator list', () => {
    const text = render({ shared: true })
    expect(text).toContain("Everyone's")
    expect(text).toContain('Administrators')
  })

  it('treats an older host that does not say as shared', () => {
    expect(render({})).toContain("Everyone's")
  })

  it('never hides administrator variables that exist, because they win', () => {
    const text = render({
      shared: false,
      admin: [{ name: 'HTTP_PROXY', value: 'http://proxy.example:8080' }],
    })
    expect(text).toContain("Everyone's")
    expect(text).not.toContain('Administrators')
  })
})
