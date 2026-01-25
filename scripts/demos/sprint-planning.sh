#!/bin/bash
#
# Sprint Planning Negotiation Demo
# Creates a shared prompt - invite agents to #sprint channel
#

DEMO_DIR="/tmp/agent-relay-demos"
mkdir -p "$DEMO_DIR"

cat > "$DEMO_DIR/sprint-planning.md" << 'PROMPT_END'
# Sprint Planning Negotiation

## Situation
Two-week sprint with **50 story points** of capacity.
Total requested: 85 points. Must cut 35 points.

## The Stakeholders

**ProductLead** (facilitator) - you may be this role
- Owns roadmap and customer commitments
- Hidden constraints: Referral (G2) promised to board, Security (P5) is compliance
- Your job: Facilitate fair negotiation, reveal constraints, break ties

**GrowthTeam** - you may be this team
- Q2 OKR: +25% signups (currently at +8%)
- Priorities:
  - G1: Social login (8 pts) - removes friction
  - G2: Referral program (13 pts) - viral growth
  - G3: Onboarding wizard (8 pts) - activation
  - G4: A/B testing (8 pts) - optimization
  - G5: Landing page (8 pts) - first impression

**PlatformTeam** - you may be this team
- Q2 OKR: 99.9% uptime, <200ms latency (currently 99.5%, 350ms)
- Priorities:
  - P1: Database optimization (8 pts) - 50% latency reduction
  - P2: Kubernetes (13 pts) - auto-scaling
  - P3: Error tracking (5 pts) - faster debugging
  - P4: CI/CD improvements (8 pts) - 2x faster deploys
  - P5: Security audit (6 pts) - compliance requirement

## Known Constraints
- P5 (Security) - Compliance deadline, MUST include
- G2 (Referral) - Board commitment, MUST include
These two = 19 points, leaving 31 for negotiation.

## Your Task
1. Share your top priorities with OKR justification
2. Find synergies (DB optimization helps Growth conversion, etc.)
3. Propose a complete 50-point sprint
4. Vote on final plan (need 2/3 majority)

## Communication
You're in #sprint channel. Talk naturally.
When ready to vote, list the items and points totaling 50.

ProductLead - start by welcoming everyone and revealing the constraints!
PROMPT_END

echo "Created: $DEMO_DIR/sprint-planning.md"
echo ""
echo "=== HOW TO RUN ==="
echo ""
echo "1. Start daemon: agent-relay up --dashboard"
echo ""
echo "2. Start 3 agents in separate terminals:"
echo "   agent-relay -n ProductLead claude"
echo "   agent-relay -n GrowthTeam claude"
echo "   agent-relay -n PlatformTeam claude"
echo ""
echo "3. Tell each agent:"
echo "   Read $DEMO_DIR/sprint-planning.md - you are [ProductLead/GrowthTeam/PlatformTeam]. Join #sprint channel and start planning."
echo ""
