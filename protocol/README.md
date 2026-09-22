# Protocol

`schema.json` is the single source of truth. Never edit `frontend/src/protocol.gen.ts` or `backend/internal/protocol/gen.go` manually.

Generate:

```bash
make generate
```

CI checks `make check-generate` ensures generated files are up-to-date.

## Limits

`payload` `maxLength 8192` (every `payload` def in `schema.json`) is a **wire message limit** (JSON string length on the wire), not a plaintext limit. After P2 E2EE, `payload` carries `base64url(iv).base64url(messageId).base64url(ct+tag)` (~40 chars overhead + ~33% base64 expansion), so effective plaintext budget is ~5-6k characters. The wire limit is enforced in `frontend/src/codec.ts` (`payload too large` check) and `backend/internal/protocol/gen.go` (`RuneCountInString … 8192` validation).

Since P6 there is also a derived **inner plaintext limit**, enforced before encrypting: `MAX_INNER_UTF8 = 6098` UTF-8 bytes in `frontend/src/codec.ts` — `(8192 − 40 envelope overhead) × 3/4 − 16 tag` — so oversized input fails with `message too long` instead of a generic encode failure. See SECURITY.md "P6 Notes" (payload budget).

References here are by symbol/path, not line number: numeric references rot as the code moves (see SECURITY.md P1 Notes).
