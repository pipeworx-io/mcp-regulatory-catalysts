interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout$shared` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout$shared` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout$shared(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout$shared(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout$shared`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout$shared` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * Minimal text extractor for simple, text-based PDFs — the kind a
 * mail-merge/print pipeline produces (Word or LibreOffice "export to PDF"),
 * not a scanned image. Built for Kentucky's per-statute PDFs
 * (apps.legislature.ky.gov/law/statutes/statute.aspx?id=...), which ARE
 * exactly that shape: one object tree, FlateDecode content streams, standard
 * TrueType fonts. This is the capability the state-law survey flagged as
 * "the largest single win available" (docs/state-law-probe.md) — several
 * state statute sites serve text ONLY as a per-section PDF, with no HTML
 * fallback, and until now this repo had no way to read one.
 *
 * WHAT THIS DOES NOT DO: parse a general PDF. No encryption, no cross-
 * reference recovery for a damaged file, no image/OCR, no custom
 * `/Differences` glyph encodings, no LZW or RunLength filters, no multi-byte
 * codespaces other than the 2-byte one every sampled font used. Most objects
 * this needs — Catalog, Pages, a leaf Page, its Resources/Font dict, its
 * Contents stream(s), a Type0 font's ToUnicode CMap — are found by scanning
 * for `N 0 obj ... endobj` directly in the file bytes. If a producer moves
 * one into a compressed object stream and this extractor still cannot find
 * it (see the next paragraph for what IS handled), extraction degrades to
 * `pages_found: 0` / empty text rather than silently returning garbage —
 * check `warnings` before trusting a thin result.
 *
 * COMPRESSED OBJECT STREAMS (`/Type/ObjStm`) ARE SUPPORTED (fleet #2744,
 * added for Wyoming's statute PDFs, which — unlike Kentucky's — are
 * cross-reference-STREAM files whose Catalog and Pages root are themselves
 * compressed into an ObjStm: `5205 0 obj` never appears literally in the
 * file; it exists only as entry in a decompressed `/Type/ObjStm` stream).
 * Every direct `/Type/ObjStm` object found in the file is inflated up front;
 * its header (`/N` object pairs starting at byte `/First`) is parsed into a
 * `(object number -> dict text)` map, and `getObject` falls back to that map
 * whenever the direct byte-scan finds nothing. Per the PDF spec a compressed
 * object can never itself contain a stream (Contents, ToUnicode CMaps, and
 * ObjStm/XRef streams are therefore always direct objects, found the
 * original way) — so this fallback only ever needs to resolve plain
 * dictionaries/arrays (Catalog, Pages, Font, sometimes Page), which is
 * exactly what Wyoming's shape needs. An ObjStm nested inside another
 * ObjStm via `/Extends` is NOT walked — not observed in any file tested.
 *
 * ALSO FIXED HERE: the Catalog/Pages discovery no longer requires `/Type`
 * to be the first thing found after `<<` in a Catalog's own dictionary text
 * — the original `<<[^>]*\/Type\s*\/Catalog` regex broke the moment any
 * NESTED dict (e.g. `/MarkInfo<</Marked true>>`) appeared earlier in the
 * same object, because `[^>]*` cannot cross that inner `>>`. Wyoming's real
 * Catalog objects are exactly this shape (`/Lang(...)/MarkInfo<<...>>
 * /Metadata .../Pages .../Type/Catalog/ViewerPreferences<<...>>`, `/Type`
 * nowhere near the start). Discovery now finds `/Type/Catalog` (or
 * `/Type/Pages`) as plain text anywhere — direct or inside a decompressed
 * ObjStm — and locates its OWN object number by nearest preceding
 * `N 0 obj` marker, which works regardless of what else is in the dict.
 *
 * TWO FONT SHAPES, BOTH NEEDED (confirmed against real KRS statute PDFs,
 * fleet #2734):
 *   - Simple TrueType/Type1 with `/Encoding/WinAnsiEncoding` — the common
 *     case. WinAnsiEncoding is BY DESIGN identical to Windows code page 1252
 *     (that is what "WinAnsi" means), so the raw string-literal bytes decode
 *     directly via `TextDecoder('windows-1252')` with no per-glyph table of
 *     our own to get wrong.
 *   - Type0/CIDFontType2 with `/Encoding/Identity-H` — seen even inside an
 *     otherwise-simple statute, apparently whenever the PDF producer's text
 *     shaping fell back to a subset-embedded font for one run (KRS 532.025's
 *     closing sentence, which includes a curly apostrophe, was entirely in
 *     this font while the rest of the document used WinAnsi). Each character
 *     is a 2-byte CID with NO inherent meaning; the `/ToUnicode` CMap
 *     attached to the font is the only place the real Unicode value lives
 *     (`beginbfchar`/`beginbfrange` blocks). Skipping this font shape would
 *     have truncated or corrupted exactly the statutes that happen to use a
 *     special character — not a rare edge case, a silent one.
 *
 * Verified end-to-end against two real KRS statutes during this pack's
 * build: a single-page WinAnsi-only PDF (507.020, Murder) and a four-page PDF
 * mixing both font shapes (532.025, including the CID-encoded sentence
 * naming "Kimber's Law") — both reproduced the statute's true text exactly,
 * eyeballed against the rendered PDF.
 *
 * INDIRECT /Length (fleet #2743): extended for North Dakota's Century Code
 * chapter PDFs (ndlegis.gov/cencode/t*.pdf), whose content streams all write
 * `/Length` as an indirect reference ("/Length 3 0 R") rather than inlining
 * the literal integer the way every sampled KRS PDF did. The referenced
 * object is resolved (it is always a bare integer object, never itself a
 * stream) rather than falling back to scanning for the "endstream" keyword —
 * that fallback slices in the EOL bytes between the compressed data and the
 * keyword, which this repo's own Node zlib rejects as "trailing junk" even
 * though the compressed payload is intact (Workers' DecompressionStream may
 * be more lenient, but Node is what `prepush-tests.mjs` runs, so the bug was
 * real either way). Verified against ND Century Code chapter 12.1-16
 * (Homicide, t12-1c16.pdf) — every content stream in that 9-page PDF uses
 * the indirect form.
 */

interface PdfExtractResult {
  /** Extracted text, pages joined with a blank line. Empty string if nothing
   *  could be read — check `warnings`, not just truthiness, before deciding
   *  that means the document has no text. */
  text: string;
  /** Number of leaf /Type/Page objects found via the Pages tree. */
  pages: number;
  /** Non-fatal problems found while extracting (unknown font, missing
   *  ToUnicode, etc). A non-empty array does not mean the text is wrong, but
   *  it means something was guessed rather than read. */
  warnings: string[];
}

type FontDecoder =
  | { kind: 'winansi' }
  | { kind: 'cid'; map: Map<number, number> }
  // Simple (1-byte-code) font decoded via its own /ToUnicode CMap rather than
  // WinAnsi — see fontDecoderFor's comment on North Dakota's subsetted fonts.
  | { kind: 'mapped1'; map: Map<number, number> };

/** Inflate one `/FlateDecode` stream using the platform's own zlib — no
 *  dependency, works identically in the Workers runtime and in Node (used by
 *  this repo's prepush tests), because both implement the standard
 *  CompressionStream/DecompressionStream API over the zlib wire format PDF's
 *  FlateDecode filter already uses. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Undo PDF string-literal escaping — `\(`, `\)`, `\\`, `\n`/`\r`/`\t`,
 * octal `\ddd`, and a trailing backslash-newline line continuation — on a
 * windows-1252-decoded slice. Safe to run on the decoded string rather than
 * raw bytes: every character this function inspects or produces (backslash,
 * parens, digits, the letters n/r/t/b/f) is plain ASCII, which windows-1252
 * never remaps, so the 1-byte-per-character alignment this relies on holds
 * throughout.
 */
function unescapePdfLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[i + 1];
    if (next === undefined) continue;
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === 't') { out += '\t'; i++; }
    else if (next === 'b' || next === 'f') { i++; }
    else if (next === '(' || next === ')' || next === '\\') { out += next; i++; }
    else if (next >= '0' && next <= '7') {
      let oct = next, j = i + 1, k = 0;
      while (k < 2 && s[j + 1] >= '0' && s[j + 1] <= '7') { j++; oct += s[j]; k++; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = j;
    } else if (next === '\n') { i++; }
    else if (next === '\r') { i++; if (s[i + 1] === '\n') i++; }
    else { out += next; i++; }
  }
  return out;
}

interface RawObject {
  dict: string;
  streamBytes: Uint8Array | null;
}

/** Extract readable text from a simple, non-encrypted, non-scanned PDF. */
async function extractPdfText(buf: ArrayBuffer): Promise<PdfExtractResult> {
  const bytes = new Uint8Array(buf);
  // windows-1252 decode is total (every byte maps to exactly one UTF-16 code
  // unit) and length-preserving, so a match index found in `scan` is also a
  // valid BYTE offset into `bytes` — used below to slice stream data without
  // ever routing binary bytes through a lossy string round-trip.
  const scan = new TextDecoder('windows-1252').decode(bytes);
  const warnings: string[] = [];
  const objCache = new Map<number, RawObject | null>();

  // Byte offset of every DIRECT "N 0 obj" marker, sorted, for two uses: (1)
  // the object-lookup fallback stays regex-per-object the same as before;
  // (2) `objNumBefore` below answers "which object's text is this index
  // inside", which is how Catalog/Pages/ObjStm discovery works regardless of
  // what else that object's dictionary contains — see the file header.
  const objStarts: { index: number; num: number }[] = [];
  {
    const re = /(\d+)\s+0\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) objStarts.push({ index: m.index, num: parseInt(m[1], 10) });
  }
  function objNumBefore(markerIndex: number): number | null {
    let lo = 0, hi = objStarts.length - 1, ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (objStarts[mid].index <= markerIndex) { ans = objStarts[mid].num; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function getDirectObject(n: number): RawObject | null {
    if (objCache.has(n)) return objCache.get(n) ?? null;
    const re = new RegExp(`(?:^|\\D)${n}\\s+0\\s+obj`);
    const m = re.exec(scan);
    if (!m) { objCache.set(n, null); return null; }
    const objStart = m.index + m[0].length;
    const endobjIdx = scan.indexOf('endobj', objStart);
    const streamIdx = scan.indexOf('stream', objStart);
    let dict: string;
    let streamBytes: Uint8Array | null = null;
    if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
      dict = scan.slice(objStart, streamIdx);
      let dataStart = streamIdx + 'stream'.length;
      if (bytes[dataStart] === 0x0d) dataStart++;
      if (bytes[dataStart] === 0x0a) dataStart++;
      // Matches EITHER "/Length 428" (literal) or "/Length 12 0 R"
      // (indirect) — group 2 is present only for the indirect form. Written
      // this way ON PURPOSE instead of the more obvious
      // `/\/Length\s+(\d+)(?!\s+0\s+R)/` for a literal: that negative
      // lookahead is a backtracking trap for any MULTI-DIGIT indirect
      // reference. On "/Length 12 0 R", a greedy `(\d+)` first tries "12",
      // the lookahead correctly forbids it (followed by " 0 R") — but the
      // engine then backtracks `\d+` down to "1", at which point the
      // lookahead is checked against "2 0 R", which does NOT start with
      // whitespace, so the forbidden pattern no longer matches and the
      // lookahead (wrongly) PASSES. The match silently becomes "1" instead
      // of failing, so this object's /Length reads as the literal integer 1
      // instead of as a reference to resolve — exactly the shape of North
      // Dakota's Century Code chapter PDFs (fleet #2743), whose indirect
      // Length refs are almost all two or more digits. An explicit optional
      // group has nothing to backtrack: `(\d+)` greedily keeps "12" and the
      // optional `(\s+0\s+R)?` either matches right after it or doesn't.
      const lenDictMatch = /\/Length\s+(\d+)(\s+0\s+R)?/.exec(dict);
      let dataEnd = -1;
      if (lenDictMatch) {
        if (!lenDictMatch[2]) {
          dataEnd = dataStart + parseInt(lenDictMatch[1], 10);
        } else {
          // Indirect reference. The referenced object is a bare integer
          // ("12 0 obj\n4541\nendobj"), never itself a stream, so resolving
          // it through the same getObject() is safe (no recursion risk back
          // onto object n). Falling back to scanning for the "endstream"
          // keyword instead — which the pre-fix code did unconditionally
          // here — slices in the EOL bytes PDF producers place between the
          // compressed data and that keyword, which Node's strict zlib
          // rejects as "trailing junk" even though the compressed payload
          // itself is intact.
          const lenObj = getObject(parseInt(lenDictMatch[1], 10));
          const lenVal = lenObj ? parseInt(lenObj.dict.trim(), 10) : NaN;
          if (Number.isFinite(lenVal) && lenVal >= 0) dataEnd = dataStart + lenVal;
        }
      }
      if (dataEnd === -1) dataEnd = scan.indexOf('endstream', dataStart);
      streamBytes = bytes.slice(dataStart, dataEnd);
    } else {
      dict = scan.slice(objStart, endobjIdx === -1 ? scan.length : endobjIdx);
    }
    const result = { dict, streamBytes };
    objCache.set(n, result);
    return result;
  }

  // Compressed objects (inside a /Type/ObjStm) — object number -> dict text.
  // Populated below, before any Catalog/Pages/Font lookup runs, because a
  // compressed Catalog or Pages root (Wyoming's shape) must resolve exactly
  // like a direct one from that point on. Never holds a stream: the PDF spec
  // forbids a compressed object from containing one.
  const compressedObjects = new Map<number, string>();
  {
    const objStmNums: number[] = [];
    const re = /\/Type\s*\/ObjStm\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scan))) {
      const n = objNumBefore(m.index);
      if (n !== null) objStmNums.push(n);
    }
    for (const n of objStmNums) {
      const obj = getDirectObject(n);
      if (!obj || !obj.streamBytes) { warnings.push(`ObjStm ${n} has no stream data`); continue; }
      let data: Uint8Array;
      if (/\/Filter\s*\/FlateDecode/.test(obj.dict)) {
        try {
          data = await inflate(obj.streamBytes);
        } catch (e) {
          warnings.push(`inflate failed for ObjStm ${n}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      } else {
        data = obj.streamBytes;
      }
      const nMatch = /\/N\s+(\d+)/.exec(obj.dict);
      const firstMatch = /\/First\s+(\d+)/.exec(obj.dict);
      if (!nMatch || !firstMatch) { warnings.push(`ObjStm ${n} missing /N or /First`); continue; }
      const count = parseInt(nMatch[1], 10);
      const first = parseInt(firstMatch[1], 10);
      const header = new TextDecoder('latin1').decode(data.slice(0, first)).trim().split(/\s+/).map((x) => parseInt(x, 10));
      const entries: { num: number; offset: number }[] = [];
      for (let i = 0; i + 1 < header.length && entries.length < count; i += 2) {
        entries.push({ num: header[i], offset: header[i + 1] });
      }
      const body = new TextDecoder('windows-1252').decode(data);
      for (let i = 0; i < entries.length; i++) {
        const start = first + entries[i].offset;
        const end = i + 1 < entries.length ? first + entries[i + 1].offset : data.length;
        if (start < 0 || end > data.length || start > end) {
          warnings.push(`ObjStm ${n} entry ${entries[i].num} has an out-of-range offset, skipped`);
          continue;
        }
        compressedObjects.set(entries[i].num, body.slice(start, end));
      }
    }
  }

  // The lookup every caller below actually uses: direct object text, falling
  // back to a compressed one. Never both — a given object number is either
  // found literally in the file or inside exactly one ObjStm, not both.
  function getObject(n: number): RawObject | null {
    const direct = getDirectObject(n);
    if (direct) return direct;
    const compressed = compressedObjects.get(n);
    if (compressed !== undefined) return { dict: compressed, streamBytes: null };
    return null;
  }

  async function decompressedStream(n: number): Promise<Uint8Array | null> {
    const obj = getObject(n);
    if (!obj || !obj.streamBytes) return null;
    if (/\/FlateDecode/.test(obj.dict)) {
      try {
        return await inflate(obj.streamBytes);
      } catch (e) {
        warnings.push(`inflate failed for object ${n}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
    return obj.streamBytes;
  }

  // Catalog -> Pages -> Kids, walked in document order. Falls back to the
  // first /Type/Pages object if no /Type/Catalog is found. Both searches
  // look for the TYPE MARKER as plain text first (direct text, or inside any
  // decompressed ObjStm body) and then find which object that text belongs
  // to — see the file header for why this replaced a single greedy regex.
  let pagesRef: number | null = null;
  function findObjWithType(typeName: string): number | null {
    const directIdx = scan.search(new RegExp(`/Type\\s*/${typeName}\\b`));
    if (directIdx !== -1) {
      const n = objNumBefore(directIdx);
      if (n !== null) return n;
    }
    const typeRe = new RegExp(`/Type\\s*/${typeName}\\b`);
    for (const [num, text] of compressedObjects) {
      if (typeRe.test(text)) return num;
    }
    return null;
  }
  const catNum = findObjWithType('Catalog');
  if (catNum !== null) {
    const catObj = getObject(catNum);
    const pm = catObj ? /\/Pages\s+(\d+)\s+0\s+R/.exec(catObj.dict) : null;
    if (pm) pagesRef = parseInt(pm[1], 10);
  }
  if (pagesRef === null) {
    pagesRef = findObjWithType('Pages');
  }

  const leafPages: number[] = [];
  function walkPages(n: number, depth: number): void {
    if (depth > 12) { warnings.push('Pages tree exceeded depth 12, stopped walking'); return; }
    const obj = getObject(n);
    if (!obj) return;
    if (/\/Type\s*\/Page\b(?!s)/.test(obj.dict)) { leafPages.push(n); return; }
    const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict);
    if (!kidsMatch) return;
    for (const km of kidsMatch[1].matchAll(/(\d+)\s+0\s+R/g)) walkPages(parseInt(km[1], 10), depth + 1);
  }
  if (pagesRef !== null) walkPages(pagesRef, 0);
  else warnings.push('no /Type/Catalog or /Type/Pages object found');

  /** Parse a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks into
   *  a code -> Unicode-codepoint map. Shared between Type0's 2-byte CIDs and
   *  a simple font's 1-byte codes — the CMap text format is identical either
   *  way; only how the caller SLICES its hex string differs (see decodeRun). */
  async function parseToUnicodeCMap(cmapObjNum: number): Promise<Map<number, number>> {
    const cmapBytes = await decompressedStream(cmapObjNum);
    const cmapText = cmapBytes ? new TextDecoder('latin1').decode(cmapBytes) : '';
    const map = new Map<number, number>();
    for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        map.set(parseInt(pair[1], 16), parseInt(pair[2].slice(0, 4), 16));
      }
    }
    for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const triple of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(triple[1], 16), hi = parseInt(triple[2], 16), base = parseInt(triple[3].slice(0, 4), 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, base + (c - lo));
      }
    }
    return map;
  }

  async function fontDecoderFor(fontObjNum: number): Promise<FontDecoder> {
    const obj = getObject(fontObjNum);
    if (!obj) return { kind: 'winansi' };
    if (/\/Subtype\s*\/Type0\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (!tuMatch) {
        warnings.push(`Type0 font object ${fontObjNum} has no /ToUnicode; its text will show as U+FFFD`);
        return { kind: 'cid', map: new Map() };
      }
      const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
      return { kind: 'cid', map };
    }
    // Simple font. Every KRS sample used /WinAnsiEncoding, which decodes
    // directly as windows-1252 bytes below — unchanged. North Dakota's
    // Century Code PDFs (fleet #2743) use simple TrueType fonts that declare
    // NO /Encoding at all: their embedded subsets number glyphs 0, 1, 2... in
    // whatever order the subsetter emitted them, with no relationship to any
    // standard code page — reading code 0x01 as the WinAnsi byte 0x01 (a
    // control character) produces blank/garbled output, not a wrong letter.
    // Those fonts DO carry a /ToUnicode CMap (the same mechanism Type0 fonts
    // use above, just keyed by a 1-byte code instead of a 2-byte CID), which
    // is the only place the real character is recorded — use it whenever the
    // font isn't declared WinAnsi rather than guessing.
    if (!/\/Encoding\s*\/WinAnsiEncoding\b/.test(obj.dict)) {
      const tuMatch = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
      if (tuMatch) {
        const map = await parseToUnicodeCMap(parseInt(tuMatch[1], 10));
        if (map.size) return { kind: 'mapped1', map };
      }
      warnings.push(`font object ${fontObjNum} has a non-WinAnsi simple encoding and no usable /ToUnicode; decoded as WinAnsi anyway`);
    }
    return { kind: 'winansi' };
  }

  const TOKEN_RE =
    /\/(\S+)\s+[\d.]+\s+Tf|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^()])*)\)\s*Tj|1\s+0\s+0\s+1\s+[\d.-]+\s+([\d.-]+)\s+Tm/g;
  const TJ_PIECE_RE = /\(((?:\\.|[^()])*)\)|<([0-9A-Fa-f\s]*)>/g;

  function decodeRun(dec: FontDecoder, literal: string | undefined, hex: string | undefined): string {
    if (literal !== undefined) return unescapePdfLiteral(literal);
    const cleaned = (hex ?? '').replace(/\s+/g, '');
    let out = '';
    if (dec.kind === 'mapped1') {
      // 1-byte code per glyph (a simple font's code space), unlike Type0's
      // 2-byte CIDs below — see fontDecoderFor.
      for (let i = 0; i + 2 <= cleaned.length; i += 2) {
        const code = parseInt(cleaned.slice(i, i + 2), 16);
        out += String.fromCodePoint(dec.map.get(code) ?? 0xfffd);
      }
      return out;
    }
    for (let i = 0; i + 4 <= cleaned.length; i += 4) {
      const cid = parseInt(cleaned.slice(i, i + 4), 16);
      if (dec.kind === 'cid') out += String.fromCodePoint(dec.map.get(cid) ?? 0xfffd);
      else out += String.fromCharCode(cid & 0xff);
    }
    return out;
  }

  const pageTexts: string[] = [];
  for (const pn of leafPages) {
    const page = getObject(pn);
    if (!page) continue;

    let resourcesDict = page.dict;
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(page.dict);
    if (resRef) {
      const ro = getObject(parseInt(resRef[1], 10));
      if (ro) resourcesDict = ro.dict;
    }
    // /Font is usually inline in Resources, but North Dakota's Century Code
    // PDFs (fleet #2743) write it as an indirect reference ("/Font 18 0 R")
    // to a separate dict object — resolve that one hop before giving up.
    let fontDictBody: string | null = null;
    const inlineFontMatch = /\/Font\s*<<([^>]*)>>/.exec(resourcesDict);
    if (inlineFontMatch) {
      fontDictBody = inlineFontMatch[1];
    } else {
      const fontRefMatch = /\/Font\s+(\d+)\s+0\s+R/.exec(resourcesDict);
      if (fontRefMatch) {
        const fontObj = getObject(parseInt(fontRefMatch[1], 10));
        if (fontObj) fontDictBody = fontObj.dict;
      }
    }
    const fontMap = new Map<string, FontDecoder>();
    if (fontDictBody) {
      for (const fm of fontDictBody.matchAll(/\/(\S+?)\s+(\d+)\s+0\s+R/g)) {
        fontMap.set(fm[1], await fontDecoderFor(parseInt(fm[2], 10)));
      }
    }

    const contentsMatch = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(page.dict);
    const contentRefs = contentsMatch
      ? [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => parseInt(m[1], 10))
      : [];
    let raw = '';
    for (const cr of contentRefs) {
      const dec = await decompressedStream(cr);
      if (dec) raw += new TextDecoder('latin1').decode(dec) + '\n';
    }

    let out = '';
    let currentFont: string | null = null;
    let lastY: number | null = null;
    for (const m of raw.matchAll(TOKEN_RE)) {
      if (m[1] !== undefined) { currentFont = m[1]; continue; }
      if (m[5] !== undefined) {
        const y = parseFloat(m[5]);
        if (lastY !== null && Math.abs(y - lastY) > 1) out += '\n';
        lastY = y;
        continue;
      }
      const dec = (currentFont && fontMap.get(currentFont)) || { kind: 'winansi' as const };
      if (m[2] !== undefined) {
        for (const piece of m[2].matchAll(TJ_PIECE_RE)) out += decodeRun(dec, piece[1], piece[2]);
      } else if (m[3] !== undefined) {
        out += decodeRun(dec, undefined, m[3]);
      } else if (m[4] !== undefined) {
        out += decodeRun(dec, m[4], undefined);
      }
    }
    pageTexts.push(out.trim());
  }

  return { text: pageTexts.join('\n\n'), pages: leafPages.length, warnings };
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
 *   fda_adcom_materials — the evidence a panel is reviewing: the briefing
 *     documents, agenda, questions, slides, minutes and transcripts FDA posts on
 *     each meeting page (fda.gov, keyless), plus the voting-question text pulled
 *     out of the Questions PDF. Added fleet #2793.
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
      'Companies with disclosed PDUFA dates — the highest-signal binary biotech catalyst. Searches recent SEC EDGAR 8-K filings (keyless) for PDUFA target / goal / action dates and extracts the date and surrounding context. A PDUFA date is the FDA decision date for an NDA or BLA; it is a scheduled binary event that moves biotech stocks. Returns each disclosure with company, ticker, CIK, filing date, form, PDUFA date (ISO when the filing gives a specific day), pdufa_period when the filing discloses only a coarser grain such as "Q1 2027" or "March 2027", a short context snippet, the SEC filing URL, and accession number. A row may carry a period without a date — that is the filing being vague, not a lookup failure. Use for PDUFA date, PDUFA goal date, FDA decision date, upcoming FDA decisions, drug approval catalyst, NDA/BLA decision date, biotech binary event, catalyst by ticker. ALSO the REGULATORY-STATUS reading of the same data, which is what most callers actually ask: which drugs are currently UNDER FDA REVIEW, which medicines ENTERED FDA REVIEW or were ACCEPTED FOR REVIEW recently, new NDA/BLA SUBMISSIONS and FILINGS ACCEPTED by the FDA, drugs AWAITING FDA APPROVAL, what is in the FDA review queue. A company announces acceptance in an 8-K at the moment review begins, so filing_date is when the drug ENTERED review and pdufa_date is when the decision is due — bounding filing_date with since/until answers "what entered FDA review last week". Note this is REGULATORY review of a marketing application, not clinical trials: for drugs entering or moving through TRIALS use the clinicaltrials tools instead.',
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
  {
    name: 'fda_adcom_materials',
    description:
      'What evidence is an FDA advisory committee reviewing? For one FDA advisory committee (AdCom) meeting — picked by committee (ODAC, VRBPAC, CTGTAC, or any name fragment), by date, and/or by drug, sponsor or topic — returns the meeting page\'s posted materials: FDA and sponsor briefing documents, the agenda, questions to the committee, rosters, presentation slides, minutes and transcripts, each with a document type, party (FDA / sponsor / combined), file type and size, and URL. Also extracts the agenda text, the applications under review (NDA/BLA number, product, sponsor, proposed indication), the public docket number, the webcast link, and — when a Questions document is posted — the VOTING QUESTIONS text itself. Reads FDA\'s own advisory-committee calendar (fda.gov, keyless), which lists meetings from 2016 to the next scheduled one; when a meeting has nothing posted yet it says so with the meeting date and FDA\'s posting timeline instead of returning an empty list. Use for AdCom briefing document, FDA briefing book, advisory committee materials, ODAC questions, what is the panel voting on, sponsor briefing package, panel agenda, FDA presentation slides, AdCom transcript or minutes. Pair with fda_adcom_calendar (which meetings are coming) and pdufa_catalysts (the decision date that follows the panel).',
    inputSchema: {
      type: 'object',
      properties: {
        committee: {
          type: 'string',
          description: 'Committee acronym or name fragment, case-insensitive: "ODAC", "VRBPAC", "CTGTAC", "oncologic", "vaccines", "gene therap", "cardiovascular", "psychopharmacologic", "medical devices"... Omit to search every committee.',
        },
        date: {
          type: 'string',
          description: 'Meeting date filter: a day "2026-04-30", a month "2026-04", or a year "2026". Omit to pick the meeting nearest to today (upcoming or just past).',
        },
        query: {
          type: 'string',
          description: 'Drug, sponsor, application or topic to find the meeting by, e.g. "camizestrant", "AstraZeneca", "NDA 220359", "COVID-19 vaccine". Matched against meeting titles first, then against the agenda text of the nearest candidate meetings.',
        },
        limit: {
          type: ['number', 'string'],
          description: 'Number of meetings to return with their materials (1–3). Default 1 — the single best match.',
        },
        include_questions_text: {
          type: ['boolean', 'string'],
          description: 'When a "Questions" document is posted, fetch it and return the voting-question text (default true). Set false to skip the extra PDF fetch.',
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
      case 'fda_adcom_materials':
        return await fdaAdcomMaterials(args);
      default:
        return { error: `Unknown tool: ${name}`, retry_hint: 'Use one of: fda_adcom_calendar, pdufa_catalysts, fda_adcom_materials.' };
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

  // The Federal Register term search also matches the housekeeping notices a
  // committee generates — charter renewals, establishments, terminations,
  // membership calls. Those carry a date and look exactly like a meeting row while
  // being nothing anyone can trade or attend. Drop them before they reach a caller.
  notices = notices.filter((n) => !isAdministrativeNotice(String(n.title ?? '')));

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
  // Guard: "upcoming PDUFA dates in the next N days" causes the LLM to set
  // since/until into the future. Future 8-K filings don't exist — reset to
  // the default 120-day rolling window so the query still returns real data.
  let since = strArg(args.since) ?? isoDaysAgo(120);
  let until = strArg(args.until) ?? today;
  if (since > today) { since = isoDaysAgo(120); until = today; }
  else if (until > today) { until = today; }

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
  /** Set when the filing disclosed only a quarter/half/month ("Q1 2027") rather than a day. */
  pdufa_period: string | null;
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

  const filingDate: string | null = src.file_date ?? null;

  let pdufaDate: string | null = null;
  let pdufaPeriod: string | null = null;
  let context: string | null = null;
  if (cik && accession && primaryDoc) {
    const accNoDash = accession.replace(/-/g, '');
    const cikInt = String(parseInt(cik, 10));
    const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDash}/${primaryDoc}`;
    const html = await fetchText(url, SEC_UA);
    if (html) {
      const ext = extractPdufa(html);
      pdufaDate = ext.date;
      pdufaPeriod = ext.period;
      context = ext.context;
      // Backstop: an "action date" identical to the filing date is almost always the
      // document's own date stamp scraped out of page furniture, not a disclosure.
      // Drop it rather than hand back a date that reads authoritative and isn't.
      if (pdufaDate && filingDate && pdufaDate === filingDate) pdufaDate = null;
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
    filing_date: filingDate,
    form: src.form_type ?? '8-K',
    pdufa_date: pdufaDate,
    pdufa_period: pdufaPeriod,
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

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

/**
 * Pull the PDUFA action date out of a filing.
 *
 * Two things this deliberately does NOT do, both learned from real filings:
 *
 * 1. It will not scan far past the word PDUFA looking for a date. Issuers often
 *    disclose a QUARTER ("PDUFA DATE Q1 2027") on a slide whose footer carries the
 *    filing date; a wide window skips the quarter, walks into the page furniture and
 *    returns the filing date as if it were the action date — confidently wrong, which
 *    is worse than empty. 60 chars comfortably covers the real phrasings
 *    ("PDUFA target action date of January 29, 2027").
 * 2. It does not force a quarter into a fake day. A quarter comes back as `period`
 *    with `date` left null, so a caller can see the grain it was actually given.
 */
function extractPdufa(html: string): { date: string | null; period: string | null; context: string | null } {
  const text = stripHtml(html);

  const exact = text.match(new RegExp(`PDUFA[^.]{0,60}?\\b(${MONTH}\\s+\\d{1,2},?\\s+\\d{4})`, 'i'));
  if (exact) {
    return {
      date: parseLooseDate(exact[1]),
      period: null,
      context: exact[0].replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  }

  // No day-level date near PDUFA — accept a quarter/half/month-year as a coarser grain.
  const coarse = text.match(
    new RegExp(
      `PDUFA[^.]{0,60}?\\b(Q[1-4]\\s*(?:of\\s+)?\\d{4}` +
        `|(?:first|second|third|fourth)\\s+quarter\\s+(?:of\\s+)?\\d{4}` +
        `|(?:first|second)\\s+half\\s+(?:of\\s+)?\\d{4}` +
        `|${MONTH}\\s+\\d{4})`,
      'i',
    ),
  );
  if (coarse) {
    return {
      date: null,
      period: coarse[1].replace(/\s+/g, ' ').trim(),
      context: coarse[0].replace(/\s+/g, ' ').trim().slice(0, 160),
    };
  }

  return { date: null, period: null, context: null };
}

/**
 * True for Federal Register notices that are committee administration rather than a
 * scheduled meeting: charter renewals, establishments, terminations, and calls for
 * nominations. They match the same search term and parse to a date, so without this
 * they surface alongside genuine panel reviews and read as catalysts.
 */
function isAdministrativeNotice(title: string): boolean {
  // A real meeting notice wins over any administrative suffix — e.g.
  // "…; Notice of Meeting; Establishment of a Public Docket" is a meeting that also
  // opens a docket, not a committee establishment.
  if (/\bnotice of meeting\b|\bmeeting notice\b/i.test(title)) return false;

  return /;\s*(renewal|establishment|termination|amendment|re-?charter)\b/i.test(title)
    || /\b(request|call) for nominations\b/i.test(title)
    || /\bnotice of (renewal|termination|establishment)\b/i.test(title);
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
/* Tool 3: fda_adcom_materials                                         */
/* ------------------------------------------------------------------ */

// fda.gov's advisory-committee calendar page is a Drupal DataTable fed by this
// JSON route (found in the page's own bundle: ajax.url for
// `.lcds-datatable--advisory-committee-calendar`). One row per meeting, 2016 to
// the furthest scheduled meeting, ~130 KB. Edge-probed 2026-10-07 (fleet
// #2793): the JSON, the meeting pages and the /media/<id>/download PDFs all
// answered 200 from a throwaway Worker on the prod account with this UA, so no
// relay is needed. The Orange Book refusal recorded in mcps/fda-drug-competition
// is specific to the BULK asset route, and was re-checked here: a 126 KB
// questions PDF on the same /media/ route served 200 from the edge.
const ADCOM_CAL_URL = 'https://www.fda.gov/datatables-json/advisory-committee-calendar-json';
const FDA_SITE = 'https://www.fda.gov';
const FDA_UA = 'pipeworx-mcp-regulatory-catalysts/1.0 (+https://pipeworx.io)';
// The calendar changes a few times a month; one colo-level copy per hour.
const ADCOM_CAL_TTL_SEC = 3600;
// A questions document is a 1–3 page PDF (126 KB measured). Anything past this
// is not a questions document and is not worth the CPU to inflate.
const QUESTIONS_PDF_MAX_BYTES = 3_000_000;
const QUESTIONS_TEXT_MAX_CHARS = 6000;
// How many candidate meeting pages to open when `query` misses every title and
// has to be matched against the agenda text instead.
const AGENDA_PROBE_LIMIT = 20;

// Acronyms callers actually use, mapped to the fragment that appears in the
// calendar's meeting titles. Anything not listed is matched as a plain
// substring, so an unlisted acronym simply finds nothing rather than something
// wrong.
const COMMITTEE_ALIASES: Record<string, string> = {
  odac: 'oncologic drugs',
  vrbpac: 'vaccines and related biological products',
  ctgtac: 'cellular, tissue, and gene therapies',
  pcac: 'pharmacy compounding',
  dodac: 'dermatologic and ophthalmic',
  emdac: 'endocrinologic and metabolic',
  padac: 'psychopharmacologic',
  aadpac: 'anesthetic and analgesic',
  gidac: 'gastrointestinal drugs',
  crdac: 'cardiovascular and renal',
  amdac: 'antimicrobial drugs',
  ndac: 'nonprescription drugs',
  pcns: 'peripheral and central nervous system',
  pcnsdac: 'peripheral and central nervous system',
  dsarm: 'drug safety and risk management',
  midac: 'medical imaging',
  bpac: 'blood products',
  pac: 'pediatric advisory',
  adac: 'arthritis',
  ptac: 'pulmonary-allergy',
  bramdac: 'bone, reproductive and urologic',
  tpsac: 'tobacco products',
  rcac: 'risk communication',
  mdac: 'medical devices',
};

interface AdcomCalRow {
  title: string;
  url: string | null;
  meeting_date: string | null;
  meeting_end_date: string | null;
  start_text: string | null;
  center: string | null;
  page_changed: string | null;
}

interface AdcomMaterial {
  title: string;
  document_type: string;
  party: 'fda' | 'sponsor' | 'combined' | null;
  file: string | null;
  source_organization: string | null;
  media_id: string | null;
  url: string;
}

async function fdaAdcomMaterials(args: Record<string, unknown>): Promise<unknown> {
  const committee = strArg(args.committee);
  const date = strArg(args.date);
  const query = strArg(args.query);
  const limit = clampInt(args.limit, 1, 1, 3);
  const includeQuestions = boolArg(args.include_questions_text, true);
  const today = todayISO();

  const rows = await loadAdcomCalendar();
  const dated = rows.filter((r) => r.meeting_date);
  const calendarRange = {
    earliest: dated.reduce<string | null>((m, r) => (m === null || r.meeting_date! < m ? r.meeting_date : m), null),
    latest: dated.reduce<string | null>((m, r) => (m === null || r.meeting_date! > m ? r.meeting_date : m), null),
  };

  let cands = dated;
  const filters: Record<string, string> = {};
  if (committee) {
    const needle = resolveCommittee(committee);
    filters.committee = committee;
    cands = cands.filter((r) => r.title.toLowerCase().includes(needle));
  }
  if (date) {
    const prefix = normalizeDateFilter(date);
    if (!prefix) {
      return {
        error: `date must be YYYY-MM-DD, YYYY-MM or YYYY (got "${date}")`,
        retry_hint: 'Pass date as "2026-04-30", "2026-04" or "2026", or omit it to pick the meeting nearest to today.',
      };
    }
    filters.date = prefix;
    cands = cands.filter((r) => r.meeting_date!.startsWith(prefix) || (r.meeting_end_date ?? '').startsWith(prefix));
  }
  // Nearest to today first: the upcoming panel and the one that just sat are
  // what "what is the committee reviewing" means; 2016 is the far end.
  const todayMs = Date.parse(today);
  cands.sort((a, b) => Math.abs(Date.parse(a.meeting_date!) - todayMs) - Math.abs(Date.parse(b.meeting_date!) - todayMs));

  const pageCache = new Map<string, string>();
  let matchedBy: 'calendar' | 'title' | 'federal_register' | 'agenda' = 'calendar';
  if (query) {
    filters.query = query;
    const q = query.toLowerCase();
    const titleHits = cands.filter((r) => r.title.toLowerCase().includes(q));
    if (titleHits.length) {
      cands = titleHits;
      matchedBy = 'title';
    } else {
      // Meeting titles name the committee, never the drug. The Federal Register
      // notice that announced the meeting does name it ("...will discuss NDA
      // 220359, camizestrant..."), and this pack already reads those notices:
      // one full-text search plus up to three notice bodies gives the meeting
      // date(s), which select the calendar row. Best-effort — a FR outage must
      // not sink a lookup the agenda probe below can still answer.
      let frDates: string[] = [];
      try {
        frDates = await frMeetingDatesFor(query);
      } catch {
        frDates = [];
      }
      const frHits = frDates.length ? cands.filter((r) => frDates.includes(r.meeting_date!)) : [];
      if (frHits.length) {
        cands = frHits;
        matchedBy = 'federal_register';
      } else {
        // Last resort: open the nearest candidate pages and read their agendas.
        // Bounded, and the pages are reused below.
        const probe = cands.filter((r) => r.url).slice(0, AGENDA_PROBE_LIMIT);
        const pages = await Promise.all(probe.map((r) => fetchMeetingPage(r.url!)));
        probe.forEach((r, i) => pageCache.set(r.url!, pages[i]));
        cands = probe.filter((_, i) => stripHtml(pages[i]).toLowerCase().includes(q));
        matchedBy = 'agenda';
      }
    }
  }

  const source = 'FDA Advisory Committee Calendar (fda.gov) — meeting pages and Event Materials';
  if (!cands.length) {
    return {
      source,
      source_url: `${FDA_SITE}/advisory-committees/advisory-committee-calendar`,
      as_of: today,
      data_as_of: today,
      ...(Object.keys(filters).length ? { filters } : {}),
      found: false,
      meetings_in_calendar: rows.length,
      calendar_date_range: calendarRange,
      note: query && matchedBy === 'agenda'
        ? `No meeting title matches "${query}", and the agendas of the ${AGENDA_PROBE_LIMIT} nearest ${committee ? `${committee} ` : ''}meetings do not mention it. Narrow with committee/date, or the review may not have had a panel.`
        : `No meeting in FDA's advisory-committee calendar matches these filters. The calendar lists ${rows.length} meetings from ${calendarRange.earliest} to ${calendarRange.latest}.`,
    };
  }

  const picked = cands.slice(0, limit);
  const meetings = await Promise.all(picked.map((r) => shapeAdcomMeeting(r, pageCache, includeQuestions)));
  return {
    source,
    source_url: `${FDA_SITE}/advisory-committees/advisory-committee-calendar`,
    as_of: today,
    data_as_of: today,
    ...(Object.keys(filters).length ? { filters } : {}),
    found: true,
    matched_by: matchedBy,
    candidates: cands.length,
    count: meetings.length,
    meetings,
  };
}

async function shapeAdcomMeeting(row: AdcomCalRow, pageCache: Map<string, string>, includeQuestions: boolean): Promise<unknown> {
  const html = row.url ? (pageCache.get(row.url) ?? (await fetchMeetingPage(row.url))) : '';
  const text = stripHtml(html);

  const timeRaw = html.match(/<dt[^>]*>\s*Time:\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1];
  const pageUpdated = html.match(/node-current-date[\s\S]*?<time datetime="([^"]+)"/)?.[1] ?? null;
  const agenda = extractHtmlSection(html, 'Agenda');
  const materialsNote = extractHtmlSection(html, 'Meeting Materials');
  const docket = text.match(/\b(FDA-\d{4}-N-\d{3,6})\b/)?.[1] ?? null;
  const webcast = html.match(/href="(https?:\/\/(?:www\.)?youtube\.com\/[^"]+)"/)?.[1] ?? null;
  const applications = parseApplications(agenda ?? text);

  const materials = parseEventMaterials(html, row.url ?? '');
  const base = {
    title: row.title,
    committee: committeeFromTitle(row.title),
    center: row.center,
    meeting_date: row.meeting_date,
    ...(row.meeting_end_date && row.meeting_end_date !== row.meeting_date ? { meeting_end_date: row.meeting_end_date } : {}),
    time: timeRaw ? stripHtml(timeRaw).replace(/\s+-\s+/, ' - ') : row.start_text,
    url: row.url,
    page_updated: pageUpdated ?? row.page_changed,
    ...(docket ? { docket, docket_url: `https://www.regulations.gov/docket/${docket}` } : {}),
    ...(webcast ? { webcast_url: webcast } : {}),
    ...(agenda ? { agenda: agenda.slice(0, 1500) } : {}),
    ...(applications.length ? { applications } : {}),
  };

  if (!materials || materials.length === 0) {
    // Nothing posted yet. Say so with the date rather than handing back [] —
    // FDA posts background material about two business days before the panel.
    return {
      ...base,
      materials_status: 'none_posted',
      materials_count: 0,
      materials_note: materialsNote
        ? materialsNote.slice(0, 400)
        : `No Event Materials are posted on this meeting page as of the fetch. FDA normally posts background material no later than two business days before the meeting (meeting date ${row.meeting_date}).`,
    };
  }

  const counts: Record<string, number> = {};
  for (const m of materials) counts[m.document_type] = (counts[m.document_type] ?? 0) + 1;

  let votingQuestions: unknown = null;
  const qDoc = materials.find((m) => m.document_type === 'questions');
  if (qDoc) {
    votingQuestions = includeQuestions ? await extractQuestionsText(qDoc) : { source_url: qDoc.url, text: null, note: 'include_questions_text=false — not fetched' };
  }

  return {
    ...base,
    materials_status: 'posted',
    // FDA publishes no per-document posting date; the page's own "content
    // current as of" stamp is the closest honest answer.
    materials_as_of: pageUpdated ?? row.page_changed,
    materials_count: materials.length,
    materials_by_type: counts,
    materials,
    voting_questions: votingQuestions,
    ...(materialsNote ? { materials_note: materialsNote.slice(0, 300) } : {}),
  };
}

