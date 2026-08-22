/**
 * The operator guide as a page.
 *
 * `--guide` printed to the terminal, which is right over SSH and wrong as a default — a guide is
 * something you read, and a wall of markdown in a console is the format people were trying to get
 * away from. So it opens a page, and still prints when there is nowhere to open one.
 *
 * ## A renderer, not a markdown library
 *
 * This handles exactly what `docs/hosting.md` contains — headings, paragraphs, fenced code,
 * bullets, numbered steps, tables, block quotes, rules, and inline bold/code/links. Counted, not
 * guessed. A general markdown library would be a dependency in a package whose whole point is
 * installing with no network, to render one document this repository controls.
 *
 * If the guide grows a construct this does not cover, it renders as a paragraph rather than
 * breaking — the failure is plain text, never a mangled page.
 */

/** Escapes before anything else, so nothing in the document can inject markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Inline formatting, applied to already-escaped text.
 *
 * Code spans are taken first and their contents left alone: a backticked `**not bold**` is a
 * literal, and the guide contains command lines where that matters.
 */
export function renderInline(text: string): string {
  const escaped = escapeHtml(text)
  const codeSpans: string[] = []
  /*
   * A sentinel that cannot occur in the document. A bare index would collide with any number in
   * the prose — "6 files" would come back as a code span — and this guide is full of numbers.
   */
  const withPlaceholders = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code)
    return `${String(codeSpans.length - 1)}`
  })

  const formatted = withPlaceholders
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Only http(s), and rel'd: the guide has one link, and a page opened from a CLI should not be
    // the thing that introduces a novel scheme.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')

  return formatted.replace(/(\d+)/g, (_match, index: string) => `<code>${codeSpans[Number(index)] ?? ''}</code>`)
}

interface TableRow {
  cells: string[]
}

function renderTable(rows: TableRow[]): string {
  // A markdown table's second row is the alignment separator, which is scaffolding, not content.
  const [header, , ...body] = rows
  const head =
    header === undefined
      ? ''
      : `<thead><tr>${header.cells.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`
  const rest = body
    .map((row) => `<tr>${row.cells.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('')
  // Wrapped so a wide table scrolls inside itself rather than making the page scroll sideways.
  return `<div class="scroll-x"><table>${head}<tbody>${rest}</tbody></table></div>`
}

const cellsOf = (line: string): string[] =>
  line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())

export function markdownToHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    // Fenced code. Taken first and consumed whole: everything inside is literal, including the
    // `#` and `|` that would otherwise read as a heading or a table.
    if (line.startsWith('```')) {
      const body: string[] = []
      index++
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '')
        index++
      }
      index++
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6}) (.*)$/.exec(line)
    if (heading !== null) {
      const level = (heading[1] ?? '#').length
      const text = heading[2] ?? ''
      // An id per heading, so the contents list can link to it.
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      out.push(`<h${String(level)} id="${id}">${renderInline(text)}</h${String(level)}>`)
      index++
      continue
    }

    if (/^---+\s*$/.test(line)) {
      out.push('<hr />')
      index++
      continue
    }

    if (line.startsWith('|')) {
      const rows: TableRow[] = []
      while (index < lines.length && (lines[index] ?? '').startsWith('|')) {
        rows.push({ cells: cellsOf(lines[index] ?? '') })
        index++
      }
      out.push(renderTable(rows))
      continue
    }

    if (line.startsWith('> ')) {
      const body: string[] = []
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        body.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index++
      }
      out.push(`<blockquote>${renderInline(body.join(' '))}</blockquote>`)
      continue
    }

    const bullet = /^\s*[-*] (.*)$/.exec(line)
    if (bullet !== null) {
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = /^\s*[-*] (.*)$/.exec(current)
        if (match !== null) {
          items.push(match[1] ?? '')
          index++
          continue
        }
        // A continuation line: indented, not blank, not a new item. Joined into the item above,
        // because the guide wraps its longer bullets and they are one thought.
        if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`
          index++
          continue
        }
        break
      }
      out.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`)
      continue
    }

    const ordered = /^\s*\d+\. (.*)$/.exec(line)
    if (ordered !== null) {
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const match = /^\s*\d+\. (.*)$/.exec(current)
        if (match !== null) {
          items.push(match[1] ?? '')
          index++
          continue
        }
        if (/^\s+\S/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`
          index++
          continue
        }
        break
      }
      out.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`)
      continue
    }

    if (line.trim().length === 0) {
      index++
      continue
    }

    // A paragraph, gathering its wrapped continuation lines.
    const body: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (
        current.trim().length === 0 ||
        current.startsWith('```') ||
        current.startsWith('|') ||
        current.startsWith('>') ||
        /^#{1,6} /.test(current) ||
        /^---+\s*$/.test(current) ||
        /^\s*[-*] /.test(current) ||
        /^\s*\d+\. /.test(current)
      ) {
        break
      }
      body.push(current)
      index++
    }
    out.push(`<p>${renderInline(body.join(' '))}</p>`)
  }

  return out.join('\n')
}

