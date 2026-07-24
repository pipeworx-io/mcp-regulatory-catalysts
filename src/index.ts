interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Regulatory Catalysts MCP — high-value biotech regulatory calendar events (keyless).
 *
 * Two tools, both keyless and shaped for LLM consumption:
 *
 *   fda_adcom_calendar — upcoming FDA advisory committee (AdCom) meetings, sourced
 *     from the Federal Register API (keyless). Meetings are announced as NOTICE
 *     documents; the meeting date lives in the notice body, so we fetch a bounded
 *     number of raw-text bodies and extract the date with regex.
 *
 *   pdufa_catalysts — companies with disclosed PDUFA action / goal dates, sourced
 *     from SEC EDGAR full-text search (keyless) over recent 8-K filings. The PDUFA
 *     date lives in the filing body, so we fetch a bounded number of primary docs,
 *     strip HTML, and extract the date with regex.
 *
 * Conventions: tools never throw — fetch/parse failures resolve to
 * { error, retry_hint }. English keys. Clocks are computed INSIDE the handlers
 * (CF Workers freeze the module-init clock at the epoch).
 */


const FR_BASE = 'https://www.federalregister.gov/api/v1/documents.json';
const EFTS_BASE = 'https://efts.sec.gov/LATEST/search-index';
const FR_UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const SEC_UA = 'Pipeworx/1.0 (support@pipeworx.io)';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const tools: McpToolExport['tools'] = [
  {
    name: 'fda_adcom_calendar',
    description:
      'Upcoming FDA advisory committee (AdCom) meeting calendar — a leading biotech regulatory catalyst. Lists FDA panel meetings announced in the Federal Register (keyless), extracting the scheduled meeting date from each notice. Covers oncology (ODAC), cellular/tissue & gene therapy (CTGTAC), and every other FDA advisory committee; captures panel-vote meetings that precede or accompany drug/biologic approval decisions (PDUFA-adjacent). Returns each meeting with committee, meeting date (ISO when parseable) plus raw date text, topic, publication date, Federal Register URL, and document number, sorted soonest-first. Use for AdCom, advisory committee, panel vote, drug approval catalyst, FDA meeting calendar, upcoming biotech panels.',
    inputSchema: {
      type: 'object',
      properties: {
        upcoming_only: {
          type: ['boolean', 'string'],
          description: 'Keep only meetings whose extracted date is today or later. Default true. If every recent notice describes a past meeting, the found rows are returned with a note.',
        },
        committee: {
          type: 'string',
          description: 'Case-insensitive substring filter on the committee / notice title, e.g. "oncologic", "gene therapy", "cardiovascular". Omit for all committees.',
        },
        limit: {
          type: ['number', 'string'],
          description: 'Number of meetings to return (1–20). Default 10.',
        },
      },
    },
  },
  {
    name: 'pdufa_catalysts',
    description:
      'Companies with disclosed PDUFA dates — the highest-signal binary biotech catalyst. Searches recent SEC EDGAR 8-K filings (keyless) for PDUFA target / goal / action dates and extracts the date and surrounding context. A PDUFA date is the FDA decision date for an NDA or BLA; it is a scheduled binary event that moves biotech stocks. Returns each disclosure with company, ticker, CIK, filing date, form, PDUFA date (ISO when parseable), a short context snippet, the SEC filing URL, and accession number. Use for PDUFA date, PDUFA goal date, FDA decision date, upcoming FDA decisions, drug approval catalyst, NDA/BLA decision date, biotech binary event, catalyst by ticker.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional extra term ANDed into the search — a drug or company name, e.g. "obecabtagene" or "Capricor". Omit to search all PDUFA disclosures in the window.',
        },
        since: {
          type: 'string',
          description: 'Start of the filing-date window (YYYY-MM-DD). Default: 120 days before today.',
        },
        until: {
          type: 'string',
          description: 'End of the filing-date window (YYYY-MM-DD). Default: today.',
        },
        limit: {
          type: ['number', 'string'],
          description: 'Number of disclosures to return (1–10). Default 8.',
        },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'fda_adcom_calendar':
        return await fdaAdcomCalendar(args);
      case 'pdufa_catalysts':
        return await pdufaCatalysts(args);
      default:
        return { error: `Unknown tool: ${name}`, retry_hint: 'Use one of: fda_adcom_calendar, pdufa_catalysts.' };
    }
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      retry_hint: 'Transient upstream failure — retry in a few seconds.',
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tool 1: fda_adcom_calendar                                          */
/* ------------------------------------------------------------------ */

