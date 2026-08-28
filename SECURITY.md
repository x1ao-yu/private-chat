# SECURITY.md

## Principles

* Plaintext messages must never be sent to the server
* Private keys and room secrets must remain client-side whenever possible
* Never log plaintext, private keys, or encryption keys
* Use standard cryptographic APIs or audited libraries
* Never invent custom cryptography
* Use secure randomness for security-sensitive values
* Validate and authenticate encrypted messages
* Consider replay attacks and message injection
* Membership changes must consider key rotation
* Treat XSS and malicious client code as major security risks
* Minimize server-side storage and metadata
* Production communication should use HTTPS/WSS

## Important

E2EE does not automatically provide:

* anonymity
* zero metadata
* authentication
* forward secrecy

Do not claim a security property unless the protocol and implementation actually provide it.

## Security-Sensitive Changes

Review carefully before implementing:

* cryptographic protocols
* key management
* identity
* key rotation
* file encryption
* WebRTC security
