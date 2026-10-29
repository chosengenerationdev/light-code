/**
 * Changing a Jenkins job's config.xml - its parameters, its description, or exact pieces of text -
 * without an XML library (a dependency every user downloads, for one tool).
 *
 * Asked for: create a job, copy one into a new job, and "modify that to give new parameters". The
 * parameters are the common change and the easiest to get wrong by hand, so they are structured: the
 * model says name, type, default, description, choices, and this writes Jenkins' own elements. Anything
 * else is an exact find-and-replace on the XML (each must match exactly once), and the approval prompt
 * shows the resulting diff - what Jenkins will be sent, not a description of it (invariant 8).
 *
 * Only element structure is scanned (tags, nesting); text is never parsed beyond <name>, <description>,
 * <defaultValue> and <string> inside a parameter. Values are XML-escaped on the way in.
 */

export type JobParameterType = 'string' | 'text' | 'boolean' | 'choice'

export interface JobParameterInput {
  name: string
  type?: JobParameterType | undefined
  description?: string | undefined
  /** The default; for a choice, which choice comes first. */
  default?: string | boolean | undefined
  choices?: readonly string[] | undefined
}

export interface JobChanges {
  parameters?: { set?: readonly JobParameterInput[] | undefined; remove?: readonly string[] | undefined } | undefined
  description?: string | undefined
  edits?: readonly { find: string; replace: string }[] | undefined
}