async function fdaAdcomCalendar(args: Record<string, unknown>): Promise<unknown> {
  const upcomingOnly = boolArg(args.upcoming_only, true);
  const committee = strArg(args.committee);
  const limit = clampInt(args.limit, 10, 1, 20);

  // Pull a generous list; we bound body fetches below.
  const params = new URLSearchParams();
  params.append('conditions[agencies][]', 'food-and-drug-administration');
  params.append('conditions[term]', 'advisory committee meeting');
  params.append('conditions[type][]', 'NOTICE');
  params.append('order', 'newest');
  params.append('per_page', '20');
  for (const f of ['title', 'abstract', 'html_url', 'publication_date', 'document_number', 'raw_text_url']) {
    params.append('fields[]', f);
  }

  const data = (await frGet(params)) as { count?: number; results?: any[] };
  let notices = data.results ?? [];

  // Optional committee/title filter before spending body fetches.
  if (committee) {
    const needle = committee.toLowerCase();
    notices = notices.filter((n) => String(n.title ?? '').toLowerCase().includes(needle));
  }

  // Bound the number of body fetches to <= 12.
  const toFetch = notices.slice(0, 12);
  const rows = await Promise.all(toFetch.map((n) => shapeAdcomRow(n)));

  const todayIso = todayISO();
  let visible = rows;
  let note: string | undefined;
  if (upcomingOnly) {
    const upcoming = rows.filter((r) => r.meeting_date != null && r.meeting_date >= todayIso);
    if (upcoming.length === 0) {
      note = 'No upcoming meeting date could be extracted from recent notices; returning the most recent notices found (dates may be in the past or unparsed).';
      visible = rows;
    } else {
      visible = upcoming;
    }
  }

  // Sort: parseable dates ascending first, unparsed dates last.
  visible.sort((a, b) => {
    if (a.meeting_date && b.meeting_date) return a.meeting_date < b.meeting_date ? -1 : a.meeting_date > b.meeting_date ? 1 : 0;
    if (a.meeting_date) return -1;
    if (b.meeting_date) return 1;
    return 0;
  });

  const meetings = visible.slice(0, limit);
  return {
    source: 'Federal Register API (federalregister.gov)',
    as_of: todayIso,
    upcoming_only: upcomingOnly,
    ...(committee ? { committee_filter: committee } : {}),
    count: meetings.length,
    ...(note ? { note } : {}),
    meetings,
  };
}

interface AdcomRow {
  committee: string | null;
  meeting_date: string | null;
  meeting_date_text: string | null;
  topic: string | null;
  publication_date: string | null;
  url: string | null;
  document_number: string | null;
}

async function shapeAdcomRow(n: Record<string, any>): Promise<AdcomRow> {
  const title: string = String(n.title ?? '');
  const semi = title.indexOf(';');
  const committee = (semi >= 0 ? title.slice(0, semi) : title).trim() || null;
  const titleRest = semi >= 0 ? title.slice(semi + 1).trim() : '';
  const abstract = String(n.abstract ?? '').trim();
  const topic = [titleRest, abstract].filter(Boolean).join(' — ').slice(0, 400) || null;

  let meetingText: string | null = null;
  if (n.raw_text_url) {
    const body = await fetchText(String(n.raw_text_url));
    if (body) meetingText = extractMeetingDate(body);
  }
  const meetingIso = meetingText ? parseLooseDate(meetingText) : null;

  return {
    committee,
    meeting_date: meetingIso,
    meeting_date_text: meetingText,
    topic,
    publication_date: n.publication_date ?? null,
    url: n.html_url ?? null,
    document_number: n.document_number ?? null,
  };
}

