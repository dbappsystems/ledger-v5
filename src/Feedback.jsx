// src/Feedback.jsx
// (c) dbappsystems.com | daddyboyapps.com
// Load Ledgers V5 — in-app feedback bubble.
//
// WHAT THIS IS
//   A small floating button ("idea bubble") that sits above the bottom tab bar
//   on the right edge. A logged-in user taps it, types a comment or question
//   ABOUT THE APP, and sends it. The message is saved to the database
//   (contact_messages) via POST /api/contact — it does NOT send an email to
//   anyone. dbappsystems reads these from the database when it wants to.
//
//   This is intentionally NOT an email tool. Users email their brokers/carriers
//   through their own systems. This is only for app feedback that lands in the
//   database, tied to the logged-in tenant by the worker (identity comes from
//   the session token, never the form).
//
// LAYOUT SAFETY
//   - Fixed position, right edge, lifted to bottom:90px so it rides ABOVE the
//     bottom tab bar (Loads/Profile/Repairs/Assets) and never covers a tab.
//   - z-index 9000: above page content, BELOW the credential alert (9999) and
//     toast (10000), so those always win.
//   - The collapsed button is small (56px). The open panel rises UPWARD from
//     the button so it never pushes into the tab bar.

import { useState } from 'react'
import { api } from './api.js'

export default function Feedback() {
  const [open,    setOpen]    = useState(false)
  const [message, setMessage] = useState('')
  const [subject, setSubject] = useState('')
  const [sending, setSending] = useState(false)
  const [sent,    setSent]    = useState(false)
  const [error,   setError]   = useState('')

  async function send() {
    const msg = message.trim()
    if (!msg) { setError('Type your comment first.'); return }
    setSending(true)
    setError('')
    try {
      await api('/api/contact', { method: 'POST', json: { subject: subject.trim(), message: msg } })
      setSent(true)
      setMessage('')
      setSubject('')
      // Auto-close shortly after the thank-you so it gets out of the way.
      setTimeout(() => { setOpen(false); setSent(false) }, 2200)
    } catch (e) {
      setError('Could not send right now. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {/* OPEN PANEL — rises above the button */}
      {open && (
        <div
          style={{
            position: 'fixed',
            right: 16,
            bottom: 156,                 /* sits above the 56px button + its 90px offset */
            width: 'min(340px, calc(100vw - 32px))',
            background: 'var(--navy2)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
            zIndex: 9000,
            padding: 16,
          }}
        >
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
            <div style={{ fontFamily:'var(--font-head)', fontWeight:900, fontSize:15, color:'var(--amber)', letterSpacing:'0.04em' }}>
              SEND FEEDBACK
            </div>
            <button
              onClick={() => { setOpen(false); setError(''); setSent(false) }}
              aria-label="Close"
              style={{ background:'transparent', border:'none', color:'var(--grey)', fontSize:20, lineHeight:1, cursor:'pointer', padding:4 }}
            >
              {'\u00D7'}
            </button>
          </div>

          {sent ? (
            <div style={{ textAlign:'center', padding:'18px 8px' }}>
              <div style={{ fontSize:34, marginBottom:8 }}>{'\u2705'}</div>
              <div style={{ fontFamily:'var(--font-head)', fontWeight:800, color:'var(--white)', fontSize:15 }}>Thanks — got it.</div>
              <div style={{ fontSize:12, color:'var(--grey)', marginTop:4 }}>Your comment was sent.</div>
            </div>
          ) : (
            <>
              <div style={{ fontSize:12, color:'var(--grey)', marginBottom:12, lineHeight:1.4 }}>
                A comment, question, or idea about the app? Send it here. This goes
                straight to dbappsystems — it is not email.
              </div>

              <input
                type="text"
                placeholder="Subject (optional)"
                value={subject}
                onChange={e => { setSubject(e.target.value); setError('') }}
                style={{ marginBottom:10 }}
              />

              <textarea
                placeholder="Your comment..."
                value={message}
                onChange={e => { setMessage(e.target.value); setError('') }}
                style={{ minHeight:110, resize:'vertical', marginBottom:10 }}
              />

              {error && (
                <div style={{ fontSize:12, color:'var(--red)', fontFamily:'var(--font-head)', fontWeight:700, marginBottom:10 }}>
                  {error}
                </div>
              )}

              <button
                onClick={send}
                disabled={sending}
                className="scan-btn"
                style={{ width:'100%', opacity: sending ? 0.6 : 1 }}
              >
                {sending ? 'SENDING...' : 'SEND'}
              </button>
            </>
          )}
        </div>
      )}

      {/* COLLAPSED BUBBLE — the floating button */}
      <button
        onClick={() => { setOpen(o => !o); setError(''); setSent(false) }}
        aria-label="Send feedback"
        title="Send feedback"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 90,                    /* above the bottom tab bar */
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: 'none',
          background: 'var(--amber)',
          color: 'var(--navy)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          zIndex: 9000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
        }}
      >
        {open ? (
          <span style={{ fontSize:26, lineHeight:1 }}>{'\u00D7'}</span>
        ) : (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        )}
      </button>
    </>
  )
}
