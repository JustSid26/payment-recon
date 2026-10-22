import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'

export type Placement = 'right' | 'left' | 'top' | 'bottom' | 'center'

export type TourStep = {
  /** CSS selector of the element to spotlight. Omit for a centred card. */
  target?: string
  /** Fallback selector if `target` isn't on screen (e.g. a panel that hasn't
   *  loaded yet) — usually the page's nav item, so there's always something to
   *  point at. */
  altTarget?: string
  title: string
  body: ReactNode
  /** Frame the whole page (the main content area) instead of one panel, with
   *  the card tucked into a corner so the page stays visible. */
  whole?: boolean
  /** Route to navigate to when this step opens, so the user actually sees the
   *  page being described. */
  route?: string
  /** Short page name — set on steps that map to a nav page, so Settings can
   *  offer "jump straight to this page's tip". */
  page?: string
  /** Which side of the target to place the card. Default: auto. */
  placement?: Placement
}

type Rect = { top: number; left: number; width: number; height: number }

const PAD = 8 // spotlight padding around the target
const CARD_W = 344
const GAP = 16 // gap between spotlight and card

// An element is a usable target only if it's actually on screen — one inside a
// hidden view, or collapsed to zero size, is not.
function onScreen(el: Element | null): el is Element {
  if (!el || (el as HTMLElement).offsetParent === null) return false
  const r = el.getBoundingClientRect()
  return r.width > 1 && r.height > 1
}

function resolveTarget(step: TourStep): Element | null {
  // Whole-page steps frame the main content area.
  const sel = step.whole ? '[data-tour="page-main"]' : step.target
  const t = sel ? document.querySelector(sel) : null
  if (onScreen(t)) return t
  const a = step.altTarget ? document.querySelector(step.altTarget) : null
  if (onScreen(a)) return a
  return null
}

type Placed = { rect: Rect | null; left: number; top: number; arrow: string }

function place(el: Element | null, cardW: number, cardH: number, want: Placement | undefined): Placed {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!el) {
    return { rect: null, left: Math.round((vw - cardW) / 2), top: Math.round((vh - cardH) / 2), arrow: 'none' }
  }
  const b = el.getBoundingClientRect()
  const rect: Rect = { top: b.top, left: b.left, width: b.width, height: b.height }
  // A target that fills most of the viewport (a whole page, or a very tall/wide
  // table) can't be pointed at from a side — tuck the card into the top-right
  // corner so the page stays fully visible.
  if (b.width > vw * 0.6 && b.height > vh * 0.55) {
    return { rect, left: vw - cardW - 24, top: Math.max(16, b.top + 12), arrow: 'none' }
  }
  // Auto: point right for a left-edge target (the sidebar), else below.
  const p: Placement = want ?? (b.left < vw * 0.33 ? 'right' : 'bottom')
  let left: number
  let top: number
  let arrow: string
  if (p === 'right') { left = b.right + GAP; top = b.top + b.height / 2 - cardH / 2; arrow = 'left' }
  else if (p === 'left') { left = b.left - cardW - GAP; top = b.top + b.height / 2 - cardH / 2; arrow = 'right' }
  else if (p === 'top') { left = b.left + b.width / 2 - cardW / 2; top = b.top - cardH - GAP; arrow = 'down' }
  else if (p === 'center') { left = (vw - cardW) / 2; top = (vh - cardH) / 2; arrow = 'none' }
  else { left = b.left + b.width / 2 - cardW / 2; top = b.bottom + GAP; arrow = 'up' }
  // If a side placement would push the card off-screen vertically, drop below/above.
  if ((p === 'left' || p === 'right') && (top < 16 || top + cardH > vh - 16)) {
    left = b.left + b.width / 2 - cardW / 2
    top = b.bottom + cardH + GAP < vh ? b.bottom + GAP : b.top - cardH - GAP
    arrow = 'none'
  }
  left = Math.min(Math.max(16, left), vw - cardW - 16)
  top = Math.min(Math.max(16, top), vh - cardH - 16)
  return { rect, left, top, arrow }
}

// Fill `:placeholders` in a route from context (e.g. `/merchants/:merchant`).
// Returns null if a placeholder can't be resolved yet, so we don't navigate to a
// broken URL — the step falls back to its altTarget until context arrives.
function resolveRoute(route: string | undefined, ctx: Record<string, string | undefined> | undefined): string | null {
  if (!route) return null
  const out = route.replace(/:(\w+)/g, (m, k) => ctx?.[k] ?? m)
  return out.includes(':') ? null : out
}

export default function Tour({ steps, onClose, startIndex = 0, context }: { steps: TourStep[]; onClose: () => void; startIndex?: number; context?: Record<string, string | undefined> }) {
  const [i, setI] = useState(() => Math.min(Math.max(startIndex, 0), steps.length - 1))
  const [placed, setPlaced] = useState<Placed>({ rect: null, left: 0, top: 0, arrow: 'none' })
  const cardRef = useRef<HTMLDivElement>(null)
  const step = steps[i]
  const navigate = useNavigate()
  const location = useLocation()
  const route = resolveRoute(step.route, context)

  // Take the user to the page this step describes so the tour actually walks
  // through each page, not tooltips over one screen.
  useEffect(() => {
    if (route && location.pathname !== route) navigate(route)
  }, [route, location.pathname, navigate])

  const relayout = useCallback(() => {
    const el = resolveTarget(step)
    if (el && !step.whole) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const card = cardRef.current
    setPlaced(place(el, card?.offsetWidth ?? CARD_W, card?.offsetHeight ?? 200, step.placement))
  }, [step])

  useLayoutEffect(() => {
    relayout()
    // Re-measure a few times: navigating to this step's page (and its async data
    // load) can shift layout or mount the target a beat later. Re-runs on
    // pathname change too, so a late navigation (e.g. once a merchant uuid
    // resolves) still finds the target.
    const timers = [80, 200, 420, 650].map((ms) => window.setTimeout(relayout, ms))
    window.addEventListener('resize', relayout)
    window.addEventListener('scroll', relayout, true)
    return () => {
      timers.forEach(window.clearTimeout)
      window.removeEventListener('resize', relayout)
      window.removeEventListener('scroll', relayout, true)
    }
  }, [relayout, location.pathname])

  const last = i === steps.length - 1
  const next = useCallback(() => (last ? onClose() : setI((n) => n + 1)), [last, onClose])
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back, onClose])

  const { rect } = placed

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="Product tour">
      {rect ? (
        <div
          className="tour-spot"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      ) : (
        <div className="tour-dim" onClick={onClose} />
      )}

      <div ref={cardRef} className={`tour-card arrow-${placed.arrow}`} style={{ top: placed.top, left: placed.left, width: CARD_W }}>
        <div className="tour-head">
          <span className="tour-count">{i + 1} / {steps.length}</span>
          <button className="tour-skip" onClick={onClose} aria-label="Skip tour">Skip tour</button>
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        <div className="tour-dots">
          {steps.map((_, n) => (
            <span key={n} className={`tour-dot${n === i ? ' on' : ''}`} />
          ))}
        </div>
        <div className="tour-actions">
          {i > 0 ? <button className="btn sm" onClick={back}>Back</button> : <span />}
          <button className="btn sm primary" onClick={next}>{last ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    </div>
  )
}
