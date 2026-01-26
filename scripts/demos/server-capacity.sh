#!/bin/bash
#
# Server Capacity Negotiation Demo
# Creates a shared prompt - invite agents to #incident channel
#

DEMO_DIR="/tmp/agent-relay-demos"
mkdir -p "$DEMO_DIR"

cat > "$DEMO_DIR/server-capacity.md" << 'PROMPT_END'
# Emergency Server Allocation

## Situation
It's Black Friday. Traffic is 5x normal. We have **10 emergency server slots** available for the next 6 hours. Three services need capacity - total requests exceed availability.

**This is urgent - decide within 5 minutes.**

## The Services

**WebAPI** (user-facing) - you may be this service
- Current: 4 servers at 95% CPU, 800ms latency, 2.1% error rate
- Request: 5-6 servers
- Impact: Users seeing errors NOW, Twitter complaints, direct revenue loss
- Minimum: 4 servers

**BatchJobs** (order processing) - you may be this service
- Current: 2 servers, 50K orders backlogged, oldest is 3 hours old
- Request: 4-5 servers
- Impact: "Ships today" promises broken, warehouse idle, SLA breach imminent
- Minimum: 3 servers

**Analytics** (dashboards/alerts) - you may be this service
- Current: 2 servers (1 crashed), dashboards 2 hours stale, alerts broken
- Request: 2-4 servers
- Impact: Flying blind, can't detect fraud, executives asking questions
- Minimum: 2 servers

## Constraints
- 10 slots total
- Minimum 1 per service
- Maximum 6 per service

## Your Task
1. Report your service's current state and what you need
2. Challenge assumptions - is that request really necessary?
3. Propose a fair allocation for ALL services
4. Vote quickly - we're losing money every minute

## Communication
You're in the #incident channel. Speak directly and urgently.
When ready to vote: "ALLOCATION VOTE: WebAPI=X, BatchJobs=Y, Analytics=Z"

WebAPI - you're incident commander. Start by declaring the emergency!
PROMPT_END

echo "Created: $DEMO_DIR/server-capacity.md"
echo ""
echo "=== HOW TO RUN ==="
echo ""
echo "1. Start daemon: agent-relay up --dashboard"
echo ""
echo "2. Start 3 agents in separate terminals:"
echo "   agent-relay -n WebAPI claude"
echo "   agent-relay -n BatchJobs claude"
echo "   agent-relay -n Analytics claude"
echo ""
echo "3. Tell each agent:"
echo "   Read $DEMO_DIR/server-capacity.md - you are [WebAPI/BatchJobs/Analytics]. Join #incident channel and negotiate the allocation."
echo ""
