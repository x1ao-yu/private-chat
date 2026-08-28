# Protocol

`schema.json` is the single source of truth. Never edit `frontend/src/protocol.gen.ts` or `backend/internal/protocol.gen.go` manually.

Generate:

```bash
make generate
```

CI checks `make check-generate` ensures generated files are up-to-date.
