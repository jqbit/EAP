# EAP — reproducible gates. Every published number must come from `make bench`.

.PHONY: bench test check

bench:
	python3 bench/run.py

test:
	node --test tests/*.test.mjs

check:
	bash scripts/check-contamination.sh
