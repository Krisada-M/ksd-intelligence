# Search golden queries (PROPOSED — pending owner confirmation)

**Status:** PROPOSED (M6a Round 3). Drafted from repository inspection and `docs/dogfood-log.md`; NOT YET OWNER-CONFIRMED. Do not freeze as a CI hard gate until the owner confirms.

## Evaluation rules (`docs/briefs/M6a-search.md` Round 3)
- Evaluate each repository at `limit = 8` (primary recall window) and `limit = 20` (to verify `0` confirmed queries are missing entirely).
- **Default pass mark:** `>= 80%` (`>= 16 / 20`) of expected targets appear at rank `<= 8` on **each** repository, and `0` confirmed queries are missing (`rank > 20` or absent).
- **Exact-match rule:** Queries marked `Expected Kind = exact` equal an indexed declaration's name (`simple` or qualified `name`) and must appear at rank `1` with kind `exact`.
- **No proprietary code:** `work-sure` targets are identified solely by repo-relative path, symbol name, owner, and non-proprietary domain/type concepts.

---

## Repository 1: `ksd-intelligence`

| ID | Category | Query | Expected Target | Max Rank | Expected Kind | Basis (observed field) |
|---|---|---|---|---:|---|---|
| S01 | exact | `deriveVerdict` | `src/core/kernel/verdict.ts#deriveVerdict` | 1 | `exact` | Exact exported function name |
| S02 | exact | `acquireBuildLock` | `src/core/engine/lock.ts#acquireBuildLock` | 1 | `exact` | Exact exported function name |
| S03 | exact | `fileDeclarations` | `src/core/indexing/declarations.ts#fileDeclarations` | 1 | `exact` | Exact exported function name |
| S04 | exact | `ImpactSession` | `src/core/impact/session.ts#ImpactSession` | 1 | `exact` | Exact exported class name |
| S05 | camelCase | `holder alive` | `src/core/engine/lock.ts#isHolderAlive` | 3 | `lexical` | Split name `is holder alive` + JSDoc |
| S06 | camelCase | `sanitize audit text` | `src/core/audit/log.ts#sanitizeAuditText` | 3 | `lexical` | Split name `sanitize audit text` + path |
| S07 | camelCase | `matched risk zones` | `src/core/kernel/verdict.ts#matchedRiskZones` | 3 | `lexical` | Split name `matched risk zones` |
| S08 | snake_case | `schema_version` | `src/storage/sqlite.ts#SCHEMA_VERSION` | 3 | `lexical` | Split `_` + case-folded `SCHEMA_VERSION` |
| S09 | snake_case | `max_audit_bytes` | `src/core/audit/log.ts#MAX_AUDIT_BYTES` | 3 | `lexical` | Split `_` + case-folded `MAX_AUDIT_BYTES` |
| S10 | snake_case | `default_risk_zones` | `src/core/kernel/config.ts#DEFAULT_RISK_ZONES` | 3 | `lexical` | Split `_` + case-folded `DEFAULT_RISK_ZONES` |
| S11 | multi-word | `classify task workflow` | `src/workflow/classify.ts#classifyTask` | 3 | `lexical` | Path `workflow/classify` + name `classify task` |
| S12 | multi-word | `parse project config` | `src/core/kernel/config.ts#parseProjectConfig` | 3 | `lexical` | Split name `parse project config` |
| S13 | multi-word | `differential find references` | `src/core/indexing/differential.ts#differential` | 5 | `lexical` | Name `differential` + first-paragraph JSDoc |
| S14 | multi-word | `stat probe freshness drift` | `src/core/workspace/probe.ts#probe` | 5 | `lexical` | Name `probe` + signature `freshness` + JSDoc |
| S15 | error-code | `index-failed INVALID_INPUT` | `src/core/kernel/types.ts#FailureCode` | 3 | `lexical` | Union literal signature (108 chars) |
| S16 | error-code | `computed-member-access interface-dispatch` | `src/core/indexing/resolve.ts#GapCode` | 3 | `lexical` | Union literal signature (120 chars) |
| S17 | error-code | `unresolved-name-match` | `src/core/indexing/resolve.ts#UnresolvedRecord` | 5 | `lexical` | Interface `reason` union signature (~145 chars) |
| S18 | path-term | `audit summary render` | `src/core/audit/summary.ts#renderAuditSummary` | 3 | `lexical` | Path `audit/summary` + name `render audit summary` |
| S19 | path-term | `changes git base ref` | `src/core/changes/git.ts#validateBaseRef` | 3 | `lexical` | Path `changes/git` + name `validate base ref` |
| S20 | path-term | `agy skills config` | `src/adapters/agy/skills.ts#buildAgySkillsConfig` | 3 | `lexical` | Path `agy/skills` + name `build agy skills config` |

