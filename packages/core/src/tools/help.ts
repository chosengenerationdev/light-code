import { z } from 'zod'

import { HELP_TOPICS, type HelpTopic } from '../help/topics.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Light Code answering questions about itself.
 *
 * ## Why it is always advertised, when the dispatcher hides most things
 *
 * §12's dispatcher registers tools without advertising them, and the model finds them with
 * `search_docs`. That is right for a catalogue of forty MCP tools, and wrong here: "how do I turn
 * Excel on?" does not look like a request to go and search for a tool, so a model that has to
 * *think of searching* will answer from whatever it half-remembers about products with similar
 * names instead. Being wrong about your own settings, confidently, is the failure this exists to
 * prevent.
 *
 * It costs one definition at the front of the prompt. That is stable for the session, so the
 * cache rule is satisfied — the thing §12 forbids is the block *changing*, not it being one entry
 * larger.
 *
 * ## Why it is `read` and not `always`
 *
 * `always` would make it available in every mode including a scheduled run, and reading the
 * manual unattended is not useful. `read` also means Ask mode has it, which is the mode somebody
 * asking a question is most likely to be in.
 *
 * ## Matching is lexical, on purpose
 *
 * The obvious home is the documentation index, and it is the wrong one: that needs an embedder
 * and a vector store, both off by default. A help system that only works once search is
 * configured is missing exactly when somebody is stuck configuring things. Scoring here is a
 * word count over title, keywords and body — crude, and it does not need to be better, because
 * there are fifteen topics and the model reads whichever it is handed.
 */

const paramsSchema = z.object({
  query: z
    .string()
    .max(300)
    .optional()
    .describe(
      'What the user wants to know, in their own words — "stop it asking about git status", ' +
        '"where do settings live", "turn on Excel". Leave out to list every topic.',
    ),
  topic: z
    .string()
    .max(80)
    .optional()
    .describe('The exact id of a topic, when you already know which one you want.'),
})

export type LightCodeHelpParams = z.infer<typeof paramsSchema>

/** Words too common to tell two topics apart. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'get',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'set', 'the',
  'to', 'up', 'use', 'want', 'what', 'when', 'where', 'which', 'why', 'with', 'you', 'your',
  /*
   * The second row is filler that happens to sit in a *title*, which is where it did damage.
   * "how do I teach it about our internal library" landed on Approvals, whose title is
   * "Approvals: stopping it asking **about** everything" - one filler word, weighted as though
   * it were the subject. Measured, not guessed.
   */
  'about', 'our', 'us', 'this', 'that', 'there', 'them', 'they', 'will', 'have', 'has', 'had',
  'was', 'were', 'been', 'just', 'only', 'some', 'any', 'all', 'into', 'out', 'am', 'so',
])

/**
 * A trailing plural removed, so "approval" and "approvals" are the same word.
 *
 * Crude on purpose - a real stemmer is a dependency and a much larger claim. The exceptions are
 * the ones that actually appear here: `status` must not become `statu`, or `git status`, the
 * question this whole handbook was written for, stops matching itself.
 */
function stem(word: string): string {
  if (word.length <= 3) return word
  if (/(ss|us|is)$/.test(word)) return word
  return word.replace(/s$/, '')
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem)
}

/**
 * How well a topic answers a query.
 *
 * Title and keywords are weighted far above the body, because every topic mentions "approval" and
 * "config" somewhere and only one of them is *about* either. The keyword list exists for the same
 * reason: the words people type are rarely a feature's name — "keeps asking" and "stop asking"
 * both mean the approval gate, and neither is what it is called.
 */
export function scoreTopic(topic: HelpTopic, query: string): number {
  const asked = new Set(words(query))
  if (asked.size === 0) return 0

  const title = new Set(words(topic.title))
  /*
   * A multi-word keyword counts **only** as a phrase, never as its separate words.
   *
   * It names a compound thing, and its parts are generic: `config file` contributed "file" to
   * the overview topic, so "it is not finding my files" scored there as strongly as on
   * troubleshooting, which is about exactly that. Splitting a compound keyword into words does
   * not add specificity, it spends it.
   */
  const keywords = new Set(
    topic.keywords.filter((keyword) => !keyword.includes(' ')).flatMap((keyword) => words(keyword)),
  )
  const phrases = topic.keywords
    .map((keyword) => keyword.toLowerCase())
    .filter((keyword) => keyword.includes(' '))
  const body = new Set(words(topic.body))
  const lowered = query.toLowerCase()

  let score = 0
  /*
   * The body contributes, but only up to a point, and that cap is not a tuning knob.
   *
   * Without it the longest topic wins every vague question purely on volume: `troubleshooting`
   * mentions nearly every feature in passing, so "run something every morning" landed there
   * rather than on `schedules`, which is *about* it. Measured, not guessed - that was a real miss
   * when this was first driven with ordinary questions. A body hit means the topic touches the
   * subject; a title or keyword hit means it is the subject, and only the second should decide.
   */
  let fromBody = 0
  let fromSubject = 0
  for (const word of asked) {
    if (word === stem(topic.id)) fromSubject += 12
    if (title.has(word)) fromSubject += 6
    if (keywords.has(word)) fromSubject += 4
    if (body.has(word)) fromBody += 1
  }
  score += fromSubject + Math.min(fromBody, 3)
  /*
   * A matched multi-word phrase outranks **any** amount of single-word evidence, deliberately.
   *
   * Somebody who typed "dark mode" has named one thing exactly. Before this it scored below
   * Modes, where "mode" alone matched the id, the title and a keyword and added up to more -
   * so the most specific thing the user said lost to the vaguest. The rule is not a tuning
   * constant: a phrase is strictly more specific than a word inside it, so it is weighted above
   * the largest score a single word can reach (12 + 6 + 4).
   */
  for (const phrase of phrases) {
    if (lowered.includes(phrase)) score += 24
  }
  return score
}

