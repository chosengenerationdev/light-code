import type { ReactElement } from 'react'
import { useState } from 'react'

import { colors, labelStyle, secondaryButtonStyle, textFieldStyle } from '../theme.js'

/**
 * Bringing skills or Python tools in from a folder that used to hold them.
 *
 * Asked for: *"is it possible to sync tools and skills from previously used folder to newly using
 * folder or bucket?"* Changing the folder left everything behind, and switching a bucket on
 * published only what you wrote *next* — the publish hooks fire on a write, so a folder of twenty
 * existing skills stayed invisible to the team for ever.
 *
 * ## Why the path stays typeable
 *
 * §19's rule about `HostUi`: **no method may be load-bearing.** A browser has no native picker,
 * so `showOpenDialog` returns `undefined` there and a cancel looks identical to "this host cannot
 * ask". A Browse button that was the only way in would make this feature absent on the Node host,
 * and an old folder is very often somewhere a picker is awkward anyway — a share, another
 * checkout, a backup.
 *
 * ## Why there is no preview here
 *
 * The host has to read the folder to know what is in it, and it already has to confirm before
 * copying. So the confirmation **is** the preview, and it names the files rather than counting
 * them — the rule the approval prompts follow. A second list rendered here would be the same
 * fact in two places, computed from two reads of a folder that can change between them.
 */

export interface MigrateFolderProps {
  kind: 'skills' | 'tools'
  /** Where they will land, so nobody has to guess which folder is "the new one". */
  destination?: string | undefined
  onMigrate: (from: string) => void
  onBrowse: () => void
  /** A folder the host picked, handed back for the field. */
  picked?: string | undefined
  /** True when a bucket folder is marked for publishing, so uploading everything is offered. */
  canPublishAll?: boolean | undefined
  onPublishAll?: (() => void) | undefined
}

export function MigrateFolder(props: MigrateFolderProps): ReactElement {
  const [from, setFrom] = useState('')
  const value = from.length > 0 ? from : (props.picked ?? '')
  const noun = props.kind === 'skills' ? 'skills' : 'Python tools'

  return (
    <section style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <h4 style={{ margin: '0 0 4px' }}>Bring {noun} in from another folder</h4>
      <p style={{ color: colors.muted, fontSize: 11, margin: '0 0 10px', lineHeight: 1.5 }}>
        For when you have changed where {noun} live and the old ones were left behind. Nothing is
        moved and nothing is overwritten: the old folder is untouched, and a name that already
        exists here is skipped and named back to you.
        {props.destination !== undefined && props.destination.length > 0 && (
          <>
            {' '}
            They land in <code style={{ fontFamily: monospace }}>{props.destination}</code>.
          </>
        )}
        {props.kind === 'tools' && (
          <>
            {' '}
            A copied tool arrives <strong>unapproved</strong> &mdash; approvals are recorded per
            folder, so you read it once here before it can run.
          </>
        )}
      </p>

      <label htmlFor={`lc-migrate-${props.kind}`} style={labelStyle()}>
        Folder to copy from
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          id={`lc-migrate-${props.kind}`}
          type="text"
          value={value}
          placeholder="the folder they used to be in"
          spellCheck={false}
          onChange={(event) => setFrom(event.target.value)}
          style={{ ...textFieldStyle(), fontFamily: monospace, flex: 1, minWidth: 180 }}
        />
        <button type="button" style={secondaryButtonStyle()} onClick={props.onBrowse}>
          Browse
        </button>
        <button
          type="button"
          style={secondaryButtonStyle()}
          disabled={value.trim().length === 0}
          onClick={() => props.onMigrate(value.trim())}
        >
          Copy here
        </button>
      </div>

      {props.canPublishAll === true && props.onPublishAll !== undefined && (
        <div style={{ marginTop: 12 }}>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onPublishAll}>
            Upload all existing {noun} to the bucket
          </button>
          <span style={{ display: 'block', color: colors.muted, fontSize: 11, marginTop: 4 }}>
            New {noun} are uploaded as you write them. This is the one-off for everything that was
            already here when you turned the bucket on.
          </span>
        </div>
      )}
    </section>
  )
}

const monospace = 'var(--vscode-editor-font-family, monospace)'