---

## Repository 2: `work-sure` (`desktop/src/*.ts`, 33 non-`<module>` declarations)

*Mapping note:* `work-sure` indexes `5` TS files (`desktop/src/{bridge,main,prefs,status,strings}.ts`) yielding `33` non-`<module>` declarations (`29` unique qualified names; `ServerEntry`, `ServerEntry.url`, `ServerEntry.label`, and `$` appear in both `main.ts` and `prefs.ts`). All `20` queries below map `1:1` to `20` distinct `file#name` declaration keys; duplicated names are disambiguated via `path_tokens` (`main` vs `prefs`).

| ID | Category | Query | Expected Target | Max Rank | Expected Kind | Basis (observed field) |
|---|---|---|---|---:|---|---|
| W01 | exact | `serverErrorMessage` | `desktop/src/status.ts#serverErrorMessage` | 1 | `exact` | Exact exported function name |
| W02 | exact | `goToServer` | `desktop/src/main.ts#goToServer` | 1 | `exact` | Exact function name |
| W03 | exact | `renderRemembered` | `desktop/src/main.ts#renderRemembered` | 1 | `exact` | Exact function name |
| W04 | exact | `renderServers` | `desktop/src/prefs.ts#renderServers` | 1 | `exact` | Exact function name |
| W05 | exact | `setStatus` | `desktop/src/main.ts#setStatus` | 1 | `exact` | Exact function name |
| W06 | exact | `autostart` | `desktop/src/prefs.ts#autostart` | 1 | `exact` | Exact `const` declaration name |
| W07 | exact | `unreachable` | `desktop/src/strings.ts#S.unreachable` | 1 | `exact` | Unique `simple` property name on `S` |
| W08 | camelCase | `server label` | `desktop/src/strings.ts#S.serverLabel` | 3 | `lexical` | Split name `server label` |
| W09 | camelCase | `url placeholder` | `desktop/src/strings.ts#S.urlPlaceholder` | 3 | `lexical` | Split name `url placeholder` |
| W10 | camelCase | `invalid url` | `desktop/src/strings.ts#S.invalidUrl` | 3 | `lexical` | Split name `invalid url` |
| W11 | camelCase | `launch at login` | `desktop/src/strings.ts#P.launchAtLogin` | 3 | `lexical` | Split name `launch at login` |
| W12 | camelCase | `switch to` | `desktop/src/strings.ts#P.switchTo` | 3 | `lexical` | Split name `switch to` |
| W13 | multi-word | `main connect rawUrl` | `desktop/src/main.ts#connect` | 3 | `lexical` | Path `main` + name `connect` + param `rawUrl` |
| W14 | path-term | `main boot` | `desktop/src/main.ts#boot` | 3 | `lexical` | Path `main` + name `boot` |
| W15 | path-term | `main fill` | `desktop/src/main.ts#fill` | 3 | `lexical` | Path `main` + name `fill` |
| W16 | path-term | `prefs ServerEntry` | `desktop/src/prefs.ts#ServerEntry` | 3 | `lexical` | Path `prefs` disambiguates `ServerEntry` |
| W17 | path-term | `main ServerEntry url` | `desktop/src/main.ts#ServerEntry.url` | 3 | `lexical` | Path `main` + owner `ServerEntry` + `url` |
| W18 | path-term | `prefs ServerEntry label` | `desktop/src/prefs.ts#ServerEntry.label` | 3 | `lexical` | Path `prefs` + owner `ServerEntry` + `label` |
| W19 | path-term | `strings checking` | `desktop/src/strings.ts#S.checking` | 3 | `lexical` | Path `strings` + name `checking` |
| W20 | owner-path | `strings P servers` | `desktop/src/strings.ts#P.servers` | 3 | `lexical` | Path `strings` + owner `P` + name `servers` |
