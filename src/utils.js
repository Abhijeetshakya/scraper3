import { promises as dns } from 'node:dns';
import { LINKEDIN_BASE, PAGE_TYPE_PREFIXES, CHALLENGE_MARKERS, DEFAULTS } from './constants.js';

/**
 * Collapse whitespace and trim. Returns '' for nullish input.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanText(text) {
    if (!text) return '';
    return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Normalise a scraped value for output.
 *
 * The output contract says absent fields are null, never ''. Scrapers produce
 * empty strings constantly - a selector matched an empty node, a label had no
 * value - and an empty string downstream reads as "LinkedIn published a blank",
 * which is a different claim from "LinkedIn published nothing".
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function nullIfEmpty(value) {
    const cleaned = cleanText(value);
    return cleaned === '' ? null : cleaned;
}

/**
 * Parse a human-formatted count into a number: "10,001+" -> 10001,
 * "1.2M followers" -> 1200000, "5K" -> 5000, "2-10 employees" -> 2.
 *
 * Returns the *first* figure in a range on purpose. Callers that want the
 * bucket keep the raw string alongside (companySizeRange); callers that want a
 * number want a number, and LinkedIn's own "employees" figure is exact anyway.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseCount(text) {
    const raw = cleanText(text);
    if (!raw) return null;
    const match = raw.match(/(\d[\d,.\s]*)\s*([KMB])?/i);
    if (!match) return null;

    const digits = match[1].replace(/[,\s]/g, '');
    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) return null;

    const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] || '').toLowerCase()] ?? 1;
    return Math.round(value * multiplier);
}

/**
 * Turn any accepted company reference into a canonical URL, slug and page type.
 *
 * Accepts bare slugs ("microsoft"), full URLs with or without protocol, locale
 * subdomains (uk.linkedin.com), trailing /about, /people, /jobs segments, and
 * tracking query strings. Showcase and school pages live under different path
 * prefixes but render the same about markup, so they are accepted too and only
 * the reported pageType differs.
 *
 * @param {string|{url: string}} entry
 * @returns {{companyUrl: string, companyId: string, pageType: string}|null}
 */
