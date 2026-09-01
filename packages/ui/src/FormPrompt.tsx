import type { FormField } from '@light-code/core/browser'
import { useMemo, useState, type ReactElement } from 'react'
import { Select } from './Select.js'
import {
  colors,
  fieldErrorStyle,
  labelStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  textFieldStyle,
} from './theme.js'

export interface PendingForm {
  id: string
  title: string
  description?: string
  fields: FormField[]
}

export interface FormPromptProps {
  form: PendingForm
  onSubmit: (id: string, values: Record<string, string | boolean>) => void
  onDismiss: (id: string) => void
}

/**
 * The form the assistant asked for, rendered in the transcript.
 *
 * ## Why a form rather than a question
 *
 * A skill needing four specific values used to have to describe them in prose and read the
 * answer back out of prose. Every one of those steps can go wrong quietly — the wrong value
 * picked out of a sentence looks exactly like the right one. Typed controls cannot be
 * misunderstood that way: a number field yields a number, and a dropdown yields one of the
 * values the assistant listed.
 *
 * ## It looks like the rest of the product on purpose
 *
 * Same `Select` as every other dropdown, same field styling, same buttons. A control that
 * looks foreign reads as something to be careful of, and this is ordinary input — the thing
 * to be careful of is an approval, which looks different because it *is* different.
 *
 * Skipping is always available and never destructive: it tells the assistant nobody answered,
 * which it handles by asking in plain text instead.
 */
export function FormPrompt(props: FormPromptProps): ReactElement {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialValues(props.form.fields))
  const [showErrors, setShowErrors] = useState(false)

  const errors = useMemo(() => validate(props.form.fields, values), [props.form.fields, values])
  const hasErrors = Object.keys(errors).length > 0

  const set = (name: string, value: string | boolean): void => {
    setValues((current) => ({ ...current, [name]: value }))
  }

  const submit = (): void => {
    if (hasErrors) {
      // Shown on the attempt rather than while typing: flagging a field as wrong before it has
      // been filled in is nagging, not help.
      setShowErrors(true)
      return
    }
    props.onSubmit(props.form.id, values)
  }

  return (
    <div
      style={{
        margin: '8px 12px 12px',
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: 12,
        background: colors.inputBackground,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: props.form.description === undefined ? 10 : 2 }}>
        {props.form.title}
      </div>
      {props.form.description !== undefined && (
        <div style={{ color: colors.muted, fontSize: 12, marginBottom: 10 }}>{props.form.description}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {props.form.fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name] ?? ''}
            error={showErrors ? errors[field.name] : undefined}
            onChange={(value) => set(field.name, value)}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" style={primaryButtonStyle(false)} onClick={submit}>
          Submit
        </button>
        <button type="button" style={secondaryButtonStyle()} onClick={() => props.onDismiss(props.form.id)}>
          Skip
        </button>
      </div>
    </div>
  )
}

interface FieldProps {
  field: FormField
  value: string | boolean
  error: string | undefined
  onChange: (value: string | boolean) => void
}

function Field(props: FieldProps): ReactElement {
  const { field } = props
  const id = `lc-form-${field.name}`
  const optional = field.required === false

  // A checkbox reads better with its label beside it than above it, because the label *is* the
  // question — above, it would leave an unlabelled box sitting under a heading.
  if (field.type === 'boolean') {
    return (
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.value === true}
          onChange={(event) => props.onChange(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <span style={{ display: 'block', fontSize: 13 }}>{field.label}</span>
          {field.description !== undefined && (
            <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>{field.description}</span>
          )}
        </span>
      </label>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label htmlFor={id} style={labelStyle()}>
        {field.label}
        {optional && <span style={{ color: colors.muted, fontWeight: 400 }}> (optional)</span>}
      </label>
      {field.description !== undefined && (
        <span style={{ color: colors.muted, fontSize: 11 }}>{field.description}</span>
      )}

      {field.type === 'choice' ? (
        <Select
          id={id}
          value={String(props.value)}
          options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label ?? option.value }))}
          placeholder="Choose one"
          onChange={props.onChange}
          ariaLabel={field.label}
        />
      ) : field.multiline === true || field.type === 'list' ? (
        <textarea
          id={id}
          value={String(props.value)}
          rows={field.type === 'list' ? 3 : 4}
          placeholder={field.type === 'list' ? 'One per line, or separated by commas' : undefined}
          onChange={(event) => props.onChange(event.target.value)}
          style={{ ...textFieldStyle(), resize: 'vertical' }}
        />
      ) : (
        <input
          id={id}
          /*
           * `inputMode` rather than `type="number"`. A number input silently discards what it
           * considers invalid, so a mistyped character can make the value vanish as you type.
           * Validating the text and saying what is wrong is the honest version of the same help.
           */
          inputMode={field.type === 'number' ? 'decimal' : 'text'}
          value={String(props.value)}
          onChange={(event) => props.onChange(event.target.value)}
          style={textFieldStyle()}
        />
      )}

      {/*
        Counted back to the user as they type. A comma-separated box is the one field where what
        was meant and what was parsed can differ silently — a stray comma, a trailing one — and a
        count is the cheapest possible way to notice before pressing Submit.
      */}
      {field.type === 'list' && props.error === undefined && (
        <span style={{ color: colors.muted, fontSize: 11 }}>{describeListCount(String(props.value))}</span>
      )}
      {props.error !== undefined && <span style={fieldErrorStyle()}>{props.error}</span>}
    </div>
  )
}

/** Mirrors the split in `coerceFormValue`: commas or newlines, blanks dropped. */
function listItems(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function describeListCount(text: string): string {
  const count = listItems(text).length
  if (count === 0) return 'No values yet.'
  return count === 1 ? '1 value' : `${String(count)} values`
}

function initialValues(fields: readonly FormField[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (const field of fields) {
    if (field.type === 'boolean') {
      values[field.name] = field.defaultValue === true
    } else if (field.defaultValue !== undefined) {
      values[field.name] = String(field.defaultValue)
    } else {
      // A dropdown with one option has one answer; making someone open it to discover that is
      // a click that tells them nothing.
      values[field.name] = field.type === 'choice' && field.options?.length === 1 ? (field.options[0]?.value ?? '') : ''
    }
  }
  return values
}

/** Mirrors `coerceFormValue` in core, which is the authority — this is the immediate half. */
function validate(fields: readonly FormField[], values: Record<string, string | boolean>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    if (field.type === 'boolean') continue
    const text = String(values[field.name] ?? '').trim()

    if (text.length === 0) {
      if (field.required !== false) errors[field.name] = 'Required.'
      continue
    }
    if (field.type === 'list' && listItems(text).length === 0 && field.required !== false) {
      errors[field.name] = 'Enter at least one value.'
    }
    if (field.type === 'number' && !Number.isFinite(Number(text))) {
      errors[field.name] = 'Enter a number.'
    }
    if (field.type === 'choice' && !(field.options ?? []).some((option) => option.value === text)) {
      errors[field.name] = 'Choose one of the options.'
    }
  }
  return errors
}