/**
 * A self-contained page. No network of any kind — invariant 4 applies to a page this product
 * produces just as it does to the webview, and a guide that needed a CDN to be readable would be
 * unreadable in exactly the airgapped deployment it is written for.
 */
export function guidePage(markdown: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Light Code — operator guide</title>
<style>
  :root {
    --ground: #fbfbf9; --surface: #f3f5f2; --ink: #16201a; --soft: #4a564e;
    --faint: #78837b; --rule: #dde1dc; --accent: #2f7d4f; --alert: #a8331d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #12150f; --surface: #1c211d; --ink: #e6eae4; --soft: #a8b2a8;
      --faint: #7d867e; --rule: #2b322b; --accent: #57b47f; --alert: #e0836c;
    }
  }
  * { box-sizing: border-box; }
  body {
    background: var(--ground); color: var(--ink); margin: 0;
    padding: 0 24px 80px;
    font: 16px/1.6 ui-serif, Charter, Georgia, serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 820px; margin: 0 auto; }
  h1, h2, h3, h4 {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.2; text-wrap: balance; margin: 1.8em 0 0.4em;
  }
  h1 { font-size: 2.1rem; letter-spacing: -0.02em; margin-top: 1.2em; }
  h2 { font-size: 1.5rem; letter-spacing: -0.015em; padding-top: 0.6em; border-top: 1px solid var(--rule); }
  h3 { font-size: 1.1rem; }
  p, li { max-width: 68ch; }
  a { color: var(--accent); }
  code {
    font: 0.86em ui-monospace, "Cascadia Code", Consolas, monospace;
    background: var(--surface); border: 1px solid var(--rule); border-radius: 3px; padding: 0.1em 0.32em;
  }
  pre {
    background: var(--surface); border: 1px solid var(--rule); border-left: 3px solid var(--accent);
    border-radius: 4px; padding: 14px 16px; overflow-x: auto;
    font: 13px/1.65 ui-monospace, "Cascadia Code", Consolas, monospace;
  }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  blockquote {
    margin: 1.2em 0; padding: 12px 16px; border-left: 3px solid var(--alert);
    background: var(--surface); border-radius: 0 4px 4px 0; color: var(--ink);
  }
  blockquote p { margin: 0; }
  .scroll-x { overflow-x: auto; margin: 1.2em 0; }
  table { border-collapse: collapse; width: 100%; font: 14px/1.5 system-ui, sans-serif; }
  th, td { text-align: left; vertical-align: top; padding: 9px 14px 9px 0; border-bottom: 1px solid var(--rule); }
  th { color: var(--faint); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 500; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 2.4em 0; }
  ul, ol { padding-left: 22px; }
  li { margin: 0.4em 0; }
</style>
</head>
<body><main>
${markdownToHtml(markdown)}
</main></body>
</html>
`
}
