import type { ProviderProfile } from './types.js'

/**
 * A seat - a specialist role, the decision model, the reranker, the Auditor, the Anti Hallucinator, suggestions while
 * typing - names a provider profile and, optionally, a model from that provider. Asked for: "just select the provider
 * and then select the model for that seat based on selected provider, else user have to create many providers just to
 * prefer for the seat". The profile's address, credentials, certificates and headers are used as they are; only the
 * model changes. Capability overrides belong to the profile's own model, so they are dropped for another one.
 * No model (or the profile's own) is the profile unchanged - every seat saved before this works as it did.
 */
export function seatProfile(profile: ProviderProfile, model: string | undefined): ProviderProfile {
  const chosen = model?.trim()
  if (chosen === undefined || chosen === '' || chosen === profile.model) return profile
  const { modelCapabilities: _own, ...rest } = profile
  void _own
  return { ...rest, model: chosen }
}

/** How a seat is named on screen: the profile, and the model when it is not the profile's own. */
export function seatLabel(profile: { label: string; model?: string | undefined }, model: string | undefined): string {
  const chosen = model?.trim()
  return chosen === undefined || chosen === '' || chosen === profile.model ? profile.label : `${profile.label} · ${chosen}`
}
