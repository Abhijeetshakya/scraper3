import { gotScraping } from 'got-scraping';
import { log } from 'crawlee';
import { VOYAGER_BASE, VOYAGER_HEADERS, DEFAULT_USER_AGENT, BLOCKED_STATUS_CODES, DEFAULTS } from './constants.js';
import { makeCsrfPair, jitteredSleep, isChallengePage } from './utils.js';

/**
 * Raised when LinkedIn blocks, challenges, or rate-limits an authenticated
 * call. Distinguished from a parse failure because the two demand opposite
 * responses: a block means stop and back off, a parse failure means carry on
 * with the next company.
 */
export class VoyagerBlockedError extends Error {
    constructor(message, statusCode = null) {
        super(message);
        this.name = 'VoyagerBlockedError';
        this.statusCode = statusCode;
    }
}

/**
 * Raised when the run's own authenticated request budget is spent.
 *
 * Deliberately not a VoyagerBlockedError: both stop authenticated work, but
 * they mean opposite things to whoever reads the row. One says LinkedIn pushed
 * back, the other says you hit a cap you set yourself.
 */
export class VoyagerBudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = 'VoyagerBudgetError';
    }
}

/**
 * Walk a decoded JSON payload for the first value at any of `keys`.
 *
 * Voyager's response envelope is not stable: the same logical field arrives
 * under `data.paging.total`, `data.data.searchDashClustersByAll.paging.total`,
 * or inside `included[]`, depending on the decoration ID, the endpoint
 * generation, and whether the normalized+json accept header was honoured.
 * Pinning a literal path means a silent null the next time LinkedIn reshuffles
 * the envelope; searching for the key finds it wherever it moved to.
 *
 * @param {unknown} payload
 * @param {string[]} keys
 * @param {number} [maxDepth]
 * @returns {unknown}
 */
export function findDeep(payload, keys, maxDepth = 8) {
    const wanted = new Set(keys);
    const queue = [{ node: payload, depth: 0 }];

    while (queue.length > 0) {
        const { node, depth } = queue.shift();
        if (!node || typeof node !== 'object' || depth > maxDepth) continue;

        if (!Array.isArray(node)) {
            for (const key of wanted) {
                if (node[key] !== undefined && node[key] !== null) return node[key];
            }
        }
        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') queue.push({ node: value, depth: depth + 1 });
        }
    }
    return undefined;
}

/**
 * Pull a result count out of a search response.
 *
 * `totalResultCount` is preferred over `paging.total` where both exist: paging
 * totals are capped at the page window on some endpoints, so reading them gives
 * a number that looks plausible and is wrong.
 *
 * @param {unknown} payload
 * @returns {number|null}
 */
export function extractTotal(payload) {
    const direct = findDeep(payload, ['totalResultCount']);
    if (Number.isFinite(direct)) return Number(direct);
    const paging = findDeep(payload, ['paging']);
    if (paging && Number.isFinite(paging.total)) return Number(paging.total);
    const total = findDeep(payload, ['total']);
    return Number.isFinite(total) ? Number(total) : null;
}

/**
 * Pull `urn:li:geo:<id>` out of a typeahead hit.
 *
 * @param {unknown} hit
 * @returns {string|null}
 */
function extractGeoId(hit) {
    const serialized = JSON.stringify(hit ?? '');
    const match = serialized.match(/urn:li:geo:(\d+)/);
    return match ? match[1] : null;
}

/**
 * Read the display text off a typeahead hit, whose shape varies by endpoint
 * generation ({text: {text}} vs a bare string vs {title: {text}}).
 *
 * @param {unknown} hit
 * @returns {string}
 */
function extractHitText(hit) {
    const text = hit?.text?.text ?? hit?.text ?? hit?.title?.text ?? hit?.title ?? '';
    return typeof text === 'string' ? text : '';
}

/**
 * Authenticated LinkedIn client for the fields the public page will not give up.
 *
 * Three constraints shape this class, all of them account-safety rather than
 * performance:
 *
 *  1. Requests are strictly serialised. Concurrency against Voyager with one
 *     session is the fastest way to get an account restricted.
 *  2. One proxy session for the client's whole lifetime. Rotating IPs inside a
 *     single authenticated session is a stronger anomaly signal than any single
 *     request could be - a member does not teleport between countries mid-session.
 *  3. A jittered delay between every request, and a hard request budget, so a
 *     large input list cannot quietly spend an account's whole day of goodwill.
 */
