import { useMemo, useState, type ReactElement } from 'react'
import type { TokenCommandInput } from '@light-code/core/browser'

import { colors, labelStyle, textFieldStyle } from '../theme.js'
import { PathField, type BrowseRequest } from './PathField.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export const TOKEN_SCRIPT_PURPOSE = 'tokenScript'

export interface TokenCommandFieldsProps {
  value: TokenCommandInput
  onChange: (next: TokenCommandInput) => void
  /** The shared dialog, keyed by purpose. Absent in a browser, where the field is the whole UI. */
  onBrowse?: ((request: BrowseRequest) => void) | undefined
  /** What the host's picker returned, if it was this field that asked. */
  pickedPath?: { purpose: string; path: string } | undefined
}

/**
 * Configuring a program that fetches the token, shaped around the case people actually have.
 *
 * ## Why it is "a script" rather than "a command"
 *
 * The mechanism underneath is argv, and argv is what gets stored. But nobody has an argv array —
 * they have *a Python script* that their internal library backs, and asking them to decompose that
 * into `["python", "/path/to/x.py"]` is asking them to learn an implementation detail in order to
 * describe something they already know. So the common shape gets fields, and the general shape
 * stays reachable one toggle away.
 *
 * ## Why both modes exist rather than only the friendly one
 *
 * Because the friendly one cannot express everything, and a form that silently cannot round-trip
 * what is in the config file is worse than no form: it rewrites a working credential into
 * something it can represent. Mode is *derived* from the stored command rather than stored
 * separately — two fields recording one fact is the drift this project keeps paying for — so a
 * hand-written `["python", "-c", "..."]` opens in raw mode and saves back unchanged.
 *
 * ## Why the script path stays typeable
 *
 * §19's rule: no `HostUi` method may be load-bearing. A browser has no native picker, so `onBrowse`
 * is absent there and the text field is the whole interface. Browse is an addition to it, never a
 * replacement for it.
 */
