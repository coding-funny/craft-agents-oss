import { describe, expect, it } from 'bun:test'
import { LoopDetector } from '../../src/agent/loop-detector.ts'
import { CommerceError } from '../../src/domain/errors.ts'

describe('T23 loop detection', () => {
  it('stops three identical no-information calls but treats changed pagination as a different fingerprint', () => {
    const detector = new LoopDetector(3)
    detector.observe('query:{cursor:1}', false)
    detector.observe('query:{cursor:1}', false)
    expect(() => detector.observe('query:{cursor:1}', false)).toThrow(CommerceError)
    expect(() => detector.observe('query:{cursor:2}', false)).not.toThrow()
  })
})
