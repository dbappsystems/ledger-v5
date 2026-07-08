// src/DrilldownOverlay.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Period Activity label drill-down popup (black & white)
//
// Display-only presentation. Renders the source-ledger table built by
// buildDrilldown() in settlementDrilldown.js. Plain black & white so it reads
// like a printed ledger. Writes nothing, changes no math.
//
// PORTAL FIX (2026-07-08): the overlay is rendered through a React portal into
// document.body. Previously it lived inside SettlementReport, which sits inside
// the .tab-content scroll container — an element with overflow-y:auto creates
// its own containing block, so the overlay's position:fixed resolved against
// .tab-content (WebKit behavior on iPhone), not the viewport. That clipped the
// popup's sticky black header — and its CLOSE button — up under the app chrome
// where it could not be tapped. Portalling to document.body lets position:fixed
// resolve against the real viewport, so z-index:10000 and top:0 mean what they
// say. The card is now vertically centered with its own internal scroll, so the
// CLOSE header stays pinned and reachable no matter how long the ledger is.

import { createPortal } from 'react-dom'

export default function DrilldownOverlay({ meta, driverName, periodLabel, onClose }) {
  if (!meta) return null
  if (typeof document === 'undefined') return null   // SSR/build guard

  const TH  = { background:'#000', color:'#fff', padding:'8px 10px', fontSize:11, fontWeight:700, textAlign:'left', letterSpacing:'0.03em' }
  const THr = { ...TH, textAlign:'right' }
  const TD  = { padding:'8px 10px', fontSize:12, borderBottom:'1px solid #ddd', color:'#000' }
  const TDr = { ...TD, textAlign:'right', fontWeight:600 }
  const TF  = { ...TD, background:'#eee', fontWeight:800, color:'#000', borderTop:'2px solid #000' }
  const TFr = { ...TF, textAlign:'right' }

  const overlay = (
    <div onClick={onClose} style={{ position:'fixed', top:0, left:0, right:0, bottom:0, background:'rgba(0,0,0,0.55)', zIndex:10000, display:'flex', alignItems:'center', justifyContent:'center', padding:'calc(env(safe-area-inset-top, 0px) + 16px) 12px calc(env(safe-area-inset-bottom, 0px) + 16px)', boxSizing:'border-box' }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'#fff', color:'#000', width:'100%', maxWidth:560, maxHeight:'100%', borderRadius:6, overflow:'hidden', boxShadow:'0 8px 40px rgba(0,0,0,0.5)', display:'flex', flexDirection:'column' }}>
        <div style={{ background:'#000', color:'#fff', padding:'12px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:10, letterSpacing:'0.1em', color:'rgba(255,255,255,0.7)' }}>SOURCE LEDGER — {driverName}</div>
            <div style={{ fontSize:15, fontWeight:800 }}>{meta.title}</div>
            <div style={{ fontSize:10, letterSpacing:'0.06em', color:'rgba(255,255,255,0.6)', marginTop:2 }}>{periodLabel}</div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.18)', border:'none', color:'#fff', borderRadius:6, padding:'6px 14px', fontSize:13, fontWeight:700, cursor:'pointer', flexShrink:0 }}>CLOSE</button>
        </div>
        <div style={{ padding:'12px 14px', overflowY:'auto', WebkitOverflowScrolling:'touch' }}>
          {meta.note && <div style={{ fontSize:11, color:'#333', marginBottom:10, lineHeight:1.5 }}>{meta.note}</div>}
          {meta.rows.length === 0 ? (
            <div style={{ padding:'20px 0', textAlign:'center', color:'#666', fontSize:13 }}>No records in this period.</div>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead><tr>{meta.cols.map((c,i) => (
                <th key={i} style={i===0?TH:THr}>{c}</th>
              ))}</tr></thead>
              <tbody>
                {meta.rows.map((r,ri) => (
                  <tr key={ri} style={{ background: ri%2===0?'#fff':'#f6f6f6' }}>
                    {r.map((cell,ci) => (
                      <td key={ci} style={ci===0?TD:TDr}>{cell}</td>
                    ))}
                  </tr>
                ))}
                {meta.footer && (
                  <tr>{meta.footer.map((cell,ci) => (
                    <td key={ci} style={ci===0?TF:TFr}>{cell}</td>
                  ))}</tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}
