# Genesis Trucking — Domination Plan Reference

> **Source:** trucking.myday7.com · Carter Hill + Tim Hill · Day 7 PBC
> **Purpose:** Baked reference of resources + enhancement ideas for future dbappsystems work.
> **Status:** Reference only. This file is never touched by the build — safe to recall anytime.

---

## ⚠ STACK CONFLICT — verify this before any build

The published site names **TiDB (Distributed SQL)** and **Redis** for database + cache.
The locked dbappsystems stack is **Cloudflare-only** (Workers + Pages + D1 + R2 + KV).
These do not coexist cleanly.

**Decision required:** either the Genesis plan overrides the Cloudflare-only rule, or the plan
gets re-specced onto D1 / KV / Durable Objects / R2. Legal + data-sovereignty implications
are run through the Beards Doctrine at the bottom of this file.

---

## 1 · Executive Vision (verbatim intent)

"Operating system for American freight" — AI-native, voice-first platform. Five interfaces, one brain:

- **Trucker app**
- **Broker portal**
- **Fleet dashboard**
- **Shipper tool**
- **Government / compliance**

Positioning: not competing with Motive/Samsara/DAT/Trucker Path — replacing them.
Voice-first because "truckers drive, they don't type."

---

## 2 · Market Numbers (as claimed — verify before pitching)

| Metric | Figure |
|---|---|
| US freight market / year | $800B+ |
| Truckers in US | 3.5M |
| Freight brokerage market | $90B |
| US freight moved by truck | 72% |

**Competitor comps cited:** Samsara $20B+ (NYSE: IOT) · Motive $2.85B · DAT $1.8B (acquired) ·
Convoy $900M raised (shut down — study the post-mortem).

---

## 3 · The 10 Research Streams

1. **Trucker Psychology** — r/Truckers, TruckersReport, YouTube vlogs, FB groups
2. **Pain Point Mining** — 1-star reviews, DOT complaints, OOIDA surveys, podcasts
3. **Competitive Teardown** — Motive, Samsara, DAT, Trucker Path, Relay, TruckSmarter, Convoy post-mortem
4. **Regulatory Intel** — FMCSA, DOT, CFR Title 49, ELD/HOS/IFTA/DVIR, state rules
5. **Broker-Side** — DAT, Truckstop, Highway.com, TIA, broker forums
6. **Fleet Mgmt** — Fleet Owner, CCJ, enterprise solutions
7. **Financial Services** — ATBS, OTR Solutions, RTS Financial, TriumphPay
8. **Tech Architecture** — Cloudflare, TiDB, Stripe, Twilio, Plaid
9. **Voice / AI UX** — CarPlay, Android Auto, conversational AI patterns
10. **Go-To-Market** — MATS, GATS, Walcott Jamboree, TikTok creators

---

## 4 · Feature Roadmap by User Type

### Trucker (mobile, voice-first)
- AI load matching (your truck / route / preferences)
- Truck-specific routing — bridge heights, weight limits, hazmat
- ELD/HOS compliance autopilot
- Voice command everything ("find a load to Dallas over $3/mile")
- Fuel optimization + fuel-card integration
- Detention pay tracker (auto-calc when owed)
- DVIR pre/post-trip, one-tap + photo
- IFTA fuel-tax auto-calculator
- Maintenance predictor (AI truck-health)
- Real-time community — parking, scales, road conditions
- Per-mile REAL cost/profit calculator
- Document scanner — BOL, POD, receipts auto-organized
- CDL / medical card / drug-test renewal reminders
- Weather + road alerts per route
- Trip planner — stops/rest/food/showers, trucker-rated

### Broker (web portal)
- Carrier marketplace with safety scores
- Load posting + instant AI matching
- Real-time shipment visibility
- AI carrier credit/safety scoring
- Automated rate negotiation w/ market intel
- Payment processing + quick pay
- Compliance verification (authority, insurance, safety)
- Lane/carrier analytics

### Fleet Manager (dashboard)
- Real-time fleet map
- Driver compliance dashboard (HOS/ELD/drug testing)
- Fleet-wide maintenance scheduling
- Fuel spend optimization
- Driver performance scoring/coaching
- AI dispatch optimization
- FMCSA audit-ready one-click exports
- Driver comms hub

