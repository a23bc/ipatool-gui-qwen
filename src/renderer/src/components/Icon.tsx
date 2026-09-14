/**
 * Inline icon set.
 *
 * Hand-written 24x24 stroke paths instead of an icon package: the app needs ~35
 * glyphs, and this keeps the bundle free of a font or a multi-hundred-KB sprite
 * dependency. All icons inherit `currentColor` so they theme for free.
 */

import type { ReactNode } from 'react'

export type IconName =
  | 'search'
  | 'download'
  | 'box'
  | 'list'
  | 'activity'
  | 'terminal'
  | 'settings'
  | 'user'
  | 'play'
  | 'pause'
  | 'stop'
  | 'x'
  | 'check'
  | 'alert'
  | 'info'
  | 'chevronRight'
  | 'chevronLeft'
  | 'chevronDown'
  | 'chevronUp'
  | 'folder'
  | 'copy'
  | 'external'
  | 'refresh'
  | 'trash'
  | 'plus'
  | 'minus'
  | 'sun'
  | 'moon'
  | 'globe'
  | 'clock'
  | 'loader'
  | 'command'
  | 'key'
  | 'filter'
  | 'arrowUp'
  | 'arrowDown'
  | 'more'
  | 'file'
  | 'layers'
  | 'history'
  | 'checkCircle'
  | 'xCircle'

const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4-4" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="m3 8 9 5 9-5" />
      <path d="M12 13v8" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  terminal: (
    <>
      <path d="m4 17 6-5-6-5" />
      <path d="M12 19h8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M19 7h1M4 17h1M11 17h9" />
      <circle cx="16" cy="7" r="2.4" />
      <circle cx="8" cy="17" r="2.4" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c0-3.8 3.4-6 7.5-6s7.5 2.2 7.5 6" />
    </>
  ),
  play: <path d="M7.5 4.8v14.4L19.5 12z" />,
  pause: (
    <>
      <path d="M8.5 5v14M15.5 5v14" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  x: <path d="M6 6 18 18M18 6 6 18" />,
  check: <path d="m4.5 12.5 5 5L20 6.5" />,
  alert: (
    <>
      <path d="M12 3.5 2.5 20h19z" />
      <path d="M12 9.5v4.5M12 17.2h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
  chevronRight: <path d="m9.5 5 7 7-7 7" />,
  chevronLeft: <path d="m14.5 5-7 7 7 7" />,
  chevronDown: <path d="m5 9.5 7 7 7-7" />,
  chevronUp: <path d="m5 14.5 7-7 7 7" />,
  folder: (
    <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2.2H19a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M5.5 15.5v-10a2 2 0 0 1 2-2h8" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v5h-5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="m6.5 7 1 12.2A1.5 1.5 0 0 0 9 20.5h6a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M18.8 5.2l-1.5 1.5M6.7 17.3l-1.5 1.5" />
    </>
  ),
  moon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.2 12h17.6" />
      <path d="M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6.8V12l3.4 2" />
    </>
  ),
  loader: (
    <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21M5.6 5.6l2.6 2.6M15.8 15.8l2.6 2.6M18.4 5.6l-2.6 2.6M8.2 15.8l-2.6 2.6" />
  ),
  command: (
    <path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0v11m0 0H6.5A2.5 2.5 0 1 0 9 20v-2.5m0 0h6m0 0V9m0 11h2.5A2.5 2.5 0 1 0 15 17.5M15 9V6.5A2.5 2.5 0 1 1 17.5 9H15z" />
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="4" />
      <path d="m11 12.8 8.2-8.2M17 6.8l2 2M14.8 9l2 2" />
    </>
  ),
  filter: <path d="M3.5 5.5h17l-6.6 7.6v5.6l-3.8-1.9v-3.7z" />,
  arrowUp: (
    <>
      <path d="M12 20V4.5" />
      <path d="m6 10.5 6-6 6 6" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 4v15.5" />
      <path d="m6 13.5 6 6 6-6" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18.5" cy="12" r="1.3" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
      <path d="M14 3.5V8h4.5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.2 8.8 4.9L12 13 3.2 8.1z" />
      <path d="m3.2 12.6 8.8 4.9 8.8-4.9" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4v5h5" />
      <path d="M12 7.8V12l3 1.8" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16.2 9.5" />
    </>
  ),
  xCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  )
}

/** Icons that read better filled than stroked. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play', 'pause'])

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}

export function Icon({ name, size = 16, className, strokeWidth = 1.75 }: IconProps): ReactNode {
  const filled = FILLED.has(name)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/** Spinner variant with a built-in rotation. */
export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }): ReactNode {
  return <Icon name="loader" size={size} className={`spinner ${className}`} />
}
