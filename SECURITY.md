# Security

Report vulnerabilities privately to the maintainers through GitHub's private vulnerability reporting if enabled, or contact the repository owners directly. Do not publish exploit details in an issue. Never commit OAuth secrets, signing keys, receipt credentials, API keys, or private Stellar identities.

Production operation is not yet verified; consult [build status](docs/BUILD_STATUS.md). Hosted webhook destinations must pass public-address validation and HTTPS checks. The localhost exception is restricted to explicit development configuration. Application consumers should verify the HMAC over raw bytes and retain event deduplication records for at least the supported replay horizon.
