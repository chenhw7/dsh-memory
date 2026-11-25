/**
 * The two left-sidebar panel icons: the marks that put the memory management
 * page and the identity governance page in the sidebar's global panel list.
 *
 * A `sidebar.panellist` registration is the icon itself — the sidebar renders
 * it at the caller's requested size and selection state and resolves the row
 * title from the registration's `label`, so the components here are pure
 * currentColor glyphs with no text.
 */

import type { ReactNode } from 'react'

/** Icon presentation supplied by the sidebar's panel row. */
export interface PanelIconProps {
  /** Requested square edge in pixels. */
  readonly size: number
  /** Whether this panel is selected in the main column. */
  readonly active: boolean
}

/**
 * The memory mark: a stacked inventory, the shape of the store.
 * @param props - requested size and selection state.
 * @returns the glyph.
 */
export function MemoryPanelIcon(props: PanelIconProps): ReactNode {
  const { size, active } = props
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-memory-panel-icon=""
    >
      <path
        d="M8 1.9 14 5 8 8.1 2 5l6-3.1Z"
        stroke="currentColor"
        strokeWidth={active ? 1.4 : 1.2}
        strokeLinejoin="round"
        opacity={active ? 1 : 0.85}
      />
      <path d="M2 8.1 8 11.2l6-3.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity={active ? 1 : 0.85} />
      <path d="M2 11.2 8 14.3l6-3.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity={active ? 1 : 0.6} />
    </svg>
  )
}

/**
 * The identity mark: the assistant's two self-documents, drawn as two people.
 * @param props - requested size and selection state.
 * @returns the glyph.
 */
export function IdentityPanelIcon(props: PanelIconProps): ReactNode {
  const { size, active } = props
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-identity-panel-icon=""
    >
      <circle cx="6" cy="5.2" r="2.3" stroke="currentColor" strokeWidth="1.2" opacity={active ? 1 : 0.85} />
      <path d="M1.9 13.4c.4-2.5 2-3.9 4.1-3.9s3.7 1.4 4.1 3.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity={active ? 1 : 0.85} />
      <path d="M10.3 3.2a2.2 2.2 0 0 1 0 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity={active ? 1 : 0.6} />
      <path d="M11.5 9.6c1.3.4 2.2 1.4 2.5 3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity={active ? 1 : 0.6} />
    </svg>
  )
}
