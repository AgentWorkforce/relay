# Agent Relay Use Cases

Creative end-to-end scenarios showcasing the "Supabase for Agents" vision.

---

## 1. The AI DevOps War Room

### Scenario

Your production site goes down at 3 AM. Instead of PagerDuty waking up your on-call engineer, a team of AI agents springs into action.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           WAR ROOM                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │   Sentinel   │    │   Detective  │    │   Medic      │               │
│  │   (Monitor)  │───►│   (RCA)      │───►│   (Fix)      │               │
│  └──────────────┘    └──────────────┘    └──────────────┘               │
│         │                   │                   │                        │
│         │                   ▼                   ▼                        │
│         │            ┌──────────────┐    ┌──────────────┐               │
│         │            │   Scribe     │    │   Diplomat   │               │
│         └───────────►│   (Docs)     │    │   (Comms)    │               │
│                      └──────────────┘    └──────────────┘               │
│                             │                   │                        │
│                             ▼                   ▼                        │
│                      ┌─────────────────────────────────┐                │
│                      │         Slack Bridge            │                │
│                      │   (Status updates to humans)    │                │
│                      └─────────────────────────────────┘                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Agent Roles

**Sentinel** (Monitoring Agent)
- Receives alerts from Datadog/PagerDuty via webhook bridge
- Classifies severity and impact
- Spawns appropriate response team

**Detective** (Root Cause Agent)
- Queries logs, metrics, recent deployments
- Correlates events across services
- Forms hypotheses about root cause

**Medic** (Remediation Agent)
- Executes runbooks
- Rolls back deployments
- Scales infrastructure
- Applies hotfixes

**Scribe** (Documentation Agent)
- Records timeline of events
- Captures decisions and actions
- Generates post-mortem draft

**Diplomat** (Communications Agent)
- Posts updates to Slack/Discord
- Updates status page
- Notifies stakeholders
- Knows when to escalate to humans

### Message Flow

```
# Webhook receives PagerDuty alert
->relay:Sentinel <<<
ALERT: HTTP 500 errors spiking on api-prod
Service: checkout-api
Started: 2024-01-15T03:14:00Z
Impact: 45% of requests failing>>>

# Sentinel spawns investigation
->relay:spawn Detective claude <<<
Investigate HTTP 500 spike on checkout-api.
Check: logs, recent deploys, dependency health.
Report findings to Sentinel.>>>

# Detective reports back
->relay:Sentinel <<<
ROOT CAUSE IDENTIFIED:
- Deploy 3 hours ago added new payment provider
- Provider API returning 503 (their outage)
- No circuit breaker, cascading failures
Recommend: Enable fallback to old provider>>>

# Sentinel authorizes fix
->relay:Medic <<<
TASK: Rollback checkout-api to version v2.3.1
REASON: Third-party payment provider outage
URGENCY: High - production impact>>>

# Medic executes and reports
->relay:* <<<
ROLLBACK COMPLETE:
- checkout-api now running v2.3.1
- Error rate dropping: 45% → 3% → 0.1%
- Monitoring for stability>>>

# Diplomat updates humans
->relay:SlackBridge <<<
**Incident Update** 🟢
checkout-api restored. Root cause: payment provider outage.
Rolled back to previous version. Full post-mortem in #incidents.
{"slackChannel": "#incidents"}>>>
```

### Why AR Makes This Possible

- **Speed**: Agents coordinate in milliseconds, not minutes
- **Memory**: Scribe maintains perfect timeline
- **Observability**: Every decision is logged and traceable
- **Escalation**: Diplomat knows when to wake humans
- **Learning**: Post-mortem feeds back to improve runbooks

---

## 2. The AI Startup Accelerator

### Scenario

You have an idea for a startup. You describe it in one sentence. A team of AI agents builds your MVP overnight.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        STARTUP FACTORY                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐                                                        │
│  │    Founder   │ ◄── Your idea goes here                               │
│  │   (You)      │                                                        │
│  └──────┬───────┘                                                        │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │   Visionary  │───►│   Architect  │───►│   Builder    │               │
│  │   (Product)  │    │   (System)   │    │   (Code)     │               │
│  └──────────────┘    └──────────────┘    └──────────────┘               │
│         │                   │                   │                        │
│         │                   │                   │                        │
│         ▼                   ▼                   ▼                        │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │   Designer   │    │   DevOps     │    │   QA         │               │
│  │   (UI/UX)    │    │   (Infra)    │    │   (Test)     │               │
│  └──────────────┘    └──────────────┘    └──────────────┘               │
│         │                   │                   │                        │
│         └───────────────────┴───────────────────┘                        │
│                             │                                            │
│                             ▼                                            │
│                      ┌──────────────┐                                    │
│                      │   Launcher   │                                    │
│                      │   (Deploy)   │                                    │
│                      └──────────────┘                                    │
│                             │                                            │
│                             ▼                                            │
│                    🚀 Live Product 🚀                                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Flow

