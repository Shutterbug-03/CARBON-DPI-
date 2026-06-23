Phase 7: Production-Grade Hardening (Monorepo, CI/CD & Operations)
M3 (Monorepo Structure): Consolidate all 13 separate services, SDKs, and adapters into an npm or pnpm monorepo workspace to unify dependency matching and shared TypeScript configs.
M2 (CI/CD Workflows): Add GitHub Actions workflows to run Jest/pytest suites automatically on PRs.
L2 (Atomic Redis popping): Replace current loop-based rpop sweeps with atomic Redis Lua scripts or MULTI/EXEC transactions.
L3/L5 (Secure CORS): Shift from global wildcard * CORS policy to a whitelist-based filter.
L6 (SQLite Hygiene): Clean and untrack SQLite databases (dev.db files) from Git history.