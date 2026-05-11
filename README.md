# break-compliance-mcp

MCP server exposing Buddy Punch's Break Compliance feature knowledge (PBI 12985) as queryable tools. Backed by Supabase + pgvector. Embeddings via OpenAI `text-embedding-3-small`.

## Tools

- `search_break_compliance(query, limit?, chunk_type?)` — semantic search across all 52 chunks.
- `get_break_compliance_by_slug(slug)` — retrieve a specific chunk.
- `list_break_compliance_slugs(chunk_type?)` — enumerate slugs by type.
- `get_open_questions()` — case-law-driven vs business-choice.
- `get_case_law()` — Brinker, Gerard, Donohue, Ferra, Naranjo, Lab Codes, Wage Orders.
- `get_scenarios()` — all 22 scenarios from Section 9.

## Env vars (set by bp-platform-mcp bootstrap)

- `SUPABASE_URL`, `SUPABASE_KEY` — shared from oracle-sync-engine
- `OPENAI_API_KEY` — shared from oracle-sync-engine
- `MCP_BEARER` — random 48-char string, must match break-compliance-bot's MCP_BEARER

## Knowledge model

Supabase `public.break_compliance_chunks` — 52 rows (8 decisions, 5 features, 8 case law, 9 open questions, 22 scenarios). pgvector embeddings via `text-embedding-3-small`.

Deployed on Railway via auto-deploy.