```
# Human provides the spark
->relay:Visionary <<<
Build me an app where dog owners can find
other dogs for playdates in their neighborhood.>>>

# Visionary creates product spec
->relay:Architect <<<
PRODUCT SPEC: PupMeet
- User profiles with dog info (breed, size, temperament)
- Location-based discovery (map view)
- Playdate scheduling with in-app messaging
- Reviews/ratings for safety
- Push notifications
Target: iOS/Android via React Native
MVP scope: Profile, Map, Basic Chat>>>

# Architect designs system
->relay:Builder <<<
ARCHITECTURE:
Frontend: React Native + Expo
Backend: Supabase (auth, db, realtime)
Maps: Mapbox
Notifications: Expo Push
Storage: Supabase Storage (photos)

Schema attached. Start with auth + profiles.>>>

# Builder and Designer work in parallel
->relay:spawn Designer claude <<<
Design UI for PupMeet - dog playdate app.
Style: Friendly, playful, dog-themed colors.
Screens: Onboarding, Profile, Map, Chat.
Output: Tailwind components.>>>

->relay:spawn Builder claude <<<
Implement PupMeet backend on Supabase.
- User profiles with dog details
- Geolocation queries for nearby users
- Real-time chat channels
Start with schema and auth.>>>

# QA tests as features complete
->relay:QA <<<
TEST: User registration flow
RESULT: ✅ Pass
- Email signup works
- Dog profile creation works
- Photo upload works
- Location permission handled>>>

# DevOps prepares deployment
->relay:Launcher <<<
READY FOR LAUNCH:
- iOS TestFlight build: Ready
- Android APK: Ready
- Backend: Deployed to Supabase
- Domain: pupmeet.app configured
Awaiting approval for App Store submission.>>>
```

### Memory Integration

The agents use shared memory to maintain context:

```typescript
// Visionary stores product decisions
await memory.add({
  id: 'decision-mvp-scope',
  content: 'MVP includes profiles, map, basic chat. V2 will add reviews and premium features.',
  metadata: { type: 'product-decision', phase: 'planning' }
});

// Builder can query later
const context = await memory.search({
  text: 'what features are in MVP?',
  filter: { type: 'product-decision' }
});
```

### Output

After 8 hours:
- Complete React Native app
- Deployed backend
- TestFlight/APK builds
- Landing page at pupmeet.app
- Documentation
- Trajectory of all decisions for future reference

---

## 3. The Infinite Content Studio

### Scenario

A media company needs to produce 100 pieces of content per day across blogs, social, video scripts, and newsletters. AI agents run the entire content pipeline.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CONTENT STUDIO                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                        EDITORIAL BOARD                            │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐             │   │
│  │  │ Trends  │  │ Calendar│  │ Assign  │  │ Approve │             │   │
│  │  │ Scout   │  │ Manager │  │ Editor  │  │ Editor  │             │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘             │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│         ┌────────────────────┼────────────────────┐                     │
│         ▼                    ▼                    ▼                     │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐             │
│  │   Writers   │      │   Visual    │      │   Video     │             │
│  │   Pool      │      │   Team      │      │   Team      │             │
│  │             │      │             │      │             │             │
│  │ • Blogger   │      │ • Designer  │      │ • Script    │             │
│  │ • Social    │      │ • Photo     │      │ • Voice     │             │
│  │ • Email     │      │ • Infograph │      │ • Edit      │             │
│  └─────────────┘      └─────────────┘      └─────────────┘             │
│         │                    │                    │                     │
│         └────────────────────┼────────────────────┘                     │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      QUALITY CONTROL                              │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐             │   │
│  │  │ Fact    │  │ SEO     │  │ Legal   │  │ Brand   │             │   │
│  │  │ Checker │  │ Optim   │  │ Review  │  │ Voice   │             │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘             │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      DISTRIBUTION                                 │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐             │   │
│  │  │ CMS     │  │ Social  │  │ Email   │  │ YouTube │             │   │
│  │  │ Publish │  │ Sched   │  │ Send    │  │ Upload  │             │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘             │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Daily Workflow

```
# 6 AM: Trends Scout analyzes overnight data
->relay:* <<<
TREND REPORT - Jan 15, 2024
🔥 Hot Topics:
1. AI agents in enterprise (search +340%)
2. Remote work productivity tools (social +180%)
3. Sustainable tech packaging (news +220%)

📅 Calendar Events:
- CES ongoing (tech angle)
- MLK Day Monday (diversity content)

Recommended: 3 blog posts, 12 social, 1 video>>>

# Editorial assigns work
->relay:spawn BlogWriter claude <<<
Write: "5 Ways AI Agents Are Transforming Enterprise IT"
Angle: Practical, case-study driven
Length: 1500 words
Keywords: AI agents, enterprise automation, IT operations
Deadline: 2 hours>>>

->relay:spawn SocialWriter claude <<<
Create Twitter thread: AI agents enterprise transformation
Hook: Surprising stat about IT automation
Length: 8 tweets with visuals needed
Deadline: 1 hour>>>

# Writer completes draft
->relay:QualityControl <<<
DRAFT READY: "5 Ways AI Agents Are Transforming Enterprise IT"
Word count: 1,623
Links: 5 external sources
Images needed: 3
Ready for fact-check and SEO review>>>

# Parallel quality checks
->relay:FactChecker <<<
CHECK: AI Agents blog post
Focus on: Statistics cited, company claims, technical accuracy>>>

->relay:SEOOptimizer <<<
OPTIMIZE: AI Agents blog post
Target keyword: "AI agents enterprise"
Current density: 1.2%, target: 2%
Check: Meta, headings, internal links>>>

# QC reports back
->relay:ApprovalEditor <<<
QUALITY REPORT:
✅ Fact Check: All claims verified
✅ SEO Score: 94/100
✅ Brand Voice: On target
⚠️ Legal: Remove competitor comparison in para 3
Ready after legal fix>>>

# Final publish
->relay:CMSPublisher <<<
PUBLISH: "5 Ways AI Agents Are Transforming Enterprise IT"
Schedule: Jan 15, 9:00 AM EST
Categories: AI, Enterprise, Technology
Tags: automation, agents, IT
Social: Auto-share to LinkedIn, Twitter>>>
```