export function normalizeCompanyUrl(entry) {
    const value = cleanText(typeof entry === 'string' ? entry : entry?.url);
    if (!value) return null;

    // A bare slug: no dots, no slashes. "microsoft", "acme-corp".
    if (!value.includes('/') && !value.includes('.')) {
        const slug = value.toLowerCase();
        return {
            companyUrl: `${LINKEDIN_BASE}/company/${slug}`,
            companyId: slug,
            pageType: PAGE_TYPE_PREFIXES.company,
        };
    }

    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    let parsed;
    try {
        parsed = new URL(withProtocol);
    } catch {
        return null;
    }

    const match = parsed.pathname.match(/\/(company|showcase|school)\/([^/?#]+)/i);
    if (!match) return null;

    const prefix = match[1].toLowerCase();
    const slug = decodeURIComponent(match[2]).toLowerCase();
    return {
        // Always rebuilt from www, never the locale subdomain the caller pasted:
        // uk.linkedin.com serves a localised page, and two rows for the same
        // company that differ only by subdomain are two rows too many.
        companyUrl: `${LINKEDIN_BASE}/${prefix}/${slug}`,
        companyId: slug,
        pageType: PAGE_TYPE_PREFIXES[prefix] ?? PAGE_TYPE_PREFIXES.company,
    };
}

/**
 * The guest-accessible about page for a canonical company URL.
 *
 * @param {string} companyUrl
 * @returns {string}
 */
export function buildAboutUrl(companyUrl) {
    return `${companyUrl.replace(/\/+$/, '')}/about/`;
}

/**
 * Pull LinkedIn's internal numeric organization ID out of a page.
 *
 * The guest page never labels it, but it leaks into several places: entity URNs
 * on the follow button, the embedded JSON payloads LinkedIn ships inside <code>
 * blocks, and tracking attributes. Scanning the raw HTML for the URN shape
 * catches all of them at once and survives the markup being reshuffled, which
 * a selector chain does not.
 *
 * The numeric ID is what every authenticated call keys on, so a company whose
 * page yields no ID cannot get a country breakdown at all.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function extractOrgId(html) {
    if (!html || typeof html !== 'string') return null;
    const urn = html.match(/urn:li:(?:organization|fsd_company|company):(\d+)/);
    if (urn) return urn[1];
    const numericPath = html.match(/\/company\/(\d{4,})(?:[/"?]|$)/);
    return numericPath ? numericPath[1] : null;
}

/**
 * Detect a login wall, checkpoint, or bot-challenge page.
 *
 * LinkedIn serves these with HTTP 200, so status codes alone miss them and the
 * crawler would happily parse the challenge page into an empty company record.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function isChallengePage(html) {
    if (!html || typeof html !== 'string') return false;
    return CHALLENGE_MARKERS.some((marker) => html.includes(marker));
}

/**
 * Mint a Voyager CSRF token / JSESSIONID pair.
 *
 * LinkedIn requires the csrf-token header to equal the JSESSIONID cookie value.
 * They are generated together here so the two can never drift apart, which is
 * the usual cause of a 403 from a cookie that works fine in a browser.
 *
 * @returns {{token: string, cookie: string}}
 */
export function makeCsrfPair() {
    const token = `ajax:${Math.floor(Math.random() * 9e15).toString().padStart(16, '0')}`;
    return { token, cookie: `JSESSIONID="${token}"` };
}

/**
 * Sleep for `seconds`, jittered by +/-20%.
 *
 * A fixed delay produces a metronome-regular request train, which is itself a
 * bot signal - the point of spacing requests is to look less automated, and
 * perfectly even spacing looks more automated, not less.
 *
 * @param {number} seconds
 * @returns {Promise<void>}
 */
export function jitteredSleep(seconds) {
    if (!(seconds > 0)) return Promise.resolve();
    const ms = seconds * 1000;
    const jittered = ms * (0.8 + (Math.random() * 0.4));
    return new Promise((resolve) => setTimeout(resolve, Math.round(jittered)));
}

/**
 * Decide whether the country sweep can stop early.
 *
 * A complete breakdown means one request per country, and the default list is
 * 125 countries - at ~1.75s apart that is close to four minutes per company.
 * Most companies do not have staff in 125 countries, so the sweep stops when
 * either (a) enough of the known total is accounted for, or (b) the tail has
 * gone quiet for a run of countries.
 *
 * The coverage bar is deliberately below 1.0: members who list no location
 * appear in no country bucket, so waiting for a perfect reconciliation would
 * always walk the entire list.
 *
 * @param {object} state
 * @param {number} state.accounted - Employees found so far across countries
 * @param {number|null} state.total - totalEmployeesOnLinkedIn, if known
 * @param {number} state.emptyStreak - Consecutive countries returning zero
 * @param {number} state.scanned - Countries queried so far
 * @param {object} [opts]
 * @returns {{stop: boolean, reason: string|null}}
 */
export function shouldStopScan({ accounted, total, emptyStreak, scanned }, opts = {}) {
    const coverageBar = opts.coverage ?? DEFAULTS.COUNTRY_SCAN_COVERAGE;
    const streakBar = opts.emptyStreak ?? DEFAULTS.COUNTRY_SCAN_EMPTY_STREAK;
    const maxScanned = opts.maxCountries ?? DEFAULTS.MAX_COUNTRIES_SCANNED;

    if (scanned >= maxScanned) return { stop: true, reason: 'countryLimit' };
    if (total && total > 0 && accounted / total >= coverageBar) {
        return { stop: true, reason: 'coverageReached' };
    }
    // The streak only ends a scan that has actually found something. Firing it
    // on a company whose first N countries are all empty would abandon the
    // sweep before reaching the one country its staff are actually in.
    if (accounted > 0 && emptyStreak >= streakBar) return { stop: true, reason: 'emptyTail' };
    return { stop: false, reason: null };
}

/**
 * Sort a country breakdown by headcount and attach each country's share.
 *
 * `percentOfTotal` is computed against totalEmployeesOnLinkedIn - the same
 * denominator LinkedIn shows - not against the sum of the buckets. Those two
 * numbers are not the same and normalising to the bucket sum would quietly
 * inflate every share by however much of the workforce lists no location,
 * making a partial scan look complete.
 *
 * @param {Array<{country: string, employeeCount: number}>} rows
 * @param {number|null} total
 * @returns {Array<{country: string, employeeCount: number, percentOfTotal: number|null}>}
 */
export function finalizeBreakdown(rows, total) {
    return rows
        .filter((row) => row && row.employeeCount > 0)
        .sort((a, b) => b.employeeCount - a.employeeCount)
        .map((row) => ({
            country: row.country,
            employeeCount: row.employeeCount,
            percentOfTotal: total && total > 0
                ? Math.round((row.employeeCount / total) * 1000) / 10
                : null,
        }));
}

/**
 * Check whether a listed website's domain actually resolves.
 *
 * DNS rather than an HTTP request on purpose: it is one UDP round trip, it does
 * not touch the target's servers, it needs no proxy, and it answers the only
 * question worth asking cheaply - whether the domain a company published still
 * exists. A dead domain on a LinkedIn page is a real signal (acquired, folded,
 * rebranded) and it is common enough to be worth reporting.
 *
 * @param {string|null} website
 * @returns {Promise<'valid'|'unresolved'|'invalid'|null>}
 */
export async function checkWebsiteStatus(website) {
    if (!website) return null;
    let hostname;
    try {
        hostname = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname;
    } catch {
        return 'invalid';
    }
    if (!hostname || !hostname.includes('.')) return 'invalid';
    try {
        await dns.lookup(hostname);
        return 'valid';
    } catch {
        return 'unresolved';
    }
}

/**
 * Drop the optional sections the caller switched off.
 *
 * Keys are removed outright rather than set to null: a null countryBreakdown
 * reads as "we looked and found none", which is a different statement from
 * "you asked us not to look".
 *
 * @param {object} record
 * @param {Record<string, boolean>} toggles - field name -> include?
 * @returns {object}
 */
export function applyToggles(record, toggles) {
    const result = { ...record };
    for (const [field, include] of Object.entries(toggles)) {
        if (!include) delete result[field];
    }
    return result;
}

/**
 * Cache-key for a company row in the key-value store. Key-value store keys
 * allow [a-zA-Z0-9!\-_.'()], so the slug is sanitised rather than trusted.
 *
 * @param {string} companyId
 * @param {string} pageType
 * @returns {string}
 */
export function cacheKey(companyId, pageType) {
    const safe = String(companyId).replace(/[^a-zA-Z0-9!\-_.'()]/g, '_');
    return `CACHE-${pageType}-${safe}`;
}

/**
 * Whether a cached entry is still inside its TTL.
 *
 * @param {{dataFetchedAt?: string}|null} entry
 * @param {number} ttlDays - 0 or less disables caching entirely
 * @returns {boolean}
 */
export function isCacheFresh(entry, ttlDays) {
    if (!entry || !(ttlDays > 0)) return false;
    const fetchedAt = Date.parse(entry.dataFetchedAt ?? '');
    if (Number.isNaN(fetchedAt)) return false;
    return Date.now() - fetchedAt < ttlDays * 24 * 60 * 60 * 1000;
}
