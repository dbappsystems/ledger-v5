// src/DriverQuickRef.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — DRIVER QUICK REFERENCE CARD (owner spot-check popup)
//
// PURPOSE
//   When a driver phones in, the owner (e.g. Bruce) taps one button and sees an
//   abbreviated, at-a-glance reconciliation — NOT an itemized settlement. It
//   answers exactly three questions the carrier asks:
//     1. What has this driver EARNED?   (pay after carrier cut + detention + reimb)
//     2. What has the carrier already PROVIDED to the driver, across EVERY channel?
//     3. What is STILL OWED to the driver — or what does the driver OWE back?
//
// MATH SOURCE (single source of truth — NO re-derivation of the net):
//   computeRunningBalance() in src/settlementMath.js. The card reads its fields;
//   it never invents a split, a fee, or a net. The net shown here is the SAME
//   stillOwedRaw the settlement report and FIFO ledger use, to the penny.
//
//   EARNED   = allGrossPay + allReimb
//              (allGrossPay already = base*(1-cut) + detention, per calcPay;
//               allReimb = lumper/incidental money owed 100% to the driver)
//
//   PROVIDED = every dollar the carrier has already gotten to the driver:
//     ACH paid out ............ allAchDisbursed
//     Broker Advance (Comdata)  allAdvKept       (cash the driver pocketed from brokers)
//     Escrow held ............. allEscrow
//     Fleet fuel .............. allFleetFuel     (carrier-provided fuel card = value out)
//     Carrier advances ........ allCarrierAdvance (direct carrier->driver loans, unrepaid)
//     Cash / check ............ allSettlementPayments
//
//   NET      = EARNED - PROVIDED = stillOwedRaw
//     > 0  -> carrier still owes the driver
//     < 0  -> driver owes the carrier (over-advanced)
//     ~0  -> settled
//
//   IDENTITY (holds to the penny): stillOwedRaw === EARNED - PROVIDED, because
//   computeRunningBalance defines
//     stillOwedRaw = allGrossPay - allAdvKept + allReimb - allFleetFuel
//                    - allAchDisbursed - allEscrow - allCarrierAdvance
//                    - allSettlementPayments
//   which rearranges to (allGrossPay + allReimb) - (sum of all provided channels).
//
// WHITE-LABEL: no driver or carrier names hardcoded. Detention/lumper detail is
// folded into EARNED, not shown as line items — this is a spot-check, not a stub.

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

  // --- MATH (net flows from computeRunningBalance; channels are its own fields) --
  let earned = 0, provided = 0, net = 0;
  let ch = { ach: 0, comdata: 0, escrow: 0, fuel: 0, carrierAdv: 0, cashCheck: 0 };

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

    // EARNED = pay (incl. detention) + lumper/incidental reimbursement.
    earned = bal.allGrossPay + bal.allReimb;

    // PROVIDED = every channel the carrier already moved to the driver.
    ch = {
      ach:        bal.allAchDisbursed,
      comdata:    bal.allAdvKept,
      escrow:     bal.allEscrow,
      fuel:       bal.allFleetFuel,
      carrierAdv: bal.allCarrierAdvance,
      cashCheck:  bal.allSettlementPayments,
    };
    provided = ch.ach + ch.comdata + ch.escrow + ch.fuel + ch.carrierAdv + ch.cashCheck;

    // NET — the SAME raw balance the settlement report uses (may go negative:
    // negative means the driver owes the carrier).
    net = bal.stillOwedRaw;
  }

  const netOwesCarrier = net < -0.005;   // driver owes carrier
  const netLabel = netOwesCarrier ? 'Driver owes carrier' : 'Still owed to driver';
  const netTone  = netOwesCarrier ? 'debt' : (net > 0.005 ? 'owed' : 'neutral');
  const netValue = money(Math.abs(net));

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
            {/* EARNED */}
            <Row label="Earned (lifetime)" value={money(earned)} tone="neutral" strong />
            <div style={S.hint}>Pay after carrier cut, plus detention &amp; reimbursements.</div>

            <div style={S.divider} />

            {/* PROVIDED — every channel */}
            <div style={S.sectionLabel}>PAID / PROVIDED BY CARRIER</div>
            <Row label="ACH paid out"             value={money(ch.ach)}        tone="paid" small />
            <Row label="Broker advance (Comdata)"  value={money(ch.comdata)}    tone="paid" small />
            <Row label="Escrow held"               value={money(ch.escrow)}     tone="paid" small />
            <Row label="Fleet fuel"                value={money(ch.fuel)}       tone="paid" small />
            <Row label="Carrier advances"          value={money(ch.carrierAdv)} tone="paid" small />
            <Row label="Cash / check"              value={money(ch.cashCheck)}  tone="paid" small />
            <Row label="Total provided"            value={money(provided)}      tone="paid" strong />

            <div style={S.divider} />

            {/* NET */}
            <Row label={netLabel} value={netValue} tone={netTone} big />
            <div style={S.footnote}>
              Spot-check only. “Provided” is money already moved to the driver — every channel, not just settlement.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, tone, big, small, strong }) {
  const toneColor = {
    neutral: '#e7e7ea',
    paid:    '#34d399', // green — money already out the door
    debt:    '#fb923c', // orange — driver owes carrier
    owed:    '#fbbf24', // amber — carrier owes driver
  }[tone] || '#e7e7ea';
  const rowStyle = {
    ...styles.row,
    ...(big ? styles.rowBig : null),
    ...(small ? styles.rowSmall : null),
  };
  const labelStyle = {
    ...styles.rowLabel,
    ...(big ? styles.rowLabelBig : null),
    ...(small ? styles.rowLabelSmall : null),
    ...(strong ? styles.rowLabelStrong : null),
  };
  const valueStyle = {
    ...styles.rowValue,
    ...(big ? styles.rowValueBig : null),
    ...(small ? styles.rowValueSmall : null),
    ...(strong ? styles.rowValueStrong : null),
    color: toneColor,
  };
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
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
    width: '100%', maxWidth: 380, background: '#17181c',
    border: '1px solid #2a2c33', borderRadius: 16,
    boxShadow: '0 20px 50px rgba(0,0,0,0.5)', padding: 18,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    maxHeight: '90vh', overflowY: 'auto',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  eyebrow: { fontSize: 11, letterSpacing: 1.5, color: '#8b8d96', fontWeight: 700 },
  driverName: { fontSize: 22, fontWeight: 800, color: '#fff', marginTop: 2 },
  close: {
    background: 'transparent', border: 'none', color: '#8b8d96',
    fontSize: 28, lineHeight: 1, cursor: 'pointer', padding: 0, width: 32, height: 32,
  },
  loading: { color: '#8b8d96', padding: '24px 0', textAlign: 'center' },
  errorBox: { color: '#fca5a5', padding: '18px 0', textAlign: 'center' },
  sectionLabel: { fontSize: 10.5, letterSpacing: 1.2, color: '#8b8d96', fontWeight: 700, margin: '2px 0 4px' },
  hint: { fontSize: 11, color: '#7c7e88', marginTop: 2, lineHeight: 1.3 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0' },
  rowSmall: { padding: '4px 0' },
  rowBig: { padding: '12px 0 4px' },
  rowLabel: { fontSize: 14, color: '#b6b8c0' },
  rowLabelSmall: { fontSize: 13, color: '#9a9ca4' },
  rowLabelStrong: { fontSize: 14.5, color: '#e7e7ea', fontWeight: 700 },
  rowLabelBig: { fontSize: 15, color: '#e7e7ea', fontWeight: 700 },
  rowValue: { fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  rowValueSmall: { fontSize: 14, fontWeight: 600 },
  rowValueStrong: { fontSize: 17, fontWeight: 800 },
  rowValueBig: { fontSize: 24, fontWeight: 800 },
  divider: { height: 1, background: '#2a2c33', margin: '8px 0' },
  footnote: { marginTop: 12, fontSize: 11.5, color: '#7c7e88', lineHeight: 1.4 },
};
