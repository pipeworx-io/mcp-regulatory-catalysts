# mcp-regulatory-catalysts

Regulatory Catalysts MCP — high-value biotech regulatory calendar events (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `fda_adcom_calendar` | Upcoming FDA advisory committee (AdCom) meeting calendar — a leading biotech regulatory catalyst. Lists FDA panel meetings announced in the Federal Register (keyless), extracting the scheduled meeting date from each notice. Covers oncology (ODAC), cellular/tissue & gene therapy (CTGTAC), and every other FDA advisory committee; captures panel-vote meetings that precede or accompany drug/biologic approval decisions (PDUFA-adjacent). Returns each meeting with committee, meeting date (ISO when parseable) plus raw date text, topic, publication date, Federal Register URL, and document number, sorted soonest-first. Use for AdCom, advisory committee, panel vote, drug approval catalyst, FDA meeting calendar, upcoming biotech panels. |
| `pdufa_catalysts` | Companies with disclosed PDUFA dates — the highest-signal binary biotech catalyst. Searches recent SEC EDGAR 8-K filings (keyless) for PDUFA target / goal / action dates and extracts the date and surrounding context. A PDUFA date is the FDA decision date for an NDA or BLA; it is a scheduled binary event that moves biotech stocks. Returns each disclosure with company, ticker, CIK, filing date, form, PDUFA date (ISO when the filing gives a specific day), pdufa_period when the filing discloses only a coarser grain such as "Q1 2027" or "March 2027", a short context snippet, the SEC filing URL, and accession number. A row may carry a period without a date — that is the filing being vague, not a lookup failure. Use for PDUFA date, PDUFA goal date, FDA decision date, upcoming FDA decisions, drug approval catalyst, NDA/BLA decision date, biotech binary event, catalyst by ticker. |

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
