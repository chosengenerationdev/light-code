import {
  AGENT_ROLES,
  defaultPromptFor,
  knownRoles,
  roleInfo,
  type AgentRole,
  type CustomRoleDefinition,
} from './roles.js'

/**
 * Who answers each role, as config holds it.
 *
 * `undefined` for a role means nobody is assigned and that specialist is simply not available —
 * absent rather than present and failing, which is the rule the tools already follow.
 */
export interface AgentAssignment {
  /**
   * `cli` is the Claude command line; `profile` names one of the user's provider profiles.
   *
   * The Claude CLI is a *default* for `expert` when it is detected, never a definition. Somebody
   * with a stronger model on their gateway than the one they can run locally should be able to
   * say so, and before this they could not.
   */
  kind: 'cli' | 'profile'
  /** Required when `kind` is `profile`. */
  profileId?: string | undefined
  /**
   * The system prompt, when the user has edited it.
   *
   * Stored **only when it differs from the default**. Otherwise everybody would be pinned to
   * whatever the default said on the day they first opened the tab, and every improvement to a
   * role's prompt would reach nobody who had ever looked at it.
   */
  prompt?: string | undefined
  /**
   * Overrides whether this role may look things up.
   *
   * On the *assignment* rather than the role, because it depends on who is answering: a small
   * local model given five lookups can spend them all and answer worse, while a strong one uses
   * them well. Absent means the role's own default.
   */
  tools?: boolean | undefined
}

export interface AgentTeamConfig {
  roles?: Partial<Record<AgentRole, AgentAssignment>> | undefined
  /**
   * Whether what a consultation costs is worth managing.
   *
   * Off hides the budget, the per-task limits and the spend meter entirely rather than showing
   * them at zero — a cap over something nobody is counting looks like protection without being
   * any. On is the honest default only where cost is actually metered, which today is the Claude
   * CLI; a gateway bills elsewhere and this product cannot see it.
   */
  budgetMatters?: boolean | undefined
  /** The Agent team mode's own instruction, when the user has edited it. */
  teamGuidance?: string | undefined
  /**
   * Roles the user defined, beyond the five built in.
   *
   * Carried alongside the assignments rather than merged into them: a definition says what a role
   * *is*, an assignment says who answers it, and the two are edited at different moments. A role
   * can be defined and unassigned, which is the ordinary state just after creating one.
   */
  definitions?: readonly CustomRoleDefinition[] | undefined
}

/** One role, resolved: who answers, with what prompt, and whether it can be used at all. */
export interface ResolvedAgent {
  role: AgentRole
  name: string
  summary: string
  kind: 'cli' | 'profile'
  profileId?: string
  /** The label to show and to attribute an answer to. */
  label: string
  prompt: string
  /** False when the assignment names something that no longer exists. */
  available: boolean
  /** Whether this specialist may read and search the workspace. See `AgentRoleInfo.usesTools`. */
  usesTools: boolean
  /** Why not, when it is not. */
  reason?: string
}

export interface TeamContext {
  config: AgentTeamConfig | undefined
  profiles: readonly { id: string; label: string }[]
  /** Whether the Claude CLI was detected and is runnable. */
  cliAvailable: boolean
}

/**
 * The default assignment for a role nobody has configured.
 *
 * Only `expert`, and only to the CLI, and only when it is actually there. Filling the other roles
 * with whatever profile happens to be active would look helpful and be a trap: the point of a
 * specialist is a *second* reader, and a team where every member is the model already doing the
 * work is four extra round trips that agree with it.
 */
function defaultAssignment(role: AgentRole, context: TeamContext): AgentAssignment | undefined {
  return role === 'expert' && context.cliAvailable ? { kind: 'cli' } : undefined
}

/** Every role, with whoever answers it. Roles nobody assigned are absent from the result. */
export function resolveTeam(context: TeamContext): ResolvedAgent[] {
  const resolved: ResolvedAgent[] = []
  // Built-ins first, then whatever the user defined — `knownRoles` owns that order so the roster,
  // the picker and the team all present the roles the same way round.
  const custom = context.config?.definitions ?? []
  for (const role of knownRoles(custom)) {
    const assignment = context.config?.roles?.[role] ?? defaultAssignment(role, context)
    if (assignment === undefined) continue

    const info = roleInfo(role, custom)
    const prompt = assignment.prompt ?? defaultPromptFor(role, custom)
    // The assignment may override the role's own default, so somebody who wants a frugal reviewer
    // or a well-read tester can say so without editing prompts.
    const usesTools = assignment.tools ?? info.usesTools

    if (assignment.kind === 'cli') {
      resolved.push({
        role,
        name: info.name,
        summary: info.summary,
        kind: 'cli',
        label: 'Claude',
        prompt,
        usesTools,
        available: context.cliAvailable,
        ...(context.cliAvailable
          ? {}
          : { reason: 'The Claude CLI is not available on this machine.' }),
      })
      continue
    }

    const profile = context.profiles.find((candidate) => candidate.id === assignment.profileId)
    resolved.push({
      role,
      name: info.name,
      summary: info.summary,
      kind: 'profile',
      ...(assignment.profileId !== undefined ? { profileId: assignment.profileId } : {}),
      label: profile?.label ?? assignment.profileId ?? 'unassigned',
      prompt,
      usesTools,
      available: profile !== undefined,
      /*
       * A profile that has been deleted leaves the role unavailable and says so, rather than
       * falling back to the model already doing the work. A specialist that is quietly the
       * primary model gives advice with nothing to distrust about it, which is worse than none.
       */
      ...(profile === undefined
        ? { reason: `No profile "${assignment.profileId ?? ''}" exists any more.` }
        : {}),
    })
  }
  return resolved
}

/** The roles that can actually be consulted right now. */
export function availableAgents(context: TeamContext): ResolvedAgent[] {
  return resolveTeam(context).filter((agent) => agent.available)
}

/**
 * Whether a budget is worth showing.
 *
 * Defaults to *whether anything meters*, rather than to true. Only a Claude CLI consultation
 * reports a cost; a gateway bills somewhere this product cannot see, so offering a spend cap over
 * one would be a control that binds on nothing.
 */
export function budgetMatters(context: TeamContext): boolean {
  const stated = context.config?.budgetMatters
  if (stated !== undefined) return stated
  return resolveTeam(context).some((agent) => agent.kind === 'cli' && agent.available)
}
