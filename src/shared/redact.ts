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

/** Replaces the values that follow secret-bearing flags. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    // `--password=hunter2` inline form
    const eq = arg.indexOf('=')
    if (eq > 0 && SECRET_FLAGS.has(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=${REDACTION}`)
      continue
    }
    out.push(arg)
    if (SECRET_FLAGS.has(arg) && i + 1 < args.length) {
      out.push(REDACTION)
      i += 1
    }
  }
  return out
}

/**
 * Masks literal secret values inside arbitrary text (log lines, error
 * messages). Empty/short secrets are ignored to avoid nuking the whole string.
 */
export function redactText(text: string, secrets: Array<string | null | undefined>): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || secret.length < 2) continue
    // Split-join avoids regex-escaping pitfalls with arbitrary user input.
    out = out.split(secret).join(REDACTION)
  }
  return out
}

/** True when any argument looks like it carries a secret. */
export function hasSecretFlag(args: string[]): boolean {
  return args.some((arg) => SECRET_FLAGS.has(arg) || SECRET_FLAGS.has(arg.split('=')[0]))
}
