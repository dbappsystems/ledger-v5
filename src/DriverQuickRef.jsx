// src/DriverQuickRef.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — DRIVER QUICK REFERENCE CARD (owner spot-check popup)
//
// PURPOSE
//   When a driver phones in, the owner (e.g. Bruce) taps one button and gets an
//   abbreviated, at-a-glance card — NOT an itemized settlement. It answers four
//   questions and nothing else:
//     1. What has this driver EARNED?              (lifetime net of carrier cut)
//     2. What has the carrier PAID from settlement? (cash/check + ACH — actual money out)
//     3. What carrier advances are still OUTSTANDING?
//     4. What repair debt does the driver still owe?
//   Plus one honest footer line: what is STILL OWED to the driver right now.
//
// MATH SOURCE (single source of truth — NO re-derivation here):
//   computeRunningBalance() in src/settlementMath.js supplies every dollar shown.
//     Earned            = allGrossPay
//     Paid (settlement) = allSettlementPayments + allAchDisbursed
//     Still owed (net)  = stillOwed
//   The card reads those fields; it never recomputes a split, a fee, or a total.
//   "Paid" is intentionally NOT "owed" — they are different numbers and the card
//   keeps them separate so the owner is never told a driver was paid what they
//   were merely owed.
//
// ADVANCES / REPAIR DEBT:
//   Unrepaid carrier_advances rows. reason==='repair' is the repair bucket; every
//   other unrepaid reason is the general-advance bucket. Repaid rows are closed
//   and excluded (matches carrierAdvanceOwed() semantics).
//
// WHITE-LABEL: no driver names or carrier names are hardcoded. Standard accounting
// labels only. Detention, lumper, ACH line-items, incidentals etc. are deliberately
// NOT shown — this is a spot-check, not a paystub.

import React, { useEffect, useState } from 'react';
import { api } from './api';
import { computeRunningBalance } from './settlementMath';

