/**
 * The chat's Markdown parser lives in core (`markdown/parse.ts`), because Confluence pages are written
 * from the same Markdown: one reading of it, so a page and the chat cannot disagree about what a table
 * or a code block is. Re-exported here so the UI's imports stay where they were.
 */
export { isSafeHref, looksLikeMarkdown, parseInline, parseMarkdown, type Align, type Block, type Inline } from '@light-code/core/browser'
