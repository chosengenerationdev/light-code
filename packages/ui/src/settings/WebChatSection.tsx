import { useEffect, useState, type ReactElement } from 'react'

import type { HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'

import { Select } from '../Select.js'
import { colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { disabledWhen } from '../disabledWhen.js'
import { Panel } from './Panel.js'

type WebChatMessage = Extract<HostToUiMessage, { type: 'webChat' }>
type CaptureMessage = Extract<HostToUiMessage, { type: 'webChatCapture' }>

/** The Chrome DevTools MCP server entry the rules allow: an installed copy, reporting off, this PC's Chrome only. */
const SERVER_ENTRY = `"chrome-webchat": {
  "command": "chrome-devtools-mcp",
  "args": ["--autoConnect", "--no-usage-statistics", "--no-performance-crux"]
}`

/**
 * Settings → Agents → Web chat: consulting the model behind the organisation's internal web chat through the user's own
 * Chrome (`webchat/` in core). Self-contained over the transport, like the Decision model panel.
 *
 * The capture is guided step by step, and the backend address it finds is saved only when the user approves it - the
 * only address used afterwards.
 */
export function WebChatSection(props: { transport: Transport }): ReactElement | null {
  const { transport } = props
  const [state, setState] = useState<WebChatMessage | undefined>(undefined)
  const [capture, setCapture] = useState<CaptureMessage | undefined>(undefined)
  const [pageUrl, setPageUrl] = useState('')
  const [model, setModel] = useState('')
  const [server, setServer] = useState('')

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'webChat') {
        setState(message)
        if (message.chrome.chosen !== undefined) setServer((current) => (current.length > 0 ? current : (message.chrome.chosen ?? '')))
        if (message.setup !== undefined) {
          setPageUrl((current) => (current.length > 0 ? current : (message.setup?.pageUrl ?? '')))
          setModel(message.setup.modelOverride ?? '')
        }
        if (message.message !== undefined) setCapture(undefined)
      } else if (message.type === 'webChatCapture') {
        setCapture(message)
      }
    })
    transport.post({ type: 'requestWebChat' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  if (state === undefined || !state.available) return null
  const post = (message: UiToHostMessage): void => transport.post(message)
  const servers = state.chrome.servers
  const chosenEntry = servers.find((entry) => entry.name === server)
  const chromeReady = chosenEntry !== undefined && chosenEntry.problems.length === 0
  const setup = state.setup

  return (
    <div style={{ padding: '0 12px 12px' }}>
      <Panel id="agents.webchat" title="Web chat" summary={setup !== undefined ? (setup.modelOverride ?? setup.model ?? 'set up') : 'Not set up'}>
        <p style={{ color: colors.muted, fontSize: 12, margin: '0 0 8px' }}>
          Consult the model behind your organisation's internal web chat (such as Gemini) with <code style={{ fontFamily: monospaceFamily }}>ask_web_chat</code>. It
          goes through your own Chrome, signed in as you, to the web chat's own backend only - Light Code opens no connection and never sees your
          session. Every consultation shows you the exact text first.
        </p>

        <strong style={{ fontSize: 12 }}>1. The Chrome DevTools MCP server for the web chat</strong>
        <div style={{ fontSize: 12, margin: '4px 0 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ color: colors.muted }}>
            Give the web chat a Chrome DevTools MCP server of its own: only that one is used for it, and only that one is hidden from the
            assistant (its tools are replaced by <code style={{ fontFamily: monospaceFamily }}>ask_web_chat</code>, so the assistant is given fewer tools, not more). Any
            other Chrome server you have is left exactly as it is.
          </span>
          {servers.length === 0 ? (
            <span>No Chrome DevTools MCP server is connected.</span>
          ) : (
            <Select
              value={server}
              ariaLabel="The Chrome DevTools MCP server for the web chat"
              options={[{ value: '', label: 'Choose the server for the web chat…' }, ...servers.map((entry) => ({ value: entry.name, label: entry.name, ...(entry.problems.length > 0 ? { detail: 'cannot be used yet - see below' } : {}) }))]}
              onChange={(value) => {
                setServer(value)
                if (setup !== undefined && value.length > 0) post({ type: 'setWebChatServer', server: value })
              }}
            />
          )}
          {chosenEntry?.registry !== undefined && (
            <span style={{ color: colors.muted }}>
              npx downloads it from <code style={{ fontFamily: monospaceFamily }}>{chosenEntry.registry}</code> (npm's own setting) - this should be your
              organisation's registry.
            </span>
          )}
          {chosenEntry !== undefined && chosenEntry.problems.length > 0 && (
            <div style={{ color: colors.error }}>
              "{chosenEntry.name}" cannot be used for the web chat yet:
              <ul style={{ margin: '4px 0' }}>
                {chosenEntry.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          {state.chrome.chosen !== undefined && !servers.some((entry) => entry.name === state.chrome.chosen) && (
            <span style={{ color: colors.error }}>"{state.chrome.chosen}", chosen for the web chat, is not connected in this codebase (Settings → MCP).</span>
          )}
          <details>
            <summary style={{ cursor: 'pointer', color: colors.muted }}>Add a server for the web chat (Settings → MCP)</summary>
            Allow it in Chrome at <code style={{ fontFamily: monospaceFamily }}>chrome://inspect/#remote-debugging</code>, then add an entry like this under its own
            name - installed once with <code style={{ fontFamily: monospaceFamily }}>npm i -g chrome-devtools-mcp</code>, or with npx and a pinned version when npm
            downloads from your organisation's registry. The two flags switch its reporting to Google off.
            <pre style={{ fontFamily: monospaceFamily, fontSize: 11, background: colors.inputBackground, padding: 6, borderRadius: 4, whiteSpace: 'pre-wrap' }}>{SERVER_ENTRY}</pre>
          </details>
        </div>

        <strong style={{ fontSize: 12 }}>2. The web chat</strong>
        {setup !== undefined && capture === undefined ? (
          <div style={{ fontSize: 12, margin: '4px 0 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>
              Page: <code style={{ fontFamily: monospaceFamily }}>{setup.pageUrl}</code>
            </span>
            <span>
              Approved backend address (the only one used): <code style={{ fontFamily: monospaceFamily }}>{setup.method} {setup.backend}</code>
            </span>
            {state.hostProblem !== undefined && state.hostProblem.length > 0 && <span style={{ color: colors.error }}>{state.hostProblem}</span>}
            {setup.fromPage.length > 0 && (
              <span style={{ color: colors.muted }}>Signed with {setup.fromPage.join(', ')}, taken from the page each time and never stored.</span>
            )}
            <label style={labelStyle()} htmlFor="webchat-model">
              Model {setup.model !== undefined ? `(captured: ${setup.model})` : ''}
            </label>
            <input
              id="webchat-model"
              value={model}
              placeholder={setup.model ?? 'as captured'}
              onChange={(event) => setModel(event.target.value)}
              onBlur={() => post({ type: 'setWebChatModel', ...(model.trim().length > 0 ? { model: model.trim() } : {}) })}
              style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'startWebChatCapture', pageUrl: setup.pageUrl, server })} {...disabledWhen([!chromeReady, 'Choose a Chrome DevTools MCP server that can be used (step 1).'])}>
                Capture again
              </button>
              <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'clearWebChat' })}>
                Remove
              </button>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, margin: '4px 0 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={labelStyle()} htmlFor="webchat-page">
              Web chat page address
            </label>
            <input
              id="webchat-page"
              value={pageUrl}
              placeholder="https://ai-chat.your-organisation.internal/"
              onChange={(event) => setPageUrl(event.target.value)}
              style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
            />
            {capture === undefined && (
              <div>
                <button
                  type="button"
                  style={primaryButtonStyle(!chromeReady || pageUrl.trim().length === 0)}
                  {...disabledWhen([!chromeReady, 'Choose a Chrome DevTools MCP server that can be used (step 1).'], [pageUrl.trim().length === 0, 'Type the web chat page address first.'], { enabledTitle: 'Open the page in Chrome and capture one message.' })}
                  onClick={() => post({ type: 'startWebChatCapture', pageUrl: pageUrl.trim(), server })}
                >
                  Capture
                </button>
              </div>
            )}
          </div>
        )}

        {capture !== undefined && (
          <div data-testid="webchat-capture" style={{ fontSize: 12, border: `1px solid ${colors.border}`, borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {capture.phase === 'waiting' && (
              <>
                <span>
                  In the web chat tab Light Code selected, <strong>start a new chat, choose the model</strong> (e.g. Gemini), and send this message:
                </span>
                <code style={{ fontFamily: monospaceFamily, fontSize: 13, padding: 6, background: colors.inputBackground, borderRadius: 4, userSelect: 'all' }}>{capture.phrase}</code>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => void navigator.clipboard?.writeText(capture.phrase ?? '')}>
                    Copy
                  </button>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'sendWebChatPhrase' })} title="Light Code types it into the chat's message box and sends it.">
                    Send it for me
                  </button>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'cancelWebChatCapture' })}>
                    Cancel
                  </button>
                </div>
                <span style={{ color: colors.muted }}>Waiting for that message… {capture.message ?? ''}</span>
              </>
            )}
            {capture.phase === 'found' && (
              <>
                <span>
                  <strong>Is this the right backend?</strong> Only the one you approve will ever be used.
                </span>
                {(capture.candidates ?? []).map((candidate, index) => (
                  <div key={index} style={{ border: `1px solid ${colors.border}`, borderRadius: 4, padding: 6 }}>
                    <div>
                      <code style={{ fontFamily: monospaceFamily }}>
                        {candidate.method} {candidate.backend}
                      </code>
                    </div>
                    {candidate.model !== undefined && <div>Model: {candidate.model}</div>}
                    <div style={{ color: colors.muted }}>Answer read from it: "{candidate.answerPreview}"</div>
                    <button type="button" style={{ ...primaryButtonStyle(false), marginTop: 4 }} onClick={() => post({ type: 'confirmWebChatCapture', index })}>
                      Use this
                    </button>
                  </div>
                ))}
                {(capture.refused ?? []).map((reason) => (
                  <span key={reason} style={{ color: colors.muted }}>
                    Not offered: {reason}
                  </span>
                ))}
                <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'cancelWebChatCapture' })}>
                  None of these - cancel
                </button>
              </>
            )}
            {capture.phase === 'failed' && (
              <>
                <span style={{ color: colors.error }}>{capture.message}</span>
                <button type="button" style={secondaryButtonStyle()} onClick={() => setCapture(undefined)}>
                  OK
                </button>
              </>
            )}
          </div>
        )}
        {state.message !== undefined && <p style={{ fontSize: 12, color: colors.muted, margin: '6px 0 0' }}>{state.message}</p>}
      </Panel>
    </div>
  )
}