### Bridges Used

- **CMS Bridge**: Publishes to WordPress/Ghost/Contentful
- **Social Bridge**: Posts to Twitter, LinkedIn, Instagram
- **Email Bridge**: Sends to Mailchimp/Sendgrid
- **Analytics Bridge**: Reads from GA4, social metrics
- **Stock Photo Bridge**: Fetches from Unsplash/Getty
- **Video Bridge**: Uploads to YouTube, generates thumbnails

### Scale

With 20 agents running in parallel:
- 10 blog posts/day
- 50 social posts/day
- 2 video scripts/day
- 5 email newsletters/week
- 100% fact-checked and on-brand

---

## 4. The AI Hedge Fund

### Scenario

A quantitative trading operation where AI agents research, analyze, debate, and execute trades with human oversight.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          TRADING FLOOR                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                    RESEARCH DESK                                │     │
│  │                                                                 │     │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │     │
│  │  │  Macro   │  │  Sector  │  │  Quant   │  │  Sent-   │       │     │
│  │  │  Analyst │  │  Expert  │  │  Analyst │  │  iment   │       │     │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                              │                                           │
│                              ▼                                           │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                    INVESTMENT COMMITTEE                         │     │
│  │                                                                 │     │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │     │
│  │  │   Bull   │◄─┤  Chair   │─►│   Bear   │                     │     │
│  │  │  (Pro)   │  │ (Decides)│  │  (Con)   │                     │     │
│  │  └──────────┘  └──────────┘  └──────────┘                     │     │
│  │                      │                                         │     │
│  │           ┌──────────┴──────────┐                             │     │
│  │           ▼                     ▼                              │     │
│  │    ┌──────────┐          ┌──────────┐                         │     │
│  │    │   Risk   │          │  Comply  │                         │     │
│  │    │  Manager │          │  Officer │                         │     │
│  │    └──────────┘          └──────────┘                         │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                              │                                           │
│                    ┌─────────┴─────────┐                                │
│                    ▼                   ▼                                │
│  ┌──────────────────────┐  ┌──────────────────────┐                    │
│  │      EXECUTION       │  │    HUMAN OVERSIGHT   │                    │
│  │                      │  │                      │                    │
│  │  ┌──────────┐       │  │  • Veto power        │                    │
│  │  │  Trader  │       │  │  • Position limits   │                    │
│  │  │  Bot     │       │  │  • Kill switch       │                    │
│  │  └──────────┘       │  │                      │                    │
│  └──────────────────────┘  └──────────────────────┘                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Debate Protocol

```
# Research triggers opportunity
->relay:InvestmentCommittee <<<
OPPORTUNITY IDENTIFIED
Ticker: NVDA
Thesis: AI infrastructure demand accelerating
Entry: $875
Target: $1,050 (20% upside)
Stop: $800 (8.5% risk)
Position size: 2% portfolio>>>

# Chair convenes debate
->relay:Bull <<<
DEBATE: NVDA long position
Present bull case. You have 3 minutes.>>>

->relay:Bear <<<
DEBATE: NVDA long position
Prepare bear case. You respond after Bull.>>>

# Bull presents
->relay:InvestmentCommittee <<<
BULL CASE: NVDA
1. Data center revenue +200% YoY
2. CUDA moat unbreakable
3. Every major AI lab is a customer
4. Margins expanding despite volume
5. China risk already priced in

Probability of target: 65%
Conviction: HIGH>>>

# Bear responds
->relay:InvestmentCommittee <<<
BEAR CASE: NVDA
1. Valuation at 40x forward P/E
2. AMD/Intel catching up
3. Hyperscalers building custom silicon
4. Export restrictions tightening
5. Crypto correlation risk

Probability of stop hit: 35%
Conviction: MEDIUM

Suggest: Half position, scale in on dips>>>

# Risk Manager weighs in
->relay:Chair <<<
RISK ASSESSMENT: NVDA
- Portfolio correlation: 0.7 (high - already long tech)
- VaR impact: +$45K daily
- Sector concentration: Would push tech to 42%
- Liquidity: Excellent, can exit in minutes

Recommendation: Reduce to 1% position due to correlation>>>

# Compliance checks
->relay:Chair <<<
COMPLIANCE: NVDA
✅ Not on restricted list
✅ No pending earnings (>7 days)
✅ No material non-public info
✅ Position within limits
CLEARED FOR TRADING>>>

# Chair decides (using consensus)
->relay:_consensus <<<
PROPOSE: NVDA Long 1% Position
TYPE: majority
PARTICIPANTS: Bull, Bear, Risk, Compliance
DESCRIPTION: Enter 1% NVDA long at $875, stop $800, target $1,050
TIMEOUT: 300000>>>

# After votes collected
->relay:HumanOversight <<<
TRADE PENDING APPROVAL
Action: BUY NVDA
Size: 1% portfolio ($500,000 notional)
Entry: $875
Stop: $800
Target: $1,050

Votes: 3 approve, 1 abstain
Reasoning: [attached debate transcript]

⏳ Auto-execute in 5 minutes unless vetoed>>>

# Human approves (or doesn't veto)
->relay:Trader <<<
EXECUTE: BUY NVDA
Quantity: 571 shares
Limit: $876.50
Algo: TWAP over 30 minutes
Urgency: Medium>>>
```

