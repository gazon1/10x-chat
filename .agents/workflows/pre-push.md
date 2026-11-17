---
description: Pre-push checklist — run before every git push
---

// turbo-all

1. Run type checker:
```bash
bun run typecheck
```

2. Run linter with auto-fix:
```bash
bun run lint:fix
```

3. Run tests:
```bash
bun run test
```

4. Run the end-to-end scenarios of the CLI flows:
```bash
bun run test:e2e
```

5. Build:
```bash
bun run build
```

6. Stage any formatting changes from lint:fix:
```bash
git add -A
```

7. If there are staged changes, amend the last commit:
```bash
git diff --cached --quiet || git commit --amend --no-edit
```
