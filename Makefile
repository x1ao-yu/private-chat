SHELL := /bin/bash
export PATH := $(HOME)/go/bin:$(HOME)/.local/go/bin:$(PATH)

.PHONY: generate check-generate dev-frontend dev-backend build test lint

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
	cd backend && go test ./... -count=1

lint:
	pnpm -C frontend exec tsc --noEmit
	cd backend && go vet ./...
	@echo "lint ok (tsc + go vet)"
