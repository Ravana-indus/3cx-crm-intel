# Knowledge base seed (Phase 4)

Drop one Markdown file per topic here, for example:

- `office-hours-and-locations.md`
- `germany-opportunity-card.md`
- `how-payment-works.md`
- `what-we-never-promise.md`

On first start the bridge loads `./kb/*.md` into `kb_docs`, then syncs them to
the ElevenLabs knowledge base. Every fee, processing time and eligibility rule
must name an owner and a "review by" date so stale information is visible in
`/v1/health`.