const money = (n) =>
  (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function DriverQuickRef({
  driver,                 // 'TIM' (uppercase, as stored on loads)
  loads = [],             // already-loaded loads array (parent supplies)
  fuelEntries,            // OPTIONAL: parent's fuel rows; if omitted, card fetches
  escrowTotal,            // OPTIONAL: driver's escrow total; if omitted, card fetches
  ownerCutPct,            // tenant carrier rate (fraction), passed explicitly
  onClose,                // () => void
}) {
  const [advances, setAdvances] = useState(null);   // carrier_advances rows
  const [payments, setPayments] = useState(null);   // settlement_payments rows
  const [fuel,     setFuel]     = useState(null);   // fuel_entries rows
  const [escrow,   setEscrow]   = useState(null);   // escrow total (number)
  const [err, setErr] = useState('');

  const dn = String(driver || '').toUpperCase();

  // Fuel + escrow: use the parent's copies when supplied, else fetch them here.
  // Owner/bookkeeper can read any driver's fuel and escrow (worker-verified), so
  // the card is fully self-contained and the mount site needs no new state.
  const fuelProvided   = Array.isArray(fuelEntries);
  const escrowProvided = escrowTotal !== undefined && escrowTotal !== null;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [adv, pay, fu, esc] = await Promise.all([
          api('/api/carrier-advances/' + encodeURIComponent(dn)).catch(() => []),
          api('/api/settlement-payments/' + encodeURIComponent(dn)).catch(() => []),
          fuelProvided   ? Promise.resolve(fuelEntries)
                         : api('/api/fuel/' + encodeURIComponent(dn)).catch(() => []),
          escrowProvided ? Promise.resolve(escrowTotal)
                         : api('/api/escrow-payments/' + encodeURIComponent(dn)).catch(() => []),
        ]);
        if (!live) return;
        setAdvances(Array.isArray(adv) ? adv : []);
        setPayments(Array.isArray(pay) ? pay : []);
        setFuel(Array.isArray(fu) ? fu : []);
        // escrow may arrive as the parent's number OR as fetched rows to sum.
        if (escrowProvided) {
          setEscrow(parseFloat(escrowTotal) || 0);
        } else {
          const rows = Array.isArray(esc) ? esc : [];
          setEscrow(rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
        }
      } catch (e) {
        if (live) setErr('Could not load quick reference.');
      }
    })();
    return () => { live = false; };
  }, [dn]);

  const loading = advances === null || payments === null || fuel === null || escrow === null;

  // --- MATH (all figures flow from computeRunningBalance) --------------------
  let earned = 0, paidSettlement = 0, stillOwed = 0;
  let advOutstanding = 0, repairOwed = 0;

  if (!loading) {
    const settlementPaymentsTotal = payments
      .reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    const bal = computeRunningBalance({
      loads,
      fuelEntries: fuel,
      escrowTotal: escrow,
      driver: dn,
      ownerCutPct,                 // explicit — never rely on the default
      carrierAdvances: advances,
      settlementPaymentsTotal,
    });

    earned         = bal.allGrossPay;                                   // lifetime net earned
    paidSettlement = bal.allSettlementPayments + bal.allAchDisbursed;   // actual money out
    stillOwed      = bal.stillOwed;                                     // true remaining owed

    // Split unrepaid advances into repair vs general (repaid rows are closed).
    const openAdv = advances.filter(a => !a.repaid);
    repairOwed     = openAdv.filter(a => (a.reason || '') === 'repair')
                            .reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
    advOutstanding = openAdv.filter(a => (a.reason || '') !== 'repair')
                            .reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  }

  const S = styles;

  return (
    <div style={S.backdrop} onClick={onClose}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={S.header}>
          <div>
            <div style={S.eyebrow}>QUICK REFERENCE</div>
            <div style={S.driverName}>{dn}</div>
          </div>
          <button style={S.close} onClick={onClose} aria-label="Close">×</button>
        </div>

        {err ? (
          <div style={S.errorBox}>{err}</div>
        ) : loading ? (
          <div style={S.loading}>Loading…</div>
        ) : (
          <>
            <Row label="Earned (lifetime)"        value={money(earned)}         tone="neutral" />
            <Row label="Paid from settlement"     value={money(paidSettlement)} tone="paid" />
            <div style={S.divider} />
            <Row label="Carrier advances open"    value={money(advOutstanding)} tone={advOutstanding > 0 ? 'debt' : 'neutral'} />
            <Row label="Repair still owed"        value={money(repairOwed)}     tone={repairOwed > 0 ? 'debt' : 'neutral'} />
            <div style={S.divider} />
            <Row
              label="Still owed to driver"
              value={money(stillOwed)}
              tone={stillOwed > 0 ? 'owed' : 'neutral'}
              big
            />
            <div style={S.footnote}>
              Spot-check only. “Paid” is money already disbursed — not the balance owed.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, tone, big }) {
  const toneColor = {
    neutral: '#e7e7ea',
    paid:    '#34d399', // green — money already out the door
    debt:    '#fb923c', // orange — driver owes carrier
    owed:    '#fbbf24', // amber — carrier owes driver
  }[tone] || '#e7e7ea';
  return (
    <div style={{ ...styles.row, ...(big ? styles.rowBig : null) }}>
      <span style={{ ...styles.rowLabel, ...(big ? styles.rowLabelBig : null) }}>{label}</span>
      <span style={{ ...styles.rowValue, ...(big ? styles.rowValueBig : null), color: toneColor }}>
        {value}
      </span>
    </div>
  );
}

const styles = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999, padding: 16,
  },
  card: {
    width: '100%', maxWidth: 360, background: '#17181c',
    border: '1px solid #2a2c33', borderRadius: 16,
    boxShadow: '0 20px 50px rgba(0,0,0,0.5)', padding: 18,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, color: '#8b8d96', fontWeight: 700 },
  driverName: { fontSize: 22, fontWeight: 800, color: '#fff', marginTop: 2 },
  close: {
    background: 'transparent', border: 'none', color: '#8b8d96',
    fontSize: 28, lineHeight: 1, cursor: 'pointer', padding: 0, width: 32, height: 32,
  },
  loading: { color: '#8b8d96', padding: '24px 0', textAlign: 'center' },
  errorBox: { color: '#fca5a5', padding: '18px 0', textAlign: 'center' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '9px 0' },
  rowBig: { padding: '12px 0 4px' },
  rowLabel: { fontSize: 14, color: '#b6b8c0' },
  rowLabelBig: { fontSize: 15, color: '#e7e7ea', fontWeight: 700 },
  rowValue: { fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  rowValueBig: { fontSize: 24, fontWeight: 800 },
  divider: { height: 1, background: '#2a2c33', margin: '4px 0' },
  footnote: { marginTop: 12, fontSize: 11.5, color: '#7c7e88', lineHeight: 1.4 },
};