### Memory for Learning

```typescript
// Store trade outcomes
await memory.add({
  id: 'trade-nvda-jan15',
  content: 'NVDA long: Entry $875, exited $980 (+12%), held 3 weeks. Bull thesis correct on data center demand. Bear was wrong about AMD competition.',
  metadata: {
    type: 'trade-outcome',
    ticker: 'NVDA',
    pnl: 60000,
    holdingPeriod: 21,
    thesisAccuracy: 0.8
  }
});

// Future research can query past trades
const pastNVDA = await memory.search({
  text: 'NVIDIA trading history',
  filter: { ticker: 'NVDA' }
});
```

---

## 5. The AI Law Firm

### Scenario

A legal tech company offers AI-powered contract review, due diligence, and legal research at 1/10th the cost of traditional firms.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AI LAW FIRM                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CLIENT INTAKE                                                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │   Intake     │───►│   Conflict   │───►│   Matter     │               │
│  │   Bot        │    │   Check      │    │   Manager    │               │
│  └──────────────┘    └──────────────┘    └──────────────┘               │
│                                                 │                        │
│         ┌───────────────────────────────────────┘                        │
│         │                                                                │
│         ▼                                                                │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    PRACTICE GROUPS                               │    │
│  │                                                                  │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐ │    │
│  │  │  Contract  │  │  M&A Due   │  │  Litigation│  │  IP       │ │    │
│  │  │  Review    │  │  Diligence │  │  Research  │  │  Search   │ │    │
│  │  │            │  │            │  │            │  │           │ │    │
│  │  │ • Redline  │  │ • Doc Rev  │  │ • Case Law │  │ • Patent  │ │    │
│  │  │ • Risk ID  │  │ • Risk Map │  │ • Brief    │  │ • TM      │ │    │
│  │  │ • Clause   │  │ • Summary  │  │ • Motion   │  │ • Prior   │ │    │
│  │  │   Library  │  │ • Timeline │  │   Draft    │  │   Art     │ │    │
│  │  └────────────┘  └────────────┘  └────────────┘  └───────────┘ │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    QUALITY & ETHICS                              │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                │    │
│  │  │  Citation  │  │  Ethics    │  │  Partner   │                │    │
│  │  │  Verifier  │  │  Screen    │  │  Review    │                │    │
│  │  └────────────┘  └────────────┘  └────────────┘                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│                      Human Attorney Sign-Off                             │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Contract Review Flow

