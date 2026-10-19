// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { MarkdownView } from './MarkdownView.js'

/**
 * A link in a reply opens in a new window, which every host turns into the right thing: VS Code and
 * Fire Code open the default browser, a browser opens a tab. Reported from Fire Code: without it the
 * click navigated the chat's own frame, and the site showed "content is blocked" because it refuses
 * to be framed.
 */
describe('links in a reply', () => {
  it('open in a new window, without handing the chat page to the site', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(<MarkdownView text="See [the docs](https://example.com/docs) or [mail](mailto:a@example.com)." />))
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/docs', 'mailto:a@example.com'])
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toContain('noopener')
    }
    act(() => root.unmount())
  })
})
