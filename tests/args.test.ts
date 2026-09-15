import { describe, expect, it } from 'vitest'
import {
  accountInfoArgs,
  downloadArgs,
  listPurchasesArgs,
  listVersionsArgs,
  loginArgs,
  packageFileName,
  purchaseArgs,
  revokeArgs,
  searchArgs,
  versionArgs,
  versionMetadataArgs,
  withGlobals
} from '@shared/ipatool/args'

/** Asserts the exact argv, because a typo here is a silent runtime failure. */
function argv(args: string[], globals = {}): string[] {
  return withGlobals(args, globals)
}

describe('global flags', () => {
  it('defaults to machine-readable, non-interactive output', () => {
    expect(argv(['auth', 'info'])).toEqual(['auth', 'info', '--format', 'json', '--non-interactive'])
  })

  it('omits --non-interactive when explicitly disabled (download needs this)', () => {
    expect(argv(['download', '-i', '1'], { nonInteractive: false })).toEqual([
      'download',
      '-i',
      '1',
      '--format',
      'json'
    ])
  })

  it('passes verbose and the keychain passphrase through', () => {
    expect(argv(['search', 'x'], { verbose: true, keychainPassphrase: 'sekrit' })).toEqual([
      'search',
      'x',
      '--format',
      'json',
      '--verbose',
      '--non-interactive',
      '--keychain-passphrase',
      'sekrit'
    ])
  })

  it('can request human-readable text output', () => {
    expect(argv(['auth', 'info'], { format: 'text' })).toContain('--format')
    expect(argv(['auth', 'info'], { format: 'text' })).toContain('text')
  })
})

describe('version', () => {
  it('uses the root --version flag', () => {
    expect(versionArgs()).toEqual(['--version'])
  })
})

describe('auth login', () => {
  it('maps email/password onto -e/-p', () => {
    expect(loginArgs('me@example.com', 'hunter2')).toEqual([
      'auth',
      'login',
      '-e',
      'me@example.com',
      '-p',
      'hunter2'
    ])
  })

  it('adds --auth-code only when a 2FA code is supplied', () => {
    expect(loginArgs('me@example.com', 'pw', '123456')).toContain('--auth-code')
    expect(loginArgs('me@example.com', 'pw', '   ')).not.toContain('--auth-code')
    expect(loginArgs('me@example.com', 'pw')).not.toContain('--auth-code')
  })
})

describe('auth info / revoke', () => {
  it('has no arguments of its own', () => {
    expect(accountInfoArgs()).toEqual(['auth', 'info'])
    expect(revokeArgs()).toEqual(['auth', 'revoke'])
  })
})

describe('search', () => {
  it('passes the term positionally plus -l and --platform', () => {
    expect(searchArgs('telegram', { limit: 25, platform: 'ipad' })).toEqual([
      'search',
      'telegram',
      '-l',
      '25',
      '--platform',
      'ipad'
    ])
  })

  it('omits --platform for the automatic default', () => {
    expect(searchArgs('x', { platform: '' })).not.toContain('--platform')
    expect(searchArgs('x')).not.toContain('--platform')
  })

  it('omits an invalid limit', () => {
    expect(searchArgs('x', { limit: 0 })).toEqual(['search', 'x'])
  })

  it('keeps multi-word terms as a single argument', () => {
    const args = searchArgs('shadow rocket')
    expect(args[1]).toBe('shadow rocket')
    expect(args).toHaveLength(2)
  })
})