```
# Client uploads contract
->relay:IntakeBot <<<
NEW MATTER: Contract Review
Client: TechCorp Inc.
Document: Software Licensing Agreement (47 pages)
Counterparty: MegaCloud LLC
Urgency: Standard (5 business days)>>>

# Conflict check
->relay:ConflictCheck <<<
CHECK: TechCorp Inc. vs MegaCloud LLC
Result: ✅ No conflict
- No current matters with MegaCloud
- No former representation
- No adverse parties in common>>>

# Matter assigned to contract team
->relay:spawn ContractReviewer claude <<<
REVIEW: Software Licensing Agreement
Client: TechCorp Inc. (licensee)
Focus areas:
1. IP ownership and license scope
2. Limitation of liability
3. Indemnification
4. Data protection/privacy
5. Termination rights
6. Unusual or non-market terms

Compare against our clause library.
Flag HIGH/MEDIUM/LOW risk items.>>>

# Parallel clause analysis
->relay:spawn ClauseAnalyzer claude <<<
ANALYZE: Limitation of Liability clause (Section 8)
Compare to:
- Market standard for enterprise SaaS
- Client's risk tolerance (medium)
- Our clause library alternatives

Output: Risk rating + suggested redline>>>

# Reviewer completes analysis
->relay:QualityControl <<<
CONTRACT REVIEW COMPLETE

HIGH RISK (3):
🔴 Section 4.2: IP assignment too broad
   - Grants ownership of client customizations
   - Redline: Limit to derivative works for vendor only

🔴 Section 8.1: Cap at 1x annual fees
   - Market is 12-24 months
   - Redline: Increase to 24 months minimum

🔴 Section 12.3: No data return on termination
   - GDPR issue for EU operations
   - Add: Data export within 30 days

MEDIUM RISK (7):
🟡 Section 3.1: Auto-renewal 60 days
🟡 Section 6.2: Audit rights unlimited
...

LOW RISK (12):
🟢 Standard terms, no changes needed

Estimated negotiation: 2-3 rounds>>>

# Citation verification
->relay:CitationVerifier <<<
VERIFY: Contract Review memo
Check all legal citations are:
- Correctly formatted
- Currently good law
- Accurately summarized

Result: ✅ All 8 citations verified>>>

# Ethics screen
->relay:EthicsScreen <<<
SCREEN: TechCorp contract review
✅ No unauthorized practice issues
✅ No confidentiality concerns
✅ No conflicts discovered
✅ Scope appropriate for non-lawyer review
Note: Final advice requires attorney sign-off>>>

# Prepare client deliverable
->relay:MatterManager <<<
DELIVERABLE READY: TechCorp Contract Review
Contents:
1. Executive Summary (1 page)
2. Risk Matrix (color-coded)
3. Redlined Agreement (tracked changes)
4. Issue Log with recommendations
5. Clause comparison chart

Route to: Partner Review
Then: Client Portal>>>
```

### Memory: Clause Library

```typescript
// Build institutional knowledge
await memory.add({
  id: 'clause-lol-saas-v3',
  content: `Limitation of Liability - Enterprise SaaS Standard:
    "EXCEPT FOR BREACHES OF CONFIDENTIALITY, GROSS NEGLIGENCE,
    OR WILLFUL MISCONDUCT, NEITHER PARTY'S TOTAL LIABILITY SHALL
    EXCEED THE GREATER OF (A) FEES PAID IN THE 24 MONTHS PRECEDING
    THE CLAIM OR (B) $1,000,000."

    Negotiation notes: Most vendors accept 24-month cap.
    Push for carve-outs on data breach. Floor of $1M for large deals.`,
  metadata: {
    type: 'clause-template',
    category: 'limitation-of-liability',
    industry: 'saas',
    risk_level: 'medium',
    success_rate: 0.85
  }
});

// Future reviews can pull relevant clauses
const similarClauses = await memory.search({
  text: 'limitation of liability SaaS enterprise',
  filter: { type: 'clause-template' }
});
```

---

## 6. The AI Game Master

### Scenario

An AI-powered tabletop RPG where multiple agents collaborate to create an immersive, dynamic story. One agent is the GM, others play NPCs, and the world evolves based on player actions.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          INFINITE QUEST                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      DUNGEON MASTER                               │   │
│  │                                                                   │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │   │
│  │  │  Narrator  │  │   Rules    │  │   World    │                 │   │
│  │  │            │  │   Engine   │  │   State    │                 │   │
│  │  └────────────┘  └────────────┘  └────────────┘                 │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│         ┌────────────────────┼────────────────────┐                     │
│         ▼                    ▼                    ▼                     │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐             │
│  │   NPC:      │      │   NPC:      │      │   NPC:      │             │
│  │   Bartender │      │   Guard     │      │   Merchant  │             │
│  │   "Grim"    │      │   Captain   │      │   "Silks"   │             │
│  └─────────────┘      └─────────────┘      └─────────────┘             │
│         │                    │                    │                     │
│         └────────────────────┼────────────────────┘                     │
│                              ▼                                           │
│                    ┌─────────────────┐                                  │
│                    │  Discord Bridge │◄───── Players join here          │
│                    └─────────────────┘                                  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    WORLD SIMULATION                               │   │
│  │                                                                   │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │  Weather   │  │  Economy   │  │  Factions  │  │  Rumors   │  │   │
│  │  │  System    │  │  Sim       │  │  Politics  │  │  Mill     │  │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Game Session

