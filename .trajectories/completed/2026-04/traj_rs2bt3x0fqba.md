# Trajectory: Compare failed web deploy to prior deploys and identify no-downtime fix

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** April 10, 2026 at 01:50 PM
> **Completed:** April 10, 2026 at 02:00 PM

---

## Summary

Updated production SST domain to orgin.agentrelay.net and verified with a read-only ar_prod diff that the new plan issues a certificate for orgin.agentrelay.net, creates a CloudFront distribution for that hostname, and removes stale agentrelay.net validation resources from the partial stack state without touching the live apex site.

**Approach:** Standard approach

---

## Key Decisions

### Switch production SST alias to orgin.agentrelay.net to avoid the existing apex alias conflict

- **Chose:** Switch production SST alias to orgin.agentrelay.net to avoid the existing apex alias conflict
- **Reasoning:** The current production deployment path in the new AWS account cannot claim agentrelay.net because the live site is still attached elsewhere. Moving the new stack to orgin.agentrelay.net allows a no-downtime deploy while the main domain remains untouched.

---

## Chapters

### 1. Work

_Agent: default_

- Deploy history points to a credential/state access regression rather than a web-code regression: production updated the existing stack successfully through run 24125038176, then every production deploy after the OIDC workflow change tried to create a fresh CloudFront distribution for the same alias and failed with CNAMEAlreadyExists.
- Switch production SST alias to orgin.agentrelay.net to avoid the existing apex alias conflict: Switch production SST alias to orgin.agentrelay.net to avoid the existing apex alias conflict
