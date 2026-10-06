# Security Policy

## Supported Versions

This project is under active development; the latest code on `main` is the
supported version.

## Reporting a Vulnerability

If you believe you have found a security vulnerability in this repository
(code, infrastructure template, or committed secrets), please do **not**
open a public issue.

- Contact the repository owner privately (GitHub: report via
  [private vulnerability reporting](../../security/advisories/new) if enabled,
  or reach out to the maintainer directly).
- Include what you found, where it is (file/line or resource), and a
  reproduction if possible.
- You can expect an initial response within a few days.

## Scope Notes

- `template.yaml` intentionally provisions an IAM access key for the Vercel
  dashboard via CloudFormation outputs; treat stack outputs as sensitive.
- The ingestion API is authenticated with an API Gateway API key
  (`x-api-key`). API keys are transport-level credentials — keep agent keys
  out of browsers and logs.
- The local agent collects environment variable values and a small set of
  config files; deployments should review `ENV_DENYLIST_PATTERNS` in
  `agent/agent.py` before pointing the agent at systems with sensitive
  environments.