```
# Player action via Discord
->relay:DungeonMaster <<<
[Player: @Sarah] I walk up to the bartender and ask
about the strange lights people have been seeing
in the old tower.>>>

# DM processes and delegates
->relay:NPC_Grim <<<
CONTEXT: A young adventurer (human fighter, level 3)
approaches you at the bar. They're asking about the
mysterious lights in Thornwood Tower.

YOUR KNOWLEDGE:
- You've heard rumors of a wizard moving in
- Three travelers went to investigate, none returned
- The local lord has offered 50 gold for information

PERSONALITY: Gruff but fair, protective of regulars,
secretly worried about your daughter who went missing

Respond in character. Keep it to 2-3 sentences.>>>

# Grim responds
->relay:DungeonMaster <<<
*wipes glass slowly, not meeting your eyes*

"Thornwood Tower, eh? Bad business, that. Three folk
went up there last tenday—merchants, they were. Came
back changed... if they came back at all."

*leans in closer*

"You look like you can handle yourself. If you're
thinking of going, talk to the Guard Captain first.
She might have work for someone with your... talents.">>>

# DM weaves narrative
->relay:DiscordBridge <<<
**The Rusty Anchor Tavern**

The bartender, a weathered man with a scar across his
cheek, sets down the glass he was cleaning. His eyes
carry a weight of unspoken worry.

*"Thornwood Tower, eh? Bad business, that. Three folk
went up there last tenday—merchants, they were. Came
back changed... if they came back at all."*

He leans closer, voice dropping to a whisper.

*"You look like you can handle yourself. If you're
thinking of going, talk to the Guard Captain first.
She might have work for someone with your... talents."*

**What do you do?**
{"discordChannel": "#game-session"}>>>

# Meanwhile, world simulation ticks
->relay:WorldState <<<
TIME: Evening → Night
WEATHER: Clear → Light fog rolling in
FACTION UPDATE:
  - Town Guard: Increased patrols near tower
  - Merchant Guild: Offering bounty for missing traders
  - Thieves Guild: Sees opportunity in chaos

RUMOR GENERATED: "A child claims to have seen a
ghostly figure in the tower window at midnight">>>

# Rules engine tracks mechanics
->relay:RulesEngine <<<
PLAYER: Sarah (Fighter 3)
ACTION: Social - Gather Information
NPC DISPOSITION: Neutral → Friendly (good roleplay)
INFORMATION REVEALED: Quest hook, NPC reference
XP AWARDED: 25 (social encounter)
NOTES: Player now knows about Guard Captain>>>
```

### Persistent World Memory

```typescript
// Store world state
await memory.add({
  id: 'npc-grim-knowledge',
  content: `Grim (Bartender) has revealed to Sarah:
    - Thornwood Tower rumors
    - Three missing merchants
    - Guard Captain has a job
    He is now friendly toward Sarah's party.`,
  metadata: {
    type: 'world-state',
    npc: 'grim',
    players: ['sarah'],
    session: 5
  }
});

// Track faction relationships
await memory.add({
  id: 'faction-state-session-5',
  content: `Faction standings after Session 5:
    - Town Guard: Neutral (no interaction)
    - Merchant Guild: Friendly (helped find clues)
    - Thieves Guild: Unknown
    - Wizard (Tower): Hostile (discovered spying)`,
  metadata: { type: 'faction-state', session: 5 }
});
```

---

## 7. The AI Customer Success Team

### Scenario

A SaaS company uses AI agents to handle the entire customer lifecycle—from onboarding to expansion to save—with humans for high-touch moments only.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     CUSTOMER SUCCESS COMMAND                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  SIGNALS & SCORING                                                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │   Health     │    │   Intent     │    │   Risk       │               │
│  │   Scorer     │    │   Detector   │    │   Predictor  │               │
│  └──────────────┘    └──────────────┘    └──────────────┘               │
│         │                   │                   │                        │
│         └───────────────────┴───────────────────┘                        │
│                              │                                           │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    ACTION ORCHESTRATOR                            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│     ┌────────────────────────┼────────────────────────┐                 │
│     ▼                        ▼                        ▼                 │
│  ONBOARDING              ENGAGEMENT               AT-RISK               │
│  ┌──────────┐           ┌──────────┐           ┌──────────┐            │
│  │ Welcome  │           │ Educate  │           │ Save     │            │
│  │ Coach    │           │ Bot      │           │ Agent    │            │
│  ├──────────┤           ├──────────┤           ├──────────┤            │
│  │ Setup    │           │ Feature  │           │ Diagnose │            │
│  │ Guide    │           │ Announcer│           │ Bot      │            │
│  ├──────────┤           ├──────────┤           ├──────────┤            │
│  │ Success  │           │ Review   │           │ Offer    │            │
│  │ Checker  │           │ Requester│           │ Maker    │            │
│  └──────────┘           └──────────┘           └──────────┘            │
│                              │                                           │
│                              ▼                                           │
│                    ┌─────────────────┐                                  │
│                    │  Human Handoff  │                                  │
│                    │  (when needed)  │                                  │
│                    └─────────────────┘                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Automated Playbooks

```
# New signup detected
->relay:HealthScorer <<<
NEW CUSTOMER: Acme Corp
Plan: Professional ($500/mo)
Users: 5 seats
Industry: E-commerce
Integration: Shopify
First login: 2024-01-15 09:00

Calculate initial health score and risk factors.>>>

# Health score computed
->relay:ActionOrchestrator <<<
CUSTOMER: Acme Corp
HEALTH: 72/100 (new customer baseline)
RISK FACTORS:
- Low: Only 1 of 5 users active
- Medium: No integrations configured yet

RECOMMENDED PLAYS:
1. [NOW] Welcome sequence
2. [Day 1] Setup guide for Shopify
3. [Day 3] Check integration status
4. [Day 7] Usage review>>>

# Welcome coach activates
->relay:WelcomeCoach <<<
CUSTOMER: Acme Corp
CONTACT: Sarah Chen (Admin)
CHANNEL: In-app + Email

Send welcome message:
- Personalized for e-commerce
- Highlight Shopify integration
- Offer live setup call
- Include quick-win tutorial>>>

