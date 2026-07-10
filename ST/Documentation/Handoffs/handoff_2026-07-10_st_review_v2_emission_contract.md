# ST Conformance Review + Gravity v2 Emission Contract — Session Handoff

Date: 2026-07-10
Branch: `claude/extension-silly-tavern-review-unuffv` (outer repo)

## ⚠ Resume here

**The user has pending comments on the structure of the plugin that were NOT captured this session.** The next session should open by collecting those structural comments before doing any implementation work — they may modify the improvement priorities in this handoff and possibly the v2 spec's migration phases.

## What Landed

1. **Full SillyTavern-docs conformance review** of the extension + deliverable assets (findings below, review-only — no code changed).
2. **Gravity v2 emission-contract design spec** — committed as `docs/superpowers/specs/2026-07-10-gravity-v2-emission-contract-design.md` (commit `1d10f13`). Outcome of a structured brainstorm; supersedes the emission model in `2026-04-25-gravity-director-design.md`.
3. This handoff.

## Source of truth used for the review

The official SillyTavern docs are mirrored in the user's **vouse-vault** (Obsidian vault in Google Drive → `Vault_2_0/Knowledge/SillyTavern/`, captured from docs.sillytavern.app on 2026-06-22). Key note: `Writing UI Extensions.md` (Drive fileId `11mzRq2gUl1-lntRM2DvgFnoEFLH46KWZ`). The folder also holds World Info, Regex, Macros, Prompts/Presets, STscript, Function Calling references. Prefer these notes over training-data recall; access via the Google Drive MCP tools (large files return a JSON `{fileContent}` overflow file — extract with python).

## Conformance review findings (2026-07-10, unfixed)

Extension is fundamentally well-aligned: `SillyTavern.getContext()` everywhere (no core imports), correct events, `chatMetadata`+`saveMetadata`, `esc()` sanitization in the panel (121 call sites). Open findings, priority order:

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | High | OpenRouter API key stored in `extensionSettings` (docs: never store secrets there — plaintext, readable by all extensions) | `index.js:1513/1521/1555` |
| 2 | High | Director bypasses ST generation — raw `fetch` to OpenRouter, hardcoded provider/model | `director-client.js:62` |
| 3 | Medium | In-flight race: `onMessageReceived` awaits a 30s director call; chat switch mid-flight can commit txs to the wrong chat's ledger. Guard chatId across the await; abort on `CHAT_CHANGED` | `index.js:1650` |
| 4 | Medium | Injection rides `GENERATION_STARTED` (no type gating, fires on dry runs) instead of a `generate_interceptor` — practical harm contained by `_injectFingerprint` guard | `index.js:2762` |
| 5 | Medium | Eager DOM mounting at module load instead of `APP_READY`/`activate` hook | `index.js:2703` |
| 6 | Medium | Lorebook NSFW-on-by-default: uid 12 + uid 14 share key `gravity_prose_intimacy`, both enabled, no inclusion group | `Gravity World Info.json` |
| 7 | Low | One-shot dedup state (`_firedCollisionArrivals` etc.) is module memory — F5 re-fires arrival gates | `index.js:70–75` |
| 8 | Low/Nit | Manifest: `author: "SillyTarvevn"` typo, deprecated `requires`/`optional`, empty `homePage`, no `hooks`; 3 disabled prose prompts in preset missing injection fields; `[DBG]` block marked "remove after smoke" still in (`index.js:1674–1683`); `window.__gravityDirectorStatus` ternary copy-pasted ~10× | various |

Notes: #1–#2 are **resolved by design** in the v2 spec (director retired) — fix by implementing v2 Phase 1, not by patching the director. Assets otherwise schema-clean (lorebook field set correct incl. `disable` not `disabled`; preset `prompts[]`/`prompt_order` valid; `regex-intercept.js` correctly internal JS, preset's "Strip Ledger Block" regex correctly `disabled:true` as fallback).

## v2 brainstorm — decisions and empirical premises (do not re-litigate)

Premises from the user's play-testing:
- **Single smart model doing prose + ledgering beats the director split** (director lacked scene feel; is retired in v2).
- Real pains: **scaffolding token cost** (300–700 output tok/turn: deduction block + `[timestamp] OP … -- reason` lines per `regex-intercept.js:71`) and **compliance/correction churn**. NOT state drift, NOT prose-quality tax.
- **All four subsystems earned their keep** (collisions+gates, dossiers+asymmetry, nudges+heartbeats, challenges+divination). Nothing is cut.
- Audience: **the author** (no migration/polish burden). Model target: **2–3 switchable frontier models** (no vendor-specific hard deps). Streaming: **nice but negotiable**.

Chosen direction: **Hybrid (option D)** — per-turn compact exception-only `---STATE---` footer + generalized decision gates (one-token enumerated answers, arrival-gate pattern) + same-model `generateQuietPrompt` **interview turns** on triggers/consolidation for archival writes. Deduction block deleted (pending A/B). Full detail, tier tables, and 3-phase migration in the spec.

## Next steps (in order)

1. **Collect the user's structural comments on the plugin** (see ⚠ above).
2. Cheap empirical tests, pre-implementation: **deduction A/B** (spec §4) and the **one-afternoon interview prototype** (spec §8) — both run in live chats, no code.
3. **v2 Phase 1** (no format break): machine-stamp timestamps/provenance, no-op suppression, delete director subsystem (closes findings #1/#2), persist one-shot state (closes #7), deduction→native-reasoning guidance.
4. Mop-up batch: findings #5, #6, #8.

## Session mechanics

- Outer-repo work branch this session: `claude/extension-silly-tavern-review-unuffv` (pushed). Prior active branch context (`mari-integration`, fork `gravity-integration`) unchanged — see root `CLAUDE.md`.
- The Marinara embedded port (Tasks 2–13) is untouched; v2 spec §7 defines how the emission contract lands in the portable engine module shared with the Marinara agents.
