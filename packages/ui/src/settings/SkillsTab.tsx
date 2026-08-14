import { useState, type ReactElement } from 'react'
import { colors, fontFamily, primaryButtonStyle, secondaryButtonStyle } from '../theme.js'

const monospace = 'var(--vscode-editor-font-family, monospace)'

export interface SkillsTabProps {
  skills: { name: string; description: string; filePath: string }[]
  issues: { filePath: string; detail: string }[]
  skillsDir?: string | undefined
  onDelete: (name: string) => void
}

/**
 * What the model has been told to remember about this workspace.
 *
 * The tab exists mainly so the list is *visible*. A skill's description is injected into every
 * future conversation, so it is not something the user should have to browse the filesystem to
 * discover — and a malformed one was previously dropped with nothing but a log line.
 */
export function SkillsTab(props: SkillsTabProps): ReactElement {
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  return (
    <div style={{ padding: 12, overflowY: 'auto', fontFamily, fontSize: 13, color: colors.foreground }}>
      <h3 style={{ margin: '0 0 4px' }}>Skills</h3>
      <p style={{ color: colors.muted, fontSize: 11, marginTop: 0 }}>
        Notes the assistant keeps about this workspace — internal libraries, conventions, anything
        you would otherwise explain again each time. Tell it something durable and it will offer to
        record one; you approve the text before it is written.
      </p>
      <p style={{ color: colors.muted, fontSize: 11 }}>
        Only each <strong>description</strong> below is loaded into every conversation. The bodies are
        read on demand, so a long skill costs nothing until it is relevant.
        {props.skillsDir !== undefined && (
          <>
            {' '}
            They are plain markdown in <code style={{ fontFamily: monospace }}>{props.skillsDir}</code>, so
            they land in git and can be reviewed like any other file.
          </>
        )}
      </p>

      {/*
        Shown rather than only logged. A skill that is silently not offered is impossible to
        diagnose from the chat — the same reasoning as refused Python tools.
      */}
      {props.issues.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <strong style={{ fontSize: 12, color: colors.error }}>Not loaded</strong>
          {props.issues.map((issue) => (
            <div key={issue.filePath} style={{ fontSize: 11, color: colors.error, marginTop: 4 }}>
              ⚠ {issue.filePath} — {issue.detail}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {props.skills.length === 0 ? (
          <p style={{ color: colors.muted, fontSize: 12 }}>
            {props.skillsDir === undefined
              ? 'Open a folder — skills belong to a workspace.'
              : 'None yet. Explain something about this codebase and the assistant will offer to record it.'}
          </p>
        ) : (
          props.skills.map((skill) => (
            <div key={skill.name} style={{ padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <strong style={{ fontFamily: monospace, fontSize: 12 }}>{skill.name}</strong>
                <span style={{ marginLeft: 'auto' }}>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(skill.name)}>
                    Remove
                  </button>
                </span>
              </div>
              <div style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{skill.description}</div>
              <div style={{ color: colors.muted, fontSize: 10, fontFamily: monospace, marginTop: 2 }}>
                {skill.filePath}
              </div>

              {confirming === skill.name && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12 }}>
                  <span>Delete this skill file?</span>
                  <button
                    type="button"
                    style={primaryButtonStyle(false)}
                    onClick={() => {
                      props.onDelete(skill.name)
                      setConfirming(undefined)
                    }}
                  >
                    Delete
                  </button>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => setConfirming(undefined)}>
                    Keep
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