# Welcome sent via product bridge
->relay:ProductBridge <<<
SEND IN-APP MESSAGE
To: sarah.chen@acmecorp.com
Template: welcome-ecommerce
Variables:
  name: Sarah
  integration: Shopify
  quick_win: "Sync your first 100 orders"
  calendar_link: https://cal.com/cs-team/setup>>>

# Day 3: Check integration
->relay:SuccessChecker <<<
CHECK: Acme Corp integration status
Result: ❌ Shopify not connected

Trigger: Proactive outreach
Reason: Key integration not completed by Day 3
Risk: Increases churn probability by 34%>>>

# Proactive help
->relay:SetupGuide <<<
OUTREACH: Acme Corp
Contact: Sarah Chen
Issue: Shopify integration incomplete

Send helpful nudge:
- Acknowledge they're busy
- Offer 15-min Zoom to do it together
- Include video walkthrough link
- Mention other Shopify customers' success>>>

# Week 4: Low engagement detected
->relay:HealthScorer <<<
ALERT: Acme Corp health declining
Previous: 72 → Current: 45
Signals:
- Login frequency: 3x/week → 1x/week
- Feature usage: Declining
- Support tickets: 0 (no engagement)
- Last admin login: 8 days ago

Risk level: HIGH
Trigger save playbook.>>>

# Save agent activates
->relay:SaveAgent <<<
AT-RISK: Acme Corp
Health: 45/100
Days to renewal: 60
ARR at risk: $6,000

Diagnosis needed:
1. Check recent support history
2. Review feature usage patterns
3. Identify potential blockers
4. Check competitor mentions in tickets

Then recommend intervention.>>>

# Diagnosis complete
->relay:DiagnoseBot <<<
DIAGNOSIS: Acme Corp
ROOT CAUSE: Integration failed silently
- Shopify sync stopped 3 weeks ago
- Orders not updating
- Sarah likely thinks product is broken

EVIDENCE:
- Error logs show API rate limit hit
- No notification was sent (our bug)
- Sarah searched help docs for "sync not working"

RECOMMENDATION:
1. Apologize proactively
2. Fix sync immediately
3. Offer 1 month credit
4. Assign dedicated CSM for recovery>>>

# Handoff to human for save call
->relay:HumanHandoff <<<
ESCALATION: Acme Corp Save Required

Summary: Product bug caused silent integration failure.
Customer likely frustrated. Needs personal outreach.