function extractMeetingDate(text: string): string | null {
  // Verified primary pattern: "meeting will be held on July 30, 2026".
  let m = text.match(/meeting will be held on\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
  if (m) return cleanDate(m[1]);
  // Fallback: a DATES: section mentioning a full date.
  const dates = text.match(/DATES:\s*([\s\S]{0,300})/i);
  if (dates) {
    const dm = dates[1].match(/([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/);
    if (dm) return cleanDate(dm[1]);
  }
  // Fallback: any full date within ~80 chars after the word "meeting".
  const near = text.match(/meeting[\s\S]{0,80}?([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
  if (near) return cleanDate(near[1]);
  return null;
}

/* ------------------------------------------------------------------ */
/* Tool 2: pdufa_catalysts                                             */
/* ------------------------------------------------------------------ */

async function pdufaCatalysts(args: Record<string, unknown>): Promise<unknown> {
  const extra = strArg(args.query);
  const limit = clampInt(args.limit, 8, 1, 10);
  const today = todayISO();
  const since = strArg(args.since) ?? isoDaysAgo(120);
  const until = strArg(args.until) ?? today;

  const q = extra ? `"PDUFA" AND "${extra.replace(/"/g, '')}"` : '"PDUFA"';
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('forms', '8-K');
  params.set('size', '10');
  params.set('dateRange', 'custom');
  params.set('startdt', since);
  params.set('enddt', until);

  const data = (await eftsGet(params)) as { hits?: { total?: { value?: number }; hits?: any[] } };
  const hits = data.hits?.hits ?? [];
  const total = data.hits?.total?.value ?? hits.length;

  // Bound primary-doc fetches to <= 10.
  const toFetch = hits.slice(0, 10);
  const rows = await Promise.all(toFetch.map((h) => shapePdufaRow(h)));

  const catalysts = rows.slice(0, limit);
  return {
    source: 'SEC EDGAR full-text search (efts.sec.gov) — 8-K filings',
    as_of: today,
    window: { since, until },
    ...(extra ? { query: extra } : {}),
    total_matches: total,
    count: catalysts.length,
    catalysts,
  };
}

interface PdufaRow {
  company: string | null;
  ticker: string | null;
  cik: string | null;
  filing_date: string | null;
  form: string | null;
  pdufa_date: string | null;
  pdufa_context: string | null;
  url: string | null;
  accession: string | null;
}

async function shapePdufaRow(h: Record<string, any>): Promise<PdufaRow> {
  const src = h._source ?? {};
  const id = String(h._id ?? '');
  const [accession, primaryDoc] = splitOnce(id, ':');
  const display = Array.isArray(src.display_names) && src.display_names.length ? String(src.display_names[0]) : '';
  const { company, ticker, cik } = parseDisplayName(display);

  let pdufaDate: string | null = null;
  let context: string | null = null;
  if (cik && accession && primaryDoc) {
    const accNoDash = accession.replace(/-/g, '');
    const cikInt = String(parseInt(cik, 10));
    const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDash}/${primaryDoc}`;
    const html = await fetchText(url, SEC_UA);
    if (html) {
      const ext = extractPdufa(html);
      pdufaDate = ext.date;
      context = ext.context;
    }
  }

  const cikInt = cik ? String(parseInt(cik, 10)) : null;
  const accNoDash = accession ? accession.replace(/-/g, '') : null;
  const url = cikInt && accNoDash && primaryDoc
    ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDash}/${primaryDoc}`
    : null;

  return {
    company,
    ticker,
    cik,
    filing_date: src.file_date ?? null,
    form: src.form_type ?? '8-K',
    pdufa_date: pdufaDate,
    pdufa_context: context,
    url,
    accession: accession || null,
  };
}

function parseDisplayName(display: string): { company: string | null; ticker: string | null; cik: string | null } {
  if (!display) return { company: null, ticker: null, cik: null };
  const firstParen = display.indexOf('(');
  const company = (firstParen >= 0 ? display.slice(0, firstParen) : display).trim() || null;
  let ticker: string | null = null;
  let cik: string | null = null;
  const groups = display.match(/\(([^)]*)\)/g) ?? [];
  for (const g of groups) {
    const inner = g.slice(1, -1).trim();
    const cikM = inner.match(/CIK\s+(\d+)/i);
    if (cikM) {
      cik = cikM[1];
      continue;
    }
    if (!ticker && inner) ticker = inner;
  }
  return { company, ticker, cik };
}

function extractPdufa(html: string): { date: string | null; context: string | null } {
  const text = stripHtml(html);
  const m = text.match(
    /PDUFA[^.]{0,140}?\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i,
  );
  if (!m) return { date: null, context: null };
  const date = parseLooseDate(m[1]);
  const context = m[0].replace(/\s+/g, ' ').trim().slice(0, 160);
  return { date, context };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

async function frGet(params: URLSearchParams): Promise<unknown> {
  const res = await fetchWithTimeout(`${FR_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': FR_UA },
  });
  if (!res.ok) {
    const body = await safeBody(res);
    throw new Error(`Federal Register API: ${res.status} ${body}`.trim());
  }
  return res.json();
}

async function eftsGet(params: URLSearchParams): Promise<unknown> {
  const res = await fetchWithTimeout(`${EFTS_BASE}?${params.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': SEC_UA },
  });
  if (!res.ok) {
    const body = await safeBody(res);
    throw new Error(`SEC EDGAR full-text search: ${res.status} ${body}`.trim());
  }
  return res.json();
}

// Body fetches are best-effort: a failure yields null so one bad notice/filing
// does not sink the whole result set.
async function fetchText(url: string, ua: string = FR_UA): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': ua } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeBody(res: Response): Promise<string> {
  return res.text().then((t) => t.slice(0, 200)).catch(() => '');
}

/* ------------------------------------------------------------------ */
/* Date + arg helpers                                                  */
/* ------------------------------------------------------------------ */

// Normalize whitespace in an extracted date string.
function cleanDate(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Parse "July 30, 2026" / "Jul. 30, 2026" / "August 22 2026" -> "2026-07-30".
function parseLooseDate(s: string): string | null {
  const m = s.match(/([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (day < 1 || day > 31) return null;
  return `${year}-${pad2(mon)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Computed IN-HANDLER (CF Workers freeze the module-init clock at the epoch).
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, ''];
  return [s.slice(0, i), s.slice(i + sep.length)];
}

function boolArg(v: unknown, dflt: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'no') return false;
  }
  return dflt;
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
