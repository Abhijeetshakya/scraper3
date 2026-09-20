import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import { parseCompanyAbout, parseRecentUpdates, parseFeaturedEmployees } from './parsers.js';
import { VoyagerClient, VoyagerBlockedError, VoyagerBudgetError } from './voyager.js';
import {
    normalizeCompanyUrl, buildCompanyPageUrl, extractOrgId, isChallengePage, isWalledUrl,
    shouldStopScan, finalizeBreakdown, checkWebsiteStatus, applyToggles, expandToLocationRows,
    cacheKey, isCacheFresh,
} from './utils.js';
import { LABELS, DEFAULT_USER_AGENT, BLOCKED_STATUS_CODES, DEFAULT_COUNTRY_SCAN, DEFAULTS } from './constants.js';

await Actor.init();

// ─── Input ───────────────────────────────────────────────────────────
const input = await Actor.getInput() ?? {};
const {
    companyUrls = [],
    sessionCookie = null,
    // 'company' -> one row per company. 'location' -> one row per campus, with
    // the company's identity repeated on each and the address broken out.
    outputMode = 'company',
    includeLocationEmployeeCounts = false,
    includeCountryBreakdown = true,
    includeLocations = true,
    includeSpecialties = true,
    includeAffiliatedCompanies = true,
    includeSimilarCompanies = false,
    includeRecentUpdates = false,
    includeFeaturedEmployees = false,
    proxyConfiguration: proxyConfig,

    // Apify input schemas have no float type, only integer, so the UI knob is
    // in milliseconds. `requestDelaySeconds` is kept as the spec-named alias
    // for API/JSON callers, who can pass the fractional value directly.
    requestDelayMs = null,
    requestDelaySeconds = DEFAULTS.REQUEST_DELAY_SECONDS,

    // ─── Country-sweep tuning ──────────────────────────────────────
    countries = [],                    // Restrict/override the sweep list
    countryScanCoveragePercent = null, // Integer form of the coverage bar, for the UI
    countryScanCoverage = DEFAULTS.COUNTRY_SCAN_COVERAGE,
    maxCountriesScanned = DEFAULTS.MAX_COUNTRIES_SCANNED,
    maxAuthenticatedRequests = null,   // Hard budget across the whole run

    // ─── Run control ───────────────────────────────────────────────
    verifyWebsite = false,
    cacheTtlDays = DEFAULTS.CACHE_TTL_DAYS,
    maxConcurrency = DEFAULTS.MAX_CONCURRENCY,
    maxRequestRetries = DEFAULTS.MAX_REQUEST_RETRIES,
} = input;

const delaySeconds = requestDelayMs > 0 ? requestDelayMs / 1000 : requestDelaySeconds;
const coverageBar = countryScanCoveragePercent > 0
    ? countryScanCoveragePercent / 100
    : countryScanCoverage;

// ─── Resolve the input list ──────────────────────────────────────────
const targets = [];
const seenCompanies = new Set();
const rejected = [];
for (const entry of companyUrls) {
    const ref = normalizeCompanyUrl(entry);
    if (!ref) {
        rejected.push(typeof entry === 'string' ? entry : JSON.stringify(entry));
        continue;
    }
    const key = `${ref.pageType}:${ref.companyId}`;
    if (seenCompanies.has(key)) continue;
    seenCompanies.add(key);
    targets.push(ref);
}

if (rejected.length > 0) {
    log.warning(`Ignored ${rejected.length} unparseable input(s): ${rejected.slice(0, 5).join(', ')}`);
}
if (targets.length === 0) {
    log.error('No usable LinkedIn company URLs or slugs in `companyUrls`. Nothing to do.');
    await Actor.exit();
}

// The country breakdown is the one thing here that a public page will not give
// up. Without a cookie the run still produces every other field, so this is a
// warning and not a failure - but it has to be loud, because the field the user
// most likely came for will be missing.
const wantBreakdown = includeCountryBreakdown && Boolean(sessionCookie);
if (includeCountryBreakdown && !sessionCookie) {
    log.warning('includeCountryBreakdown is on but no sessionCookie was provided. '
        + 'LinkedIn only exposes location facets beyond its default top-5 to an authenticated session, '
        + 'so countryBreakdown will be null and every row will be marked sourceType "public".');
}

log.info('Starting LinkedIn Company Workforce & Profile Intelligence', {
    companies: targets.length,
    outputMode,
    countryBreakdown: wantBreakdown,
    requestDelaySeconds: delaySeconds,
    cacheTtlDays,
});

// ─── Proxy ───────────────────────────────────────────────────────────
const proxyConfiguration = proxyConfig
    ? await Actor.createProxyConfiguration(proxyConfig)
    : undefined;

