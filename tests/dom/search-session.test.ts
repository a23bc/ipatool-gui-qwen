/**
 * Per-account session binding for the search store.
 *
 * The behaviour under test is the part of multi-account that is easy to get
 * silently wrong: results are fetched through one Apple ID and the storefront
 * comes from that account, so a cache that ignored the account would present
 * account A's catalogue as account B's. Switching must also drop what is on
 * screen *and* any answer that is still in flight, because a late IPC response
 * arriving after a switch would repopulate the list with the old session's data.
 *
 * The store reads `window.api`, so the bridge is stubbed here rather than mocked
 * at the module level - that keeps the real zustand store, the real LRU cache and
 * the real `accounts:changed` wiring in the test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, SearchResult, StoreApp } from '@shared/types'

type Listener = (payload: unknown) => void

const channel = vi.hoisted(() => ({ listeners: new Set<Listener>() }))
const search = vi.hoisted(() => ({ calls: [] as string[], impl: async (): Promise<Operation<SearchResult>> => ({ ok: true, data: { count: 0, apps: [] }, taskId: 't' }) }))

const api = {
  search: (request: { term: string }): Promise<Operation<SearchResult>> => {
    search.calls.push(request.term)
    return search.impl()
  },
  on: (_channel: string, listener: Listener): (() => void) => {
    channel.listeners.add(listener)
    return () => channel.listeners.delete(listener)
  }
}

// The store, `storage.ts` and the account binder all reach for `window`; only the
// bridge needs to be real.
;(globalThis as unknown as { window: unknown }).window = { api }

import { useAppStore } from '@renderer/store/app'
import { initSearchSession, useSearchStore } from '@renderer/store/search'

function app(id: string): StoreApp {
  return { id: Number(id.slice(1)) || 1, bundleID: `com.example.${id}`, name: id, version: '1.0', price: 0 }
}

/** A promise plus the resolver, so a test can control when the IPC call settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** Simulates the main process publishing a new active account. */
function publishActive(id: string): void {
  useAppStore.setState({
    accounts: {
      accounts: [],
      activeId: id,
      credentialSlot: 'file',
      slotBridge: 'not-needed',
      slotDetail: '',
      legacy: null
    }
  })
  for (const listener of channel.listeners) {
    listener({ accounts: [], activeId: id, credentialSlot: 'file', slotBridge: 'not-needed', slotDetail: '', legacy: null })
  }
}

let dispose: (() => void) | null = null

beforeEach(() => {
  channel.listeners.clear()
  search.calls.length = 0
  search.impl = async () => ({ ok: true, data: { count: 1, apps: [app('a1')] }, taskId: 't' })
  useSearchStore.setState({
    term: '',
    platform: '',
    limit: 25,
    results: [],
    query: '',
    loading: false,
    error: null,
    accountId: '',
    epoch: 0
  })
  dispose?.()
  publishActive('a1')
  dispose = initSearchSession()
})

describe('search results and the active account', () => {
  it('clears the results and the error when the account changes', async () => {
    await useSearchStore.getState().run('term1')
    expect(useSearchStore.getState().results).toHaveLength(1)
    expect(useSearchStore.getState().query).toBe('term1')

    useSearchStore.setState({ error: { message: 'boom', hint: null, code: null } })
    publishActive('a2')

    const state = useSearchStore.getState()
    expect(state.results).toEqual([])
    expect(state.query).toBe('')
    expect(state.error).toBeNull()
    // The typed text survives: re-running it under the new account is one
    // keypress, whereas silently keeping the old list is what made a switch look
    // like it had not happened.
    expect(state.accountId).toBe('a2')
    expect(state.epoch).toBeGreaterThan(0)
  })

  it('does not serve the previous account\u2019s cached results for the same term', async () => {
    search.impl = async () => ({ ok: true, data: { count: 1, apps: [app('a1')] }, taskId: 't' })
    await useSearchStore.getState().run('shared')
    expect(search.calls).toEqual(['shared'])

    publishActive('a2')
    search.impl = async () => ({ ok: true, data: { count: 1, apps: [app('b1')] }, taskId: 't' })
    await useSearchStore.getState().run('shared')

    // The account is part of the cache key, so the same term really re-queries
    // instead of replaying account A's catalogue.
    expect(search.calls).toEqual(['shared', 'shared'])
    expect(useSearchStore.getState().results[0]?.name).toBe('b1')
  })

  it('still serves a cache hit for the same account', async () => {
    await useSearchStore.getState().run('same')
    await useSearchStore.getState().run('same')
    expect(search.calls).toEqual(['same'])
  })

  it('reuses account A\u2019s entry after switching away and back', async () => {
    await useSearchStore.getState().run('again')
    publishActive('a2')
    await useSearchStore.getState().run('again')
    publishActive('a1')

    search.calls.length = 0
    await useSearchStore.getState().run('again')
    expect(search.calls).toEqual([])
    expect(useSearchStore.getState().results[0]?.name).toBe('a1')
  })

  it('discards a response that arrives after the account changed', async () => {
    const gate = deferred<Operation<SearchResult>>()
    search.impl = () => gate.promise

    const pending = useSearchStore.getState().run('term9')
    publishActive('a2')
    gate.resolve({ ok: true, data: { count: 1, apps: [app('a1')] }, taskId: 't' })
    await pending

    const state = useSearchStore.getState()
    expect(state.results).toEqual([])
    expect(state.loading).toBe(false)
    expect(state.query).toBe('')
  })

  it('ignores a response for an account the user already switched away from', async () => {
    // The account pointer can move without an `accounts:changed` event (e.g. a
    // switch that was rolled back), so the guard reads the live store too.
    const gate = deferred<Operation<SearchResult>>()
    search.impl = () => gate.promise

    const pending = useSearchStore.getState().run('term10')
    useAppStore.setState((state) => ({ accounts: { ...state.accounts, activeId: 'a9' } }))
    gate.resolve({ ok: true, data: { count: 1, apps: [app('a1')] }, taskId: 't' })
    await pending

    expect(useSearchStore.getState().results).toEqual([])
  })

  it('stops listening once the returned disposer runs', async () => {
    dispose?.()
    dispose = null
    await useSearchStore.getState().run('term11')
    publishActive('a2')

    // No binder: nothing clears the list, which is exactly why App mounts one.
    expect(useSearchStore.getState().results).toHaveLength(1)
  })
})
