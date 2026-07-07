// src/DrilldownOverlay.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledger V5 — Period Activity label drill-down popup (black & white)
//
// Display-only presentation. Renders the source-ledger table built by
// buildDrilldown() in settlementDrilldown.js. Plain black & white so it reads
// like a printed ledger. Writes nothing, changes no math.

export default function DrilldownOverlay({ meta, driverName, periodLabel, onClose }) {
  if (!meta) return null
  const TH  = { background:'#000', color:'#fff', padding:'8px 10px', fontSize:11, fontWeight:700, textAlign:'left', letterSpacing:'0.03em' }
  const THr = { ...TH, textAlign:'right' }
  const TD  = { padding:'8px 10px', fontSize:12, borderBottom:'1px solid #ddd', color:'#000' }
  const TDr = { ...TD, textAlign:'right', fontWeight:600 }
  const TF  = { ...TD, background:'#eee', fontWeight:800, color:'#000', borderTop:'2px solid #000' }
  const TFr = { ...TF, textAlign:'right' }
  return (
    <div onClick={onClose} style={{ position:'fixed', top:0, left:0, right:0, bottom:0, background:'rgba(0,0,0,0.55)', zIndex:10000, display:'flex', alignItems:'flex-start', justifyContent:'center', padding:'24px 12px', overflowY:'auto', WebkitOverflowScrolling:'touch' }}>
      <div onClick={e => e.stopPropagation()} style={{ background:'#fff', color:'#000', width:'100%', maxWidth:560, borderRadius:6, overflow:'hidden', boxShadow:'0 8px 40px rgba(0,0,0,0.5)' }}>
        <div style={{ background:'#000', color:'#fff', padding:'12px 14px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontSize:10, letterSpacing:'0.1em', color:'rgba(255,255,255,0.7)' }}>SOURCE LEDGER — {driverName}</div>
            <div style={{ fontSize:15, fontWeight:800 }}>{meta.title}</div>
            <div style={{ fontSize:10, letterSpacing:'0.06em', color:'rgba(255,255,255,0.6)', marginTop:2 }}>{periodLabel}</div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.18)', border:'none', color:'#fff', borderRadius:6, padding:'6px 14px', fontSize:13, fontWeight:700, cursor:'pointer' }}>CLOSE</button>
        </div>
        <div style={{ padding:'12px 14px' }}>
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
}
