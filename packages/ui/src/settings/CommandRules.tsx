import type { CommandRules } from '@light-code/core/browser'
import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'

import { TrashIcon } from '../icons.js'
import { colors, iconButtonStyle, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

/**
 * The user's own command rules: what always asks, and what Auto mode may run unprompted.
 *
 * ## Why this exists
 *
 * Both lists have been in the config schema and in the approval path since they were added, and
 * neither ever had anywhere to be edited. So the honest answer to "how do I add my own rule for
 * Auto mode" was "hand-edit `config.json`", and nobody was told that either. That is the same
 * shape as the `always: true` skill flag and the per-project override, each of which shipped with
 * no way to reach it and was therefore indistinguishable from not existing.
 *
 * ## Why the two lists are worded differently
 *
 * They are not symmetric and this panel must not imply that they are. A wrong **risky** rule
 * fails closed — an extra prompt, or no match and the command sits in front of the ordinary
 * prompt anyway. A wrong **safe** rule fails open: something runs that nobody saw. That asymmetry
 * is why risky rules match a substring anywhere and safe ones match a prefix, and why the safe
 * list spends its words on what it is giving away rather than on how to use it.
 *
 * ## Global, unlike the approvals above it
 *
 * "Never run `rm -rf` without asking me" is a statement about how somebody works rather than
 * about one project, and having to repeat it per repository is how it ends up missing from the
 * one that mattered. Stored in user scope for the reason invariant 5 lists `commands`: a
 * repository able to write here would pre-*disarm* the check, and the first anybody would know is
 * a command that never stopped.
 */

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface CommandRulesSectionProps {
  rules: CommandRules
  onSave: (rules: CommandRules) => void
}

export function CommandRulesSection(props: CommandRulesSectionProps): ReactElement {
  /*
   * Edited as a whole and saved as one, resynced from props **by value**.
   *
   * The object is rebuilt on every settings message from the host, so depending on its identity
   * would discard whatever was half-typed each time anything unrelated arrived — the bug
   * `S3Section` records having had.
   */
  /*
   * `?? {}` although the prop is required, and that is not belt-and-braces.
   *
   * `SettingsNavigation.test.tsx` renders every tab with nothing configured, which is the state a
   * panel is genuinely in between opening and the host's first `settings` message. It exists
   * because four tabs once threw on a missing array in exactly that window, and this one threw
   * too the moment it was written.
   */
  const saved = JSON.stringify(props.rules ?? {})
  const [draft, setDraft] = useState<CommandRules>(() => JSON.parse(saved) as CommandRules)
  useEffect(() => setDraft(JSON.parse(saved) as CommandRules), [saved])

  const dirty = JSON.stringify(draft) !== saved
  const risky = draft.risky ?? []
  const safe = draft.safe ?? []

  const setRisky = (next: typeof risky): void => setDraft({ ...draft, risky: next })
  const setSafe = (next: string[]): void => setDraft({ ...draft, safe: next })

  return (
    <section style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <h4 style={{ margin: '0 0 4px' }}>Command rules</h4>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 14px', lineHeight: 1.5 }}>
        These apply in every workspace, not just this one, and are kept with your own settings so
        no repository can change them.
      </p>

      <label style={labelStyle()}>Always ask about</label>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px', lineHeight: 1.5 }}>
        Matched anywhere in the command, ignoring case. Checked before everything else, so a rule
        here beats an always-allowed command and every toggle above it. Getting one of these wrong
        costs you a prompt, which is the direction worth erring in.
      </p>
      {risky.map((rule, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
            padding: '3px 0',
          }}
        >
          <input
            type="text"
            value={rule.contains}
            placeholder="rm -rf"
            spellCheck={false}
            aria-label="Text to match"
            onChange={(event) =>
              setRisky(
                risky.map((other, at) =>
                  at === index ? { ...other, contains: event.target.value } : other,
                ),
              )
            }
            style={{ ...textFieldStyle(), fontFamily: monospace, flex: 1, minWidth: 130 }}
          />
          <input
            type="text"
            value={rule.reason ?? ''}
            placeholder="why — shown on the prompt"
            aria-label="Reason"
            onChange={(event) =>
              setRisky(
                risky.map((other, at) =>
                  at === index ? { ...other, reason: event.target.value } : other,
                ),
              )
            }
            style={{ ...textFieldStyle(), flex: 1, minWidth: 130 }}
          />
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
            title={
              'Refuse it outright instead of asking. For the ones where the answer is always no: ' +
              'putting it in front of you again only invites the click you were protecting ' +
              'yourself from.'
            }
          >
            <input
              type="checkbox"
              checked={rule.refuse === true}
              onChange={(event) =>
                setRisky(
                  risky.map((other, at) =>
                    at === index ? { ...other, refuse: event.target.checked } : other,
                  ),
                )
              }
            />
            Never run
          </label>
          <button
            type="button"
            style={iconButtonStyle('secondary')}
            aria-label={`Remove rule ${rule.contains}`}
            onClick={() => setRisky(risky.filter((_, at) => at !== index))}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        style={secondaryButtonStyle()}
        onClick={() => setRisky([...risky, { contains: '' }])}
      >
        Add a rule
      </button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 10 }}>
        <input
          type="checkbox"
          checked={draft.builtinRisky !== false}
          onChange={(event) => setDraft({ ...draft, builtinRisky: event.target.checked })}
        />
        Also use the built-in list
      </label>
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 2 }}>
        Recursive deletes, force pushes, dropping tables, piping a download into a shell, and a
        few others. Deliberately short, so it stays out of the way of ordinary work.
      </span>

      <label style={{ ...labelStyle(), marginTop: 16 }}>Run without asking, in Auto mode</label>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px', lineHeight: 1.5 }}>
        Matched at the <strong>start</strong> of the command, and only while the mode is Auto
        &mdash; every other mode still asks for all of these. A command that could be more than one
        command never qualifies whatever it starts with, so{' '}
        <code style={{ fontFamily: monospace }}>grep foo &amp;&amp; rm -rf /</code> is still
        stopped. The leading program is matched by name, so reaching it by a full path counts as
        the same program.
      </p>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px', lineHeight: 1.5 }}>
        Add only what reads, prints or compiles, and ask the two questions the built-in list was
        written against: can it write or delete through its own flags, and can it run something it
        was handed? <code style={{ fontFamily: monospace }}>find</code> fails the first;{' '}
        <code style={{ fontFamily: monospace }}>python somefile.py</code> fails the second.
      </p>
      {safe.map((prefix, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' }}>
          <input
            type="text"
            value={prefix}
            placeholder="dotnet build"
            spellCheck={false}
            aria-label="Command that may run unprompted"
            onChange={(event) =>
              setSafe(safe.map((other, at) => (at === index ? event.target.value : other)))
            }
            style={{ ...textFieldStyle(), fontFamily: monospace, flex: 1 }}
          />
          <button
            type="button"
            style={iconButtonStyle('secondary')}
            aria-label={`Remove ${prefix}`}
            onClick={() => setSafe(safe.filter((_, at) => at !== index))}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <button type="button" style={secondaryButtonStyle()} onClick={() => setSafe([...safe, ''])}>
        Add a command
      </button>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 10 }}>
        <input
          type="checkbox"
          checked={draft.builtinSafe !== false}
          onChange={(event) => setDraft({ ...draft, builtinSafe: event.target.checked })}
        />
        Also use the built-in list
      </label>
      <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 2 }}>
        <code style={{ fontFamily: monospace }}>ls</code>,{' '}
        <code style={{ fontFamily: monospace }}>cat</code>,{' '}
        <code style={{ fontFamily: monospace }}>grep</code>, the read-only{' '}
        <code style={{ fontFamily: monospace }}>git</code> subcommands, version checks, and
        compiling Python.
      </span>

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={!dirty}
          onClick={() => props.onSave(draft)}
        >
          {dirty ? 'Save rules' : 'Saved'}
        </button>
      </div>
    </section>
  )
}
