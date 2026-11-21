import { utils } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { readableKeyPair } from './keySetup.js'

/*
 * ssh2 1.17 writes an ed25519 private key its own parser refuses about 4 times in 1,000. "Set up SSH key" keeps the
 * key it makes for good, so one of those would have broken sign-in to that machine permanently. Found when the
 * add-on's own tests, which make keys too, failed once in a long run.
 */
describe('a new SSH key', () => {
  it('is never one ssh2 cannot read back', () => {
    for (let i = 0; i < 500; i += 1) expect(utils.parseKey(readableKeyPair().private)).not.toBeInstanceOf(Error)
  })

  it('is made again when the first one comes out unreadable', () => {
    const good = utils.generateKeyPairSync('ed25519')
    const generate = vi
      .spyOn(utils, 'generateKeyPairSync')
      .mockReturnValueOnce({ private: '-----BEGIN OPENSSH PRIVATE KEY-----\nbroken\n-----END OPENSSH PRIVATE KEY-----\n', public: good.public })
      .mockReturnValueOnce(good)
    try {
      expect(readableKeyPair().private).toBe(good.private)
      expect(generate).toHaveBeenCalledTimes(2)
    } finally {
      generate.mockRestore()
    }
  })
})