if (wantBreakdown && !proxyConfiguration) {
    log.warning('No proxy configured while using a session cookie. Residential proxies are strongly '
        + 'recommended here: authenticated LinkedIn traffic from a datacenter IP is a strong anomaly signal.');
}

// ─── Authenticated client ────────────────────────────────────────────
// One sticky proxy session for the client's entire lifetime. Rotating IPs
// inside one authenticated session is a bigger red flag than any single request
// could be, so the session ID is minted once here and never changed.
const GEO_CACHE_KEY = 'GEO_URN_CACHE';
let voyager = null;
if (wantBreakdown) {
    const stickySessionId = `auth_${Date.now().toString(36)}`;
    const proxyUrl = proxyConfiguration
        ? await proxyConfiguration.newUrl(stickySessionId)
        : null;
    voyager = new VoyagerClient({
        sessionCookie,
        proxyUrl,
        delaySeconds,
        maxRequests: maxAuthenticatedRequests,
    });
    const cachedGeo = await Actor.getValue(GEO_CACHE_KEY);
    if (cachedGeo && typeof cachedGeo === 'object') {
        voyager.primeGeoCache(cachedGeo);
        log.info(`Primed ${Object.keys(cachedGeo).length} cached country -> geo ID mapping(s).`);
    }
}

const scanList = countries.length > 0 ? countries : DEFAULT_COUNTRY_SCAN;

// ─── State ───────────────────────────────────────────────────────────
/** companyId -> the public half of a row, awaiting its authenticated half. */
const pending = new Map();
let pushedRows = 0;
let failedRows = 0;
/** Set once LinkedIn blocks the session; stops burning the account on the rest. */
let authAbandoned = false;

/**
 * Build the row's Metadata block and push it.
 *
 * Every row is pushed through here, including failures, so that a run always
 * returns one row per input company. A silently missing row is indistinguishable
 * from a company that was never in the list.
 *
 * @param {object} row
 */
async function pushRow(row) {
    const toggled = applyToggles(row, {
        // In location mode the campus list *is* the output, so the toggle
        // cannot be allowed to delete it.
        locations: includeLocations || outputMode === 'location',
        specialties: includeSpecialties,
        affiliatedCompanies: includeAffiliatedCompanies,
        similarCompanies: includeSimilarCompanies,
        recentUpdates: includeRecentUpdates,
        featuredEmployees: includeFeaturedEmployees,
        countryBreakdown: includeCountryBreakdown,
        totalEmployeesOnLinkedIn: includeCountryBreakdown,
    });

    // Cached at company granularity, before any fan-out: the cache should not
    // have to be invalidated just because the caller switched output modes.
    if (row.success && cacheTtlDays > 0) {
        await Actor.setValue(cacheKey(row.companyId, row.pageType), toggled);
    }

    await emitRow(toggled);
    if (!row.success) failedRows++;
}

/**
 * Write a finished company row to the dataset, expanding it per campus first
 * when the run is in location mode.
 *
 * @param {object} companyRow
 */
async function emitRow(companyRow) {
    const records = outputMode === 'location' ? expandToLocationRows(companyRow) : [companyRow];
    await Actor.pushData(records);
    pushedRows += records.length;
}

/**
 * A row for a company that could not be fetched at all.
 *
 * @param {{companyUrl: string, companyId: string, pageType: string}} ref
 * @param {string} error
 * @returns {object}
 */
function failedRow(ref, error) {
    return {
        companyUrl: ref.companyUrl,
        companyId: ref.companyId,
        companyIdNumeric: null,
        pageType: ref.pageType,
        success: false,
        error,
        dataFetchedAt: new Date().toISOString(),
        sourceType: 'public',
    };
}

/**
 * Count members in each campus's own metro area.
 *
 * Opt-in and charged per campus: Microsoft declares 45 offices, so this is 45
 * more authenticated requests on top of the country sweep. The metro LinkedIn
 * matched is reported as `locationGeoName` - "Redmond" resolves to "Redmond,
 * Washington, United States", and a consumer should be able to see that rather
 * than trust a bare number.
 *
 * @param {string} orgId
 * @param {object[]} campuses - Mutated in place
 */
async function addLocationEmployeeCounts(orgId, campuses) {
    for (const campus of campuses) {
        if (!campus.city) continue;
        // Qualified with the country so "Cambridge" and "Reading" resolve to
        // the intended one of the several cities that share those names.
        const query = campus.country ? `${campus.city}, ${campus.country}` : campus.city;
        const geo = await voyager.resolveGeoId(query, { exact: false })
            ?? await voyager.resolveGeoId(campus.city, { exact: false });
        if (!geo) continue;
        campus.locationGeoName = geo.matchedName;
        campus.employeesAtLocation = await voyager.countEmployees({ orgId, geoId: geo.geoId });
    }
}