### Shipper (portal)
- Instant AI freight quoting
- Quote-to-dispatch booking
- Real-time tracking + ETAs
- Digital POD/BOL flow
- Invoice reconciliation (auto-match + flag)
- Carrier performance analytics

### Government / Compliance
- Real-time ELD data sharing
- Automated CSA score tracking + improvement tips
- Audit-ready report generation
- Drug/alcohol testing compliance mgmt
- HOS perfection (zero violations)
- Weigh-station pre-clearance (Drivewyze / PrePass)

---

## 5 · Tech Stack (as published on site)

| Layer | Choice |
|---|---|
| Mobile | React Native |
| Web | Next.js |
| Voice | Conversational AI |
| In-cab | CarPlay / Android Auto |
| API | REST + GraphQL |
| Real-time | WebSocket |
| Auth | OAuth2 + API Keys |
| Portal | Open API developer portal |
| Hosting | Cloudflare Workers |
| Storage | Cloudflare R2 |
| Cache | **Redis** ⚠ |
| DB | **TiDB** ⚠ |
| KV | Cloudflare KV + D1 |
| Monitoring | Grafana Cloud |
| AI | Genesis AI |
| Maps | Mapbox (truck routes) |
| Compliance | FMCSA/DOT API |
| Payments | Stripe Connect |
| Comms | Twilio |
| Financial | Plaid |

---

## 6 · Revenue Model (site figures)

| Stream | Model | Y1 | Y3 | Y5 |
|---|---|---|---|---|
| Trucker subs | $30–100/mo | $2M | $50M | $200M |
| Fleet contracts | $500–5,000/mo | $1M | $30M | $100M |
| Broker marketplace | % per load | $500K | $20M | $80M |
| API access | Usage tiers | $100K | $10M | $50M |
| Financial services | Fuel/factoring/ins. | $200K | $15M | $60M |
| Data/analytics | Lane/market intel | $0 | $5M | $30M |
| **Total** | | **~$4M** | **~$130M** | **~$520M** |

Valuation trajectory claimed: Y1 $20–50M · Y2 $200–500M · Y3 $1–2B · Y5 $5–10B.
Treat as aspirational — verify against comps before external use.

---

## 7 · Unfair Advantages (as stated)

- Carter's broker experience (money flow, where deals break)
- Tim's trucker expertise + existing code: **load-ledger, ETTR, receipt-ledger**
- Genesis AI integration (predictive, voice-native "moat")
- Open API = platform/ecosystem play from day one
- Voice-first design
- Two-sided marketplace network effects
- Data flywheel

---

## 8 · Execution Phases

- **P1 Foundation (M1–3):** research done, architecture validated, trucker MVP (ELD/load/voice), audit Tim's code, provision Cloudflare
- **P2 Trucker Launch (M4–6):** App Store + Play Store, AI load matching, voice E2E, community, 100-trucker beta
- **P3 Platform (M7–9):** broker portal, fleet dashboard, open API + dev portal, payments, 1,000+ truckers
- **P4 Scale (M10–12):** fuel cards/factoring, full compliance automation, enterprise contracts, 10,000+ users
- **P5 Dominance (Y2+):** AI moat, marketplace effects, data products, international, Series A / acquisition

---

## 9 · Ties to Existing Load Ledger V5

Genesis names Tim's apps as the seed. **Load Ledger V5 already ships pieces this plan lists as future features:**

| Genesis "future" feature | Already live in Ledger V5 |
|---|---|
| IFTA fuel-tax auto-calc | `worker/ifta.js` — ORS driving-hgv, state-mile integrity |
| Document scanner (BOL/POD/receipts) | Sauvola BOL pipeline + rate-con OCR queue |
| Per-mile / settlement math | Locked settlement + fuel-ledger formulas |
| Fuel-card integration | `fuel_entries` fleet-card reconciliation |

**Leverage:** Ledger V5 is the proven settlement/accounting core. Genesis is the marketplace +
voice shell around it. **Don't rebuild — wrap.**

---

## 10 · Enhancement Recommendations (future workflow)