export function TokenCommandFields(props: TokenCommandFieldsProps): ReactElement {
  const command = props.value.command

  /*
   * Script mode when the command looks like one: an interpreter followed by a `.py` file.
   * Derived rather than remembered, so it cannot disagree with what is actually stored.
   */
  const looksLikeScript = useMemo(
    () => command.length >= 2 && (command[1] ?? '').trim().toLowerCase().endsWith('.py'),
    [command],
  )
  const [raw, setRaw] = useState(!looksLikeScript && command.length > 0)
  const [advanced, setAdvanced] = useState(false)

  const scriptMode = !raw && (looksLikeScript || command.length === 0)

  const interpreter = scriptMode ? (command[0] ?? 'python') : ''
  const script = scriptMode ? (command[1] ?? '') : ''
  const extraArgs = scriptMode ? command.slice(2) : []

  /*
   * Only a pick this field asked for. `purpose` is what keeps one shared dialog from dropping a
   * certificate path into the script box — every settings field shares the same round trip.
   */
  const effectiveScript =
    props.pickedPath?.purpose === TOKEN_SCRIPT_PURPOSE ? props.pickedPath.path : script

  const setScriptParts = (next: { interpreter?: string; script?: string; args?: string[] }): void => {
    props.onChange({
      ...props.value,
      command: [
        next.interpreter ?? interpreter,
        next.script ?? effectiveScript,
        ...(next.args ?? extraArgs),
      ].filter((part, index) => index < 2 || part.trim().length > 0),
    })
  }

  const set = <K extends keyof TokenCommandInput>(key: K, value: TokenCommandInput[K]): void => {
    props.onChange({ ...props.value, [key]: value })
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
        Light Code runs this and uses what it prints as the token, fetching a new one before the old
        one expires. Useful when something else already does your gateway&rsquo;s authentication
        &mdash; the credential logic stays where it is, and Light Code never learns how it works.
      </p>

      {scriptMode ? (
        <>
          <PathField
            id="lc-token-script"
            label="Python script"
            value={effectiveScript}
            placeholder={`C:\\path\\to\\get_token.py`}
            hint="It must print the token and nothing else, then exit 0. Send any logging to stderr — output with a space or a newline in it is refused rather than sent as a bearer token, because a stray log line becomes a 401 that looks like a bad credential."
            browse={{ purpose: TOKEN_SCRIPT_PURPOSE, kind: 'file', extensions: ['py'] }}
            {...(props.onBrowse === undefined ? {} : { onBrowse: props.onBrowse })}
            onChange={(value) => setScriptParts({ script: value })}
          />

          <label htmlFor="lc-token-interpreter" style={labelStyle()}>
            Interpreter
          </label>
          <input
            id="lc-token-interpreter"
            type="text"
            value={interpreter}
            spellCheck={false}
            placeholder="python"
            onChange={(event) => setScriptParts({ interpreter: event.target.value })}
            style={{ ...textFieldStyle(), fontFamily: monospace }}
          />
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
            Resolved on the PATH Light Code was started with. Give a full path if the one holding
            your library is not the first on it &mdash; in Python, <code style={{ fontFamily: monospace }}>sys.executable</code>{' '}
            is that path.
          </span>

          <label htmlFor="lc-token-args" style={labelStyle()}>
            Arguments <span style={{ color: colors.muted, fontWeight: 400 }}>(optional, one per line)</span>
          </label>
          <textarea
            id="lc-token-args"
            value={extraArgs.join('\n')}
            spellCheck={false}
            rows={2}
            onChange={(event) => setScriptParts({ args: event.target.value.split('\n') })}
            style={{ ...textFieldStyle(), fontFamily: monospace, resize: 'vertical' }}
          />
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
            One per line, because nothing is parsed by a shell &mdash; an argument containing a
            space stays one argument.
          </span>
        </>
      ) : (
        <>
          <label htmlFor="lc-token-raw" style={labelStyle()}>
            Command <span style={{ color: colors.muted, fontWeight: 400 }}>(one argument per line)</span>
          </label>
          <textarea
            id="lc-token-raw"
            value={command.join('\n')}
            spellCheck={false}
            rows={4}
            onChange={(event) => set('command', event.target.value.split('\n'))}
            style={{ ...textFieldStyle(), fontFamily: monospace, resize: 'vertical' }}
          />
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginBottom: 12 }}>
            The program first, then each argument on its own line. Spawned directly, so there are no
            pipes, no redirection and no <code style={{ fontFamily: monospace }}>&amp;&amp;</code>{' '}
            &mdash; put shell logic in a script instead.
          </span>
        </>
      )}

      <button
        type="button"
        style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
        onClick={() => setRaw((current) => !current)}
      >
        {scriptMode ? 'Enter a command instead' : 'It is a Python script'}
      </button>

      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          style={{ background: 'none', border: 'none', color: colors.accent, cursor: 'pointer', padding: 0, fontSize: 11 }}
          onClick={() => setAdvanced((current) => !current)}
        >
          {advanced ? 'Hide advanced' : 'Advanced — JSON output, expiry, headers'}
        </button>
      </div>

      {advanced && (
        <div style={{ marginTop: 10, paddingLeft: 10, borderLeft: `2px solid ${colors.border}` }}>
          <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px' }}>
            Leave these empty if the script prints a bare token. Fill the two paths in if it prints
            the gateway&rsquo;s JSON instead &mdash; then it refreshes on the real expiry rather
            than an assumed hour.
          </p>

          <label htmlFor="lc-token-path" style={labelStyle()}>
            Token field
          </label>
          <input
            id="lc-token-path"
            type="text"
            value={props.value.tokenPath ?? ''}
            spellCheck={false}
            placeholder="access_token"
            onChange={(event) => set('tokenPath', event.target.value.trim() === '' ? undefined : event.target.value)}
            style={{ ...textFieldStyle(), fontFamily: monospace }}
          />

          <label htmlFor="lc-expires-path" style={labelStyle()}>
            Expiry field <span style={{ color: colors.muted, fontWeight: 400 }}>(seconds)</span>
          </label>
          <input
            id="lc-expires-path"
            type="text"
            value={props.value.expiresInPath ?? ''}
            spellCheck={false}
            placeholder="expires_in"
            onChange={(event) =>
              set('expiresInPath', event.target.value.trim() === '' ? undefined : event.target.value)
            }
            style={{ ...textFieldStyle(), fontFamily: monospace }}
          />

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="lc-token-expiry" style={labelStyle()}>
                Assume it lasts (s)
              </label>
              <input
                id="lc-token-expiry"
                type="text"
                inputMode="numeric"
                value={props.value.fallbackExpirySeconds ?? ''}
                placeholder="3600"
                onChange={(event) =>
                  set('fallbackExpirySeconds', Number(event.target.value) || undefined)
                }
                style={textFieldStyle()}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="lc-token-skew" style={labelStyle()}>
                Refresh this early (s)
              </label>
              <input
                id="lc-token-skew"
                type="text"
                inputMode="numeric"
                value={props.value.refreshSkewSeconds ?? ''}
                placeholder="60"
                onChange={(event) => set('refreshSkewSeconds', Number(event.target.value) || undefined)}
                style={textFieldStyle()}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="lc-token-timeout" style={labelStyle()}>
                Give up after (s)
              </label>
              <input
                id="lc-token-timeout"
                type="text"
                inputMode="numeric"
                value={props.value.timeoutSeconds ?? ''}
                placeholder="30"
                onChange={(event) => set('timeoutSeconds', Number(event.target.value) || undefined)}
                style={textFieldStyle()}
              />
            </div>
          </div>

          <label htmlFor="lc-token-cwd" style={labelStyle()}>
            Run it in <span style={{ color: colors.muted, fontWeight: 400 }}>(optional folder)</span>
          </label>
          <input
            id="lc-token-cwd"
            type="text"
            value={props.value.cwd ?? ''}
            spellCheck={false}
            onChange={(event) => set('cwd', event.target.value.trim() === '' ? undefined : event.target.value)}
            style={{ ...textFieldStyle(), fontFamily: monospace }}
          />

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="lc-token-header" style={labelStyle()}>
                Header name
              </label>
              <input
                id="lc-token-header"
                type="text"
                value={props.value.headerName ?? ''}
                spellCheck={false}
                placeholder="Authorization"
                onChange={(event) => set('headerName', event.target.value.trim() === '' ? undefined : event.target.value)}
                style={{ ...textFieldStyle(), fontFamily: monospace }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="lc-token-prefix" style={labelStyle()}>
                Header prefix
              </label>
              <input
                id="lc-token-prefix"
                type="text"
                value={props.value.headerPrefix ?? ''}
                spellCheck={false}
                placeholder="Bearer "
                onChange={(event) =>
                  set('headerPrefix', event.target.value === '' ? undefined : event.target.value)
                }
                style={{ ...textFieldStyle(), fontFamily: monospace }}
              />
            </div>
          </div>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
            Left empty, these follow the wire format &mdash; <code style={{ fontFamily: monospace }}>Authorization: Bearer</code>{' '}
            for OpenAI, <code style={{ fontFamily: monospace }}>x-api-key</code> for Anthropic.
          </span>
        </div>
      )}
    </div>
  )
}
