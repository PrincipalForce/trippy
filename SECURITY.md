# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Email **security@principalforce.com** with:

- A description of the issue
- Steps to reproduce (or a proof-of-concept)
- The version / commit you tested against
- Your name and how you'd like to be credited (or "anonymous")

You should get an acknowledgement within 72 hours. We aim to publish a fix
within 14 days for high-severity issues and 30 days for medium-severity
issues, after which the report is eligible for public disclosure.

## Scope

In scope:

- The trippy web app, engine, and any first-party packages in this repo
- The trippy cloud service (when deployed — see `docs/M8-cloud.md`)

Out of scope:

- Third-party WAM plugins (report to their vendors)
- Vulnerabilities requiring a malicious browser extension or compromised host

## Supported versions

trippy is pre-release. Only the `main` branch is supported. Once tagged
releases ship, this section will list the supported version window.
