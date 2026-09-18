BUN ?= bun

.PHONY: test check ci sweep serve doctor lint

test:
	$(BUN) test

lint:
	@command -v oxlint >/dev/null 2>&1 && oxlint lib bin test public || echo "oxlint 미설치 — 건너뜀"

check: lint test

ci: check

serve:
	$(BUN) bin/output-mesh.mjs serve

sweep:
	$(BUN) bin/output-mesh.mjs sweep

doctor:
	$(BUN) bin/output-mesh.mjs doctor
