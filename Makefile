SHELL := /bin/bash
export PATH := $(HOME)/go/bin:$(HOME)/.local/go/bin:$(PATH)

.PHONY: generate check-generate dev-frontend dev-backend build test lint fmt fmt-check

generate:
	@echo "Generating protocol types from protocol/schema.json..."
	pnpm --dir frontend exec json2ts -i ../protocol/schema.json -o src/protocol.gen.ts --unreachableDefinitions
	cd backend && go-jsonschema -p protocol --tags json -o internal/protocol/gen.go ../protocol/schema.json
	@echo "Generate complete. Check git diff."

check-generate: generate
	@echo "checking generated files are up-to-date..."
	@git diff --exit-code -- frontend/src/protocol.gen.ts backend/internal/protocol/gen.go 2>/dev/null || (echo "Generated files out of date. Run 'make generate'." && exit 1)

dev-frontend:
	pnpm -C frontend dev

dev-backend:
	cd backend && go run ./cmd/server

build:
	pnpm -C frontend build
	cd backend && go build -o /tmp/chat-backend ./cmd/server

test:
	pnpm -C frontend exec tsc --noEmit
	pnpm -C frontend exec vitest run
	cd backend && go vet ./...
	cd backend && go test ./... -race -count=1

# gofmt -l doubles as a formatting gate. It is only trustworthy because
# .gitattributes pins LF — under the old core.autocrlf checkout it flagged every
# file for line endings and was useless.
fmt-check:
	@out=$$(cd backend && gofmt -l .); \
	if [ -n "$$out" ]; then echo "not gofmt-clean:"; echo "$$out"; exit 1; fi

fmt:
	cd backend && gofmt -w .

lint: fmt-check
	cd backend && go vet ./...
	pnpm -C frontend exec tsc --noEmit
	@echo "lint ok (gofmt + go vet + tsc)"
