/**
 * The machine-wide credential slot, and how the GUI reads or repairs it.
 *
 * Why this module exists: ipatool opens its keyring with a *fixed* service name
 * and the backend list `[keychain, secret-service, file]`
 * (`cmd/common.go`, `cmd/constants.go`), and `keyring.Open` returns the first
 * backend that opens. On macOS the Keychain backend is compiled in
 * (`CGO_ENABLED=1` in the release workflow) and always wins, so **every** ipatool
 * process on the machine - the GUI, the terminal CLI, every account - shares one
 * item: service `ipatool-auth.service`, account `account`. There is no flag, no
 * environment variable and no config file that moves it.
 *
 * The record in that slot is not cosmetic: `cmd/*.go` calls
 * `AppStore.AccountInfo()` before *every* store operation and feeds its
 * StoreFront / Pod / DirectoryServicesID into the request, so a slot holding the
 * wrong account makes ipatool ask Apple for the wrong storefront as the wrong
 * identity.
 *
 * The two platforms differ in how far the GUI has to go:
 *
 *  - **Linux** - the Secret Service backend can be made unreachable by hiding the
 *    D-Bus address *and* the runtime directory godbus falls back to, which drops
 *    ipatool onto the `file` backend: one encrypted record per state directory.
 *    Fully isolated, no shared slot at all.
 *  - **macOS** - Security.framework is linked, not discovered, so nothing can
 *    switch it off. The GUI therefore keeps a verbatim copy of each account's
 *    record and moves the right one into the slot before use.
 *
 * Everything here is deliberately conservative: reads are validated against the
 * account-record shape before being trusted, writes never delete anything, and a
 * missing or misbehaving tool degrades to "unavailable" instead of guessing.
 */

import { execFile, spawn } from 'node:child_process'
import {
  decodeSecretToolOutput,
  decodeSecurityOutput,
  secretToolReadArgs,
  secretToolWriteArgs,
  securityWriteCommand,
  securityReadArgs
} from '../shared/accounts'
import { fileExists, lookupOnPath } from './paths'

const TOOL_TIMEOUT_MS = 15_000

export type SlotBridgeKind = 'macos-security' | 'linux-secret-tool' | 'none'

export interface SlotBridge {
  kind: SlotBridgeKind
  /** Absolute path of the helper, or null when there is none. */
  tool: string | null
  /**
   * Whether the slot can be read *and* written. Reading alone is not enough:
   * without a write the GUI could describe a foreign session but never fix it,
   * and a half-supported bridge is worse than none - it would look like switching
   * works right up to the first account that is not currently in the slot.
   */
  available: boolean
  /** Human-readable reason, shown in the accounts panel. */
  detail: string
}

/** `/usr/bin/security` ships with macOS; never resolve it through PATH. */
const MACOS_SECURITY = '/usr/bin/security'

let cached: Promise<SlotBridge> | null = null

/** Detects the platform helper once per process. */
export function slotBridge(): Promise<SlotBridge> {
  if (!cached) cached = detectSlotBridge()
  return cached
}

/** Test seam: forget the cached probe. */
export function resetSlotBridgeCache(): void {
  cached = null
}

async function detectSlotBridge(): Promise<SlotBridge> {
  if (process.platform === 'darwin') {
    const present = await fileExists(MACOS_SECURITY)
    return {
      kind: 'macos-security',
      tool: present ? MACOS_SECURITY : null,
      available: present,
      detail: present
        ? 'macOS keeps ipatool credentials in a single login-Keychain item; the app moves the selected account into it.'
        : `/usr/bin/security is missing, so the shared Keychain item cannot be managed automatically.`
    }
  }

  if (process.platform === 'linux') {
    // The D-Bus environment is stripped for child processes (see engine.childEnv),
    // which sends ipatool to the per-directory `file` backend. That is the
    // intended path; the helper only matters for sessions created before that
    // behaviour existed.
    const tool = await lookupOnPath('secret-tool')
    return {
      kind: tool ? 'linux-secret-tool' : 'none',
      tool,
      available: tool !== null,
      detail: tool
        ? 'Sessions are stored per account; secret-tool is available for migrating older shared entries.'
        : 'Sessions are stored per account. Install libsecret-tools to migrate older shared entries.'
    }
  }

  return {
    kind: 'none',
    tool: null,
    available: false,
    detail: 'The Windows credential backend is not used by ipatool, so each account owns its own record.'
  }
}

/* ------------------------------------------------------------------ *
 * reads
 * ------------------------------------------------------------------ */

/** Runs a helper and returns its stdout, or null on any failure. */
function capture(binary: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: TOOL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // A non-zero exit usually just means "no such item"; both cases are
        // reported as null and the caller decides what that means.
        resolve(error ? null : stdout)
      }
    )
  })
}

/**
 * Reads the shared slot and returns the raw record, or null.
 *
 * Only payloads that parse as a usable account record are returned; the slot is
 * shared with the terminal CLI and with anything else that uses the same service
 * name, so unvalidated output must never be treated as a session.
 */
export async function readSlot(): Promise<{ raw: string | null; bridge: SlotBridge }> {
  const bridge = await slotBridge()
  if (!bridge.available || !bridge.tool) return { raw: null, bridge }

  const stdout = await capture(bridge.tool, bridge.kind === 'macos-security' ? securityReadArgs() : secretToolReadArgs())
  if (stdout === null) return { raw: null, bridge }

  const raw = bridge.kind === 'macos-security' ? decodeSecurityOutput(stdout) : decodeSecretToolOutput(stdout)
  return { raw, bridge }
}

/* ------------------------------------------------------------------ *
 * writes
 * ------------------------------------------------------------------ */

/**
 * Writes `data` into the shared slot, replacing whatever was there.
 *
 * The secret never appears in `argv`: both helpers receive it on stdin, because a
 * command line is readable by every local user through the process table on
 * macOS. Nothing is deleted first - `security` updates in place and
 * `secret-tool store` overwrites - so a crash mid-switch cannot leave the user
 * with no record at all.
 */
export async function writeSlot(data: string): Promise<{ ok: boolean; detail: string }> {
  const bridge = await slotBridge()
  if (!bridge.available || !bridge.tool) {
    return { ok: false, detail: bridge.detail }
  }

  const args = bridge.kind === 'macos-security' ? ['-i'] : secretToolWriteArgs()
  const stdin = bridge.kind === 'macos-security' ? `${securityWriteCommand(data)}\n` : data

  return new Promise((resolve) => {
    const child = spawn(bridge.tool as string, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    const done = (ok: boolean, detail: string): void => resolve({ ok, detail })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(false, 'The credential helper did not respond in time.')
    }, TOOL_TIMEOUT_MS)
    timer.unref?.()

    child.on('error', (error: Error) => {
      clearTimeout(timer)
      done(false, `Could not run ${bridge.tool}: ${error.message}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Kept only to explain a failure; it never contains the record itself.
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return done(true, '')
      done(false, stderr.trim() || `The credential helper exited with code ${code}`)
    })

    child.stdin?.on('error', () => {
      /* the close handler reports the failure */
    })
    child.stdin?.end(stdin, 'utf8')
  })
}
