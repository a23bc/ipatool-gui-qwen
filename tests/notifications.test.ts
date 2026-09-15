import { describe, expect, it } from 'vitest'
import { notificationBody } from '@shared/notifications'
import type { QueueItem } from '@shared/types'

function item(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: 'd1',
    profileId: 'p1',
    appId: 1,
    bundleID: 'com.example.app',
    name: 'Example App',
    version: '1.0',
    platform: '',
    externalVersionID: '',
    purchase: true,
    outputDir: '/downloads',
    state: 'done',
    progress: { received: 0, total: null, percent: null, speed: 0, etaSec: null },
    outputPath: null,
    fileSize: null,
    error: null,
    taskId: null,
    attempts: 0,
    addedAt: 0,
    startedAt: null,
    finishedAt: null,
    artworkKey: null,
    ...overrides
  }
}

describe('notificationBody', () => {
  it('reports success for a done item', () => {
    expect(notificationBody(item({ state: 'done' }))).toBe('Example App finished downloading')
  })

  it('includes the classified error message for a failed item', () => {
    const body = notificationBody(
      item({ state: 'error', error: { message: 'Apple is rate limiting this account', hint: 'rate-limited' } })
    )
    expect(body).toBe('Example App failed: Apple is rate limiting this account')
  })

  it('falls back to "unknown error" when a failed item carries no message', () => {
    expect(notificationBody(item({ state: 'error', error: null }))).toBe('Example App failed: unknown error')
  })
})
