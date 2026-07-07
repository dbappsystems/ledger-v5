// src/settlementDrilldown.js
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Period Activity label drill-down (source ledger)
//
// Display-only. Every Period Activity label in SettlementReport opens a plain
// black & white popup listing the exact source rows that produced that total,
// scoped to the selected period. Reads the same period-filtered records the
// card already computes. Changes NO math, writes nothing, never touches the
// running balance. Pure presentation of existing numbers.

import {
  normalizeOwnerCut, parseAppDate, loadDate, getLoadTotals,
} from './settlementMath'

function fmt(n) { return '$' + (parseFloat(n) || 0).toFixed(2) }

// Builds the B&W source ledger for one label key, scoped to the period.
// ctx carries the already-in-scope data + period helpers from the host so the
// filtering matches the card exactly (same inPeriod / inPeriodByDate calls).
export function buildDrilldown(ctx, dn, key) {
  const {
    loads, fuelEntries, escrowPayments, ownerCutPct,
    period, periodOffset, inPeriod, inPeriodByDate, advancesForDriver,
  } = ctx

  const dLoads   = loads.filter(l => l.driver === dn)
  const inRange  = dLoads.filter(l => inPeriod(l, period, periodOffset))
  const ownerCut = normalizeOwnerCut(ownerCutPct)

  if (key === 'loads' || key === 'ratecon' || key === 'driverpay' || key === 'detention') {
    let tBase = 0, tPay = 0, tDet = 0
    const rows = inRange.map(l => {
      const base = parseFloat(l.base_pay) || 0
      const det  = parseFloat(l.detention) || 0
      const pay  = base * (1 - ownerCut)
      tBase += base; tPay += pay; tDet += det
      return [ (l.load_number || '-'), fmt(base), fmt(pay), (det > 0 ? fmt(det) : '-') ]
    })
    const titles = { loads:'Loads', ratecon:'Rate Con Total', driverpay:'Driver Pay', detention:'Detention' }
    const notes = {
      loads:'Each load delivered in this period. Count = number of rows below.',
      ratecon:'Rate confirmation (gross) amount billed per load, before the company split.',
      driverpay:'Driver pay = rate con \u00d7 (1 \u2212 owner cut ' + Math.round(ownerCut*100) + '%). Detention shown separately.',
      detention:'Detention paid per load, added on top of driver pay.',
    }
    return {
      title: titles[key], note: notes[key],
      cols: ['Load #','Rate Con','Driver Pay','Detention'],
      rows,
      footer: ['PERIOD TOTAL' + (key === 'loads' ? ' (' + rows.length + ' loads)' : ''), fmt(tBase), fmt(tPay), fmt(tDet)],
    }
  }

  if (key === 'advance') {
    let tKept = 0
    const rows = inRange.filter(l => {
      const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(l)
      return Math.max(0, comdataTotal - (lumperTotal + incTotal)) > 0
    }).map(l => {
      const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(l)
      const exp  = lumperTotal + incTotal
      const kept = Math.max(0, comdataTotal - exp)
      tKept += kept
      return [ (l.load_number || '-'), fmt(comdataTotal), fmt(exp), fmt(kept) ]
    })
    return {
      title:'Broker Advance (Comdata)',
      note:'Comdata the broker already paid the driver, net of lumpers/incidentals on that load. The leftover (Adv Kept) reduces the driver settlement.',
      cols:['Load #','Comdata','Lumpers+Inc','Adv Kept'],
      rows, footer:['TOTAL','','', fmt(tKept)],
    }
  }

  if (key === 'reimb') {
    let tReimb = 0
    const rows = inRange.filter(l => {
      const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(l)
      return Math.max(0, (lumperTotal + incTotal) - comdataTotal) > 0
    }).map(l => {
      const { comdataTotal, lumperTotal, incTotal } = getLoadTotals(l)
      const exp   = lumperTotal + incTotal
      const reimb = Math.max(0, exp - comdataTotal)
      tReimb += reimb
      return [ (l.load_number || '-'), fmt(comdataTotal), fmt(exp), fmt(reimb) ]
    })
    return {
      title:'Lumper Reimbursement',
      note:'Where lumpers/incidentals the driver paid exceeded the comdata advance — the difference is reimbursed to the driver.',
      cols:['Load #','Comdata','Lumpers+Inc','Reimb'],
      rows, footer:['TOTAL','','', fmt(tReimb)],
    }
  }

  if (key === 'fleetfuel') {
    const list = fuelEntries.filter(f => f.driver === dn.toUpperCase() && f.fuel_type === 'fleet' && inPeriodByDate(f.entry_date, period, periodOffset))
    let t = 0
    const rows = list.map(f => {
      const amt = parseFloat(f.amount) || 0
      t += amt
      return [ (f.entry_date || '-'), (f.notes || '-'), (Number(f.odometer) > 0 ? Number(f.odometer).toLocaleString() + ' mi' : '-'), fmt(amt) ]
    })
    return {
      title:'Fleet Fuel',
      note:'Fleet-card fuel charged in this period — deducted from driver pay.',
      cols:['Date','Notes','Odometer','Amount'],
      rows, footer:['PERIOD TOTAL','','', fmt(t)],
    }
  }

  if (key === 'ach') {
    const list = inRange.filter(l => l.ach_payment)
    let tRecv = 0, tFee = 0
    const rows = list.map(l => {
      const netPay = parseFloat(l.netPay || l.net_pay) || 0
      const recv   = parseFloat(l.ach_received) || 0
      const fee    = Math.max(0, netPay - recv)
      tRecv += recv; tFee += fee
      return [ (l.load_number || '-'), fmt(netPay), fmt(recv), (fee > 0 ? fmt(fee) : '-') ]
    })
    return {
      title:'ACH Paid Out',
      note:'Loads paid to the driver by ACH this period. Broker fee = invoice amount minus what landed.',
      cols:['Load #','Invoice','Received','Broker Fee'],
      rows, footer:['TOTAL','', fmt(tRecv), fmt(tFee)],
    }
  }

  if (key === 'carrieradv') {
    const list = advancesForDriver(dn).filter(a => !a.repaid)
    let t = 0
    const rows = list.map(a => {
      const amt = parseFloat(a.amount) || 0
      t += amt
      return [ (a.advance_date || '-'), (a.reason || 'general').toUpperCase(), (a.notes || '-'), fmt(amt) ]
    })
    return {
      title:'Carrier Advance (unrepaid)',
      note:'Direct carrier-to-driver loans not yet repaid (all-time). These reduce the balance owed until marked repaid.',
      cols:['Date','Reason','Notes','Amount'],
      rows, footer:['UNREPAID TOTAL','','', fmt(t)],
    }
  }

  if (key === 'escrow') {
    const list = (dn === 'TIM' ? escrowPayments : []).filter(pp => inPeriodByDate(pp.funded_at, period, periodOffset))
    let t = 0
    const rows = list.map(pp => {
      const amt = parseFloat(pp.amount) || 0
      t += amt
      return [ (pp.funded_at || '-'), (pp.notes || pp.description || '-'), fmt(amt) ]
    })
    return {
      title:'ETTR Repair Payment (this period)',
      note:'ETTR financed repair payments funded in this period. Applied against the driver balance.',
      cols:['Date','Notes','Amount'],
      rows, footer:['PERIOD TOTAL','', fmt(t)],
    }
  }

  return { title:'', note:'', cols:[], rows:[], footer:null }
}
