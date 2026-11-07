# Security

Please report vulnerabilities privately with [GitHub's private vulnerability reporting](https://github.com/ethanniser/local-reader/security/advisories/new), not in a public issue.

Useful context:

- The Mac server is meant to be reachable only from `127.0.0.1`. It rejects other `Host` and `Origin` values.
- The sync API in `convex/` protects one library with one bearer pairing token. Anyone holding the token, a pairing link, or a pairing QR code has full access to that library. Sync is encrypted in transit but not end to end.
- The Chrome extension and iOS share extension never send browser cookies to the backend.

Issues in third-party models and SDKs belong with their upstream projects ([THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)).