/**
 * Below this, nothing matched on a title or a keyword and the "best" topic is body noise.
 *
 * `Math.min(fromBody, 3)` is the ceiling on noise, so a score of 3 or less means *no topic is
 * about this*. Returning the top of a pile of threes reads as a confident answer and is a
 * coin toss - "nothing happens when I send a message" came back as the Outlook topic, which is
 * worse than useless because the model would then explain mail to somebody with a broken
 * session. Saying so and listing the topics is the honest answer.
 */
const CONFIDENT = 4

/** `config:some.key` is a marker for the test that checks the schema; the model sees the key. */
function render(topic: HelpTopic): string {
  return `## ${topic.title}\n(topic id: ${topic.id})\n${topic.body.replace(/config:/g, '')}`
}

function listing(): string {
  return [
    'Light Code help topics. Call this again with `topic` set to one of these ids, or with a',
    '`query` describing what the user asked.',
    '',
    ...HELP_TOPICS.map((topic) => `- \`${topic.id}\` — ${topic.title}`),
  ].join('\n')
}

export function createLightCodeHelpTool(): Tool<LightCodeHelpParams> {
  return {
    name: 'light_code_help',
    group: 'read',
    description:
      "Light Code's own documentation: how to use its features and how to change its settings. " +
      'CALL THIS BEFORE ANSWERING ANY QUESTION ABOUT LIGHT CODE ITSELF — modes, approvals and ' +
      'why it keeps asking permission, the config file and where it lives, skills, Python tools, ' +
      'MCP servers, indexing and search, Excel and Outlook, schedules, agents, checkpoints, or ' +
      'anything that is not working. You will otherwise answer from what you half-remember about ' +
      'other products, which is worse than saying you do not know. Pass the user\'s own words as ' +
      '`query`; with neither argument it lists the topics.',
    parametersSchema: paramsSchema,

    // No preview and no approval: it reads a constant in the bundle. Nothing on disk, nothing on
    // the network, nothing about the workspace.
    async execute(params): Promise<ToolResult> {
      if (params.topic !== undefined && params.topic.trim().length > 0) {
        const wanted = params.topic.trim().toLowerCase()
        const found = HELP_TOPICS.find((topic) => topic.id === wanted)
        if (found !== undefined) return { content: render(found) }
        /*
         * A wrong id falls through to searching for it rather than erroring.
         *
         * The model guesses ids, and "no such topic" spends a turn teaching it something the
         * listing would have told it. Treating the guess as a query almost always lands on what
         * it meant.
         */
        params = { ...params, query: params.query ?? wanted }
      }

      const query = params.query?.trim() ?? ''
      if (query.length === 0) return { content: listing() }

      const ranked = HELP_TOPICS.map((topic) => ({ topic, score: scoreTopic(topic, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)

      if (ranked.length === 0 || (ranked[0] as { score: number }).score < CONFIDENT) {
        return {
          content: [
            `Nothing here is clearly about "${query}".`,
            '',
            listing(),
            '',
            'If none of these covers it, say so plainly rather than guessing — this handbook is',
            'the whole of what Light Code knows about itself.',
          ].join('\n'),
        }
      }

      /*
       * The best one in full, then the next two named.
       *
       * Returning three whole topics would be several thousand tokens for a question with one
       * answer, and returning only one hides a better neighbour when the query straddles two —
       * "the assistant keeps asking about my Python tool" is both approvals and Python tools.
       */
      const best = ranked[0] as { topic: HelpTopic; score: number }
      const alsoRelevant = ranked.slice(1, 3)
      const parts = [render(best.topic)]
      if (alsoRelevant.length > 0) {
        parts.push(
          '',
          '---',
          'Also possibly relevant — call this tool again with one of these ids:',
          ...alsoRelevant.map((entry) => `- \`${entry.topic.id}\` — ${entry.topic.title}`),
        )
      }
      return { content: parts.join('\n') }
    },
  }
}
