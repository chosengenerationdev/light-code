import type { AddonView, HostToUiMessage, Transport, UiToHostMessage } from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'

import { disabledWhen } from '../disabledWhen.js'
import { badgeStyle, colors, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'
import { Panel } from './Panel.js'
import type { BrowseRequest } from './PathField.js'

type AddonsMessage = Extract<HostToUiMessage, { type: 'addons' }>

/**
 * Add-ons: installed Node packages that run an MCP server (`addons/discover.ts`).
 *
 * Self-contained, talking to the host through the transport itself (the `stagedFiles` pattern), so
 * the MCP tab's long prop list does not grow. Enabling shows **what will run** - the package folder
 * and the script - because that is the ground truth (invariant 8): the display name is the
 * package's own description of itself.
 */
export function AddonsSection({
  transport,
  onBrowse,
  pickedPath,
}: {
  transport: Transport
  /** Absent where the host has no folder picker: the box stays typeable either way. */
  onBrowse?: ((request: BrowseRequest) => void) | undefined
  pickedPath?: { purpose: string; path: string } | undefined
}): ReactElement {
  const [message, setMessage] = useState<AddonsMessage | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [foldersDraft, setFoldersDraft] = useState<string | undefined>(undefined)

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const incoming = raw as HostToUiMessage
      // Started, stopped or failed: the list carries each add-on's state and log, so ask for it again.
      if (incoming.type === 'mcp') {
        transport.post({ type: 'requestAddons' } satisfies UiToHostMessage)
        return
      }
      if (incoming.type !== 'addons') return
      setMessage(incoming)
      setBusy(undefined)
    })
    transport.post({ type: 'requestAddons' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  const post = (msg: UiToHostMessage, key: string): void => {
    setBusy(key)
    transport.post(msg)
  }

  // A folder chosen with Browse joins the list, as if typed on a line of its own.
  useEffect(() => {
    if (pickedPath?.purpose !== 'addons:folder') return
    setFoldersDraft((current) => {
      const lines = (current ?? (message?.folders ?? []).join('\n')).split(/\r?\n/).filter((line) => line.trim().length > 0)
      return lines.includes(pickedPath.path) ? lines.join('\n') : [...lines, pickedPath.path].join('\n')
    })
    // `message` is read only for the starting list; re-running on its change would re-add the folder.
  }, [pickedPath])

  const addons = message?.addons ?? []
  const enabledCount = addons.filter((addon) => addon.state === 'enabled').length
  const folders = foldersDraft ?? (message?.folders ?? []).join('\n')

  return (
    <Panel id="mcp.addons" title="Add-ons" summary={message === undefined ? 'Looking…' : `${String(addons.length)} installed, ${String(enabledCount)} enabled`}>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
        An add-on is a Node package that gives Light Code and Fire Code more tools. Install one with{' '}
        <code style={{ fontFamily: monospaceFamily }}>npm i -g &lt;package&gt;</code> and it is listed here.
        Installed is not enabled: nothing runs until you enable it, and an update stays off until you
        enable the new version. An enabled add-on may bring a tab of its own beside this one, and its tools
        are asked about like any other tool.
      </p>

      {message?.error !== undefined && (
        <p role="alert" style={{ color: colors.error, fontSize: 11, margin: '0 0 8px' }}>
          {message.error}
        </p>
      )}

      {message !== undefined && addons.length === 0 && (
        <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 8px' }}>
          No add-ons are installed. Light Code looks in npm's global folder and the folders below.
        </p>
      )}

      {addons.map((addon) => (
        <AddonRow
          key={addon.package}
          addon={addon}
          busy={busy !== undefined}
          onEnable={() => post({ type: 'enableAddon', package: addon.package }, addon.package)}
          onRemove={() => post({ type: 'removeAddon', server: addon.server }, addon.package)}
        />
      ))}

      {(message?.missing ?? []).map((row) => (
        <div key={row.server} style={{ fontSize: 11, margin: '6px 0', color: colors.muted }}>
          <strong>{row.package}</strong> {row.version} is enabled as <code style={{ fontFamily: monospaceFamily }}>{row.server}</code> but
          no longer installed, so it is off.{' '}
          <button type="button" style={secondaryButtonStyle()} onClick={() => post({ type: 'removeAddon', server: row.server }, row.server)}>
            Remove
          </button>
        </div>
      ))}

      {(message?.problems ?? []).length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <div style={labelStyle()}>Found, but cannot be used</div>
          {(message?.problems ?? []).map((problem) => (
            <div key={problem.dir} style={{ fontSize: 11, color: colors.error, margin: '2px 0' }}>
              {problem.package ?? problem.dir}: {problem.problem}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <label style={labelStyle()} htmlFor="addon-folders">
          Also look in these folders (one per line)
        </label>
        <textarea
          id="addon-folders"
          rows={3}
          value={folders}
          placeholder="C:\work\my-addon"
          onChange={(event) => setFoldersDraft(event.target.value)}
          style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box', fontFamily: monospaceFamily, resize: 'vertical' }}
        />
        <div style={{ fontSize: 11, color: colors.muted, margin: '4px 0 6px' }}>
          A folder of packages, or one add-on you are writing. Always looked in:{' '}
          {(message?.defaultFolders ?? []).map((folder) => (
            <code key={folder} style={{ fontFamily: monospaceFamily, marginRight: 6 }}>
              {folder}
            </code>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {onBrowse !== undefined && (
            <button type="button" style={secondaryButtonStyle()} title="Choose a folder to add to the list" onClick={() => onBrowse({ purpose: 'addons:folder', kind: 'folder' })}>
              Browse…
            </button>
          )}
          <button
            type="button"
            style={primaryButtonStyle(foldersDraft === undefined || busy !== undefined)}
            {...disabledWhen(
              [foldersDraft === undefined, 'Change the folders first.'],
              [busy !== undefined, 'Wait for the last change to finish.'],
            )}
            onClick={() => {
              post({ type: 'saveAddonFolders', folders: folders.split(/\r?\n/) }, 'folders')
              setFoldersDraft(undefined)
            }}
          >
            Save folders
          </button>
          <button
            type="button"
            style={secondaryButtonStyle()}
            {...disabledWhen([busy !== undefined, 'Wait for the last change to finish.'], { enabledTitle: 'Look in every folder again, for add-ons installed since.' })}
            onClick={() => post({ type: 'requestAddons' }, 'rescan')}
          >
            Look again
          </button>
        </div>
      </div>
    </Panel>
  )
}

function AddonRow(props: { addon: AddonView; busy: boolean; onEnable: () => void; onRemove: () => void }): ReactElement {
  const { addon } = props
  const [confirming, setConfirming] = useState(false)
  const badge =
    addon.state === 'enabled' ? 'Enabled' : addon.state === 'updated' ? `Updated from ${addon.enabledVersion ?? 'an earlier version'} - off` : 'Not enabled'
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 3, padding: '6px 8px', margin: '6px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <strong>{addon.displayName}</strong>
        <span style={{ color: colors.muted, fontSize: 11 }}>
          {addon.package} {addon.version}
        </span>
        <span style={badgeStyle(addon.state === 'updated' ? 'warning' : 'neutral')}>{badge}</span>
        <span style={{ flex: 1 }} />
        {addon.state === 'enabled' ? (
          <button type="button" style={secondaryButtonStyle()} {...disabledWhen([props.busy, 'Wait for the last change to finish.'])} onClick={props.onRemove}>
            Disable
          </button>
        ) : (
          <button
            type="button"
            style={primaryButtonStyle(props.busy)}
            {...disabledWhen([props.busy, 'Wait for the last change to finish.'])}
            onClick={() => (confirming ? props.onEnable() : setConfirming(true))}
          >
            {confirming ? 'Run it' : addon.state === 'updated' ? 'Enable this version' : 'Enable'}
          </button>
        )}
      </div>
      {addon.description !== undefined && <div style={{ fontSize: 11, margin: '4px 0 0' }}>{addon.description}</div>}
      {addon.state === 'enabled' && addon.status !== undefined && (
        <div style={{ fontSize: 11, margin: '4px 0 0', color: addon.status === 'failed' ? colors.error : colors.muted }}>
          {addon.status === 'ready' ? 'Running' : addon.status === 'failed' ? `Could not start${addon.error !== undefined ? `: ${addon.error}` : ''}` : 'Starting…'}
          {(addon.logs ?? []).length > 0 && (
            <details style={{ marginTop: 2 }}>
              <summary style={{ cursor: 'pointer' }}>Log</summary>
              <pre style={{ fontFamily: monospaceFamily, fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 0', maxHeight: 200, overflowY: 'auto' }}>{(addon.logs ?? []).join('\n')}</pre>
            </details>
          )}
        </div>
      )}
      <div style={{ fontSize: 11, color: colors.muted, margin: '4px 0 0' }}>
        Tools appear as <code style={{ fontFamily: monospaceFamily }}>{addon.server}__…</code>
      </div>
      {confirming && addon.state !== 'enabled' && (
        <div style={{ fontSize: 11, margin: '6px 0 0' }}>
          Enabling runs this program now and whenever a chat starts, as you:
          <pre style={{ fontFamily: monospaceFamily, whiteSpace: 'pre-wrap', margin: '4px 0' }}>node {addon.main}</pre>
          Only enable add-ons you trust - it can do anything you can. Press <strong>Run it</strong> to confirm.{' '}
          <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
