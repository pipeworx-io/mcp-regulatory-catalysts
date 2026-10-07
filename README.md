# regulatory-catalysts

Keyless biotech regulatory catalysts: FDA advisory-committee (AdCom) meetings,
the evidence those panels review, and disclosed PDUFA decision dates.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1715+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

| Tool | Source | Answers |
|------|--------|---------|
| `fda_adcom_calendar` | Federal Register API | Which FDA advisory committees meet next, and when |
| `fda_adcom_materials` | fda.gov advisory-committee calendar + meeting pages | What a panel is reviewing: briefing documents, agenda, voting questions, slides, minutes, transcripts |
| `pdufa_catalysts` | SEC EDGAR full-text search (8-K) | Which drugs are under FDA review and when the decision is due |

## `fda_adcom_materials` (fleet #2793)

Pick a meeting by `committee` (acronym or name fragment: `ODAC`, `VRBPAC`,
`CTGTAC`, `oncologic`, `gene therap`…), `date` (`2026-04-30`, `2026-04` or
`2026`), and/or `query` (drug, sponsor, application or topic). With no filters
it returns the meeting nearest to today. `limit` (1–3) returns more than one
meeting; `include_questions_text: false` skips the questions-PDF fetch.

How a `query` is resolved, in order, with `matched_by` saying which won:

1. `title` — the calendar's meeting titles (they name the committee, rarely a drug).
2. `federal_register` — the Federal Register notice that announced the meeting
   names the application and the drug; one full-text search plus up to three
   notice bodies yields the meeting date(s), which select the calendar row.
3. `agenda` — the 20 meetings nearest to today are opened and their page text
   searched. Last resort, bounded.

Each meeting carries: `committee`, `center`, `meeting_date`, `time`, the page
`url`, `page_updated`, the public `docket` (+ regulations.gov URL), `webcast_url`,
the `agenda` text, and `applications` parsed from the agenda (`NDA 220359`,
product, sponsor, proposed indication). Then either:

- `materials_status: "posted"` with `materials_count`, `materials_by_type`, the
  `materials` list (`title`, `document_type`, `party`, `file`, `media_id`, `url`),
  and `voting_questions` — the Questions PDF's text and its numbered items with a
  `vote` flag — when FDA has posted a Questions document; or
- `materials_status: "none_posted"` with `materials_count: 0` and a
  `materials_note` carrying the meeting date and FDA's posting timeline. There is
  deliberately no `materials: []` here: nothing posted yet is a statement about
  the meeting, not an empty search result.

`document_type` is one of `briefing_document`, `agenda`, `questions`, `roster`,
`presentations`, `minutes`, `transcript`, `webcast_information`,
`federal_register_notice`, `summary`, `public_comments`, `other`. `party` is
`fda` / `sponsor` / `combined` only when the title says so, otherwise `null` —
CDC, academic and patient-group decks sit on the same pages and a guessed
"sponsor" would read as a fact.

### What FDA does not publish, so neither do we

- **Per-document posting dates.** The page's own "content current as of" stamp is
  returned as `materials_as_of`; it is the closest honest answer.
- **The vote tally.** It is in the minutes and the transcript, which are linked,
  not in any structured field on the page.

### Source and failure policy

- Calendar: `https://www.fda.gov/datatables-json/advisory-committee-calendar-json`
  — the JSON route behind the calendar page's DataTable (found in the page's own
  JS bundle; the page itself renders no rows server-side). One row per meeting,
  2016 → the furthest scheduled meeting, ~130 KB, cached at the edge for an hour.
- Meeting pages and `/media/<id>/download` PDFs on `www.fda.gov`.
- **Edge-probed 2026-10-07** with a throwaway `wrangler dev --remote` Worker on
  the prod account: the calendar JSON, two meeting pages and a 126 KB questions
  PDF all answered `200` with this pack's UA. The Orange Book refusal recorded in
  `mcps/fda-drug-competition` is specific to the bulk asset route; the small
  per-meeting PDFs here served from the edge.
- A non-2xx from any of these, a calendar body that is not a non-empty JSON list,
  a meeting URL that serves fda.gov's "FDA Internet Site Error" apology page, or
  an Event Materials table whose rows no longer parse is a **loud** `{ error }`
  naming the upstream status and the page — never `found: false`, never an empty
  list. The questions-PDF step is the one best-effort part: its failure is
  reported in-band as `voting_questions.extraction_error`, beside the document's
  URL, so the rest of the answer stands. `src/index.test.ts` pins each of these.
- `found: false` is reserved for filters that genuinely match no meeting, and
  carries the calendar's size and date range so a caller can tell "not held" from
  "not in the window".

Smoke, 2026-10-07 (laptop, esbuild bundle of this file): `{committee:"ODAC"}` →
April 30, 2026 ODAC, 16 materials (4 briefing documents, 4 presentation decks,
2 transcripts, minutes, agenda, questions, 2 rosters, webcast), 2 applications
(NDA 220359 camizestrant, sNDA 218197/S-004 capivasertib, both AstraZeneca),
2 VOTE questions extracted; `{query:"camizestrant"}` → the same meeting via
`federal_register`; `{committee:"microbiology devices", date:"2026-11-19"}` →
`none_posted` with the date; `{committee:"VRBPAC"}` → October 1, 2026, 9
materials, the strain-selection voting question.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "regulatory-catalysts": {
      "url": "https://gateway.pipeworx.io/regulatory-catalysts/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/regulatory-catalysts/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1715+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fda_adcom_calendar \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fda_adcom_calendar`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "regulatory-catalysts": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-regulatory-catalysts"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-regulatory-catalysts
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Regulatory Catalysts data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
