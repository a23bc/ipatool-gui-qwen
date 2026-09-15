/**
 * Maps ipatool failures onto stable, translatable error codes.
 *
 * ipatool surfaces Apple's private-API responses as free-form text, so we match
 * on substrings that have been stable across v2.x. Each code has a matching
 * entry in the renderer's i18n dictionaries, which lets the UI explain *what to
 * do next* instead of dumping a raw stack trace at the user.
 */

export type IpatoolErrorCode =
  | 'two-factor-required'
  | 'passphrase-required'
  | 'passphrase-invalid'
  | 'not-signed-in'
  | 'bad-credentials'
  | 'account-locked'
  | 'license-required'
  | 'app-not-found'
  | 'version-not-found'
  | 'rate-limited'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'proxy'
  | 'resume-failed'
  | 'platform-mismatch'
  | 'disk'
  | 'engine-missing'
  | 'session-mismatch'
  | 'canceled'
  | 'unknown'

export interface ClassifiedError {
  code: IpatoolErrorCode
  /** Original text, already trimmed and de-duplicated. */
  message: string
  /** True when the renderer should offer a "retry" affordance. */
  retryable: boolean
  /** True when the app can recover on its own (e.g. re-login, ask for 2FA). */
  actionable: boolean
}

interface Rule {
  code: IpatoolErrorCode
  patterns: RegExp[]
  retryable?: boolean
  actionable?: boolean
}

const RULES: Rule[] = [
  {
    code: 'two-factor-required',
    patterns: [/2fa code is required/i, /auth.?code is required/i, /ErrAuthCodeRequired/i],
    actionable: true
  },
  {
    code: 'passphrase-required',
    patterns: [/keychain passphrase is required/i],
    actionable: true
  },
  {
    code: 'passphrase-invalid',
    patterns: [
      /failed to decrypt/i,
      /failed to configure terminal/i,
      /incorrect passphrase/i,
      /invalid passphrase/i,
      /failed to unlock/i,
      /decryption failed/i
    ],
    actionable: true
  },
  {
    code: 'not-signed-in',
    patterns: [
      /no account found/i,
      /not authenticated/i,
      /sign.?in required/i,
      /SignInRequired/i,
      /please (log ?in|sign ?in)/i,
      /no credentials/i,
      /account not found/i
    ],
    actionable: true
  },
  {
    code: 'bad-credentials',
    patterns: [
      /apple id or password is incorrect/i,
      /incorrect password/i,
      /invalid (?:email|password|credentials|username)/i,
      /authentication failed/i,
      /InvalidCredentials/i,
      /wrong password/i
    ],
    actionable: true
  },
  {
    code: 'account-locked',
    patterns: [
      /account (?:is )?(?:disabled|locked|terminated)/i,
      /disabled for security reasons/i,
      /AccountDisabled/i,
      /has been locked/i
    ],
    actionable: true
  },
  {
    code: 'license-required',
    patterns: [/license is required/i, /LicenseNotFound/i, /ErrLicenseRequired/i],
    retryable: true,
    actionable: true
  },
  {
    code: 'app-not-found',
    patterns: [
      /could not find (?:the )?app/i,
      /app not found/i,
      /no results found/i,
      /invalid response/i,
      /failed to lookup/i
    ]
  },
  {
    code: 'version-not-found',
    patterns: [/version (?:not found|unavailable)/i, /unknown version/i, /invalid version/i]
  },
  {
    code: 'rate-limited',
    patterns: [
      /too many requests/i,
      /rate limit/i,
      /\b429\b/,
      /try again later/i,
      /temporarily unavailable/i
    ],
    retryable: true
  },
  {
    code: 'resume-failed',
    patterns: [
      /416/,
      /range not satisfiable/i,
      /requested range not satisfiable/i,
      /failed to seek file/i
    ],
    retryable: true,
    actionable: true
  },
  {
    code: 'platform-mismatch',
    patterns: [/does not declare .* support/i, /failed to validate package platform/i]
  },
  {
    code: 'timeout',
    patterns: [/timeout/i, /timed out/i, /deadline exceeded/i], retryable: true
  },
  {
    code: 'dns',
    patterns: [/no such host/i, /server misbehaving/i, /name resolution/i, /dns/i],
    retryable: true
  },
  {
    code: 'tls',
    patterns: [/x509/i, /certificate/i, /tls handshake/i, /remote error/i], retryable: true
  },
  {
    code: 'proxy',
    patterns: [/proxy/i, /CONNECT tunnel/i], retryable: true
  },
  {
    code: 'disk',
    patterns: [
      /no space left on device/i,
      /permission denied/i,
      /read-only file system/i,
      /failed to (?:create|open|write|remove) file/i,
      /failed to create director/i
    ]
  },
  {
    code: 'network',
    patterns: [
      /failed to send http request/i,
      /connection refused/i,
      /connection reset/i,
      /unexpected eof/i,
      /network is unreachable/i,
      /request failed/i,
      /failed to download/i,
      /EOF/i
    ],
    retryable: true
  },
  {
    code: 'engine-missing',
    patterns: [/ENOENT/i, /no such file or directory/i, /is not recognized/i],
    actionable: true
  },
  {
    code: 'session-mismatch',
    patterns: [/session mismatch for/i],
    actionable: true
  },
  {
    code: 'canceled',
    patterns: [/context canceled/i, /signal: (?:terminated|killed)/i, /^canceled$/i]
  }
]

/** Normalises raw ipatool output into a single searchable blob. */
function haystack(parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .join('\n')
}

export function classifyError(
  ...parts: Array<string | null | undefined>
): ClassifiedError {
  const text = haystack(parts)
  const collapsed = text.replace(/\s+/g, ' ').trim()

  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      return {
        code: rule.code,
        message: collapsed || rule.code,
        retryable: rule.retryable ?? false,
        actionable: rule.actionable ?? false
      }
    }
  }

  return {
    code: 'unknown',
    message: collapsed || 'Unknown error',
    retryable: true,
    actionable: false
  }
}

/**
 * Quick predicate used by the login flow: in `--non-interactive` mode ipatool
 * exits 0 and *logs* that a 2FA code is needed, so success/failure alone is not
 * enough to decide what to do next.
 */
export function isTwoFactorRequired(...parts: Array<string | null | undefined>): boolean {
  return classifyError(...parts).code === 'two-factor-required'
}

export function isPassphraseRequired(...parts: Array<string | null | undefined>): boolean {
  return classifyError(...parts).code === 'passphrase-required'
}

/** Truncates very long messages (Apple sometimes returns whole plists). */
export function shorten(message: string, max = 400): string {
  if (message.length <= max) return message
  return `${message.slice(0, max).trimEnd()}…`
}
