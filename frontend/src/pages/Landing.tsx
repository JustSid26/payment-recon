import { Link } from 'react-router-dom'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { CountUp } from '../components/CountUp'

// Marketing landing — the public front door. Editorial, near-monochrome, lots of
// whitespace; motion is subtle. Explains what CoreServices does (import →
// reconcile → settle) with a payout-anatomy diagram and a stepped timeline, then
// routes to the two separate sign-in pages. No auth, no live data — illustrative.

const EASE = [0.22, 1, 0.36, 1] as const

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
}
const up: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
}

// A gross capture broken into the parts that make up one settlement — the
// standout diagram (our answer to "what's hidden inside one blended rate").
const PARTS: { label: string; pct: number; cls: string; amount: string; note: string }[] = [
  { label: 'Net payout', pct: 78, cls: 'net', amount: '€805,597', note: 'What the merchant actually receives.' },
  { label: 'Processing fees', pct: 9, cls: 'fee', amount: '€61,645', note: 'MDR, per-txn, decline and refund fees.' },
  { label: 'Rolling reserve', pct: 6, cls: 'reserve', amount: '€13,397', note: 'Held, then released on schedule.' },
  { label: 'Refunds', pct: 4, cls: 'refund', amount: '€6,420', note: 'Reversed captures, netted off.' },
  { label: 'Chargeback fees', pct: 3, cls: 'cb', amount: '€2,180', note: 'Dispute costs, tracked per case.' },
]

const FEATURES: { icon: string; title: string; body: string }[] = [
  { icon: 'account_balance_wallet', title: 'Double-entry ledger', body: 'Every cent posted append-only across balanced accounts — auditable, never silently edited.' },
  { icon: 'payments', title: 'Per-currency settlements', body: 'T+N timing with day-wise partial payouts, confirmation codes and running balances.' },
  { icon: 'savings', title: 'Reserve & refunds', body: 'Rolling-reserve holds, releases, refunds and chargeback fees handled on schedule.' },
  { icon: 'fact_check', title: 'Reconciliation on import', body: 'Processor files are validated and reconciled before a single row is written.' },
  { icon: 'insights', title: 'Insights & ML', body: 'Acceptance, decline drivers, anomalies and recoverable revenue — merchant by merchant.' },
  { icon: 'mark_email_read', title: 'Payout confirmations', body: 'Merchants get a per-currency statement the moment a payout completes.' },
]

const STEPS: { n: string; title: string; body: string }[] = [
  { n: '1', title: 'Import', body: 'Drop a processor CSV or settlement workbook. Rows are checked and reconciled up front — bad data never lands.' },
  { n: '2', title: 'Reconcile', body: 'Captures, fees, refunds and reserve holds post into a balanced double-entry ledger, per merchant and currency.' },
  { n: '3', title: 'Settle', body: 'One running settlement accrues matured activity. Confirm day-wise payouts; balances update to the cent.' },
  { n: '4', title: 'Watch', body: 'Insights, integrity checks and payout emails keep the book straight and everyone informed.' },
]

// A mock of a real recon-tool page — a settlement statement screen in a browser
// frame, tilted slightly for depth. Replaces the abstract card with the product.
const AM_DAYS: [string, string][] = [
  ['Mon 18 Aug', '€142,308.00'],
  ['Tue 19 Aug', '€98,740.52'],
  ['Wed 20 Aug', '€167,221.14'],
]