export class VoyagerClient {
    /**
     * @param {object} options
     * @param {string} options.sessionCookie - The li_at value
     * @param {string|null} [options.proxyUrl] - Sticky for this client's lifetime
     * @param {number} [options.delaySeconds]
     * @param {number|null} [options.maxRequests] - Request budget; null = unlimited
     */
    constructor({ sessionCookie, proxyUrl = null, delaySeconds = DEFAULTS.REQUEST_DELAY_SECONDS, maxRequests = null }) {
        const { token, cookie } = makeCsrfPair();
        this.csrfToken = token;
        this.cookieHeader = `li_at=${sessionCookie}; ${cookie}`;
        this.proxyUrl = proxyUrl;
        this.delaySeconds = delaySeconds;
        this.maxRequests = maxRequests;

        this.requestsMade = 0;
        this.blockedCount = 0;
        this.geoCache = new Map();
        /** Serialises every call through one promise chain. */
        this.queue = Promise.resolve();
    }

    /** Whether the per-run authenticated request budget is spent. */
    get budgetExhausted() {
        return this.maxRequests !== null && this.requestsMade >= this.maxRequests;
    }

    /**
     * Issue one Voyager GET, serialised behind every earlier call and preceded
     * by the inter-request delay.
     *
     * @param {string} path - Path relative to /voyager/api, query string included
     * @param {object} [opts]
     * @returns {Promise<object|null>} Decoded JSON, or null on a non-blocking failure
     */
    async request(path, { retries = DEFAULTS.VOYAGER_MAX_RETRIES } = {}) {
        const run = async () => {
            if (this.budgetExhausted) {
                throw new VoyagerBudgetError(`Authenticated request budget (${this.maxRequests}) exhausted.`);
            }
            await jitteredSleep(this.delaySeconds);
            return this.#send(path, retries);
        };
        // Chain onto the queue regardless of whether the previous call threw,
        // otherwise one blocked request poisons every later one.
        const result = this.queue.then(run, run);
        this.queue = result.catch(() => {});
        return result;
    }

    /**
     * @param {string} path
     * @param {number} retriesLeft
     * @returns {Promise<object|null>}
     */
    async #send(path, retriesLeft) {
        this.requestsMade++;
        let response;
        try {
            response = await gotScraping({
                url: `${VOYAGER_BASE}/${path.replace(/^\//, '')}`,
                proxyUrl: this.proxyUrl ?? undefined,
                timeout: { request: DEFAULTS.VOYAGER_TIMEOUT_MS },
                throwHttpErrors: false,
                retry: { limit: 0 }, // Retries are handled here, with backoff we control.
                responseType: 'text',
                headers: {
                    ...VOYAGER_HEADERS,
                    'cookie': this.cookieHeader,
                    'csrf-token': this.csrfToken,
                    'user-agent': DEFAULT_USER_AGENT,
                    'referer': 'https://www.linkedin.com/',
                },
            });
        } catch (error) {
            if (retriesLeft > 0) {
                await jitteredSleep(this.delaySeconds * 2);
                return this.#send(path, retriesLeft - 1);
            }
            log.warning(`Voyager request failed: ${error.message}`);
            return null;
        }

        const { statusCode, body } = response;

        if (BLOCKED_STATUS_CODES.includes(statusCode) || isChallengePage(body)) {
            this.blockedCount++;
            throw new VoyagerBlockedError(
                `LinkedIn rejected an authenticated request (status ${statusCode}). `
                + 'The session cookie is expired, invalid, or the account is rate-limited.',
                statusCode,
            );
        }

        if (statusCode >= 500 && retriesLeft > 0) {
            // Full jitter, not fixed exponential. Deterministic backoff makes
            // serialised retries land in lockstep with every other worker's,
            // bursting a host that is already pushing back.
            const ceiling = Math.min(
                DEFAULTS.RETRY_BACKOFF_BASE_MS * (2 ** (DEFAULTS.VOYAGER_MAX_RETRIES - retriesLeft)),
                DEFAULTS.RETRY_BACKOFF_CAP_MS,
            );
            await new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
            return this.#send(path, retriesLeft - 1);
        }

        if (statusCode !== 200) {
            log.debug(`Voyager returned ${statusCode} for ${path}`);
            return null;
        }

