import type { ToolGroup } from '../tools/types.js'

export interface Mode {
  id: string
  name: string
  description: string
  /** Tool groups this mode may use. `always` is implicit but listed for clarity. */
  groups: ToolGroup[]
}
