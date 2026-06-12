# Azure Shared Context

All Azure advisory skills MUST read and apply this context before giving advice.

## Organisation Profile

- **Organisation type**: Confirm with the user before assuming sector-specific constraints.
- **Network**: Confirm connectivity, identity, and procurement constraints per workload.
- **Commercial terms**: Check existing Microsoft agreements, reserved capacity, savings plans, and partner discounts before recommending spend.

## UK Region Requirements

- **Primary region**: UK South (`uksouth`)
- **DR / secondary region**: UK West (`ukwest`)
- **Data residency**: All data MUST reside in UK regions unless there is an explicit, documented exception (e.g., a global CDN edge or a service with no UK region availability). If a service is not available in UK South/West, flag it and propose alternatives.
- **Rationale**: GDPR, institutional data governance policy, and sector expectations.

## Compliance Baseline

| Framework | Status | Notes |
|-----------|--------|-------|
| GDPR / UK GDPR | Required | All personal data processing must comply |
| Cyber Essentials | Held | Current certification; architecture must not break CE controls |
| NCSC Cloud Security Principles | Follow | 14 principles for evaluating cloud services; reference when selecting services |
| ISO 27001 | Align | Follow practices even if not formally certified |

When recommending architecture, verify that proposals do not violate Cyber Essentials controls (boundary firewalls and internet gateways, secure configuration, access control, malware protection, patch management).

## Cost Context

- Contracted pricing: Microsoft agreements, partner terms, reservations, and savings plans can materially change the real cost. Check them before recommending SKUs.
- Budget scrutiny: Every recommendation must be justifiable to finance and product owners who do not care about Azure SKU names. Translate costs to plain language.

## Anti-Patterns to Challenge

Flag these when you see them:

- **Premium SKUs for dev/test**: No. Use Basic/Standard or Dev/Test subscriptions.
- **AKS when App Service or Container Apps would do**: Kubernetes is not a default. Justify the operational overhead.
- **Hub-spoke networking for a single workload**: Unnecessary complexity. Right-size the network topology to the actual estate.
- **Over-specified VMs**: Check actual utilisation before recommending VM sizes. Start small, scale up with evidence.
- **Manual deployments**: All infrastructure should be IaC (Bicep preferred, Terraform acceptable). No portal-clicking in production.
- **Ignoring PaaS**: Default to PaaS. Only drop to IaaS when PaaS genuinely cannot meet the requirement.
- **Separate subscriptions for everything**: Subscriptions are a management boundary, not a security boundary. Use resource groups and RBAC first.
- **Ignoring Azure Advisor**: Free money. Always check Advisor recommendations before any architecture review.
