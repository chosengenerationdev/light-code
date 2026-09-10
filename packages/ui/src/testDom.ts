/**
 * Shims for the parts of the DOM jsdom does not implement.
 *
 * Not shipped and not imported by any component — only by tests. It exists because the
 * alternative is guarding these calls in shipping code, and that decision was already made the
 * other way for `scrollIntoView` in `Select`: every real browser has them, so a guard would be
 * dead weight that also hides a genuine regression.
 *
 * One owner rather than a copy per test file. The second copy is where they start to disagree.
 */

/**
 * Gives every element a no-op `scrollTo`.
 *
 * jsdom performs no layout and implements no scrolling, so the method is simply absent and any
 * component that scrolls throws on mount. Call this in `beforeEach`; a test that wants to
 * *observe* scrolling replaces the method on its own element afterwards.
 */
export function installScrollStub(): void {
  Element.prototype.scrollTo = function scrollTo() {
    /* deliberately empty — replaced per element by tests that assert on it */
  }
}

/**
 * Gives one element the geometry jsdom cannot compute, and records where it is asked to scroll.
 *
 * Without this every element reports `scrollHeight` and `clientHeight` of zero, which makes it
 * trivially "at the bottom" — so a test written against the defaults passes whatever the
 * component does.
 */
export function giveScrollGeometry(
  element: HTMLElement,
  options: { scrollHeight: number; clientHeight: number; scrollTop: number },
): { scrolls: ScrollToOptions[] } {
  Object.defineProperty(element, 'scrollHeight', { value: options.scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: options.clientHeight, configurable: true })
  Object.defineProperty(element, 'scrollTop', { value: options.scrollTop, writable: true, configurable: true })

  const scrolls: ScrollToOptions[] = []
  element.scrollTo = ((request: ScrollToOptions) => {
    scrolls.push(request)
  }) as HTMLElement['scrollTo']
  return { scrolls }
}
