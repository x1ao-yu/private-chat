# Protocol

`schema.json` is the single source of truth. Never edit `frontend/src/protocol.gen.ts` or `backend/internal/protocol/gen.go` manually.

Generate:

```bash
make generate
```

CI checks `make check-generate` ensures generated files are up-to-date.

## Limits

`payload` `maxLength 8192` in `schema.json:61,105` is a **wire message limit** (JSON string length on the wire), not a plaintext limit. After P2 E2EE, `payload` carries `base64url(iv).base64url(messageId).base64url(ct+tag)` (~40 chars overhead + ~33% base64 expansion), so effective plaintext budget is ~5-6k characters. Plaintext length is not separately limited; wire limit is enforced in `frontend/src/codec.ts:38` (`p.length >8192`) and `backend/internal/protocol/gen.go:80` (`RuneCount >8192`).
