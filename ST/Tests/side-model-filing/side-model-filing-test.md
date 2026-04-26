# Side Model Filing Test

## Context

Tests whether a local LLM (Gemma 9B, Phi-3, Qwen2.5, etc.) can reliably
translate a natural-language hint + full prose into structured ledger transactions.

The prompt includes ~500 words of prose (realistic turn length) plus compressed
state and the author's hint block.

## Token budget (approximate)

| Component | Tokens |
|-----------|--------|
| System prompt | ~350 |
| Compressed state | ~400 |
| Full prose (500 words) | ~700 |
| Hint block | ~150 |
| Instructions | ~200 |
| **Input total** | **~1800** |
| Output space | ~500 |
| **Grand total** | **~2300** |

Well within 8k context. A heavier state (10+ chars, many KA entries) might push
input to ~3000 tokens — still fine.

## How to run

```bash
# Option 1: Interactive (paste or pipe)
ollama run gemma2:9b < Test/side-model-filing-prompt.txt

# Option 2: API call (OpenAI-compat endpoint)
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @Test/side-model-filing-api.json

# Option 3: LM Studio / llama.cpp (same payload, different port)
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d @Test/side-model-filing-api.json
```

## Expected output (approximate)

The model should produce something close to:

```
CR char:flay-allster name="Flay Allster" tier=KNOWN
S char:flay-allster field=location value="deck 2 corridor"
S char:flay-allster field=doing value="confronting Autumn about Coordinator sympathies"
S pc field=location value="deck 2 corridor"
S pc field=doing value="facing down Flay in corridor outside briefing room"
S pc field=current_scene value="Deck 2 corridor. Autumn vs Flay. Mu watching from doorway."
MS char:mu-la-flaga field=knowledge_asymmetry key=noticed_autumn_stillness value="Autumn's hands didn't move — unnatural control for a Natural"
MS char:lacus-clyne field=knowledge_asymmetry key=reads_autumn_politically_exposed value="Overheard crew hostility; assessing Autumn as potential ally or pressure point"
A char:natarle-badgiruel field=demonstrated_traits value="Calculating Lacus's leverage value immediately after ID confirmation"
S collision:suit-asks field=distance value=2
```

## Evaluation criteria

### Pass (model is usable for filing)
1. **Correct entity IDs** — uses existing IDs from state (char:lacus-clyne, not char:lacus)
2. **Correct ops** — CR for new entity, S for field updates, MS for knowledge_asymmetry, A for array appends
3. **No hallucinations** — doesn't create transactions for things not in the hint
4. **Correct field names** — location, doing, tier, knowledge_asymmetry, demonstrated_traits
5. **Reasonable values** — concise, factual, matches the hint content
6. **No commentary** — only transaction lines, no explanations

### Bonus (model is strong)
7. **Infers scene change** — PC moved, so current_scene should update
8. **KA key naming** — uses snake_case descriptive keys (not generic like "info1")
9. **Proportional response** — 7-12 transactions for this hint, not 3 (too sparse) or 20 (hallucinating)

### Fail conditions
- Emits markdown formatting (```blocks, headers, bullet points)
- Creates entities that weren't introduced (hallucinated characters)
- Uses wrong entity IDs (char:lacus instead of char:lacus-clyne)
- Misuses ops (S where MS is needed for maps, CR for existing entity)
- Adds explanatory text between or after transactions
