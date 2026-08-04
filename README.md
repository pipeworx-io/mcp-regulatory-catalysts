# mcp-regulatory-catalysts

Regulatory Catalysts MCP — high-value biotech regulatory calendar events (keyless).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Regulatory Catalysts data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
