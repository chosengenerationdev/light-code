import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'

import { DEFAULT_LOOP_ROUNDS, strategyOrder, type HostToUiMessage, type StrategiesMessage, type Strategy, type StrategyEdge, type StrategyExchange, type StrategyGroup, type StrategyNode, type Transport, type UiToHostMessage } from '@light-code/core/browser'

import { Select } from './Select.js'
import { disabledWhen } from './disabledWhen.js'
import { colors, fontFamily, labelStyle, monospaceFamily, primaryButtonStyle, secondaryButtonStyle, textFieldStyle } from './theme.js'

/**
 * Agent team mode's Strategy window: a flow chart of which specialist does what, saved to a library and used per
 * chat (`strategy/strategy.ts` in core says what each part means to the agent).
 *
 * Asked to be "smooth and simple": click a role to add it, drag a step to move it, drag from a step's right-hand
 * dot to another step to connect them, click anything to edit it on the right. SVG and pointer capture only - a
 * drag never selects text, and nothing re-lays the chart out under the user's hand.
 */

const NODE_W = 168
const NODE_H = 48
const CANVAS_W = 1600
const CANVAS_H = 1000

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function blankStrategy(): Strategy {
  return { id: newId('s'), name: 'New strategy', nodes: [], edges: [], updatedAt: 0 }
}

/** Where the line from a node's centre towards `toward` leaves its box. */
function boxExit(node: StrategyNode, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = node.x + NODE_W / 2
  const cy = node.y + NODE_H / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const scale = Math.min(Math.abs(NODE_W / 2 / (dx || 1e-9)), Math.abs(NODE_H / 2 / (dy || 1e-9)))
  return { x: cx + dx * scale, y: cy + dy * scale }
}

function centre(node: StrategyNode): { x: number; y: number } {
  return { x: node.x + NODE_W / 2, y: node.y + NODE_H / 2 }
}

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'group'; id: string } | undefined

type Drag =
  | { kind: 'move'; id: string; dx: number; dy: number; moved: boolean }
  | { kind: 'moveGroup'; id: string; lastX: number; lastY: number }
  | { kind: 'resizeGroup'; id: string }
  | { kind: 'connect'; from: string; x: number; y: number }
  | undefined

export interface StrategyEditorProps {
  transport: Transport
  onClose: () => void
  /** Puts a question into the chat's message box, for the main agent to explain (it reads `strategy_history`). */
  onAsk?: (text: string) => void
  /** Filling its own editor tab (VS Code) rather than laid over the chat panel. */
  standalone?: boolean
}

/** Which box a step's centre is in, if any - how dropping a step into a parallel box puts it there. */
function groupAt(groups: readonly StrategyGroup[], node: StrategyNode): string | undefined {
  const cx = node.x + NODE_W / 2
  const cy = node.y + NODE_H / 2
  return groups.find((g) => cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h)?.id
}

/** Every step's box from where it sits now. */
function withMembership(s: Strategy): Strategy {
  const groups = s.groups ?? []
  return {
    ...s,
    nodes: s.nodes.map((node) => {
      const group = groupAt(groups, node)
      if (group === node.group) return node
      const { group: _old, ...rest } = node
      void _old
      return group === undefined ? rest : { ...rest, group }
    }),
  }
}

