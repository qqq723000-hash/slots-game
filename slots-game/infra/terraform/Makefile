TERRAFORM ?= terraform

.PHONY: fmt validate static negative verify

fmt:
	$(TERRAFORM) fmt -check -recursive .

validate:
	TERRAFORM_BIN=$(TERRAFORM) ./scripts/validate-environments.sh

static:
	./scripts/verify-static-contract.sh

negative:
	./scripts/test-negative-contract.sh

verify: fmt static negative validate
