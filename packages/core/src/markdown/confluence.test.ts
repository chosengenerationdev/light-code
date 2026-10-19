import { describe, expect, it } from 'vitest'
import { markdownToStorage } from './confluence.js'

/**
 * Reported: pages the agent wrote looked plainer than the same content in the chat. The page is now
 * written from the chat's own Markdown, so each part the chat renders has its Confluence counterpart.
 */
describe('Markdown to a Confluence page', () => {
  it('keeps headings, emphasis, lists, quotes, rules and links', () => {
    const page = markdownToStorage('## Summary\n\nTwo jobs **failed**, *again*, ~~fixed~~.\n\n- one\n- two\n\n1. first\n\n> careful\n\n---\n\nSee [runbook](https://wiki.example.com/r).')
    expect(page).toContain('<h2>Summary</h2>')
    expect(page).toContain('<p>Two jobs <strong>failed</strong>, <em>again</em>, <span style="text-decoration: line-through;">fixed</span>.</p>')
    expect(page).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(page).toContain('<ol><li>first</li></ol>')
    expect(page).toContain('<blockquote><p>careful</p></blockquote>')
    expect(page).toContain('<hr />')
    expect(page).toContain('<a href="https://wiki.example.com/r">runbook</a>')
  })

  it('gives a table a header row, which Confluence shades, and keeps column alignment', () => {
    const page = markdownToStorage('| Job | Status |\n| --- | :---: |\n| PAY_LOAD | FAILURE |')
    expect(page).toBe(
      '<table><tbody><tr><th><p>Job</p></th><th><p style="text-align: center;">Status</p></th></tr>' +
        '<tr><td><p>PAY_LOAD</p></td><td><p style="text-align: center;">FAILURE</p></td></tr></tbody></table>',
    )
  })

  it('puts code in the code macro with a language the macro knows, and plain otherwise', () => {
    expect(markdownToStorage('```python\nprint("a")\n```')).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">py</ac:parameter><ac:plain-text-body><![CDATA[print("a")]]></ac:plain-text-body></ac:structured-macro>',
    )
    // An unknown language would be an error on the page; it is shown as plain code instead.
    expect(markdownToStorage('```cobol\nMOVE A TO B\n```')).not.toContain('ac:name="language"')
  })

  it('cannot be broken out of: markup is escaped and ]]> is split inside code', () => {
    expect(markdownToStorage('a <script>x</script> & b')).toBe('<p>a &lt;script&gt;x&lt;/script&gt; &amp; b</p>')
    const code = markdownToStorage('```\nx = "]]>"\n```')
    expect(code).toContain('<![CDATA[x = "]]]]><![CDATA[>"]]>')
    // A link with an unsafe scheme keeps its words and loses the link.
    expect(markdownToStorage('[click](javascript:alert(1))')).not.toContain('href')
  })
})