export function StrategyEditor(props: StrategyEditorProps): ReactElement {
  const { transport } = props
  const [message, setMessage] = useState<StrategiesMessage | undefined>(undefined)
  const [draft, setDraft] = useState<Strategy>(blankStrategy)
  const [saved, setSaved] = useState('')
  const [selection, setSelection] = useState<Selection>(undefined)
  const [drag, setDrag] = useState<Drag>(undefined)
  const [result, setResult] = useState<{ ok: boolean; message: string } | undefined>(undefined)
  /**
   * Connecting by clicks: the step "Connect to…" was pressed on; the next step clicked becomes the other end.
   * Asked for after "i dont know how to add steps and connectors" - dragging from a small dot is not discoverable.
   */
  const [connectFrom, setConnectFrom] = useState<string | undefined>(undefined)
  const loaded = useRef(false)
  const svg = useRef<SVGSVGElement | null>(null)
  const instructionsBox = useRef<HTMLTextAreaElement | null>(null)
  /** The ✎ on a step: select it and put the cursor in its instructions. */
  const editInstructions = (id: string): void => {
    setSelection({ kind: 'node', id })
    setTimeout(() => instructionsBox.current?.focus(), 0)
  }

  useEffect(() => {
    const unsubscribe = transport.onMessage((raw) => {
      const incoming = raw as HostToUiMessage
      if (incoming.type === 'strategies') {
        setMessage(incoming)
        // Opens on what this chat uses, once; later updates (loop progress) do not replace what is being edited.
        if (!loaded.current) {
          loaded.current = true
          if (incoming.active !== undefined) {
            setDraft(incoming.active)
            setSaved(JSON.stringify(incoming.active))
          }
        }
      } else if (incoming.type === 'strategyResult') {
        setResult({ ok: incoming.ok, message: incoming.message })
      }
    })
    transport.post({ type: 'requestStrategies' } satisfies UiToHostMessage)
    return unsubscribe
  }, [transport])

  const roleName = useCallback((role: string) => message?.roles.find((r) => r.id === role)?.name ?? role, [message])

  const update = (change: (s: Strategy) => Strategy): void => setDraft((s) => change(s))
  const updateNode = (id: string, change: Partial<StrategyNode>): void =>
    update((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)) }))
  const updateEdge = (id: string, change: Partial<StrategyEdge>): void =>
    update((s) => ({ ...s, edges: s.edges.map((e) => (e.id === id ? { ...e, ...change } : e)) }))

  const updateGroup = (id: string, change: Partial<StrategyGroup>): void =>
    update((s) => ({ ...s, groups: (s.groups ?? []).map((g) => (g.id === id ? { ...g, ...change } : g)) }))
  const addGroup = (): void => {
    const id = newId('g')
    update((s) => {
      const index = (s.groups ?? []).length
      const group: StrategyGroup = { id, label: 'In parallel', x: 30 + index * 40, y: 200 + index * 40, w: NODE_W * 2 + 60, h: NODE_H + 70 }
      return withMembership({ ...s, groups: [...(s.groups ?? []), group] })
    })
    setSelection({ kind: 'group', id })
  }

  const addRole = (role: string): void => {
    const id = newId('n')
    update((s) => {
      // Next free spot along a row, so a click never stacks a box on another.
      const index = s.nodes.length
      const node: StrategyNode = { id, role, x: 40 + (index % 5) * (NODE_W + 60), y: 40 + Math.floor(index / 5) * (NODE_H + 80) }
      return { ...s, nodes: [...s.nodes, node] }
    })
    setSelection({ kind: 'node', id })
  }

  const removeSelected = useCallback((): void => {
    if (selection === undefined) return
    if (selection.kind === 'node') {
      update((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== selection.id), edges: s.edges.filter((e) => e.from !== selection.id && e.to !== selection.id) }))
    } else if (selection.kind === 'group') {
      // The box goes; the steps in it stay where they are, no longer parallel.
      update((s) => withMembership({ ...s, groups: (s.groups ?? []).filter((g) => g.id !== selection.id) }))
    } else {
      update((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== selection.id) }))
    }
    setSelection(undefined)
  }, [selection])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
      if (event.key === 'Escape') {
        if (connectFrom !== undefined) setConnectFrom(undefined)
        else props.onClose()
      }
      else if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) removeSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, removeSelected, connectFrom])

  const toCanvas = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svg.current?.getBoundingClientRect()
    return rect === undefined ? { x: 0, y: 0 } : { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const onNodeDown = (event: ReactPointerEvent, node: StrategyNode): void => {
    event.stopPropagation()
    if (connectFrom !== undefined) {
      connect(connectFrom, node.id)
      setConnectFrom(undefined)
      return
    }
    ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
    const at = toCanvas(event)
    setDrag({ kind: 'move', id: node.id, dx: at.x - node.x, dy: at.y - node.y, moved: false })
    setSelection({ kind: 'node', id: node.id })
  }
  const onHandleDown = (event: ReactPointerEvent, node: StrategyNode): void => {
    event.stopPropagation()
    svg.current?.setPointerCapture?.(event.pointerId)
    const at = toCanvas(event)
    setDrag({ kind: 'connect', from: node.id, x: at.x, y: at.y })
  }
  const onGroupDown = (event: ReactPointerEvent, group: StrategyGroup, resize: boolean): void => {
    event.stopPropagation()
    svg.current?.setPointerCapture?.(event.pointerId)
    const at = toCanvas(event)
    setSelection({ kind: 'group', id: group.id })
    setDrag(resize ? { kind: 'resizeGroup', id: group.id } : { kind: 'moveGroup', id: group.id, lastX: at.x, lastY: at.y })
  }
  const onMove = (event: ReactPointerEvent): void => {
    if (drag === undefined) return
    const at = toCanvas(event)
    if (drag.kind === 'moveGroup') {
      // The box carries its steps with it.
      const dx = at.x - drag.lastX
      const dy = at.y - drag.lastY
      update((s) => ({
        ...s,
        groups: (s.groups ?? []).map((g) => (g.id === drag.id ? { ...g, x: Math.round(g.x + dx), y: Math.round(g.y + dy) } : g)),
        nodes: s.nodes.map((n) => (n.group === drag.id ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)),
      }))
      setDrag({ ...drag, lastX: at.x, lastY: at.y })
      return
    }
    if (drag.kind === 'resizeGroup') {
      const group = draft.groups?.find((g) => g.id === drag.id)
      if (group !== undefined) updateGroup(drag.id, { w: Math.max(NODE_W + 40, Math.round(at.x - group.x)), h: Math.max(NODE_H + 40, Math.round(at.y - group.y)) })
      return
    }
    if (drag.kind === 'move') {
      const x = Math.max(0, Math.min(CANVAS_W - NODE_W, at.x - drag.dx))
      const y = Math.max(0, Math.min(CANVAS_H - NODE_H, at.y - drag.dy))
      updateNode(drag.id, { x: Math.round(x), y: Math.round(y) })
      if (!drag.moved) setDrag({ ...drag, moved: true })
    } else {
      setDrag({ ...drag, x: at.x, y: at.y })
    }
  }
  /** Joins two steps; drawn again the other way, the connector becomes a back-and-forth. */
  const connect = (from: string, to: string): void => {
    if (from === to) return
    const existing = draft.edges.find((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))
    if (existing !== undefined) {
      if (existing.from === to) updateEdge(existing.id, { twoWay: true })
      setSelection({ kind: 'edge', id: existing.id })
      return
    }
    const edge: StrategyEdge = { id: newId('e'), from, to }
    update((s) => ({ ...s, edges: [...s.edges, edge] }))
    setSelection({ kind: 'edge', id: edge.id })
  }

  const onUp = (event: ReactPointerEvent): void => {
    if (drag?.kind === 'connect') {
      const at = toCanvas(event)
      const target = draft.nodes.find((n) => at.x >= n.x && at.x <= n.x + NODE_W && at.y >= n.y && at.y <= n.y + NODE_H)
      if (target !== undefined) connect(drag.from, target.id)
    }
    // A step dropped into a box, or a box moved or resized over steps: membership follows where they are.
    if (drag !== undefined && drag.kind !== 'connect') update(withMembership)
    setDrag(undefined)
  }

  const library = message?.library ?? []
  const active = message?.active
  const dirty = JSON.stringify(draft) !== saved
  const isActive = active !== undefined && active.id === draft.id
  const assigned = new Set((message?.roles ?? []).filter((r) => r.assigned).map((r) => r.id))
  const problems = useMemo(() => {
    const out: string[] = []
    if (draft.nodes.length === 0) out.push('Add at least one role.')
    for (const node of draft.nodes) if (!assigned.has(node.role)) out.push(`${roleName(node.role)} has no model yet (Settings → Agents).`)
    return [...new Set(out)]
  }, [draft, assigned, roleName])

  const save = (use: boolean): void => {
    setResult(undefined)
    const clean: Strategy = {
      ...draft,
      edges: draft.edges.map((edge) => {
        const items = (edge.requires ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
        const { requires: _r, ...rest } = edge
        void _r
        return items.length > 0 ? { ...rest, requires: items } : rest
      }),
    }
    transport.post({ type: 'saveStrategy', strategy: clean, use } satisfies UiToHostMessage)
    setSaved(JSON.stringify(draft))
  }

  const selectedNode = selection?.kind === 'node' ? draft.nodes.find((n) => n.id === selection.id) : undefined
  const selectedEdge = selection?.kind === 'edge' ? draft.edges.find((e) => e.id === selection.id) : undefined
  const selectedGroup = selection?.kind === 'group' ? draft.groups?.find((g) => g.id === selection.id) : undefined
  const progress = isActive ? (message?.progress ?? {}) : {}
  /** Which part of the strategy is being carried out: the role working now, else the last to answer. */
  const current = isActive ? message?.current : undefined
  const stepNumber = useMemo(() => new Map(strategyOrder(draft).map((node, i) => [node.id, i + 1])), [draft])
  const currentStep = current !== undefined ? draft.nodes.find((n) => n.role === current.role) : undefined
  const running = new Set(isActive ? (message?.runningRoles ?? []) : [])
  /** What passed between the specialists, newest first - narrowed to the selected step's or connector's roles. */
  const exchanges: StrategyExchange[] = useMemo(() => {
    if (!isActive) return []
    const all = [...(message?.exchanges ?? [])].reverse()
    const roleOf = (id: string): string | undefined => draft.nodes.find((n) => n.id === id)?.role
    const roles =
      selectedNode !== undefined ? new Set([selectedNode.role]) : selectedEdge !== undefined ? new Set([roleOf(selectedEdge.from), roleOf(selectedEdge.to)].filter((r): r is string => r !== undefined)) : undefined
    return roles === undefined ? all : all.filter((e) => roles.has(e.role))
  }, [isActive, message, draft, selectedNode, selectedEdge])

  // In its own tab it fills the tab; over the chat panel it leaves a margin and a backdrop to click away on.
  const overlay: CSSProperties = props.standalone === true
    ? { position: 'fixed', inset: 0, display: 'flex', fontFamily, background: colors.background }
    : { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'stretch', justifyContent: 'stretch', padding: 12, fontFamily }
  const panel: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', background: colors.background, color: colors.foreground, border: props.standalone === true ? 'none' : `1px solid ${colors.border}`, borderRadius: props.standalone === true ? 0 : 10, overflow: 'hidden', minWidth: 0 }
  // Narrower sides in a narrow window, so the chart in the middle keeps most of the room.
  const narrow = useNarrow()
  const side: CSSProperties = { width: narrow ? 160 : 220, flexShrink: 0, borderRight: `1px solid ${colors.border}`, padding: 10, overflow: 'auto' }

  return (
    <div style={overlay} role="dialog" aria-label="Strategy" onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div style={panel}>
        {/* Header: name, library, and what to do with it */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: `1px solid ${colors.border}`, flexWrap: 'wrap' }}>
          <strong>Strategy</strong>
          <input
            aria-label="Strategy name"
            value={draft.name}
            maxLength={80}
            onChange={(event) => update((s) => ({ ...s, name: event.target.value }))}
            style={{ ...textFieldStyle(), width: 200 }}
          />
          <Select
            compact
            ariaLabel="Saved strategies"
            value={library.some((s) => s.id === draft.id) ? draft.id : ''}
            placeholder="Saved strategies…"
            options={[{ value: '__new', label: 'New strategy' }, ...library.map((s) => ({ value: s.id, label: s.name, detail: `${String(s.nodes.length)} steps${active?.id === s.id ? ' · in use here' : ''}` }))]}
            onChange={(value) => {
              const chosen = value === '__new' ? blankStrategy() : library.find((s) => s.id === value)
              if (chosen === undefined) return
              setDraft(chosen)
              setSaved(value === '__new' ? '' : JSON.stringify(chosen))
              setSelection(undefined)
            }}
          />
          <span style={{ flex: 1 }} />
          {active !== undefined ? <span style={{ fontSize: 12, color: colors.muted }}>In use in this chat: {active.name}</span> : <span style={{ fontSize: 12, color: colors.muted }}>No strategy in this chat</span>}
          <button type="button" style={secondaryButtonStyle()} {...disabledWhen([draft.nodes.length === 0, 'Add at least one role first.'])} onClick={() => save(false)}>
            Save
          </button>
          <button type="button" style={primaryButtonStyle(draft.nodes.length === 0)} {...disabledWhen([draft.nodes.length === 0, 'Add at least one role first.'])} onClick={() => save(true)}>
            {isActive && !dirty ? 'In use' : 'Save and use in this chat'}
          </button>
          {active !== undefined ? (
            <button type="button" style={secondaryButtonStyle()} onClick={() => transport.post({ type: 'useStrategy' } satisfies UiToHostMessage)}>
              Stop using
            </button>
          ) : null}
          <button
            type="button"
            style={secondaryButtonStyle()}
            {...disabledWhen([!library.some((s) => s.id === draft.id), 'It is not saved yet.'])}
            onClick={() => {
              transport.post({ type: 'deleteStrategy', id: draft.id } satisfies UiToHostMessage)
              setDraft(blankStrategy())
              setSaved('')
            }}
          >
            Delete
          </button>
          <button type="button" style={secondaryButtonStyle()} onClick={props.onClose} title="Close (Esc)">
            Close
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Roles to add */}
          <div style={side}>
            <div style={{ ...labelStyle(), marginBottom: 6 }}>Click a role to add it</div>
            {(message?.roles ?? []).map((role) => (
              <button
                key={role.id}
                type="button"
                title={role.assigned ? `${role.summary}${role.label !== undefined ? ` - ${role.label}` : ''}${role.ownProcess === true ? ' - runs in its own process' : ''}` : 'No model assigned yet: Settings → Agents.'}
                onClick={() => addRole(role.id)}
                style={{ ...secondaryButtonStyle(), display: 'block', width: '100%', textAlign: 'left', marginBottom: 4, opacity: role.assigned ? 1 : 0.6 }}
              >
                {role.name}
                <span style={{ display: 'block', fontSize: 10, color: colors.muted }}>{role.assigned ? (role.label ?? '') : 'not assigned'}</span>
              </button>
            ))}
            <button type="button" onClick={addGroup} title="A box whose steps are consulted at the same time, each in its own process" style={{ ...secondaryButtonStyle(), display: 'block', width: '100%', textAlign: 'left', marginTop: 8 }}>
              ∥ Add a parallel box
              <span style={{ display: 'block', fontSize: 10, color: colors.muted }}>steps dropped in run at once</span>
            </button>
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 10, lineHeight: 1.5 }}>
              Drag a step to move it. To connect two steps, select one and press Connect to… on the right, then click the other - or drag from its coloured dot onto the other. Connect them back the other way for a back-and-forth. Delete removes the selected item.
            </div>
          </div>

          {/* The chart */}
          <div style={{ flex: 1, overflow: 'auto', minWidth: 0, background: colors.inputBackground }}>
            <svg
              ref={svg}
              width={CANVAS_W}
              height={CANVAS_H}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerDown={() => {
                setSelection(undefined)
                setConnectFrom(undefined)
              }}
              style={{ display: 'block', touchAction: 'none', userSelect: 'none' }}
            >
              <defs>
                <marker id="lc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={colors.foreground} />
                </marker>
                <marker id="lc-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={colors.accent} />
                </marker>
              </defs>
              {(draft.groups ?? []).map((group) => {
                const chosen = selection?.kind === 'group' && selection.id === group.id
                const members = draft.nodes.filter((n) => n.group === group.id).length
                return (
                  <g key={group.id}>
                    <rect
                      x={group.x}
                      y={group.y}
                      width={group.w}
                      height={group.h}
                      rx={12}
                      fill={colors.accentSoft}
                      fillOpacity={0.35}
                      stroke={chosen ? colors.accent : colors.border}
                      strokeWidth={chosen ? 2 : 1.2}
                      strokeDasharray="8 5"
                      style={{ cursor: 'move' }}
                      onPointerDown={(event) => onGroupDown(event, group, false)}
                    />
                    <text x={group.x + 10} y={group.y + 16} fontSize={11} fontWeight={600} fill={colors.muted} pointerEvents="none">
                      ∥ {group.label ?? 'In parallel'} · {members} step{members === 1 ? '' : 's'} at once
                    </text>
                    <rect x={group.x + group.w - 12} y={group.y + group.h - 12} width={12} height={12} fill={chosen ? colors.accent : colors.border} style={{ cursor: 'nwse-resize' }} onPointerDown={(event) => onGroupDown(event, group, true)}>
                      <title>Drag to resize</title>
                    </rect>
                  </g>
                )
              })}
              {draft.nodes.length < 2 ? (
                <g pointerEvents="none" fill={colors.muted} fontSize={13}>
                  <text x={40} y={draft.nodes.length === 0 ? 60 : 160}>
                    <tspan x={40} dy={0}>1. Click a role on the left - it appears here as a step.</tspan>
                    <tspan x={40} dy={22}>2. Add a second step the same way.</tspan>
                    <tspan x={40} dy={22}>3. Connect them: select a step and press "Connect to…" on the right, then click the other step</tspan>
                    <tspan x={40} dy={18}>    (or drag from the coloured dot on a step's right edge onto the other step).</tspan>
                    <tspan x={40} dy={22}>4. Connect them again the other way for a back-and-forth, then set "Until" on the right.</tspan>
                    <tspan x={40} dy={22}>5. Save and use in this chat.</tspan>
                  </text>
                </g>
              ) : null}
              {connectFrom !== undefined ? (
                <text x={12} y={CANVAS_H > 0 ? 20 : 20} fill={colors.accent} fontSize={13} fontWeight={600} pointerEvents="none">
                  Now click the step it should lead to (Esc to cancel)
                </text>
              ) : null}
              {draft.edges.map((edge) => {
                const from = draft.nodes.find((n) => n.id === edge.from)
                const to = draft.nodes.find((n) => n.id === edge.to)
                if (from === undefined || to === undefined) return null
                const a = boxExit(from, centre(to))
                const b = boxExit(to, centre(from))
                const chosen = selection?.kind === 'edge' && selection.id === edge.id
                const loop = edge.twoWay === true
                const stroke = chosen ? colors.accent : colors.foreground
                const marker = chosen ? 'url(#lc-arrow-accent)' : 'url(#lc-arrow)'
                const state = progress[edge.id]
                const caption = loop
                  ? `⇄ ${edge.until !== undefined && edge.until.trim().length > 0 ? `until ${edge.until.trim().slice(0, 40)}${edge.until.trim().length > 40 ? '…' : ''}, ` : ''}max ${String(edge.maxRounds ?? DEFAULT_LOOP_ROUNDS)}${state !== undefined ? ` · round ${String(state.rounds)}${state.met === true ? ' · met' : ''}` : ''}`
                  : (edge.label ?? '')
                const checked = (edge.requires ?? []).filter((item) => item.trim().length > 0).length
                const withContract =
                  (edge.contract !== undefined && edge.contract.trim().length > 0) || checked > 0
                    ? `${caption}${caption.length > 0 ? ' · ' : ''}contract${checked > 0 ? ` (${String(checked)} checked)` : ''}`
                    : caption
                return (
                  <g
                    key={edge.id}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      setSelection({ kind: 'edge', id: edge.id })
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    {/* A wide invisible line, so a thin connector is easy to click. */}
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14} />
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={stroke}
                      strokeWidth={chosen ? 2.5 : 1.6}
                      strokeDasharray={loop ? '6 4' : undefined}
                      markerEnd={marker}
                      {...(loop ? { markerStart: marker } : {})}
                    />
                    {withContract.length > 0 ? (
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} textAnchor="middle" fontSize={11} fill={state?.met === true ? colors.accent : colors.muted}>
                        {withContract}
                      </text>
                    ) : null}
                  </g>
                )
              })}
              {drag?.kind === 'connect'
                ? (() => {
                    const from = draft.nodes.find((n) => n.id === drag.from)
                    if (from === undefined) return null
                    const a = boxExit(from, { x: drag.x, y: drag.y })
                    return <line x1={a.x} y1={a.y} x2={drag.x} y2={drag.y} stroke={colors.accent} strokeWidth={2} strokeDasharray="4 3" markerEnd="url(#lc-arrow-accent)" pointerEvents="none" />
                  })()
                : null}
              {draft.nodes.map((node) => {
                const chosen = selection?.kind === 'node' && selection.id === node.id
                const missing = !assigned.has(node.role)
                const now = (current !== undefined && current.role === node.role) || running.has(node.role)
                // The same test the Now panel uses, so the two cannot disagree about who is working.
                const working = running.has(node.role) || (current !== undefined && current.role === node.role && current.running)
                const instructed = node.instructions !== undefined && node.instructions.trim().length > 0
                return (
                  <g key={node.id} transform={`translate(${String(node.x)},${String(node.y)})`}>
                    {now ? (
                      // The step being carried out: a glow, moving while it works.
                      <rect x={-5} y={-5} width={NODE_W + 10} height={NODE_H + 10} rx={14} fill="none" stroke={colors.accent} strokeWidth={2} strokeDasharray={working ? '6 4' : undefined} opacity={0.9} pointerEvents="none">
                        {working ? <animate attributeName="stroke-dashoffset" from="0" to="-20" dur="0.8s" repeatCount="indefinite" /> : null}
                      </rect>
                    ) : null}
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={10}
                      fill={colors.background}
                      stroke={chosen || connectFrom === node.id ? colors.accent : missing ? colors.warning : colors.border}
                      strokeWidth={chosen || connectFrom === node.id ? 2.5 : 1.5}
                      style={{ cursor: connectFrom !== undefined ? (connectFrom === node.id ? 'not-allowed' : 'crosshair') : drag?.kind === 'move' ? 'grabbing' : 'grab' }}
                      onPointerDown={(event) => onNodeDown(event, node)}
                    />
                    <text x={12} y={20} fontSize={13} fontWeight={600} fill={colors.foreground} pointerEvents="none">
                      {String(stepNumber.get(node.id) ?? '')}. {roleName(node.role)}
                    </text>
                    <text x={12} y={37} fontSize={10} fill={now ? colors.accent : colors.muted} pointerEvents="none">
                      {now ? (working ? 'working now…' : 'answered last') : `${node.readOnly === true ? 'read-only' : 'may change things'}${instructed ? ' · instructed' : ' · plan decides'}`}
                      {missing ? ' · no model' : ''}
                    </text>
                    {/* Instructions for this specialist, one click away. */}
                    <g
                      transform={`translate(${String(NODE_W - 22)},6)`}
                      style={{ cursor: 'pointer' }}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        editInstructions(node.id)
                      }}
                    >
                      <rect width={16} height={16} rx={4} fill={instructed ? colors.accent : colors.inputBackground} stroke={colors.border} />
                      <text x={8} y={12} textAnchor="middle" fontSize={11} fill={instructed ? colors.background : colors.foreground}>
                        ✎
                      </text>
                      <title>{instructed ? 'Edit the instructions for this specialist' : 'Give this specialist instructions (otherwise the main agent plans it)'}</title>
                    </g>
                    {/* The connect handle */}
                    <circle
                      cx={NODE_W}
                      cy={NODE_H / 2}
                      r={7}
                      fill={colors.accent}
                      stroke={colors.background}
                      strokeWidth={2}
                      style={{ cursor: 'crosshair' }}
                      onPointerDown={(event) => onHandleDown(event, node)}
                    >
                      <title>Drag to another step to connect</title>
                    </circle>
                  </g>
                )
              })}
            </svg>
          </div>

          {/* What is selected */}
          <div style={{ ...side, borderRight: 'none', borderLeft: `1px solid ${colors.border}`, width: narrow ? 200 : 260 }}>
            {isActive ? (
              <div style={{ border: `1px solid ${colors.border}`, borderRadius: 6, padding: 8, marginBottom: 12, fontSize: 12 }}>
                <div style={{ ...labelStyle(), marginBottom: 4 }}>Now</div>
                {currentStep !== undefined && current !== undefined ? (
                  <div>
                    <strong style={{ color: colors.accent }}>
                      {String(stepNumber.get(currentStep.id) ?? '')}. {roleName(currentStep.role)}
                    </strong>{' '}
                    {current.running ? 'is working on it' : 'answered last'}
                  </div>
                ) : (
                  <div style={{ color: colors.muted }}>No specialist consulted yet in this chat.</div>
                )}
                {draft.edges
                  .filter((edge) => edge.twoWay === true)
                  .map((edge) => {
                    const state = progress[edge.id]
                    const a = draft.nodes.find((n) => n.id === edge.from)
                    const b = draft.nodes.find((n) => n.id === edge.to)
                    if (a === undefined || b === undefined) return null
                    return (
                      <div key={edge.id} style={{ marginTop: 4, color: state?.met === true ? colors.accent : colors.foreground }}>
                        {roleName(a.role)} ⇄ {roleName(b.role)}: round {String(state?.rounds ?? 0)} of {String(edge.maxRounds ?? DEFAULT_LOOP_ROUNDS)}
                        {state?.met === true ? ' · done' : state?.verdict !== undefined ? ` · ${state.verdict}` : ''}
                      </div>
                    )
                  })}
              </div>
            ) : null}
            {selectedNode !== undefined ? (
              <>
                <strong>Step: {roleName(selectedNode.role)}</strong>
                <label style={{ ...labelStyle(), marginTop: 8 }} htmlFor="strategy-node-role">
                  Role
                </label>
                <Select
                  id="strategy-node-role"
                  value={selectedNode.role}
                  options={(message?.roles ?? []).map((r) => ({ value: r.id, label: r.name, detail: r.assigned ? (r.label ?? '') : 'not assigned' }))}
                  onChange={(value) => updateNode(selectedNode.id, { role: value })}
                />
                <label style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'flex-start', fontSize: 12 }}>
                  <input type="checkbox" checked={selectedNode.readOnly === true} onChange={(event) => updateNode(selectedNode.id, { readOnly: event.target.checked })} />
                  <span>
                    Read-only
                    <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>It cannot change anything: it is given no tool that edits or runs commands, and recommends instead.</span>
                  </span>
                </label>
                <label style={{ ...labelStyle(), marginTop: 10 }} htmlFor="strategy-node-instructions">
                  Instructions for this specialist
                </label>
                <textarea
                  id="strategy-node-instructions"
                  ref={instructionsBox}
                  value={selectedNode.instructions ?? ''}
                  maxLength={4000}
                  rows={6}
                  placeholder="e.g. write a failing test for the change first; never edit the code under test"
                  onChange={(event) => updateNode(selectedNode.id, event.target.value.length > 0 ? { instructions: event.target.value } : { instructions: undefined })}
                  style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
                />
                <span style={{ display: 'block', fontSize: 11, color: colors.muted, marginTop: 4 }}>
                  Sent to it with every question it is asked under this strategy. Leave empty and the main agent decides what to ask it, from its plan.
                </span>
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={primaryButtonStyle(draft.nodes.length < 2)}
                    {...disabledWhen([draft.nodes.length < 2, 'Add another step first - a connector needs two.'], { enabledTitle: 'Then click the step this one should lead to.' })}
                    onClick={() => setConnectFrom(selectedNode.id)}
                  >
                    {connectFrom === selectedNode.id ? 'Click the other step…' : 'Connect to…'}
                  </button>
                  <button type="button" style={secondaryButtonStyle()} onClick={removeSelected}>
                    Remove step
                  </button>
                </div>
              </>
            ) : selectedGroup !== undefined ? (
              <>
                <strong>Parallel box</strong>
                <label style={{ ...labelStyle(), marginTop: 8 }} htmlFor="strategy-group-label">
                  Name
                </label>
                <input
                  id="strategy-group-label"
                  value={selectedGroup.label ?? ''}
                  maxLength={80}
                  onChange={(event) => updateGroup(selectedGroup.id, event.target.value.length > 0 ? { label: event.target.value } : { label: undefined })}
                  style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
                />
                <span style={{ display: 'block', fontSize: 11, color: colors.muted, marginTop: 6 }}>
                  Steps dropped inside are consulted at the same time, each specialist in its own process, and the strategy carries on when all have answered.
                  Drag the box to move it with its steps, its corner to resize it. A role belongs in one box once.
                </span>
                <button type="button" style={{ ...secondaryButtonStyle(), marginTop: 10 }} onClick={removeSelected}>
                  Remove box
                </button>
              </>
            ) : selectedEdge !== undefined ? (
              <>
                <strong>
                  {roleName(draft.nodes.find((n) => n.id === selectedEdge.from)?.role ?? '')} {selectedEdge.twoWay === true ? '⇄' : '→'}{' '}
                  {roleName(draft.nodes.find((n) => n.id === selectedEdge.to)?.role ?? '')}
                </strong>
                <label style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'flex-start', fontSize: 12 }}>
                  <input type="checkbox" checked={selectedEdge.twoWay === true} onChange={(event) => updateEdge(selectedEdge.id, { twoWay: event.target.checked })} />
                  <span>
                    Back and forth
                    <span style={{ display: 'block', color: colors.muted, fontSize: 11 }}>
                      {roleName(draft.nodes.find((n) => n.id === selectedEdge.from)?.role ?? '')} works, {roleName(draft.nodes.find((n) => n.id === selectedEdge.to)?.role ?? '')} checks, and back again.
                    </span>
                  </span>
                </label>
                {selectedEdge.twoWay === true ? (
                  <>
                    <label style={{ ...labelStyle(), marginTop: 10 }} htmlFor="strategy-edge-until">
                      Until (judged by {roleName(draft.nodes.find((n) => n.id === selectedEdge.to)?.role ?? '')})
                    </label>
                    <textarea
                      id="strategy-edge-until"
                      value={selectedEdge.until ?? ''}
                      maxLength={300}
                      rows={3}
                      placeholder="e.g. every test passes and the tester has no concerns"
                      onChange={(event) => updateEdge(selectedEdge.id, event.target.value.length > 0 ? { until: event.target.value } : { until: undefined })}
                      style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
                    />
                    <label style={{ ...labelStyle(), marginTop: 10 }} htmlFor="strategy-edge-max">
                      At most this many rounds
                    </label>
                    <input
                      id="strategy-edge-max"
                      type="number"
                      min={1}
                      max={50}
                      value={selectedEdge.maxRounds ?? DEFAULT_LOOP_ROUNDS}
                      onChange={(event) => {
                        const value = Math.max(1, Math.min(50, Math.round(Number(event.target.value) || 1)))
                        updateEdge(selectedEdge.id, { maxRounds: value })
                      }}
                      style={{ ...textFieldStyle(), width: 80 }}
                    />
                    <span style={{ display: 'block', fontSize: 11, color: colors.muted, marginTop: 4 }}>
                      With a condition, it stops as soon as the condition is met - or at this many rounds, whichever comes first.
                    </span>
                  </>
                ) : (
                  <>
                    <label style={{ ...labelStyle(), marginTop: 10 }} htmlFor="strategy-edge-label">
                      Label (optional)
                    </label>
                    <input
                      id="strategy-edge-label"
                      value={selectedEdge.label ?? ''}
                      maxLength={120}
                      placeholder="e.g. with the spec"
                      onChange={(event) => updateEdge(selectedEdge.id, event.target.value.length > 0 ? { label: event.target.value } : { label: undefined })}
                      style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
                    />
                  </>
                )}
                <label style={{ ...labelStyle(), marginTop: 10 }} htmlFor="strategy-edge-contract">
                  What passes along here (the contract, optional)
                </label>
                <textarea
                  id="strategy-edge-contract"
                  value={selectedEdge.contract ?? ''}
                  maxLength={1000}
                  rows={3}
                  placeholder="e.g. the failing tests, each with file:line and the assertion that failed"
                  onChange={(event) => updateEdge(selectedEdge.id, event.target.value.length > 0 ? { contract: event.target.value } : { contract: undefined })}
                  style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box' }}
                />
                <span style={{ display: 'block', fontSize: 11, color: colors.muted, marginTop: 4 }}>
                  The first is told its answer must contain this; the second, that it will be given it - and to say what is missing.
                </span>
                <label style={{ ...labelStyle(), marginTop: 10 }} htmlFor="strategy-edge-requires">
                  Required items, one per line (checked)
                </label>
                <textarea
                  id="strategy-edge-requires"
                  value={(selectedEdge.requires ?? []).join('\n')}
                  rows={4}
                  placeholder={'Changed files\nTests run\nResult'}
                  onChange={(event) => {
                    const items = event.target.value.split('\n').map((line) => line.slice(0, 80))
                    // Kept as typed while editing (blank lines too); empty ones are dropped when it is saved.
                    updateEdge(selectedEdge.id, items.some((item) => item.trim().length > 0) ? { requires: items.slice(0, 10) } : { requires: undefined })
                  }}
                  style={{ ...textFieldStyle(), width: '100%', boxSizing: 'border-box', fontFamily: monospaceFamily }}
                />
                <span style={{ display: 'block', fontSize: 11, color: colors.muted, marginTop: 4 }}>
                  After each answer Light Code checks every item is there, and asks the same specialist again for any it left out (twice at most) before it goes on.
                </span>
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  <button type="button" style={secondaryButtonStyle()} onClick={() => updateEdge(selectedEdge.id, { from: selectedEdge.to, to: selectedEdge.from })} title="Swap which side works and which checks">
                    Reverse
                  </button>
                  <button type="button" style={secondaryButtonStyle()} onClick={removeSelected}>
                    Remove connector
                  </button>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.6 }}>
                {draft.edges.some((e) => (e.contract !== undefined && e.contract.trim().length > 0) || (e.requires ?? []).length > 0) ? (
                  <div style={{ marginBottom: 12, color: colors.foreground }}>
                    <div style={{ ...labelStyle(), marginBottom: 4 }}>Contracts - what passes between them</div>
                    {draft.edges
                      .filter((e) => (e.contract !== undefined && e.contract.trim().length > 0) || (e.requires ?? []).length > 0)
                      .map((e) => (
                        <div
                          key={e.id}
                          role="button"
                          tabIndex={0}
                          title="Click to edit this connector"
                          onClick={() => setSelection({ kind: 'edge', id: e.id })}
                          style={{ cursor: 'pointer', padding: '4px 0', borderTop: `1px solid ${colors.border}` }}
                        >
                          <strong>
                            {roleName(draft.nodes.find((n) => n.id === e.from)?.role ?? '')} {e.twoWay === true ? '⇄' : '→'} {roleName(draft.nodes.find((n) => n.id === e.to)?.role ?? '')}
                          </strong>
                          {e.contract !== undefined ? <div style={{ whiteSpace: 'pre-wrap' }}>{e.contract}</div> : null}
                          {(e.requires ?? []).length > 0 ? <div style={{ color: colors.muted }}>Checked: {(e.requires ?? []).join(', ')}</div> : null}
                        </div>
                      ))}
                  </div>
                ) : null}
                Select a step or a connector to change it. A connector's contract - what passes along it - is set on the
                connector: click the arrow.
                <br />
                <br />
                When this strategy is in use, the main agent first proposes a plan that follows it, and Light Code counts the rounds of each back-and-forth and stops one at its maximum. Each specialist works in its own process with its own memory; the main agent only sees their answers.
              </div>
            )}
            {problems.length > 0 ? (
              <div style={{ marginTop: 14, fontSize: 12, color: colors.warning }}>
                {problems.map((p) => (
                  <div key={p}>• {p}</div>
                ))}
              </div>
            ) : null}
            {isActive && (message?.processes.length ?? 0) > 0 ? (
              <div style={{ marginTop: 14, fontSize: 11, color: colors.muted, fontFamily: monospaceFamily }}>
                {message?.processes.map((p) => (
                  <div key={p.role}>
                    {roleName(p.role)}: process {String(p.generation)}
                    {p.tokens !== undefined ? `, ${String(Math.round((p.tokens / p.window) * 100))}% context` : ''}
                    {p.handoffs > 0 ? `, ${String(p.handoffs)} handoff${p.handoffs === 1 ? '' : 's'}` : ''}
                  </div>
                ))}
              </div>
            ) : null}
            {isActive ? (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...labelStyle(), marginBottom: 4 }}>
                  What passed between them{selectedNode !== undefined || selectedEdge !== undefined ? ' (this selection)' : ''}
                </div>
                {exchanges.length === 0 ? (
                  <div style={{ fontSize: 11, color: colors.muted }}>Nothing yet.</div>
                ) : (
                  exchanges.slice(0, 30).map((e, i) => (
                    <details key={`${String(e.at)}-${String(i)}`} style={{ fontSize: 11, borderTop: `1px solid ${colors.border}`, padding: '4px 0' }}>
                      <summary style={{ cursor: 'pointer' }}>
                        {new Date(e.at).toLocaleTimeString()} <strong>{roleName(e.role)}</strong>
                        {e.parallel === true ? ' ∥' : ''}
                        {e.refused !== undefined ? ' - refused' : ''}
                        {(e.loops ?? []).map((loop) => ` · round ${String(loop.rounds)}${loop.met === true ? ' met' : loop.verdict !== undefined ? ` ${loop.verdict}` : ''}`).join('')}
                        {(e.contracts ?? []).map((c) => (
                          <span key={c.edgeId} style={{ color: c.missing.length > 0 ? colors.error : colors.accent }}>
                            {c.missing.length > 0 ? ` · contract to ${roleName(c.to)} missing ${c.missing.join(', ')}` : ` · contract to ${roleName(c.to)} kept`}
                            {c.askedAgain > 0 ? ` (asked again ${String(c.askedAgain)}×)` : ''}
                          </span>
                        ))}
                      </summary>
                      <div style={{ whiteSpace: 'pre-wrap', margin: '4px 0', color: colors.muted }}>
                        <strong>Asked:</strong> {e.question}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{e.refused !== undefined ? <><strong>Refused:</strong> {e.refused}</> : <><strong>Answered:</strong> {e.answer}</>}</div>
                    </details>
                  ))
                )}
                {props.onAsk !== undefined ? (
                  <button
                    type="button"
                    style={{ ...secondaryButtonStyle(), marginTop: 6 }}
                    title="Put a question in the chat for the main agent, which reads this record to answer"
                    onClick={() => {
                      const about =
                        selectedEdge !== undefined
                          ? `the ${roleName(draft.nodes.find((n) => n.id === selectedEdge.from)?.role ?? '')} and ${roleName(draft.nodes.find((n) => n.id === selectedEdge.to)?.role ?? '')} step`
                          : selectedNode !== undefined
                            ? `the ${roleName(selectedNode.role)} step`
                            : 'the strategy so far'
                      props.onAsk?.(`Explain what has happened in ${about}: what was agreed between the specialists, and why it went back and forth. Use strategy_history.`)
                      props.onClose()
                    }}
                  >
                    Ask the agent why
                  </button>
                ) : null}
              </div>
            ) : null}
            {result !== undefined ? <div style={{ marginTop: 10, fontSize: 12, color: result.ok ? colors.foreground : colors.error }}>{result.message}</div> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

/** The header's Strategy button, Agent team mode only, naming the strategy in use. */
export function StrategyButton(props: { transport: Transport; onAsk?: (text: string) => void; inEditor?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<string | undefined>(undefined)
  const [now, setNow] = useState<string | undefined>(undefined)
  useEffect(() => {
    const unsubscribe = props.transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type !== 'strategies') return
      setActive(message.active?.name)
      const role = message.current?.running === true ? message.roles.find((r) => r.id === message.current?.role)?.name : undefined
      setNow(role)
    })
    props.transport.post({ type: 'requestStrategies' } satisfies UiToHostMessage)
    return unsubscribe
  }, [props.transport])
  return (
    <>
      <button
        type="button"
        style={{ ...secondaryButtonStyle(), padding: '2px 8px', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={active !== undefined ? `This chat follows the strategy "${active}"${now !== undefined ? ` - ${now} is working now` : ''}. Click to see it or change it.` : 'Draw how the main agent should use its specialists.'}
        // In VS Code it opens as an editor tab, with room for the chart; elsewhere over the panel.
        onClick={() => (props.inEditor === true ? props.transport.post({ type: 'openStrategyWindow' } satisfies UiToHostMessage) : setOpen(true))}
      >
        Strategy{active !== undefined ? `: ${active}` : ''}
        {now !== undefined ? <span style={{ color: colors.accent }}> · {now}…</span> : null}
      </button>
      {open ? <StrategyEditor transport={props.transport} onClose={() => setOpen(false)} {...(props.onAsk !== undefined ? { onAsk: props.onAsk } : {})} /> : null}
    </>
  )
}
