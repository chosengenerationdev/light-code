// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FolderTree, type MailFolderNode } from './FolderTree.js'

/**
 * Collapsing has to actually collapse.
 *
 * The first version exempted ticked folders from being hidden, on the theory that a selection
 * vanishing from view reads as a selection lost. But a tick is the *normal* state of this tree —
 * it exists to select folders — so once anything was selected, Collapse all left most of the rows
 * on screen and simply looked broken. Reported as exactly that.
 *
 * A render test rather than a reasoned one, because the whole defect was the difference between
 * what the state said and what a person saw.
 */
let container: HTMLDivElement
let root: Root

const FOLDERS: MailFolderNode[] = [
  { name: 'mailbox', path: 'mailbox', depth: 0 },
  { name: 'Inbox', path: 'mailbox\\Inbox', depth: 1 },
  { name: 'Alerts', path: 'mailbox\\Inbox\\Alerts', depth: 2 },
  { name: 'Prod', path: 'mailbox\\Inbox\\Alerts\\Prod', depth: 3 },
  { name: 'Sent', path: 'mailbox\\Sent', depth: 1 },
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(selected: string[] = []): void {
  act(() =>
    root.render(
      <FolderTree folders={FOLDERS} selected={selected} onChange={() => undefined} includeSubfolders={false} />,
    ),
  )
}

/** The folder rows currently on screen, by name. */
function rows(): string[] {
  return [...container.querySelectorAll('label[title]')].map((label) => label.getAttribute('title') ?? '')
}

function click(text: string): void {
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent === text)
  if (button === undefined) throw new Error(`no button labelled ${text}`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('the mail folder tree', () => {
  it('starts collapsed', () => {
    render()
    // Only the mailbox itself; nothing beneath it.
    expect(rows()).toEqual(['mailbox'])
  })

  it('shows everything after Expand all', () => {
    render()
    click('Expand all')
    expect(rows()).toHaveLength(FOLDERS.length)
  })

  it('hides ticked folders on Collapse all, rather than leaving them on screen', () => {
    // The exact case that was reported: things are selected, and collapsing appears to do nothing.
    render(['mailbox\\Inbox\\Alerts', 'mailbox\\Sent'])
    click('Expand all')
    expect(rows()).toHaveLength(FOLDERS.length)

    click('Collapse all')
    expect(rows()).toEqual(['mailbox'])
  })

  it('says how many ticked folders are inside a collapsed branch', () => {
    render(['mailbox\\Inbox\\Alerts', 'mailbox\\Sent'])
    // Summarised rather than concealed — what the ticked exemption was reaching for.
    expect(container.textContent).toContain('2 selected inside')
  })

  it('keeps the selection while it is out of view', () => {
    render(['mailbox\\Inbox\\Alerts'])
    expect(container.textContent).toContain('1 selected of 5')
  })
})
