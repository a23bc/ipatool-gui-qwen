import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAppStore } from '@renderer/store/app'
import { useQueueStore } from '@renderer/store/queue'
import { useSearchStore } from '@renderer/store/search'
import { useTasksStore } from '@renderer/store/tasks'
import { useUiStore, type View } from '@renderer/store/ui'
import { Icon, type IconName } from './Icon'

interface Command {
  id: string
  label: string
  group: string
  icon: IconName
  keywords?: string
  run: () => void
}

/**
 * Subsequence fuzzy match. Returns a score (higher is better) or null.
 *
 * Contiguous and prefix matches are rewarded, which is what makes "dl" find
 * "Downloads" and "setthm" find "Settings → Theme" feel right without pulling in
 * a fuzzy-search dependency.
 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  if (needle === '') return 0
  const n = needle.toLowerCase()
  const h = haystack.toLowerCase()
  const direct = h.indexOf(n)
  if (direct >= 0) return 1000 - direct

  let score = 0
  let haystackIndex = 0
  let streak = 0
  for (const char of n) {
    const found = h.indexOf(char, haystackIndex)
    if (found < 0) return null
    streak = found === haystackIndex ? streak + 1 : 0
    score += 10 + streak * 6
    if (found === 0) score += 25
    haystackIndex = found + 1
  }
  return score
}

export function CommandPalette(): ReactNode {
  const t = useAppStore((state) => state.t)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const account = useAppStore((state) => state.account)
  const detectEngine = useAppStore((state) => state.detectEngine)
  const installEngine = useAppStore((state) => state.installEngine)
  const revokeAccount = useAppStore((state) => state.revokeAccount)

  const setView = useUiStore((state) => state.setView)
  const open = useUiStore((state) => state.paletteOpen)
  const setOpen = useUiStore((state) => state.setPaletteOpen)
  const setAuthOpen = useUiStore((state) => state.setAuthOpen)
  const toast = useUiStore((state) => state.toast)

  const term = useSearchStore((state) => state.term)
  const runSearch = useSearchStore((state) => state.run)
  const clearFinished = useQueueStore((state) => state.clearFinished)
  const importList = useQueueStore((state) => state.importList)
  const openFolder = useQueueStore((state) => state.openFolder)
  const exportLogs = useTasksStore((state) => state.exportLogs)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const go = (view: View, icon: IconName, label: string): Command => ({
      id: `go-${view}`,
      label,
      group: t('palette.group.navigation'),
      icon,
      keywords: view,
      run: () => setView(view)
    })

    const list: Command[] = [
      go('search', 'search', t('palette.go.search')),
      go('purchases', 'layers', t('palette.go.purchases')),
      go('downloads', 'download', t('palette.go.downloads')),
      go('activity', 'activity', t('palette.go.activity')),
      go('console', 'terminal', t('palette.go.console')),
      go('settings', 'settings', t('palette.go.settings')),
      {
        id: 'act-theme',
        label: t('palette.act.toggleTheme'),
        group: t('palette.group.actions'),
        icon: settings.theme === 'dark' ? 'sun' : 'moon',
        keywords: 'theme dark light appearance 主题',
        run: () => void updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })
      },
      {
        id: 'act-lang-zh',
        label: t('palette.act.langZh'),
        group: t('palette.group.actions'),
        icon: 'globe',
        keywords: 'language chinese zh 中文 语言',
        run: () => void updateSettings({ locale: 'zh-CN' })
      },
      {
        id: 'act-lang-en',
        label: t('palette.act.langEn'),
        group: t('palette.group.actions'),
        icon: 'globe',
        keywords: 'language english en 英文',
        run: () => void updateSettings({ locale: 'en-US' })
      },
      {
        id: 'act-detect',
        label: t('palette.act.detect'),
        group: t('palette.group.actions'),
        icon: 'refresh',
        keywords: 'ipatool engine binary detect',
        run: () => void detectEngine(true)
      },
      {
        id: 'act-install',
        label: t('palette.act.install'),
        group: t('palette.group.actions'),
        icon: 'download',
        keywords: 'ipatool install engine download binary',
        run: () => {
          void installEngine().then((status) => {
            toast(
              status.state === 'ready'
                ? { kind: 'success', message: t('toast.engineInstalled', { version: status.version ?? '' }) }
                : { kind: 'error', message: t('toast.engineFailed'), detail: status.message ?? undefined }
            )
          })
        }
      },
      {
        id: 'act-folder',
        label: t('palette.act.openDownloads'),
        group: t('palette.group.actions'),
        icon: 'folder',
        keywords: 'folder downloads directory 目录',
        run: () => openFolder()
      },
      {
        id: 'act-clear',
        label: t('palette.act.clearFinished'),
        group: t('palette.group.actions'),
        icon: 'trash',
        keywords: 'clear finished downloads 清除',
        run: () => void clearFinished()
      },
      {
        id: 'act-import',
        label: t('palette.act.importList'),
        group: t('palette.group.actions'),
        icon: 'file',
        keywords: 'import list batch 导入 批量',
        run: () => void importList()
      },
      {
        id: 'act-export',
        label: t('palette.act.exportLogs'),
        group: t('palette.group.actions'),
        icon: 'file',
        keywords: 'export logs activity 导出 日志',
        run: () => {
          void exportLogs().then((saved) => {
            if (saved) toast({ kind: 'success', message: saved })
          })
        }
      }
    ]

    if (account) {
      list.push({
        id: 'act-signout',
        label: t('palette.act.signOut'),
        group: t('palette.group.actions'),
        icon: 'user',
        keywords: 'sign out logout revoke account 退出登录',
        run: () => void revokeAccount()
      })
    } else {
      list.push({
        id: 'act-signin',
        label: t('palette.act.signIn'),
        group: t('palette.group.actions'),
        icon: 'user',
        keywords: 'sign in login account apple id 登录',
        run: () => setAuthOpen(true)
      })
    }

    // Searching for whatever is in the header box is always the top hit.
    const pending = term.trim()
    if (pending !== '') {
      list.unshift({
        id: 'search-now',
        label: `${t('common.search')}: ${pending}`,
        group: t('palette.group.search'),
        icon: 'search',
        keywords: pending,
        run: () => {
          setView('search')
          void runSearch(pending)
        }
      })
    }

    return list
  }, [t, settings.theme, account, term, setView, updateSettings, detectEngine, installEngine, toast, openFolder, clearFinished, importList, exportLogs, revokeAccount, setAuthOpen, runSearch])

  const matches = useMemo(() => {
    if (query.trim() === '') return commands
    return commands
      .map((command) => ({ command, score: fuzzyScore(query.trim(), `${command.label} ${command.keywords ?? ''}`) }))
      .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    if (open) {
      setQuery('')
      // Focus after the panel mounts.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Global toggle. Registered once, independent of palette visibility.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(!useUiStore.getState().paletteOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  // Keep the cursor in view while arrowing through a long list.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const grouped: Array<{ group: string; items: Command[] }> = []
  for (const command of matches) {
    const last = grouped[grouped.length - 1]
    if (last && last.group === command.group) last.items.push(command)
    else grouped.push({ group: command.group, items: [command] })
  }

  let flatIndex = -1

  const activate = (command: Command): void => {
    setOpen(false)
    // Defer so the palette unmount is not interleaved with the action's own
    // state updates (e.g. opening another modal).
    setTimeout(() => command.run(), 0)
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]"
      style={{ background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(3px)' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div
        className="panel fade-in flex w-[560px] max-w-[92vw] flex-col overflow-hidden"
        style={{ boxShadow: 'var(--shadow)', maxHeight: '62vh' }}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center gap-2.5 border-b px-3.5" style={{ borderColor: 'var(--border)' }}>
          <span style={{ color: 'var(--text-faint)' }}>
            <Icon name="search" size={15} />
          </span>
          <input
            ref={inputRef}
            className="h-11 flex-1 border-none bg-transparent text-[13.5px] outline-none"
            style={{ color: 'var(--text)' }}
            value={query}
            placeholder={t('palette.placeholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((value) => (matches.length === 0 ? 0 : (value + 1) % matches.length))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((value) => (matches.length === 0 ? 0 : (value - 1 + matches.length) % matches.length))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const command = matches[cursor]
                if (command) activate(command)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
              }
            }}
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1.5">
          {matches.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12.5px] faint">{t('palette.empty')}</p>
          ) : (
            grouped.map((section) => (
              <div key={section.group} className="mb-1">
                <p className="faint px-3.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider">
                  {section.group}
                </p>
                {section.items.map((command) => {
                  flatIndex += 1
                  const index = flatIndex
                  const active = index === cursor
                  return (
                    <button
                      key={command.id}
                      type="button"
                      data-index={index}
                      className="flex w-full items-center gap-2.5 px-3.5 py-[7px] text-left text-[12.5px]"
                      style={{
                        background: active ? 'var(--accent-soft)' : 'transparent',
                        color: active ? 'var(--accent)' : 'var(--text)'
                      }}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => activate(command)}
                    >
                      <Icon name={command.icon} size={14} />
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                      {active ? <span className="kbd">↵</span> : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div
          className="faint flex items-center gap-2 border-t px-3.5 py-2 text-[10.5px]"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="kbd">↑</span>
          <span className="kbd">↓</span>
          <span className="kbd">↵</span>
          <span className="kbd">esc</span>
        </div>
      </div>
    </div>
  )
}