**[P1] Resolve the TiDB/Redis vs Cloudflare fork now.**
Re-spec the Genesis stack onto D1 (relational) + KV (cache/session) + Durable Objects
(real-time/WebSocket) + R2. Removes a vendor, keeps data on one sovereign platform, matches the
locked rule. Only keep TiDB if a real sharding limit forces it — verify with a load projection first.

**[P1] Multi-tenant from the schema up.**
Ledger V5 is already tenant-walled (`ten_edgerton`). Carry that `tenant_id` convention into every
Genesis table so trucker/broker/fleet/shipper share one D1 with hard row-level isolation. Cheaper
than five databases, and it's the foundation for the iCloud/client-storage endgame.

**[P2] Voice as a thin layer, not a rewrite.**
Ship voice as an intent parser that calls the same Worker endpoints the UI already hits.
"Find a load to Dallas over $3/mile" → structured query → existing load API. One source of truth;
voice never forks the logic or the math formulas.

**[P2] Compliance data = liability. Wall it early.**
ELD/HOS/drug-testing/CSA data is regulated. Separate R2 bucket + KV namespace per data class,
audit-logged writes, explicit retention rules. Build this before onboarding a single real driver.

**[P2] Open API needs rate-limit + key management on day one.**
Cloudflare Workers + KV for API keys, tiered rate limits at the edge. The revenue model depends on
API tiers — meter from the first external call or billing can't be accurate later.

**[P3] Study the Convoy post-mortem before scaling spend.**
Convoy burned marketplace liquidity subsidizing both sides. The dbappsystems edge is that the
accounting core is real revenue, not subsidy — lead with the profitable ledger, add marketplace
once liquidity is organic.

**[P3] iPhone-buildable path for every module.**
Next.js + React Native both build/deploy via GitHub → Cloudflare Pages/Workers from Chrome on
iPhone 14. Keep each Genesis module a small standalone file wired into `index.js` — same discipline
as `ifta.js` / `ratecons.js`. No module ever requires a desktop to ship.

---

## 11 · Key Resources

**Regulatory:** fmcsa.dot.gov · transportation.gov · ecfr.gov/current/title-49 · ai.fmcsa.dot.gov
**Associations:** ooida.com · tianet.org · truckingresearch.org · trucking.org
**Community:** thetruckersreport.com · r/Truckers · r/FreightBrokers · r/Trucking
**Competitors:** gomotive.com · samsara.com · dat.com · truckerpath.com · trucksmarter.com · relay.amazon.com
**Tech:** developers.cloudflare.com · pingcap.com/tidb · stripe.com/connect · twilio.com · mapbox.com
**Market data:** bts.gov · ops.fhwa.dot.gov/freight · highway.com
**Financial partners named:** ATBS · OTR Solutions · RTS Financial · TriumphPay · Plaid

---

## 12 · ⚖ Beards Doctrine — applied to the two legal-weight decisions

### Decision A — Storing regulated compliance / ELD data (new build, legal concern)

- **Transparency of Intent:** Drivers must know exactly what compliance data is stored, shared with DOT, and why. No silent data sharing dressed as a feature.
- **Non-Exploitation:** "Real-time ELD data sharing" cannot become surveillance sold to third parties. Driver data is the driver's leverage, not a product line without consent.
- **Sovereignty of the User:** Aligns with the iCloud/client-storage endgame — the driver owns their record. Compliance exports happen on the driver's authorization, not the platform's default.
- **Accountability Without Exception:** Every compliance write audit-logged, immutable, attributable. If a report is wrong, the trail shows who/what/when.
- **Truth as Architecture:** "HOS perfection — zero violations" must never mean editing logs to hide violations. The architecture records truth; it doesn't launder it. **That line needs rewording before it's public — it reads like log-tampering.**

### Decision B — Vendor stack fork (TiDB/Redis vs Cloudflare-only)

Sovereignty + Accountability favor one platform where you control data residency and can answer any
audit from one source of truth. Adding TiDB/Redis splits custody of regulated data across vendors —
more surface for breach, more parties under subpoena. **Default to Cloudflare-only unless a proven
scale limit overrides.**

---

*Baked reference for dbappsystems · Genesis Trucking Domination Plan · captured from trucking.myday7.com*
