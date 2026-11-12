# Cloud and Infrastructure Security

Load when a change touches deployment, infrastructure as code, IAM or permissions, CI/CD pipelines, networking, logging, CDN or backups. Provider names are examples; apply the same checks to whichever platform the project uses. Changing live infrastructure always needs user approval through the Queen; this checklist is for reviewing code and configuration.

## 1. Identity and access

```yaml
# Right: minimal actions on a specific resource
permissions: [storage:GetObject, storage:ListBucket]
resources:   ["bucket/my-app-uploads/*"]

# Wrong: everything on everything
permissions: ["storage:*"]
resources:   ["*"]
```

- [ ] Policies grant the minimum actions on named resources; no wildcard action plus wildcard resource.
- [ ] No root or owner account used for day-to-day or automated work.
- [ ] Multi-factor required for privileged human accounts.
- [ ] Services use roles or workload identity, not long-lived access keys.
- [ ] Unused credentials removed; remaining ones rotated on a schedule.

## 2. Secrets in the cloud

- [ ] Secrets in the platform's secret manager, not baked into images, IaC files or plain pipeline variables.
- [ ] Automatic rotation for database credentials where supported; API keys rotated at least quarterly.
- [ ] Secret access audited.
- [ ] No secrets in logs, error messages, build output or container layers.

## 3. Network

```hcl
# Right: HTTPS only, from the internal network
ingress { from_port = 443  to_port = 443  protocol = "tcp"  cidr_blocks = ["10.0.0.0/16"] }

# Wrong: every port open to the internet
ingress { from_port = 0  to_port = 65535  protocol = "tcp"  cidr_blocks = ["0.0.0.0/0"] }
```

- [ ] Databases and caches not publicly reachable (`publicly_accessible = false` or equivalent).
- [ ] SSH / RDP restricted to a VPN or bastion; never open to the internet.
- [ ] Security groups and firewall rules follow least privilege, ingress and egress.
- [ ] Storage buckets private by default; public access only for intentionally public assets, granted by policy, not by ACL.
- [ ] Network flow logs enabled where the platform supports them.

## 4. Logging and monitoring

- [ ] Logging enabled for all services, centralized and tamper-resistant.
- [ ] Failed logins, permission denials and admin actions logged, without sensitive data.
- [ ] Log retention meets the project's compliance needs (often 90 days or more).
- [ ] Alerts configured for suspicious activity and cost or traffic anomalies.

## 5. CI/CD pipelines

- [ ] Pipeline tokens have minimal permissions (for example read-only repository contents unless a job must write).
- [ ] Short-lived federated credentials (OIDC or equivalent) instead of long-lived cloud keys stored in the CI system.
- [ ] Secret scanning and dependency audit run on every change.
- [ ] Container images scanned, if images are built.
- [ ] Third-party pipeline actions or plugins pinned to a version or commit, not a moving branch.
- [ ] Branch protection: review required before merge, required checks green; signed commits if the project requires them.
- [ ] Untrusted pull requests cannot read deployment secrets.

## 6. CDN, edge and WAF

- [ ] Security headers set at the edge or app: frame protection, `nosniff`, referrer policy, permissions policy.
- [ ] TLS in strict mode end to end; HTTP redirected to HTTPS.
- [ ] WAF with OWASP-style managed rules where available.
- [ ] Rate limiting and bot protection on public endpoints.
- [ ] DDoS protection enabled for public services.

## 7. Encryption

- [ ] Data encrypted at rest (databases, buckets, backups, volumes).
- [ ] Data encrypted in transit, including internal service-to-service traffic where feasible.
- [ ] Keys managed by a key service; access to keys audited.

## 8. Backup and recovery

- [ ] Automated backups with retention that meets requirements; point-in-time recovery for primary databases.
- [ ] Deletion protection on production databases and critical storage.
- [ ] Restores actually tested on a schedule.
- [ ] Recovery point and recovery time objectives defined and documented.

## Pre-deployment checklist

- [ ] IAM: no root use, MFA on, least-privilege policies.
- [ ] Secrets: in a secret manager, rotated.
- [ ] Network: restricted groups, no public databases or open admin ports.
- [ ] Logging and alerting on, retention set.
- [ ] CI/CD: federated short-lived auth, secret and dependency scanning, pinned actions.
- [ ] Edge: TLS strict, headers, WAF and rate limits.
- [ ] Encryption at rest and in transit.
- [ ] Backups automated and restore-tested.
- [ ] Compliance requirements identified (privacy, health, payment data) if applicable.
- [ ] Runbooks and an incident response plan exist.