/**
 * Sweep countries, counting members per country for one organization.
 *
 * A genuinely complete breakdown is one request per country, and the default
 * list is 125 of them - at the spec'd ~1.75s spacing that is close to four
 * minutes per company. Most companies are not in 125 countries, so the sweep
 * stops once enough of the known total is accounted for or the tail goes quiet.
 * `stopReason` is reported so a consumer can tell a complete sweep from a
 * truncated one rather than having to guess from the shape of the numbers.
 *
 * @param {string} orgId
 * @returns {Promise<object>}
 */
async function buildCountryBreakdown(orgId) {
    const total = await voyager.countEmployees({ orgId });

    const rows = [];
    let accounted = 0;
    let emptyStreak = 0;
    let scanned = 0;
    let stopReason = 'listExhausted';

    for (const country of scanList) {
        const geo = await voyager.resolveGeoId(country);
        if (!geo) continue; // Unresolvable name; counted as neither hit nor miss.

        const count = await voyager.countEmployees({ orgId, geoId: geo.geoId });
        scanned++;

        if (count && count > 0) {
            rows.push({ country, employeeCount: count });
            accounted += count;
            emptyStreak = 0;
        } else {
            emptyStreak++;
        }

        const verdict = shouldStopScan(
            { accounted, total, emptyStreak, scanned },
            { coverage: coverageBar, maxCountries: maxCountriesScanned },
        );
        if (verdict.stop) {
            stopReason = verdict.reason;
            break;
        }
    }

    return {
        totalEmployeesOnLinkedIn: total,
        countryBreakdown: finalizeBreakdown(rows, total),
        countryScan: {
            countriesQueried: scanned,
            stopReason,
            // What share of LinkedIn's own total the sweep managed to place in a
            // country. Short of 1.0 for every real company: members who list no
            // location are in the total and in no country bucket.
            coverage: total && total > 0 ? Math.round((accounted / total) * 1000) / 1000 : null,
        },
    };
}

// ─── Phase 1: public guest pages ─────────────────────────────────────
// No login, so this runs wide and fast. Everything except the country
// breakdown comes from here.
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency,
    maxRequestRetries,
    minConcurrency: DEFAULTS.MIN_CONCURRENCY,
    requestHandlerTimeoutSecs: DEFAULTS.REQUEST_HANDLER_TIMEOUT_SECS,
    maxRequestsPerMinute: maxConcurrency * DEFAULTS.REQUESTS_PER_MINUTE_MULTIPLIER,

    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: DEFAULTS.SESSION_POOL_MAX_SIZE,
        blockedStatusCodes: BLOCKED_STATUS_CODES,
        sessionOptions: { maxUsageCount: DEFAULTS.SESSION_MAX_USAGE_COUNT },
    },

    preNavigationHooks: [
        async (_context, gotOptions) => {
            gotOptions.headers = {
                ...gotOptions.headers,
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1',
            };
        },
    ],

    async requestHandler({ request, $, body, session }) {
        const { ref } = request.userData;

        // LinkedIn serves auth walls and checkpoints with HTTP 200 at the end
        // of a redirect chain, so neither the status code nor the requested URL
        // says anything. Checked before parsing, because a sign-in page parses
        // perfectly happily into a company record named "Sign in" with every
        // other field null - a row that claims success and carries nothing.
        const landedOn = request.loadedUrl ?? request.url;
        if (isWalledUrl(landedOn) || (typeof body === 'string' && isChallengePage(body))) {
            session?.retire();
            throw new Error(`LinkedIn served a sign-in wall for ${request.url}`
                + (landedOn !== request.url ? ` (redirected to ${landedOn})` : ''));
        }

        const html = typeof body === 'string' ? body : body.toString('utf8');
        const publicData = parseCompanyAbout($, html, ref);
        publicData.companyIdNumeric = extractOrgId(html);

        if (includeRecentUpdates) publicData.recentUpdates = parseRecentUpdates($);
        if (includeFeaturedEmployees) publicData.featuredEmployees = parseFeaturedEmployees($);
        if (verifyWebsite) publicData.websiteStatus = await checkWebsiteStatus(publicData.website);

        pending.set(`${ref.pageType}:${ref.companyId}`, { ref, publicData });
        log.info(`Public page parsed: ${publicData.name ?? ref.companyId}`
            + `${publicData.companyIdNumeric ? ` (org ${publicData.companyIdNumeric})` : ' (no numeric org ID found)'}`);
    },

    async failedRequestHandler({ request }, error) {
        const { ref } = request.userData;
        log.error(`Failed to fetch ${request.url}: ${error.message}`);
        await pushRow(failedRow(ref, `Public page fetch failed: ${error.message}`));
    },
});

