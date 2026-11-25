import { describe, expect, it } from 'vitest'

import { resolveTeam } from '../agents/team.js'
import type { ProviderProfile } from './types.js'
import { seatLabel, seatProfile } from './seat.js'

/** Asked for: choose the provider, then the model for the seat - not one provider profile per model. */
describe('a seat with its own model', () => {
  const gateway = { id: 'gw', label: 'Gateway', wireFormat: 'openai', baseUrl: 'https://gw.example.internal/v1', model: 'big-model', auth: { type: 'none' }, modelCapabilities: { contextWindow: 200_000 } } as ProviderProfile

  it('uses the profile with only the model changed', () => {
    const seat = seatProfile(gateway, 'small-model')
    expect(seat).toMatchObject({ id: 'gw', baseUrl: 'https://gw.example.internal/v1', model: 'small-model', auth: { type: 'none' } })
    // The profile's capability overrides belong to its own model.
    expect(seat.modelCapabilities).toBeUndefined()
    expect(seatProfile(gateway, undefined)).toBe(gateway)
    expect(seatProfile(gateway, ' ')).toBe(gateway)
    expect(seatProfile(gateway, 'big-model')).toBe(gateway)
    expect(seatLabel(gateway, 'small-model')).toBe('Gateway · small-model')
    expect(seatLabel(gateway, undefined)).toBe('Gateway')
  })

  it('reaches a specialist role', () => {
    const team = resolveTeam({ config: { roles: { tester: { kind: 'profile', profileId: 'gw', model: 'small-model' } } }, profiles: [{ id: 'gw', label: 'Gateway' }], cliAvailable: false } as never)
    const tester = team.find((agent) => agent.role === 'tester')
    expect(tester).toMatchObject({ profileId: 'gw', model: 'small-model', label: 'Gateway · small-model' })
  })

  // Asked: "if someone allocated the seat already with provider, we need to handle that case too". A seat saved before
  // models could be chosen has none: it is the profile exactly as it was, named as it was.
  it('leaves a seat saved before this exactly as it was', () => {
    const team = resolveTeam({ config: { roles: { tester: { kind: 'profile', profileId: 'gw' } } }, profiles: [{ id: 'gw', label: 'Gateway' }], cliAvailable: false } as never)
    const tester = team.find((agent) => agent.role === 'tester')
    expect(tester?.model).toBeUndefined()
    expect(tester?.label).toBe('Gateway')
    expect(seatProfile(gateway, undefined)).toBe(gateway)
  })
})