function AppMock() {
  const reduced = useReducedMotion()
  return (
    <div className="lp-mock-stage">
      <motion.div
        className="lp-appmock"
        initial={reduced ? false : { opacity: 0, y: 36, rotateY: -14, rotateX: 6 }}
        whileInView={{ opacity: 1, y: 0, rotateY: -8, rotateX: 3 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.9, ease: EASE }}
      >
        <div className="am-bar">
          <span className="am-dot" /><span className="am-dot" /><span className="am-dot" />
          <span className="am-url">app.coreservices · Settlement</span>
        </div>
        <div className="am-body">
          <aside className="am-side">
            <span className="am-logo">CS</span>
            {['on', '', '', '', ''].map((s, i) => <span key={i} className={`am-nav ${s}`} />)}
          </aside>
          <div className="am-main">
            <div className="am-head">
              <div>
                <div className="am-title">Settlement · EUR</div>
                <div className="am-subtle">CANAMONEY · 23 Jun → 20 Aug</div>
              </div>
              <span className="am-pill">● Paid</span>
            </div>
            <div className="am-kpis">
              <div className="am-kpi"><span>Gross</span><b>€880,639</b></div>
              <div className="am-kpi"><span>Fees</span><b>−€61,645</b></div>
              <div className="am-kpi net"><span>Net payout</span><b>€805,597</b></div>
            </div>
            <div className="am-rows">
              {AM_DAYS.map(([d, v]) => (
                <div className="am-row" key={d}>
                  <span className="am-rowdate">{d}</span>
                  <span className="am-chip">Paid</span>
                  <span className="am-amt mono">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

/** Big payout-anatomy section: numeral + tilted card + full-width segmented bar + legend columns. */
function PayoutAnatomy() {
  const reduced = useReducedMotion()
  return (
    <section className="lp-anatomy">
      <div className="lp-anatomy-top">
        <motion.div
          className="lp-anatomy-intro"
          initial={reduced ? false : { opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-70px' }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          <span className="lp-kicker">Anatomy of a payout</span>
          <h2>Five parts inside one&nbsp;net&nbsp;payout.</h2>
          <p>
            Behind a single settlement sits a full breakdown — what the merchant keeps, what we
            charge, and what we hold. CoreServices itemises every part, to the cent.
          </p>
        </motion.div>
        <AppMock />
      </div>

      <div className="lp-fullbar" aria-hidden="true">
        {PARTS.map((p, i) => (
          <motion.span
            key={p.label}
            className={`lp-fullbar-seg ${p.cls}`}
            initial={reduced ? false : { transform: 'scaleX(0)' }}
            whileInView={{ transform: 'scaleX(1)' }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.7, ease: EASE, delay: i * 0.1 }}
            style={{ flexGrow: p.pct, flexBasis: 0 }}
          />
        ))}
      </div>

      <motion.div className="lp-cols" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }}>
        {PARTS.map((p) => (
          <motion.div key={p.label} className="lp-col" variants={up}>
            <span className={`lp-dot ${p.cls}`} />
            <h4>{p.label}</h4>
            <span className="lp-col-amt mono">{p.amount}</span>
            <p>{p.note}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  )
}

/** Horizontal, animated step timeline — nodes pop in along a line that draws across. */
function Timeline() {
  const reduced = useReducedMotion()
  return (
    <div className="lp-timeline">
      <motion.span
        className="lp-tl-line"
        initial={reduced ? false : { scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 1.1, ease: EASE }}
      />
      {STEPS.map((s, i) => (
        <div className="lp-tl-step" key={s.n}>
          <motion.span
            className="lp-tl-node"
            initial={reduced ? false : { scale: 0, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.4, ease: EASE, delay: 0.3 + i * 0.2 }}
          >
            {s.n}
          </motion.span>
          <motion.div
            className="lp-tl-body"
            initial={reduced ? false : { opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.4 + i * 0.2 }}
          >
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </motion.div>
        </div>
      ))}
    </div>
  )
}

export default function Landing() {
  const reduced = useReducedMotion()

  const reveal = reduced
    ? {}
    : { initial: { opacity: 0, y: 18 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-70px' }, transition: { duration: 0.6, ease: EASE } }

  return (
    <div className="landing">
      <header className="lp-nav">
        <div className="lp-brand"><span className="lp-mark">CS</span><span>CoreServices</span></div>
        <nav className="lp-nav-actions">
          <Link to="/login/merchant" className="lp-link">Merchant login</Link>
          <Link to="/login/admin" className="btn primary">Admin login</Link>
        </nav>
      </header>

      <section className="lp-hero">
        <motion.div className="lp-hero-copy" variants={stagger} initial="hidden" animate="show">
          <motion.span className="lp-eyebrow" variants={up}>Settlement &amp; ledger platform</motion.span>
          <motion.h1 className="lp-h1" variants={up}>
            Reconcile everything.<br />Pay merchants <span className="lp-hl">to the cent.</span>
          </motion.h1>
          <motion.p className="lp-lede" variants={up}>
            CoreServices reads your processor statements, reconciles every capture, fee, refund and
            reserve into a double-entry ledger, and settles merchants per currency — automatically.
          </motion.p>
          <motion.div className="lp-cta" variants={up}>
            <Link to="/login/admin" className="btn primary lg">Admin sign in →</Link>
            <Link to="/login/merchant" className="btn lg">Merchant sign in</Link>
          </motion.div>
          <motion.div className="lp-pays" variants={up}>
            <span className="dim small">Reconciles</span>
            {['Visa', 'Mastercard', 'Apple Pay', 'Google Pay', 'SEPA', 'USDC'].map((p) => (
              <span key={p} className="lp-pay">{p}</span>
            ))}
          </motion.div>
        </motion.div>

        <motion.div
          className="lp-panel"
          initial={reduced ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.15 }}
        >
          <div className="lp-panel-head">
            <span>Settlement · EUR · CANAMONEY</span>
            <span className="lp-panel-code">TW-4F9A2C</span>
          </div>
          <div className="lp-panel-gross">
            <span className="lp-panel-label">Net payout</span>
            <span className="lp-panel-figure">€<CountUp value={805597} duration={1300} /></span>
            <span className="lp-panel-pill">● Paid · 23 Jun → 20 Aug</span>
          </div>
          <ul className="lp-panel-rows">
            {[['Gross captured', '€880,639.14'], ['Processing fees', '−€61,644.74'], ['Rolling reserve', '−€13,397.04'], ['Net settled', '€805,597.36']].map(([k, v], i) => (
              <li key={k} className={i === 3 ? 'total' : ''}><span>{k}</span><span className="mono">{v}</span></li>
            ))}
          </ul>
        </motion.div>
      </section>

      <section className="lp-strip">
        {[
          ['Double-entry', 'Balanced, append-only postings'],
          ['T+N', 'Business-day settlement cadence'],
          ['Per-currency', 'Day-wise partial payouts'],
          ['Audit-ready', 'Every movement, line by line'],
        ].map(([v, s], i) => (
          <motion.div
            key={v} className="lp-strip-item"
            initial={reduced ? false : { opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-50px' }}
            transition={{ duration: 0.5, ease: EASE, delay: i * 0.06 }}
          >
            <span className="lp-strip-v">{v}</span>
            <span className="lp-strip-s">{s}</span>
          </motion.div>
        ))}
      </section>

      <PayoutAnatomy />

      <section className="lp-section">
        <motion.div className="lp-section-head" {...reveal}>
          <span className="lp-kicker">What it does</span>
          <h2>One reconciled system of record — from file to payout.</h2>
        </motion.div>
        <motion.div className="lp-grid" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }}>
          {FEATURES.map((f) => (
            <motion.article key={f.title} className="lp-card" variants={up}>
              <span className="lp-card-icon material-symbols-outlined">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </section>

      <section className="lp-section lp-process">
        <motion.div className="lp-process-head" {...reveal}>
          <h2>Four steps,<br />fully reconciled.</h2>
          <p>Upload once; the ledger and settlements keep themselves straight — no spreadsheets to chase.</p>
        </motion.div>
        <Timeline />
      </section>

      <section className="lp-final">
        <motion.div className="lp-final-card" {...reveal}>
          <h2>Sign in to CoreServices</h2>
          <p>Operations run the whole book. Merchants read their own payouts.</p>
          <div className="lp-cta">
            <Link to="/login/admin" className="btn primary lg">Admin login →</Link>
            <Link to="/login/merchant" className="btn lg">Merchant login →</Link>
          </div>
        </motion.div>
      </section>

      <footer className="lp-foot">
        <div className="lp-brand"><span className="lp-mark">CS</span><span>CoreServices</span></div>
        <span className="dim small">Internal settlement &amp; ledger platform</span>
      </footer>
    </div>
  )
}
