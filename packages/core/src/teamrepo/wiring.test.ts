import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { isSecretPath } from '../fs/reach.js'
import { sharedMachineApprovalsFile } from '../platform/node/sharedApprovals.js'
import { loadSkills } from '../skills/index.js'

/*
 * The pieces around the team repository and the shared approvals that no single module's test sees:
 * the copy joining the search path, the timers, "Needs attention", and one approvals list per user.
 */
const bridge = fs.readFileSync(path.join(__dirname, '..', 'host', 'bridge.ts'), 'utf8')

describe('the team repository in the host', () => {
  it('joins the skill and tool search paths as a read-only folder', () => {
    expect(bridge).toContain('extraSkillDirs.push(team.dirs.skills)')
    expect(bridge).toContain('mirroredToolsDirs.push(team.dirs.tools)')
  })

  it('pushes from every folder skills and tools load from - S3 bucket folders included - never the team copy', () => {
    expect(bridge).toContain('skills: [skillsDir, localSkillsDir, ...mirroredSkillsDirs].filter((dir) => !samePath(dir, plan.dirs.skills)),')
    expect(bridge).toContain('tools: [pythonFolders(config).toolsDir, localToolsDir(config), ...mirroredToolsDirs].filter((dir) => !samePath(dir, plan.dirs.tools)),')
    expect(bridge).toContain('const client = await bitbucketClient()')
  })

  it('syncs on its timer and soon after a save, never two at once', () => {
    expect(bridge).toContain("teamTick().catch(")
    expect(bridge).toContain("if (teamRepoSyncing) return")
    expect(bridge.match(/scheduleTeamRepoPush\(\)/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('puts what broke behind the scenes first in "Needs attention"', () => {
    expect(bridge).toContain('problems: [...backgroundProblems.values(), ...pythonProblems(), ...dashboard.problems]')
    expect(bridge).toContain("noteProblem('teamrepo',")
    expect(bridge).toContain('noteProblem(\n      `s3-${kind}`,')
  })
})

describe('where new skills and tools go while the repository is on', () => {
  it('saves them in its own folder outside the project, unless a folder or a publishing bucket was chosen', () => {
    expect(bridge).toContain("own: { skills: path.join(root, 'saved-here', 'skills'), tools: path.join(root, 'saved-here', 'tools') },")
    expect(bridge).toContain('if (config.skills?.dir === undefined && publishSkills === undefined) {\n        skillsDir = team.own.skills')
    expect(bridge).toContain("(publishFolder('tools', config.s3?.tools ?? []) ?? (team !== undefined && 'own' in team ? team.own.tools : undefined))")
  })

  it('lets the agent read every skill and tool folder, wherever it is', () => {
    const roots = bridge.slice(bridge.indexOf('        readRoots: [\n          ...cachedReadRoots,'))
    expect(roots.slice(0, 900)).toContain('...skillSearchPath(),')
    expect(roots.slice(0, 900)).toContain('...python.toolDirectories(),')
  })
})

describe('deleting a skill or tool everywhere', () => {
  const handler = bridge.slice(bridge.indexOf('async function handleDeleteEverywhere('), bridge.indexOf('/** The team repository, as the approval prompt names it'))

  it('goes to the repository first and removes nothing else if it refuses', () => {
    expect(handler.indexOf('tombstoneInRepo(')).toBeLessThan(handler.indexOf('removeSkillFromBucket('))
    expect(handler.indexOf('tombstoneInRepo(')).toBeLessThan(handler.indexOf('await fs.rm(entry'))
    expect(handler).toContain('if (result.failed !== undefined) {')
    expect(handler.slice(handler.indexOf('if (result.failed !== undefined) {'), handler.indexOf('if (result.failed !== undefined) {') + 300)).toContain('return')
  })

  it('acts only on entries a fresh plan still lists - the request comes from the panel', () => {
    expect(handler).toContain('const fresh = await planDeleteEverywhere(kind, name)')
    expect(handler).toContain('requested.repo.filter((repoPath) => fresh.repo.includes(repoPath))')
    expect(handler).toContain('requested.local.filter((entry) => fresh.local.some((allowed) => samePath(allowed, entry)))')
  })

  it('is a button a person presses: no tool sends it, and on a shared server only an admin', () => {
    const tools = fs.readdirSync(path.join(__dirname, '..', 'tools')).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    for (const file of tools) expect(fs.readFileSync(path.join(__dirname, '..', 'tools', file), 'utf8')).not.toContain('deleteEverywhere')
    const roles = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'apps', 'host', 'src', 'roles.ts'), 'utf8')
    expect(roles).toContain("'previewDeleteEverywhere',")
  })
})

describe('switching the S3 bucket folders off', () => {
  const handler = bridge.slice(bridge.indexOf('async function handleRetireS3Buckets('), bridge.indexOf('\n  }\n', bridge.indexOf('async function handleRetireS3Buckets(')))

  it('syncs the bucket and the repository first, and refuses on a failed sync or any conflict', () => {
    expect(handler.indexOf("handleSyncS3('skills')")).toBeLessThan(handler.indexOf('await handleTeamRepoSync('))
    expect(handler.indexOf('await handleTeamRepoSync(')).toBeLessThan(handler.indexOf('checkCoverage('))
    expect(handler).toContain('if (status?.error !== undefined) return refuse(')
    expect(handler).toContain('status.conflicts.length > 0')
    expect(handler).toContain('if (coverage.problems.length > 0) {')
  })

  it('checks again when the switch is pressed, and only unticks - nothing in the bucket or on disk is deleted', () => {
    // The same path runs for Check and for the switch; the switch only differs after a clean check.
    expect(handler.indexOf('if (!confirm) {')).toBeGreaterThan(handler.indexOf('if (coverage.problems.length > 0) {'))
    expect(handler).toContain('delete rest.enabled')
    expect(handler).not.toMatch(/\.rm\(|remove\(|unlink|deleteSkill/)
    expect(handler).toContain('await releaseFromRecord(plan.stateFile,')
  })
})

describe('skills that are the same in two folders', () => {
  it('are one skill, silently; a copy that differs is still reported', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lc-dupe-'))
    const mine = path.join(root, 'mine')
    const team = path.join(root, 'team')
    await fsp.mkdir(mine)
    await fsp.mkdir(team)
    const skill = '---\nname: deploy\ndescription: How we deploy.\n---\nSteps.\n'
    await fsp.writeFile(path.join(mine, 'deploy.md'), skill)
    await fsp.writeFile(path.join(team, 'deploy.md'), skill)
    expect((await loadSkills([mine, team])).issues).toEqual([])
    await fsp.writeFile(path.join(team, 'deploy.md'), skill.replace('Steps.', 'Other steps.'))
    expect((await loadSkills([mine, team])).issues[0]?.detail).toContain('Shadowed')
    await fsp.rm(root, { recursive: true, force: true })
  })
})

describe('approved tool code, one list per user', () => {
  it('lives in the same place for the VS Code extension, the Node host and Fire Code', () => {
    expect(sharedMachineApprovalsFile({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a', 'win32')).toBe(
      path.join('C:\\Users\\a\\AppData\\Local', 'light-code', 'approvals', 'approved-tools.json'),
    )
    const extension = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'apps', 'vscode', 'src', 'webview', 'hostServices.ts'), 'utf8')
    expect(extension).toContain('machineApprovalsFile: sharedMachineApprovalsFile(),')
    const host = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'apps', 'host', 'src', 'cli.ts'), 'utf8')
    expect(host).toContain(': { machineApprovalsFile: sharedMachineApprovalsFile() }),')
    const fire = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'apps', 'sun', 'native', 'src', 'main.rs'), 'utf8')
    expect(fire).toContain('approved_tools: system::shared_approvals_file(),')
  })

  it('is out of reach of tools - a tool able to write it could approve itself', () => {
    expect(isSecretPath('C:\\Users\\a\\AppData\\Local\\light-code\\approvals\\approved-tools.json')).toBe(true)
  })
})