        try {
            return JSON.parse(body);
        } catch {
            log.debug(`Voyager returned non-JSON for ${path}`);
            return null;
        }
    }

    /**
     * Resolve the numeric organization ID for a company slug.
     *
     * Only needed when the public page did not leak one - which happens for
     * pages that redirect, and for companies whose guest page is gated.
     *
     * @param {string} slug
     * @returns {Promise<string|null>}
     */
    async resolveOrgId(slug) {
        const payload = await this.request(
            `organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12`
            + `&q=universalName&universalName=${encodeURIComponent(slug)}`,
        );
        if (!payload) return null;
        const serialized = JSON.stringify(payload);
        const match = serialized.match(/urn:li:(?:fs_normalized_company|organization|fsd_company|company):(\d+)/);
        return match ? match[1] : null;
    }

    /**
     * Resolve a country name to LinkedIn's numeric geo URN via their own
     * typeahead.
     *
     * Resolved rather than hardcoded because a wrong geo ID does not fail - it
     * returns a clean count for the wrong place, which is worse than an error.
     * Results are memoised per client and persisted by the caller, so a run
     * over many companies pays the lookup once per country.
     *
     * @param {string} country
     * @returns {Promise<string|null>}
     */
    async resolveGeoId(query, { exact = true } = {}) {
        const key = `${exact ? 'c' : 'p'}:${query.toLowerCase()}`;
        if (this.geoCache.has(key)) return this.geoCache.get(key);

        const payload = await this.request(
            `typeahead/hitsV2?keywords=${encodeURIComponent(query)}`
            + '&origin=OTHER&q=type&type=GEO&useCase=GEO_ABBREVIATED',
        );

        let resolved = null;
        const elements = findDeep(payload, ['elements']);
        if (Array.isArray(elements)) {
            const wanted = query.toLowerCase();
            // Countries are matched exactly. A prefix match on "Georgia"
            // happily returns the US state and on "India" returns "Indiana",
            // and neither errors - they return a confident count for the
            // wrong place.
            //
            // Cities cannot be matched that way: LinkedIn names them
            // "Redmond, Washington, United States", never "Redmond". So a
            // city match accepts a hit whose name begins with the city
            // followed by a comma, and the matched name is reported back so
            // a consumer can see what was actually counted.
            const hit = elements.find((element) => {
                const text = extractHitText(element).toLowerCase();
                return exact ? text === wanted : (text === wanted || text.startsWith(`${wanted},`));
            });
            const geoId = extractGeoId(hit ?? null);
            if (geoId) resolved = { geoId, matchedName: extractHitText(hit) };
        }

        this.geoCache.set(key, resolved);
        if (!resolved) log.debug(`No LinkedIn geo ID resolved for "${query}"; it will be skipped.`);
        return resolved;
    }

    /**
     * Seed the geo cache from a previously persisted mapping.
     *
     * @param {Record<string, string|null>} mapping
     */
    primeGeoCache(mapping = {}) {
        for (const [key, value] of Object.entries(mapping)) {
            // Tolerate the older cache format, which stored a bare ID string.
            const entry = typeof value === 'string' ? { geoId: value, matchedName: null } : value;
            if (!entry?.geoId) continue;
            // Keys are stored with the match-mode prefix resolveGeoId looks
            // them up by. An unprefixed key comes from a cache written before
            // city lookups existed, where every entry was an exact country
            // match - without this it would be primed under a key nothing
            // ever reads, and every country would be re-resolved from scratch.
            const prefixed = /^[cp]:/.test(key) ? key : `c:${key}`;
            this.geoCache.set(prefixed.toLowerCase(), entry);
        }
    }

    /**
     * The geo mapping learned this run, for persisting across runs.
     *
     * Failed lookups are held in memory - so one run does not retry the same
     * country 125 times - but never exported. A transient typeahead failure
     * cached as "this country has no geo ID" would otherwise poison every
     * future run permanently.
     *
     * @returns {Record<string, string>}
     */
    exportGeoCache() {
        return Object.fromEntries([...this.geoCache].filter(([, entry]) => entry?.geoId));
    }

    /**
     * Count members who list `orgId` as their current company, optionally
     * restricted to one geography.
     *
     * Two endpoint generations are tried. The dash/clusters endpoint is
     * current; search/blended is the older REST one, which LinkedIn has kept
     * alive for long enough that it is a genuinely useful fallback rather than
     * wishful thinking. Either way `count=0` is requested: only the total is
     * wanted, and asking for result bodies costs payload for nothing.
     *
     * @param {object} params
     * @param {string} params.orgId
     * @param {string|null} [params.geoId]
     * @returns {Promise<number|null>}
     */
    async countEmployees({ orgId, geoId = null }) {
        const geoClause = geoId ? `,(key:geoUrn,value:List(${geoId}))` : '';
        const clusters = await this.request(
            'search/dash/clusters'
            + '?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-198'
            + '&origin=FACETED_SEARCH&q=all&start=0&count=0'
            + '&query=(flagshipSearchIntent:SEARCH_SRP,queryParameters:List('
            + `(key:currentCompany,value:List(${orgId}))`
            + geoClause
            + ',(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false)',
        );
        const fromClusters = extractTotal(clusters);
        if (fromClusters !== null) return fromClusters;

        const geoFilter = geoId ? `,geoUrn->${geoId}` : '';
        const blended = await this.request(
            'search/blended?count=0&origin=FACETED_SEARCH&q=all'
            + `&filters=List(currentCompany->${orgId}${geoFilter},resultType->PEOPLE)`
            + '&queryContext=List(spellCorrectionEnabled->true)',
        );
        return extractTotal(blended);
    }
}