// Meeting dates of the FDA advisory-committee NOTICES whose full text mentions
// `query` — the drug, sponsor or application a caller is asking about.
async function frMeetingDatesFor(query: string): Promise<string[]> {
  const params = new URLSearchParams();
  params.append('conditions[agencies][]', 'food-and-drug-administration');
  params.append('conditions[term]', `"${query.replace(/"/g, '')}" "advisory committee"`);
  params.append('conditions[type][]', 'NOTICE');
  params.append('order', 'newest');
  params.append('per_page', '6');
  for (const f of ['title', 'raw_text_url']) params.append('fields[]', f);
  const data = (await frGet(params)) as { results?: Array<{ title?: string; raw_text_url?: string }> };
  const notices = (data.results ?? [])
    .filter((n) => /advisory committee|panel/i.test(String(n.title ?? '')) && !isAdministrativeNotice(String(n.title ?? '')))
    .slice(0, 3);
  const dates = await Promise.all(
    notices.map(async (n) => {
      if (!n.raw_text_url) return null;
      const body = await fetchText(String(n.raw_text_url));
      const text = body ? extractMeetingDate(body) : null;
      return text ? parseLooseDate(text) : null;
    }),
  );
  return [...new Set(dates.filter((d): d is string => d !== null))];
}

async function loadAdcomCalendar(): Promise<AdcomCalRow[]> {
  const init: RequestInit & { cf?: Record<string, unknown> } = {
    headers: { Accept: 'application/json', 'User-Agent': FDA_UA },
    cf: { cacheTtl: ADCOM_CAL_TTL_SEC, cacheEverything: true },
  };
  const res = await fetchWithTimeout(ADCOM_CAL_URL, init);
  if (!res.ok) {
    const body = await safeBody(res);
    throw new Error(`FDA advisory-committee calendar (fda.gov): HTTP ${res.status} ${body}`.trim());
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new Error(`FDA advisory-committee calendar (fda.gov): HTTP ${res.status} but the body is not JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`FDA advisory-committee calendar (fda.gov): HTTP ${res.status} but the JSON is ${Array.isArray(raw) ? 'an empty list' : 'not a list'} — the route's shape changed`);
  }
  const rows = raw.map(shapeAdcomCalRow);
  if (!rows.some((r) => r.url && r.meeting_date)) {
    throw new Error(`FDA advisory-committee calendar (fda.gov): ${raw.length} rows but none carries a meeting link and date — the row shape changed`);
  }
  return rows;
}

function shapeAdcomCalRow(r: any): AdcomCalRow {
  const titleHtml = String(r?.title ?? '');
  const href = titleHtml.match(/href="([^"]+)"/)?.[1] ?? null;
  const startText = String(r?.field_start_date ?? '').trim() || null;
  return {
    title: stripHtml(titleHtml),
    url: href ? (href.startsWith('http') ? href : `${FDA_SITE}${href}`) : null,
    meeting_date: usDateToIso(startText),
    meeting_end_date: usDateToIso(String(r?.field_end_date ?? '').trim() || null),
    start_text: startText,
    center: String(r?.field_center ?? '').trim() || null,
    page_changed: String(r?.changed ?? '').match(/datetime="([^"]+)"/)?.[1] ?? null,
  };
}