const TAGS: Record<JobParameterType, string> = {
  string: 'hudson.model.StringParameterDefinition',
  text: 'hudson.model.TextParameterDefinition',
  boolean: 'hudson.model.BooleanParameterDefinition',
  choice: 'hudson.model.ChoiceParameterDefinition',
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

interface Element {
  tag: string
  /** Index of '<' of the opening tag. */
  start: number
  /** Index just after the opening tag's '>'. */
  innerStart: number
  /** Index of '<' of the closing tag (= innerStart for a self-closing one). */
  innerEnd: number
  /** Index just after the closing tag. */
  end: number
}

/** The elements directly inside [from, to) - tags only, comments and declarations skipped. */
function children(xml: string, from: number, to: number): Element[] {
  const out: Element[] = []
  const tag = /<(\/?)([A-Za-z_][\w.\-:$]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g
  tag.lastIndex = from
  let depth = 0
  let open: { tag: string; start: number; innerStart: number } | undefined
  for (let match = tag.exec(xml); match !== null && match.index < to; match = tag.exec(xml)) {
    if (match[2] === undefined) continue // comment, declaration or CDATA
    const closing = match[1] === '/'
    const selfClosing = match[4] === '/'
    const end = match.index + match[0].length
    if (closing) {
      depth -= 1
      if (depth === 0 && open !== undefined) {
        out.push({ tag: open.tag, start: open.start, innerStart: open.innerStart, innerEnd: match.index, end })
        open = undefined
      }
    } else if (selfClosing) {
      if (depth === 0) out.push({ tag: match[2], start: match.index, innerStart: end, innerEnd: end, end })
    } else {
      if (depth === 0) open = { tag: match[2], start: match.index, innerStart: end }
      depth += 1
    }
  }
  return out
}

function rootOf(xml: string): Element {
  const root = children(xml, 0, xml.length)[0]
  if (root === undefined) throw new Error('The job configuration is not XML Jenkins would accept (no root element).')
  return root
}

function childNamed(xml: string, parent: Element, tag: string): Element | undefined {
  return children(xml, parent.innerStart, parent.innerEnd).find((child) => child.tag === tag)
}

function textOf(xml: string, parent: Element, tag: string): string | undefined {
  const child = childNamed(xml, parent, tag)
  return child === undefined ? undefined : unescapeXml(xml.slice(child.innerStart, child.innerEnd).trim())
}

function lineIndent(xml: string, at: number): string {
  const lineStart = xml.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(xml.slice(lineStart, at))?.[0] ?? ''
}

interface ParsedParameter {
  element: Element
  name: string
  type?: JobParameterType
  description?: string
  default?: string
  choices?: string[]
}

function parseParameter(xml: string, element: Element): ParsedParameter {
  const type = (Object.entries(TAGS).find(([, tag]) => tag === element.tag)?.[0] as JobParameterType | undefined) ?? undefined
  const choicesElement = childNamed(xml, element, 'choices')
  const choices =
    choicesElement === undefined
      ? undefined
      : [...xml.slice(choicesElement.innerStart, choicesElement.innerEnd).matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unescapeXml(match[1] ?? ''))
  const description = textOf(xml, element, 'description')
  const defaultValue = textOf(xml, element, 'defaultValue')
  return {
    element,
    name: textOf(xml, element, 'name') ?? '',
    ...(type !== undefined ? { type } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(choices !== undefined ? { choices } : {}),
  }
}

function renderParameter(input: { name: string; type: JobParameterType; description?: string | undefined; default?: string | undefined; choices?: readonly string[] | undefined }, indent: string): string {
  const inner = `${indent}  `
  const lines = [`${indent}<${TAGS[input.type]}>`, `${inner}<name>${escapeXml(input.name)}</name>`, `${inner}<description>${escapeXml(input.description ?? '')}</description>`]
  if (input.type === 'choice') {
    const choices = [...(input.choices ?? [])]
    if (choices.length === 0) throw new Error(`The choice parameter "${input.name}" needs at least one choice.`)
    // Jenkins' default for a choice is the first one.
    if (input.default !== undefined) {
      const at = choices.indexOf(input.default)
      if (at < 0) throw new Error(`The default "${input.default}" is not one of the choices of "${input.name}" (${choices.join(', ')}).`)
      choices.splice(at, 1)
      choices.unshift(input.default)
    }
    lines.push(`${inner}<choices class="java.util.Arrays$ArrayList">`, `${inner}  <a class="string-array">`)
    for (const choice of choices) lines.push(`${inner}    <string>${escapeXml(choice)}</string>`)
    lines.push(`${inner}  </a>`, `${inner}</choices>`)
  } else if (input.type === 'boolean') {
    lines.push(`${inner}<defaultValue>${input.default === 'true' ? 'true' : 'false'}</defaultValue>`)
  } else {
    lines.push(`${inner}<defaultValue>${escapeXml(input.default ?? '')}</defaultValue>`)
    if (input.type === 'string') lines.push(`${inner}<trim>false</trim>`)
  }
  lines.push(`${indent}</${TAGS[input.type]}>`)
  return lines.join('\n')
}

/** The job's parameter list, as name/type/default - for a preview and for tests. */
export function jobParameters(xml: string): { name: string; type: string; default?: string; choices?: string[] }[] {
  const definitions = findDefinitions(xml)
  if (definitions === undefined) return []
  return children(xml, definitions.innerStart, definitions.innerEnd).map((element) => {
    const parsed = parseParameter(xml, element)
    return {
      name: parsed.name,
      type: parsed.type ?? element.tag,
      ...(parsed.default !== undefined ? { default: parsed.default } : {}),
      ...(parsed.choices !== undefined ? { choices: parsed.choices } : {}),
    }
  })
}

function findDefinitions(xml: string): Element | undefined {
  const root = rootOf(xml)
  const properties = childNamed(xml, root, 'properties')
  if (properties === undefined) return undefined
  const property = childNamed(xml, properties, 'hudson.model.ParametersDefinitionProperty')
  if (property === undefined) return undefined
  return childNamed(xml, property, 'parameterDefinitions')
}

/** Makes sure <properties><ParametersDefinitionProperty><parameterDefinitions> exists, and returns the XML. */
function ensureDefinitions(xml: string): string {
  const found = findDefinitions(xml)
  if (found !== undefined && found.innerStart === found.innerEnd && xml.slice(found.start, found.end).endsWith('/>')) {
    // <parameterDefinitions/>: opened up so a parameter can go inside.
    const indent = lineIndent(xml, found.start)
    return xml.slice(0, found.start) + `<parameterDefinitions>\n${indent}</parameterDefinitions>` + xml.slice(found.end)
  }
  if (found !== undefined) return xml
  const root = rootOf(xml)
  const properties = childNamed(xml, root, 'properties')
  const block = (indent: string): string =>
    [`${indent}<hudson.model.ParametersDefinitionProperty>`, `${indent}  <parameterDefinitions>`, `${indent}  </parameterDefinitions>`, `${indent}</hudson.model.ParametersDefinitionProperty>`].join('\n')
  if (properties === undefined) {
    const indent = '  '
    const insert = `${indent}<properties>\n${block(`${indent}  `)}\n${indent}</properties>\n`
    return xml.slice(0, root.innerEnd) + insert + xml.slice(root.innerEnd)
  }
  const indent = lineIndent(xml, properties.start)
  if (properties.innerStart === properties.innerEnd && xml.slice(properties.start, properties.end).endsWith('/>')) {
    const replacement = `<properties>\n${block(`${indent}  `)}\n${indent}</properties>`
    return xml.slice(0, properties.start) + replacement + xml.slice(properties.end)
  }
  const existing = childNamed(xml, properties, 'hudson.model.ParametersDefinitionProperty')
  if (existing !== undefined) {
    // The property is there without its list - give it one.
    const inner = `${lineIndent(xml, existing.start)}  `
    const list = `\n${inner}<parameterDefinitions>\n${inner}</parameterDefinitions>\n${lineIndent(xml, existing.start)}`
    if (existing.innerStart === existing.innerEnd) {
      const tag = 'hudson.model.ParametersDefinitionProperty'
      return xml.slice(0, existing.start) + `<${tag}>${list}</${tag}>` + xml.slice(existing.end)
    }
    return xml.slice(0, existing.innerStart) + list + xml.slice(existing.innerStart)
  }
  return xml.slice(0, properties.innerStart) + `\n${block(`${indent}  `)}` + xml.slice(properties.innerStart)
}

/** Applies the changes and says what each did. Throws, naming the problem, rather than half-applying. */
export function applyJobChanges(original: string, changes: JobChanges): { xml: string; notes: string[] } {
  let xml = original
  const notes: string[] = []

  for (const edit of changes.edits ?? []) {
    if (edit.find.length === 0) throw new Error('An edit has nothing to find.')
    const first = xml.indexOf(edit.find)
    if (first < 0) throw new Error(`Not found in the job configuration, so nothing was changed: ${JSON.stringify(edit.find.slice(0, 120))}`)
    if (xml.indexOf(edit.find, first + edit.find.length) >= 0) {
      throw new Error(`Found more than once in the job configuration - include more around it so it is unique: ${JSON.stringify(edit.find.slice(0, 120))}`)
    }
    xml = xml.slice(0, first) + edit.replace + xml.slice(first + edit.find.length)
    notes.push('edited the configuration text')
  }

  if (changes.description !== undefined) {
    const root = rootOf(xml)
    const description = childNamed(xml, root, 'description')
    const value = escapeXml(changes.description)
    if (description === undefined) {
      xml = xml.slice(0, root.innerStart) + `\n  <description>${value}</description>` + xml.slice(root.innerStart)
    } else {
      xml = xml.slice(0, description.start) + `<description>${value}</description>` + xml.slice(description.end)
    }
    notes.push('set the description')
  }

  const remove = changes.parameters?.remove ?? []
  const set = changes.parameters?.set ?? []
  if (remove.length > 0 || set.length > 0) {
    xml = ensureDefinitions(xml)
    for (const name of remove) {
      const definitions = findDefinitions(xml)
      const found = definitions === undefined ? undefined : children(xml, definitions.innerStart, definitions.innerEnd).find((element) => parseParameter(xml, element).name === name)
      if (found === undefined) throw new Error(`The job has no parameter "${name}" to remove.`)
      const lineStart = xml.lastIndexOf('\n', found.start - 1)
      xml = xml.slice(0, lineStart >= 0 ? lineStart : found.start) + xml.slice(found.end)
      notes.push(`removed parameter ${name}`)
    }
    for (const input of set) {
      if (input.name.trim().length === 0) throw new Error('A parameter needs a name.')
      const definitions = findDefinitions(xml)
      if (definitions === undefined) throw new Error('Could not find where the job keeps its parameters.')
      const existingElement = children(xml, definitions.innerStart, definitions.innerEnd).find((element) => parseParameter(xml, element).name === input.name)
      const existing = existingElement === undefined ? undefined : parseParameter(xml, existingElement)
      if (existing !== undefined && existing.type === undefined && input.type === undefined) {
        throw new Error(`The parameter "${input.name}" is of a kind this tool does not rewrite (${existing.element.tag}). Give a type to replace it, or change it with edits.`)
      }
      const type = input.type ?? existing?.type ?? 'string'
      const defaultValue = input.default !== undefined ? String(input.default) : existing?.default ?? (type === 'choice' ? existing?.choices?.[0] : undefined)
      const merged = {
        name: input.name,
        type,
        description: input.description ?? existing?.description,
        default: defaultValue,
        choices: input.choices ?? existing?.choices,
      }
      if (existingElement !== undefined) {
        const rendered = renderParameter(merged, lineIndent(xml, existingElement.start))
        xml = xml.slice(0, existingElement.start) + rendered.trimStart() + xml.slice(existingElement.end)
        notes.push(`changed parameter ${input.name}`)
      } else {
        const indent = `${lineIndent(xml, definitions.start)}  `
        const closeIndent = lineIndent(xml, definitions.innerEnd)
        // Appended after the last parameter, before the closing tag's own line.
        const before = xml.slice(0, definitions.innerEnd).replace(/[ \t]*$/, '')
        const glue = before.endsWith('\n') ? '' : '\n'
        xml = `${before}${glue}${renderParameter(merged, indent)}\n${closeIndent}${xml.slice(definitions.innerEnd)}`
        notes.push(`added parameter ${input.name}`)
      }
    }
  }
  return { xml, notes }
}
