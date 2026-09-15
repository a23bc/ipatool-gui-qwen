/**
 * Secret redaction.
 *
 * Apple ID passwords, 2FA codes and keychain passphrases travel through argv,
 * which on POSIX is world-readable via /proc and shows up in shell history and
 * crash dumps. We cannot avoid passing them to ipatool (that is its interface),
 * but we must never let them reach the log view, the task history, exported
 * logs or the persisted queue.
 */

const SECRET_FLAGS = new Set([
  '-p',
  '--password',
  '--auth-code',
  '--keychain-passphrase',
  '--password-token'
])

export const REDACTION = '\u2022\u2022\u2022\u2022'

/**
 * Minimum length for a value to be scrubbed from free text. Anything shorter
 * risks nuking legitimate content (a 2-char "secret" matches everywhere);
 * real passwords/2FA codes/passphrases are always longer.
 */
const MIN_TEXT_SECRET_LENGTH = 4

/** Replaces the values that follow secret-bearing flags. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    // `--password=hunter2` inline form
    const eq = arg.indexOf('=')
    if (eq > 0 && SECRET_FLAGS.has(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=${REDACTION}`)
      continue
    }
    out.push(arg)
    // NOTE: the next token is masked unconditionally, even when it looks like
    // another flag: pflag (ipatool's parser) treats the token after `-p` as the
    // value regardless of a leading dash, so `-p --verbose` really does send
    // "--verbose" as the password. Over-masking here mirrors what ipatool sees.
    if (SECRET_FLAGS.has(arg) && i + 1 < args.length) {
      out.push(REDACTION)
      i += 1
    }
  }
  return out
}

/**
 * Extracts the literal secret values carried by an argv (the tokens that
 * `redactArgs` would mask). Used by the raw console so a user-typed
 * `-p hunter2` still lands on the scrub list for log redaction.
 */
export function secretValuesFromArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    const eq = arg.indexOf('=')
    if (eq > 0 && SECRET_FLAGS.has(arg.slice(0, eq))) {
      const value = arg.slice(eq + 1)
      if (value !== '') out.push(value)
      continue
    }
    if (SECRET_FLAGS.has(arg) && i + 1 < args.length) {
      const value = args[i + 1]
      if (value) out.push(value)
      i += 1
    }
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}

/**
 * Masks literal secret values inside arbitrary text (log lines, error
 * messages). Empty/short secrets are ignored to avoid nuking the whole string.
 *
 * Two hardening rules:
 *  - secrets are applied longest-first, so a secret that is a substring of
 *    another one cannot shred the longer match first;
 *  - pure-ASCII secrets additionally get a case-insensitive pass, covering
 *    error echoes that case-fold the offending value before printing it.
 */
export function redactText(text: string, secrets: Array<string | null | undefined>): string {
  const sorted = secrets
    .filter((s): s is string => typeof s === 'string' && s.length >= MIN_TEXT_SECRET_LENGTH)
    // Longest first: replacing a short secret before a longer one that
    // contains it would break the longer match apart.
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of sorted) {
    // Split-join avoids regex-escaping pitfalls with arbitrary user input.
    out = out.split(secret).join(REDACTION)
    // Case-insensitive fallback for ASCII-only secrets (locale-folded echoes).
    if (/^[a-z0-9]+$/i.test(secret)) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'gi'), REDACTION)
    }
  }
  return out
}

/** True when any argument looks like it carries a secret. */
export function hasSecretFlag(args: string[]): boolean {
  return args.some((arg) => SECRET_FLAGS.has(arg) || SECRET_FLAGS.has(arg.split('=')[0] ?? ''))
}