// "04/30/2026 08:00 AM EDT" -> "2026-04-30"
function usDateToIso(s: string | null): string | null {
  const m = s?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function normalizeDateFilter(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t)) return t;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${pad2(parseInt(us[1], 10))}-${pad2(parseInt(us[2], 10))}`;
  const loose = parseLooseDate(t);
  return loose;
}

function resolveCommittee(s: string): string {
  const key = s.trim().toLowerCase().replace(/[^a-z]/g, '');
  return COMMITTEE_ALIASES[key] ?? s.trim().toLowerCase();
}

// "April 30, 2026: Meeting of the Oncologic Drugs Advisory Committee Meeting
// Announcement - 04/30/2026" -> "Oncologic Drugs Advisory Committee"
function committeeFromTitle(title: string): string {
  let t = title
    .replace(/^(postponed|cancelled|canceled|rescheduled|updated)[:\s-]*/i, '')
    .replace(/^[A-Z][a-z]+\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?,?\s+\d{4}:?\s*/, '')
    .replace(/\s*-\s*\d{2}\/\d{2}\/\d{4}\s*$/, '')
    .replace(/\bmeeting announcement\b.*$/i, '')
    .replace(/^meeting of the\s+/i, '')
    .replace(/\b[A-Z][a-z]+\.?\s+\d{1,2}(?:\s*[-–]\s*\d{1,2})?,?\s+\d{4}\b/g, '')
    .replace(/\s*\(updated\)\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s:,-]+$/, '');
  return t || title;
}

async function fetchMeetingPage(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'text/html', 'User-Agent': FDA_UA } });
  if (!res.ok) {
    const body = await safeBody(res);
    throw new Error(`FDA advisory-committee meeting page (${url}): HTTP ${res.status} ${body}`.trim());
  }
  const html = await res.text();
  // fda.gov serves its "FDA Internet Site Error" apology page with a 2xx/5xx
  // mix, and Akamai bot management answers a refusal with a generic page too.
  // A page without the meeting template is a refusal or a redesign, not a meeting.
  if (!/id="event-information"|lcds-description-list--event|advisory-committee-calendar/i.test(html)) {
    throw new Error(`FDA advisory-committee meeting page (${url}): HTTP ${res.status} but the body is not a meeting page — ${summarizeErrorBody(html) || `${html.length} chars of something else`}`);
  }
  return html;
}

// Returns null when the page has no Event Materials section at all (nothing
// posted yet), the parsed rows otherwise. A section that exists but yields no
// rows while plainly containing download links is a parse failure and throws.
function parseEventMaterials(html: string, pageUrl: string): AdcomMaterial[] | null {
  const start = html.search(/id="event-materials"/);
  if (start < 0) return null;
  const endRel = html.slice(start).search(/<\/table>/i);
  const section = endRel < 0 ? html.slice(start) : html.slice(start, start + endRel);
  const out: AdcomMaterial[] = [];
  const rowRe = /<tr>\s*<td>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(section))) {
    const href = m[1];
    const title = stripHtml(m[2]);
    const file = stripHtml(m[3]).replace(/\s+/g, ' ').trim() || null;
    const org = stripHtml(m[4]).trim() || null;
    const url = href.startsWith('http') ? href : `${FDA_SITE}${href}`;
    const { document_type, party } = classifyMaterial(title);
    out.push({ title, document_type, party, file, source_organization: org, media_id: href.match(/\/media\/(\d+)\//)?.[1] ?? null, url });
  }
  if (out.length === 0 && /\/media\/\d+\/download/.test(section)) {
    throw new Error(`FDA advisory-committee meeting page (${pageUrl}): the Event Materials table has download links but none parsed — the table shape changed`);
  }
  return out;
}

function classifyMaterial(title: string): { document_type: string; party: 'fda' | 'sponsor' | 'combined' | null } {
  const t = title.toLowerCase();
  const party: 'fda' | 'sponsor' | 'combined' | null = /\bcombined\b/.test(t)
    ? 'combined'
    : /\bfda\b|\bcder\b|\bcber\b|\bcdrh\b|\bagency\b/.test(t)
      ? 'fda'
      : /\bsponsor\b|\bapplicant\b|\bindustry\b/.test(t)
        ? 'sponsor'
        : null;
  if (/transcript/.test(t)) return { document_type: 'transcript', party: null };
  if (/minutes/.test(t)) return { document_type: 'minutes', party: null };
  if (/roster/.test(t)) return { document_type: 'roster', party: null };
  if (/agenda/.test(t)) return { document_type: 'agenda', party: null };
  if (/question/.test(t)) return { document_type: 'questions', party: null };
  if (/webcast|broadcast|youtube/.test(t)) return { document_type: 'webcast_information', party: null };
  if (/federal register|\bnotice\b/.test(t)) return { document_type: 'federal_register_notice', party: null };
  // `party` is only ever set from a signal in the title (FDA / combined /
  // sponsor / applicant). An un-labelled briefing document or slide deck is
  // null, not guessed: CDC, academic and patient-group presentations sit on the
  // same pages, and a wrong "sponsor" reads as a fact.
  if (/briefing|background (material|package|document)|backgrounder/.test(t)) return { document_type: 'briefing_document', party };
  if (/presentation|slides|\bslide\b/.test(t)) return { document_type: 'presentations', party };
  if (/summary/.test(t)) return { document_type: 'summary', party: null };
  if (/public comment|docket/.test(t)) return { document_type: 'public_comments', party: null };
  return { document_type: 'other', party };
}

// Text of the <h2>Heading</h2> ... block up to the next <h2>, as plain text.
function extractHtmlSection(html: string, heading: string): string | null {
  const re = new RegExp(`<h2[^>]*>\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</h2>([\\s\\S]*?)(?=<h2[^>]*>|<div class="inset-column" id="event-materials"|$)`, 'i');
  const m = html.match(re);
  if (!m) return null;
  const t = stripHtml(m[1]);
  return t || null;
}

interface AdcomApplication {
  application: string;
  product: string;
  sponsor: string;
  proposed_indication: string | null;
}

// "the Committee will discuss new drug application (NDA) 220359, for
// camizestrant tablets, submitted by AstraZeneca Pharmaceuticals LP. The
// proposed indication (use) is ..." — the agenda's own phrasing, one application
// per sentence. Anything that does not match this shape is simply absent; the
// agenda text is returned alongside so nothing is lost.
function parseApplications(text: string): AdcomApplication[] {
  const out: AdcomApplication[] = [];
  const re = /(supplemental\s+)?(?:new drug application|biologics license application|abbreviated new drug application|biologic license application)s?\s*\(\s*(s?NDAs?|s?BLAs?|ANDAs?)\s*\)\s*(\d{5,6}(?:\s*\/\s*S-?\d+)?)\s*,?\s*(?:for|of)\s+([^,.]{3,160}?),\s*(?:submitted|sponsored|held)\s+by\s+([^.]{2,160}?)\./gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = m[2].toUpperCase().replace(/S$/, '');
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 700);
    const ind = tail.match(/proposed indication[^.]{0,40}?\bis\b\s+([^.]+(?:\.[^A-Z][^.]*)*)\./i)?.[1] ?? null;
    out.push({
      application: `${m[1] ? 's' : ''}${kind.replace(/^S/, '')} ${m[3].replace(/\s+/g, '')}`.replace(/^sS/, 's'),
      product: m[4].trim(),
      sponsor: m[5].trim(),
      proposed_indication: ind ? ind.replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    });
  }
  return out;
}

async function extractQuestionsText(doc: AdcomMaterial): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(doc.url, { headers: { 'User-Agent': FDA_UA } });
  } catch (e) {
    return { source_url: doc.url, text: null, extraction_error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    return { source_url: doc.url, text: null, extraction_error: `HTTP ${res.status} fetching the questions document` };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > QUESTIONS_PDF_MAX_BYTES) {
    return { source_url: doc.url, text: null, extraction_error: `questions document is ${buf.byteLength} bytes, above the ${QUESTIONS_PDF_MAX_BYTES}-byte extraction cap` };
  }
  if (!/^%PDF/.test(new TextDecoder('latin1').decode(new Uint8Array(buf.slice(0, 5))))) {
    return { source_url: doc.url, text: null, extraction_error: `questions document is not a PDF (content-type ${res.headers.get('content-type') ?? 'unknown'})` };
  }
  try {
    const ext = await extractPdfText(buf);
    // \u0095 is the Windows-1252 bullet FDA's Word exports leave in the text layer.
    const text = ext.text.replace(/\u0095/g, ' • ').replace(/\s+/g, ' ').trim();
    if (!text) {
      return { source_url: doc.url, text: null, pages: ext.pages, extraction_error: `no text layer could be read from the PDF${ext.warnings.length ? ` (${ext.warnings.slice(0, 3).join('; ')})` : ''}` };
    }
    const questions = splitQuestions(text);
    return {
      source_url: doc.url,
      pages: ext.pages,
      text: text.slice(0, QUESTIONS_TEXT_MAX_CHARS),
      ...(text.length > QUESTIONS_TEXT_MAX_CHARS ? { truncated: true } : {}),
      ...(questions.length ? { questions } : {}),
      ...(ext.warnings.length ? { extraction_warnings: ext.warnings.slice(0, 5) } : {}),
    };
  } catch (e) {
    return { source_url: doc.url, text: null, extraction_error: `PDF text extraction failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Split a questions document into its numbered items, flagging the VOTE ones.