describe('download', () => {
  it('supports app id selection', () => {
    expect(downloadArgs({ appId: 686449807 })).toEqual(['download', '-i', '686449807'])
  })

  it('supports bundle identifier selection', () => {
    expect(downloadArgs({ bundleID: 'com.apple.mobilesafari' })).toEqual([
      'download',
      '-b',
      'com.apple.mobilesafari'
    ])
  })

  it('emits the full flag set for a pinned historical version', () => {
    expect(
      downloadArgs({
        appId: 686449807,
        output: '/tmp/ipas',
        externalVersionID: '86394041',
        platform: 'iphone',
        purchase: true
      })
    ).toEqual([
      'download',
      '-i',
      '686449807',
      '-o',
      '/tmp/ipas',
      '--external-version-id',
      '86394041',
      '--platform',
      'iphone',
      '--purchase'
    ])
  })

  it('never emits --purchase unless asked', () => {
    expect(downloadArgs({ appId: 1, purchase: false })).not.toContain('--purchase')
  })

  it('skips an empty output path so ipatool falls back to cwd', () => {
    expect(downloadArgs({ appId: 1, output: '  ' })).not.toContain('-o')
  })
})

describe('list-versions', () => {
  it('accepts either selector plus a platform', () => {
    expect(listVersionsArgs({ appId: 42, platform: 'visionos' })).toEqual([
      'list-versions',
      '-i',
      '42',
      '--platform',
      'visionos'
    ])
    expect(listVersionsArgs({ bundleID: 'com.x' })).toEqual(['list-versions', '-b', 'com.x'])
  })
})

describe('list-purchases', () => {
  it('uses -l for page size and -p for page number', () => {
    expect(listPurchasesArgs({ page: 3, maxResults: 50, platform: 'macos' })).toEqual([
      'list-purchases',
      '-l',
      '50',
      '-p',
      '3',
      '--platform',
      'macos'
    ])
  })

  it('omits invalid pagination values', () => {
    expect(listPurchasesArgs({ page: 0, maxResults: -1 })).toEqual(['list-purchases'])
  })
})

describe('purchase', () => {
  it('mirrors the selector flags of download', () => {
    expect(purchaseArgs({ appId: 7, platform: 'appletv' })).toEqual([
      'purchase',
      '-i',
      '7',
      '--platform',
      'appletv'
    ])
  })
})

describe('get-version-metadata', () => {
  it('always includes the required --external-version-id', () => {
    expect(versionMetadataArgs({ appId: 7, externalVersionID: '86394041' })).toEqual([
      'get-version-metadata',
      '-i',
      '7',
      '--external-version-id',
      '86394041'
    ])
  })
})

describe('packageFileName', () => {
  it('mirrors ipatool resolveDestinationPath naming', () => {
    expect(packageFileName('com.telegram.Telegram', 686449807, '10.5.1', 'iphone')).toBe(
      'com.telegram.Telegram_686449807_10.5.1.ipa'
    )
  })

  it('uses .pkg for macOS packages', () => {
    expect(packageFileName('com.x', 1, '1.0', 'macos')).toBe('com.x_1_1.0.pkg')
  })

  it('omits empty components', () => {
    expect(packageFileName('', 0, '1.0', '')).toBe('1.0.ipa')
  })

  it('neutralises path traversal inside a user-supplied version (M11)', () => {
    const name = packageFileName('com.example.app', 42, '../../etc/passwd', 'iphone')
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name.endsWith('.ipa')).toBe(true)
    // No component may start with dots after sanitisation.
    expect(name).toBe('com.example.app_42__.._etc_passwd.ipa')
  })

  it('neutralises windows separators and leading dots', () => {
    const name = packageFileName('com.example.app', 42, '..\\..\\windows\\system32', 'iphone')
    expect(name).not.toContain('\\')
    expect(name).not.toContain('/')
    const dotted = packageFileName('', 0, '.hidden', 'macos')
    expect(dotted.startsWith('.')).toBe(false)
    expect(dotted.endsWith('.pkg')).toBe(true)
  })

  it('sanitises a hostile bundleID too', () => {
    const name = packageFileName('../../../evil', 0, '1.0', 'iphone')
    expect(name).not.toContain('/')
    expect(name.startsWith('.')).toBe(false)
  })

  it('keeps legitimate semver build metadata intact', () => {
    expect(packageFileName('com.x', 1, '1.0.0-rc1+build.42', 'iphone')).toBe(
      'com.x_1_1.0.0-rc1+build.42.ipa'
    )
  })
})