Recommended approach:
1. Call Sarah directly (don't email)
2. Acknowledge our failure
3. Confirm fix is deployed
4. Offer 1 month credit ($500)
5. Schedule weekly check-in for 30 days

Prep doc: [link]
Customer 360: [link]
Previous interactions: [attached]

Assign to: @jennifer (CSM)>>>
```

---

## 8. The AI Research Lab

### Scenario

An academic research group uses AI agents to accelerate scientific discovery—literature review, hypothesis generation, experiment design, and paper writing.

### The Team

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        RESEARCH LAB                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐                                                        │
│  │  Principal   │ ◄── Human researcher (you)                            │
│  │  Investigator│                                                        │
│  └──────┬───────┘                                                        │
│         │                                                                │
│         ▼                                                                │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    DISCOVERY ENGINE                               │   │
│  │                                                                   │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │ Literature │  │ Hypothesis │  │ Experiment │  │ Analysis  │  │   │
│  │  │ Scout      │  │ Generator  │  │ Designer   │  │ Engine    │  │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    PUBLICATION PIPELINE                           │   │
│  │                                                                   │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │ Draft      │  │ Figures    │  │ Peer       │  │ Submission│  │   │
│  │  │ Writer     │  │ Generator  │  │ Reviewer   │  │ Assistant │  │   │
│  │  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Research Flow

```
# PI poses research question
->relay:LiteratureScout <<<
RESEARCH QUESTION:
Can transformer architectures be adapted for
protein folding prediction without the massive
compute requirements of AlphaFold?

Search:
1. Recent papers on efficient transformers
2. Protein structure prediction methods
3. Knowledge distillation approaches
4. Edge deployment of ML models>>>

# Literature review
->relay:PI <<<
LITERATURE REVIEW COMPLETE

Key findings:
1. "EfficientFold" (Chen et al. 2023) achieved
   85% of AlphaFold accuracy with 10x less compute

2. Knowledge distillation from AlphaFold to
   smaller models shows promise (Kim 2024)

3. Sparse attention mechanisms reduce complexity
   from O(n²) to O(n log n) for sequences

4. No one has combined distillation + sparse
   attention for protein folding

GAP IDENTIFIED: Opportunity to create lightweight
model combining these techniques.

Relevant papers: [23 papers attached]
Citation graph: [visualization]>>>

# Hypothesis generation
->relay:HypothesisGenerator <<<
CONTEXT: [Literature review summary]
QUESTION: Efficient protein folding prediction

Generate testable hypotheses ranked by:
1. Novelty (not already published)
2. Feasibility (can test with available compute)
3. Impact (if true, how significant?)>>>

# Hypotheses proposed
->relay:PI <<<
HYPOTHESES GENERATED

H1: Knowledge distillation + sparse attention
Claim: A 100M parameter model trained via distillation
from AlphaFold, using sparse attention, can achieve
>80% accuracy on CASP14 with <5% of compute.
Novelty: ⭐⭐⭐⭐ (novel combination)
Feasibility: ⭐⭐⭐⭐ (8x A100 GPUs, 2 weeks)
Impact: ⭐⭐⭐⭐⭐ (democratizes protein folding)

H2: Domain-specific tokenization
Claim: Treating amino acid sequences with structure-
aware tokenization improves accuracy over character-
level tokenization.
Novelty: ⭐⭐⭐ (incremental)
Feasibility: ⭐⭐⭐⭐⭐ (easy to test)
Impact: ⭐⭐⭐ (modest improvement expected)

RECOMMENDATION: Pursue H1 as primary, H2 as secondary>>>

# PI approves, experiment design begins
->relay:ExperimentDesigner <<<
DESIGN EXPERIMENT FOR H1

Requirements:
- Baseline: AlphaFold2 on CASP14
- Model: 100M param transformer with sparse attention
- Training: Distillation from AlphaFold predictions
- Metrics: TM-score, GDT-TS, inference time, FLOPS
- Ablations:
  * With/without distillation
  * Dense vs sparse attention
  * Model size variations (50M, 100M, 200M)>>>

# Experiment plan
->relay:PI <<<
EXPERIMENT PLAN

Phase 1: Data preparation (Week 1)
- Download CASP14 targets
- Generate AlphaFold predictions for distillation
- Create train/val/test splits

Phase 2: Architecture (Week 2)
- Implement sparse attention transformer
- Implement distillation loss
- Validate training loop on toy data

Phase 3: Training (Weeks 3-4)
- Train 100M model with distillation
- Run ablation experiments
- Log to W&B

Phase 4: Evaluation (Week 5)
- CASP14 benchmark
- Compute efficiency analysis
- Statistical significance tests

Compute budget: 400 A100 hours
Estimated cost: $1,200

Shall I generate the code scaffold?>>>

# After experiments complete...
->relay:AnalysisEngine <<<
ANALYZE RESULTS
Experiment: EfficientFold v1
Data: [W&B run links]

Generate:
1. Performance comparison tables
2. Ablation analysis
3. Compute efficiency plots
4. Statistical significance (p-values)
5. Failure case analysis>>>

# Ready for publication
->relay:DraftWriter <<<
WRITE PAPER DRAFT

Title: "EfficientFold: Democratizing Protein Structure
       Prediction via Knowledge Distillation"

Structure:
1. Abstract (150 words)
2. Introduction (motivation, contributions)
3. Related Work (lit review summary)
4. Method (architecture, training)
5. Experiments (tables, ablations)
6. Discussion (limitations, future work)
7. Conclusion

Style: NeurIPS 2024
Tone: Clear, confident, accessible
Include: All figures from AnalysisEngine>>>

# Internal peer review before submission
->relay:PeerReviewer <<<
REVIEW DRAFT: EfficientFold paper

Act as a critical NeurIPS reviewer.
Identify:
- Weaknesses in claims
- Missing baselines
- Unclear explanations
- Statistical issues
- Reproducibility gaps

Be constructive but thorough.>>>
```

---

## Common Patterns Across Use Cases

### 1. Specialized Agents with Clear Roles

Each agent has a focused responsibility:
- **Scout/Detector**: Finds information, monitors signals
- **Analyzer**: Processes data, generates insights
- **Executor**: Takes actions, implements changes
- **Communicator**: Interfaces with humans/external systems
- **Quality Controller**: Validates, reviews, catches errors

### 2. Human-in-the-Loop at Key Moments

Agents handle routine work, humans intervene for:
- High-stakes decisions (trading, legal sign-off)
- Ambiguous situations (creative judgment)
- Escalations (customer saves, incidents)
- Final approval (publication, deployment)

### 3. Shared Memory for Context

All agents share:
- **Decisions**: Why things were done
- **Outcomes**: What worked, what didn't
- **State**: Current situation
- **History**: What happened before

### 4. External Bridges

Connect to where work happens:
- Slack/Discord for team communication
- GitHub for code and issues
- CRM for customer data
- Trading systems for execution
- Publishing platforms for content

### 5. Consensus for Critical Decisions

Use `->relay:_consensus` for multi-stakeholder decisions:
- Trading committee votes
- Deployment approvals
- Content publication
- Customer offers

---

## What Makes This Possible

**Agent Relay provides:**
- Fast messaging (<5ms) for real-time coordination
- Persistent history for context and debugging
- Shadow agents for oversight and quality
- Bridges for external system integration
- Memory adapters for long-term learning
- Trajectories for decision traceability

**Without AR, you'd need to build:**
- Custom message passing between agents
- Your own persistence layer
- Bespoke integrations for every system
- Manual context management
- No observability into agent decisions

The "Supabase for Agents" pitch is that AR handles all this infrastructure so you can focus on the agents themselves.