// Session headings ("Morning session") become the `session` of what follows.
function splitQuestions(text: string): Array<{ number: number; vote: boolean; session: string | null; text: string }> {
  const out: Array<{ number: number; vote: boolean; session: string | null; text: string }> = [];
  // "1. VOTE: ..." normally; "1.For the composition..." when the PDF's text
  // layer drops the space (VRBPAC 2026-10-01 measured). Both are question starts.
  const parts = text.split(/(?=(?:^|\s)(?:Morning|Afternoon|Day \d|Session \d)[^.]{0,20}session\b|(?=(?:\s|^|[a-z])\d{1,2}\.\s*(?:VOTE|DISCUSSION|Vote|Discussion|[A-Z])))/);
  let session: string | null = null;
  for (const p of parts) {
    const s = p.trim();
    const sess = s.match(/^((?:Morning|Afternoon|Day \d|Session \d)[^.]{0,20}session)\b/i);
    if (sess) {
      session = sess[1];
      const rest = s.slice(sess[0].length).trim();
      if (!rest) continue;
      pushQuestion(rest);
      continue;
    }
    pushQuestion(s);
  }
  function pushQuestion(s: string) {
    const m = s.match(/^[a-z]?(\d{1,2})\.\s*([\s\S]+)$/);
    if (!m) return;
    // "1. VOTE: ..." (CDER) or "...Vote: \"Yes\", \"No\", or \"Abstain\"" (CBER) — the
    // word appears at either end, so the whole item is read.
    out.push({ number: parseInt(m[1], 10), vote: /\bvote\b/i.test(m[2]), session, text: m[2].trim() });
  }
  return out;
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
