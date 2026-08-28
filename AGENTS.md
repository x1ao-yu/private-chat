# AGENTS.md

## Project

Lightweight browser-based E2EE private chat.

Core principles:

* No account
* No contacts
* Rooms are the only communication unit
* Server mainly relays data
* Encryption happens client-side
* Keep the architecture lightweight

## Workflow

1. Read `ROADMAP.md` and `SECURITY.md` and `COMMIT.md`
2. Inspect the existing code before changing it
3. For non-trivial tasks, create a plan first
4. Implement only the approved/current task
5. Run relevant tests, typecheck, lint, and build
6. Report changes, verification, and remaining risks

## Rules

* Do not implement future roadmap items without permission
* Keep changes small and focused
* Avoid unnecessary dependencies and infrastructure
* Do not invent cryptographic algorithms or protocols
* Never log plaintext messages or secret keys
* Update documentation when architecture or security changes

## Git

Use Conventional Commits:

`feat:` `fix:` `refactor:` `docs:` `test:` `perf:` `chore:`
