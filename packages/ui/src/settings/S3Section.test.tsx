// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { S3Section, type S3SectionProps } from './S3Section.js'

/**
 * That a bucket folder can be marked as the one new files are published to — **for Python tools
 * as well as skills**.
 *
 * A render test because the defect was a single rendering condition, and therefore invisible to
 * every test of the behaviour it prevented. `onToolSaved` in `bridge.ts` had always uploaded a
 * newly created tool to whichever mirror carries `publish`, and `python/sharedWiring.test.ts`
 * asserts that it does. No control had ever set the flag on a `tools` mirror, so the host's
 * condition was unreachable: tools came *down* from a bucket and never went back up, which reads
 * from the outside as syncing being broken rather than as half of it being missing.
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

const base: Omit<S3SectionProps, 'kind'> = {
  connections: [
    {
      id: 'team',
      label: 'Team bucket',
      bucket: 'example-bucket',
      region: 'eu-west-1',
      accessKeyId: 'AKIAEXAMPLE',
      hasSecret: true,
    },
    {
      id: 'readonly',
      label: 'Published bucket',
      bucket: 'example-published',
      region: 'eu-west-1',
      accessKeyId: 'AKIAEXAMPLE2',
      hasSecret: true,
      readOnly: true,
    },
  ],
  problems: [],
  mirrors: [{ connectionId: 'team', prefix: 'tools/', enabled: true }],
  folders: [],
  onSaveConnection: () => {},
  onDeleteConnection: () => {},
  onSaveMirrors: () => {},
  onSync: () => {},
}

function render(props: S3SectionProps): void {
  act(() => root.render(<S3Section {...props} />))
}

/** The publish checkbox, found by its label rather than by position. */
function publishBox(): HTMLInputElement | undefined {
  return [...container.querySelectorAll('label')]
    .filter((label) => label.textContent?.includes('Save new here') === true)
    .map((label) => label.querySelector('input[type="checkbox"]'))
    .find((input): input is HTMLInputElement => input !== null)
}

describe('S3Section publish control', () => {
  it('offers it for Python tools', () => {
    // The assertion the bug would have failed. Everything else about tools syncing was present.
    render({ ...base, kind: 'tools' })
    expect(publishBox()).toBeDefined()
  })

  it('still offers it for skills', () => {
    render({ ...base, kind: 'skills' })
    expect(publishBox()).toBeDefined()
  })

  it('reports the choice back for tools, so the host can act on it', () => {
    let saved: { connectionId: string; publish?: boolean | undefined }[] | undefined
    render({ ...base, kind: 'tools', onSaveMirrors: (mirrors) => void (saved = mirrors) })

    const box = publishBox()
    expect(box).toBeDefined()
    act(() => {
      box?.click()
    })

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save folders',
    )
    act(() => save?.click())

    expect(saved?.[0]?.publish).toBe(true)
  })

  it('refuses a read-only connection rather than accepting a tick that does nothing', () => {
    /*
     * The host declines an upload to a read-only target silently, which is right — but a control
     * that can be set and has no effect is the shape this project keeps paying for. Disabled and
     * explained beats accepted and ignored.
     */
    render({
      ...base,
      kind: 'tools',
      mirrors: [{ connectionId: 'readonly', enabled: true }],
    })
    expect(publishBox()?.disabled).toBe(true)
  })
})
