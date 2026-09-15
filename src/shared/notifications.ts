/**
 * Notification copy shared by the main process (OS notifications) and any
 * future renderer use.
 *
 * Pure on purpose: extracting this from `main/ipc.ts` and `main/queue.ts`
 * (which carried two identical copies) makes the notification body unit
 * testable without mocking Electron.
 */

import type { QueueItem } from './types'

/** Body text for the OS notification raised when a queue item settles. */
export function notificationBody(item: QueueItem): string {
  if (item.state === 'done') return `${item.name} finished downloading`
  return `${item.name} failed: ${item.error?.message ?? 'unknown error'}`
}
