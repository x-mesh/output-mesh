BUN ?= bun
CATALOG_DB ?= $(HOME)/Library/Application Support/AgentOutputCatalog/catalog.db

.PHONY: test check ci sweep serve stop doctor lint reset

test:
	$(BUN) test

lint:
	@command -v oxlint >/dev/null 2>&1 && oxlint lib bin test public || echo "oxlint 미설치 — 건너뜀"

check: lint test

ci: check

serve:
	$(BUN) bin/output-mesh.mjs serve

stop:
	$(BUN) bin/output-mesh.mjs stop --db "$(CATALOG_DB)"

sweep:
	$(BUN) bin/output-mesh.mjs sweep

doctor:
	$(BUN) bin/output-mesh.mjs doctor

# 테스트용 재생성: 개인 메타데이터(태그·메모·즐겨찾기·최종본 표시)를 포함한 로컬 인덱스를 지운다.
reset:
	@test ! -e "$(CATALOG_DB).running.json" || (echo "실행 중인 카탈로그를 먼저 멈추세요: $(BUN) bin/output-mesh.mjs stop --db \"$(CATALOG_DB)\""; exit 1)
	rm -f "$(CATALOG_DB)" "$(CATALOG_DB)-wal" "$(CATALOG_DB)-shm" "$(CATALOG_DB).writer.lock"
	$(BUN) bin/output-mesh.mjs sweep --db "$(CATALOG_DB)"