// ─── Cache pass ──────────────────────────────────────────────────────
// Firmographics and country distribution move slowly, so re-scraping an
// unchanged company spends authenticated request budget for an identical row.
const toCrawl = [];
for (const ref of targets) {
    const cached = cacheTtlDays > 0 ? await Actor.getValue(cacheKey(ref.companyId, ref.pageType)) : null;
    if (isCacheFresh(cached, cacheTtlDays)) {
        log.info(`Cache hit (<${cacheTtlDays}d) for ${ref.companyId}; skipping fetch.`);
        await emitRow({ ...cached, fromCache: true });
        continue;
    }
    toCrawl.push({
        url: buildCompanyPageUrl(ref.companyUrl),
        userData: { label: LABELS.COMPANY, ref },
        uniqueKey: `${ref.pageType}-${ref.companyId}`,
    });
}

if (toCrawl.length > 0) {
    log.info(`Fetching ${toCrawl.length} public company page(s) at concurrency ${maxConcurrency}.`);
    await crawler.run(toCrawl);
}

// ─── Phase 2: authenticated country breakdown ────────────────────────
// Serialised, not concurrent, and deliberately after the public pass: the
// numeric org ID every authenticated call keys on is only known once the public
// page has been read.
for (const { ref, publicData } of pending.values()) {
    const base = {
        companyUrl: ref.companyUrl,
        companyId: ref.companyId,
        ...publicData,
        success: true,
        error: null,
        dataFetchedAt: new Date().toISOString(),
        sourceType: 'public',
    };

    if (!wantBreakdown) {
        await pushRow({ ...base, countryBreakdown: null, totalEmployeesOnLinkedIn: null });
        continue;
    }

    if (authAbandoned || voyager.budgetExhausted) {
        await pushRow({
            ...base,
            countryBreakdown: null,
            totalEmployeesOnLinkedIn: null,
            error: authAbandoned
                ? 'Country breakdown skipped: the LinkedIn session was blocked earlier in this run.'
                : `Country breakdown skipped: authenticated request budget (${maxAuthenticatedRequests}) exhausted.`,
        });
        continue;
    }

    // A numeric org ID is mandatory for every authenticated call. If the public
    // page did not leak one, ask LinkedIn directly rather than dropping the row.
    let orgId = publicData.companyIdNumeric;
    try {
        if (!orgId) {
            orgId = await voyager.resolveOrgId(ref.companyId);
            base.companyIdNumeric = orgId;
        }
        if (!orgId) {
            await pushRow({
                ...base,
                countryBreakdown: null,
                totalEmployeesOnLinkedIn: null,
                error: 'Country breakdown unavailable: no numeric LinkedIn organization ID could be resolved.',
            });
            continue;
        }

        log.info(`Sweeping countries for ${base.name ?? ref.companyId} (org ${orgId})...`);
        const breakdown = await buildCountryBreakdown(orgId);

        if (includeLocationEmployeeCounts && outputMode === 'location' && Array.isArray(base.locations)) {
            log.info(`  Counting employees at ${base.locations.length} campus metro(s)...`);
            await addLocationEmployeeCounts(orgId, base.locations);
        }

        await pushRow({ ...base, ...breakdown, sourceType: 'authenticated' });
        log.info(`  ${breakdown.countryBreakdown.length} country/countries found across `
            + `${breakdown.countryScan.countriesQueried} queried (stop: ${breakdown.countryScan.stopReason}).`);
    } catch (error) {
        if (error instanceof VoyagerBudgetError) {
            authAbandoned = true;
            log.warning(`${error.message} Remaining companies will be returned with public fields only.`);
        } else if (error instanceof VoyagerBlockedError) {
            // One block means the session is done. Continuing would spend the
            // rest of the list confirming it and risk the account outright, so
            // the remaining companies fall back to public-only.
            authAbandoned = true;
            log.error(`LinkedIn blocked the authenticated session: ${error.message} `
                + 'Remaining companies will be returned with public fields only.');
        } else {
            log.warning(`Country breakdown failed for ${ref.companyId}: ${error.message}`);
        }
        await pushRow({
            ...base,
            countryBreakdown: null,
            totalEmployeesOnLinkedIn: null,
            error: `Country breakdown failed: ${error.message}`,
        });
    }
}

// ─── Wrap up ─────────────────────────────────────────────────────────
if (voyager) {
    await Actor.setValue(GEO_CACHE_KEY, voyager.exportGeoCache());
    log.info(`Authenticated requests used: ${voyager.requestsMade}`
        + `${maxAuthenticatedRequests ? ` / ${maxAuthenticatedRequests}` : ''}`
        + `, blocked: ${voyager.blockedCount}.`);
}

log.info(`✅ Done. ${pushedRows} row(s) pushed, ${failedRows} with success: false.`);

await Actor.exit();
