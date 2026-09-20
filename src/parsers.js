import { LINKEDIN_BASE, PAGE_TYPE_PREFIXES } from './constants.js';
import { cleanText, nullIfEmpty, parseCount, normalizeCompanyUrl, parseAddressLines } from './utils.js';

/**
 * Absolutise a LinkedIn href and strip its tracking query string.
 *
 * @param {string|undefined|null} href
 * @returns {string|null}
 */
function absoluteUrl(href) {
    const raw = cleanText(href);
    if (!raw) return null;
    const withBase = raw.startsWith('http') ? raw : `${LINKEDIN_BASE}${raw.startsWith('/') ? '' : '/'}${raw}`;
    try {
        const parsed = new URL(withBase);
        return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    } catch {
        return null;
    }
}

/**
 * LinkedIn wraps outbound links in a redirector
 * (/redir/redirect?url=<encoded>). The redirector URL is useless as a website
 * field - it is not the company's domain, it does not resolve to one without a
 * round trip, and it carries tracking. Unwrap it back to the real target.
 *
 * @param {string|undefined|null} href
 * @returns {string|null}
 */
function unwrapExternalUrl(href) {
    const raw = cleanText(href);
    if (!raw) return null;
    try {
        const parsed = new URL(raw.startsWith('http') ? raw : `${LINKEDIN_BASE}${raw}`);
        const target = parsed.searchParams.get('url');
        if (target) return cleanText(decodeURIComponent(target));
        if (parsed.hostname.endsWith('linkedin.com')) return null;
        return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '');
    } catch {
        return raw;
    }
}

/**
 * Collect the JSON-LD Organization payload LinkedIn embeds in the guest page.
 *
 * Preferred over scraping the visible DOM wherever it carries the field: it is
 * structured, it is what LinkedIn publishes for search engines, and it survives
 * the class-name churn that breaks selector chains. The DOM is the fallback,
 * not the other way round.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {object|null}
 */
export function parseJsonLd($) {
    const organizations = [];

    $('script[type="application/ld+json"]').each((_index, element) => {
        const raw = $(element).contents().text();
        if (!raw.trim()) return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return; // A malformed block is not worth failing the whole page over.
        }
        // LinkedIn ships either a bare object, an array, or an @graph wrapper
        // depending on the page; flatten all three shapes into one list.
        const candidates = [parsed, ...(parsed['@graph'] ?? []), ...(Array.isArray(parsed) ? parsed : [])];
        for (const candidate of candidates) {
            const type = candidate?.['@type'];
            const types = Array.isArray(type) ? type : [type];
            if (types.some((t) => /Organization|Corporation|Company|School/i.test(t ?? ''))) {
                organizations.push(candidate);
            }
        }
    });

    return organizations[0] ?? null;
}

/**
 * Read LinkedIn's about-page definition list into a label -> value map.
 *
 * Two lookups, because the markup differs between page variants: the stable
 * data-test-id attributes when present, and the visible <dt> label text when
 * LinkedIn serves the older layout that has no such attributes.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Record<string, string>}
 */
export function parseAboutDefinitions($) {
    const definitions = {};

    // LinkedIn's own key for the size row is "size", not "companySize". The
    // <dt>-label fallback below happened to cover for that, which is exactly
    // why it went unnoticed - aliasing it makes the primary path work too.
    const keyAliases = { size: 'companySize', founded: 'foundedOn', type: 'organizationType' };

    $('[data-test-id^="about-us__"]').each((_index, element) => {
        const raw = ($(element).attr('data-test-id') ?? '').replace('about-us__', '');
        const key = keyAliases[raw] ?? raw;
        const value = cleanText($(element).find('dd').text()) || cleanText($(element).text());
        if (key && value) definitions[key] = value;
    });

    // Fallback: walk the <dt>/<dd> pairs and key off the visible label.
    $('dl dt').each((_index, element) => {
        const label = cleanText($(element).text()).toLowerCase().replace(/[^a-z]/g, '');
        const value = cleanText($(element).next('dd').text());
        if (!label || !value) return;
        const mapped = {
            website: 'website',
            phone: 'phone',
            industry: 'industry',
            companysize: 'companySize',
            headquarters: 'headquarters',
            type: 'organizationType',
            founded: 'foundedOn',
            specialties: 'specialties',
            stocksymbol: 'stockSymbol',
        }[label];
        if (mapped && !definitions[mapped]) definitions[mapped] = value;
    });

    return definitions;
}

/**
 * Flatten a JSON-LD PostalAddress into a single readable line.
 *
 * @param {object|undefined} address
 * @returns {string|null}
 */
function formatPostalAddress(address) {
    if (!address || typeof address !== 'object') return null;
    const parts = [
        address.streetAddress,
        address.addressLocality,
        address.addressRegion,
        address.postalCode,
        typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry,
    ]
        .map((part) => cleanText(part))
        .filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Every office location the page declares, not just the HQ.
 *
 * The distinction matters to the actor's whole premise: declared offices are
 * where a company says it operates, the country breakdown is where its staff
 * actually are, and the gap between the two is the interesting part.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string[]}
 */
export function parseLocations($) {
    const campuses = [];
    const seen = new Set();

    const add = ({ lines, isPrimary = false, mapUrl = null, fallbackText = null }) => {
        const cleaned = (lines ?? []).map((line) => cleanText(line)).filter(Boolean);
        const parsed = parseAddressLines(cleaned.length > 0 ? cleaned : [cleanText(fallbackText)]);
        if (!parsed.formattedAddress || parsed.formattedAddress.length < 4) return;
        if (seen.has(parsed.formattedAddress)) return;
        seen.add(parsed.formattedAddress);
        campuses.push({ ...parsed, isPrimary, mapUrl, addressLines: cleaned });
    };

    // The real guest markup: one <li> per office, the address split across <p>
    // lines inside a div#address-N, a "Primary" tag on the HQ, and a map link.
    // Reading the <li> text whole glues the tag and the link onto the address;
    // reading each <p> as its own location turned one office into three, which
    // is how 45 Microsoft campuses once came back as 151 "locations".
    $('ul[data-impression-id="org-locations_show-more-less"] > li, [data-test-id="about-us__locations"] li')
        .each((_index, element) => {
            const $el = $(element);
            const $address = $el.find('[id^="address-"]').first();
            const $scope = $address.length > 0 ? $address : $el;
            add({
                lines: $scope.find('p').map((_i, p) => $(p).text()).get(),
                isPrimary: /primary/i.test($el.find('span.tag-sm, .tag-enabled').first().text()),
                mapUrl: $el.find('a[data-tracking-control-name="org-locations_url"]').attr('href') ?? null,
                fallbackText: $scope.text(),
            });
        });

    if (campuses.length === 0) {
        $('.locations__list li, .org-locations__list li, .location-item').each((_index, element) => {
            add({ lines: [], fallbackText: $(element).text() });
        });
    }

    // Last resort for layouts with no list markup. Restricted to elements not
    // inside an <li>, so a nested <p> is not counted a second time.
    if (campuses.length === 0) {
        $('section').each((_index, section) => {
            const heading = cleanText($(section).find('h2, h3').first().text()).toLowerCase();
            if (!heading.includes('location')) return;
            $(section).find('p, address').each((_i, element) => {
                if ($(element).parents('li').length > 0) return;
                add({ lines: [], fallbackText: $(element).text() });
            });
        });
    }

    return campuses;
}

/**
 * Companies linked from a section whose heading matches `headingPattern`.
 *
 * Both "Affiliated pages" and "Similar pages" render as the same card grid with
 * only the heading to tell them apart, so they share one extractor. Matching on
 * heading text rather than a section class keeps this working when LinkedIn
 * renames the class, which it does often.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {RegExp} headingPattern
 * @param {string[]} containerSelectors - Tried before the heading walk
 * @returns {Array<{name: string|null, url: string}>}
 */
function parseLinkedCompanySection($, headingPattern, containerSelectors) {
    const seen = new Map();

    const harvest = (scope) => {
        $(scope).find('a[href*="/company/"], a[href*="/showcase/"], a[href*="/school/"]').each((_index, element) => {
            const $link = $(element);
            const url = absoluteUrl($link.attr('href'));
            if (!url || seen.has(url)) return;

            // The card renders name, industry and location as three stacked
            // elements inside the <a>, so .text() on the link returns
            // "GitHub Software Development San Francisco, CA" - a name field
            // with two other fields glued to it. Read the title element.
            const $card = $link.closest('li, .base-card').length > 0 ? $link.closest('li, .base-card') : $link;
            const name = nullIfEmpty($card.find('.base-aside-card__title, .base-main-card__title, h3').first().text())
                ?? nullIfEmpty($link.find('img').attr('alt'))
                ?? nullIfEmpty($link.text());
            seen.set(url, { name, url });
        });
    };

    for (const selector of containerSelectors) {
        $(selector).each((_index, element) => harvest(element));
    }

    if (seen.size === 0) {
        $('section').each((_index, section) => {
            const heading = cleanText($(section).find('h2, h3').first().text());
            if (headingPattern.test(heading)) harvest(section);
        });
    }

    return [...seen.values()];
}

/**
 * Subsidiary, regional, showcase and acquired pages linked from this one.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Array<{name: string|null, url: string}>}
 */
export function parseAffiliatedCompanies($) {
    return parseLinkedCompanySection(
        $,
        /affiliated|showcase|related pages/i,
        ['ul[data-impression-id="affiliated-pages_show-more-less"]',
            'section.affiliated-companies', '[data-test-id="affiliated-companies"]', '.affiliated-pages'],
    );
}

/**
 * LinkedIn's own "people also viewed" / "similar pages" suggestions.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @returns {Array<{name: string|null, url: string}>}
 */
export function parseSimilarCompanies($) {
    return parseLinkedCompanySection(
        $,
        /similar pages|people also viewed|similar companies/i,
        ['ul[data-impression-id="similar-pages_show-more-less"]',
            'section.similar-pages', '[data-test-id="similar-pages"]', '.similar-companies'],
    );
}

/**
 * Recent posts from the page's activity feed.
 *
 * `likes` and `engagement` are separate on purpose: LinkedIn reports a reaction
 * count and a comment count and they measure different things, so collapsing
 * them into one number would throw away the ratio, which is the part that
 * actually distinguishes a post that landed from one that was merely seen.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {number} limit
 * @returns {Array<{text: string|null, date: string|null, likes: number|null, engagement: object}>}
 */
export function parseRecentUpdates($, limit = 10) {
    const updates = [];

    $('article.main-feed-activity-card, .feed-shared-update-v2, [data-test-id="main-feed-activity-card"]')
        .each((_index, element) => {
            if (updates.length >= limit) return false;
            const $card = $(element);

            const text = nullIfEmpty(
                $card.find('.attributed-text-segment-list__content, .feed-shared-update-v2__description, p').first().text(),
            );
            const $time = $card.find('time').first();
            const date = nullIfEmpty($time.attr('datetime')) ?? nullIfEmpty($time.text());

            const likes = parseCount(
                $card.find('[data-test-id="social-actions__reaction-count"], .social-details-social-counts__reactions-count, .main-feed-activity-card__social-actions span').first().text(),
            );
            const comments = parseCount(
                $card.find('[data-test-id="social-actions__comments"], .social-details-social-counts__comments').first().text(),
            );

            if (!text && !date) return undefined;
            updates.push({
                text,
                date,
                likes,
                engagement: { likes, comments, total: (likes ?? 0) + (comments ?? 0) },
            });
            return undefined;
        });

    return updates;
}

/**
 * The handful of employee profiles LinkedIn surfaces on the public page.
 *
 * Deliberately capped and deliberately not the point of this actor: it is a
 * sample LinkedIn chose to show, not a roster, and treating it as one would
 * misrepresent it. The country breakdown is the workforce signal.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {number} limit
 * @returns {Array<{name: string|null, title: string|null, photoUrl: string|null, profileUrl: string|null}>}
 */
export function parseFeaturedEmployees($, limit = 10) {
    const employees = [];
    const seen = new Set();

    $('a[href*="/in/"]').each((_index, element) => {
        if (employees.length >= limit) return false;
        const $link = $(element);
        const profileUrl = absoluteUrl($link.attr('href'));
        if (!profileUrl || !/\/in\//.test(profileUrl) || seen.has(profileUrl)) return undefined;

        const $card = $link.closest('li, .base-card, .profile-card');
        const name = nullIfEmpty($card.find('h3, .base-main-card__title').first().text())
            ?? nullIfEmpty($link.find('img').attr('alt'))
            ?? nullIfEmpty($link.text());
        if (!name) return undefined;

        seen.add(profileUrl);
        employees.push({
            name,
            title: nullIfEmpty($card.find('h4, .base-main-card__subtitle').first().text()),
            photoUrl: nullIfEmpty($card.find('img').attr('data-delayed-url'))
                ?? nullIfEmpty($card.find('img').attr('src')),
            profileUrl,
        });
        return undefined;
    });

    return employees;
}

/**
 * Parse a LinkedIn company/showcase/school about page into the public half of
 * an output row.
 *
 * Everything here is reachable without a session cookie, so it carries
 * sourceType 'public'. The country breakdown is bolted on separately by the
 * authenticated lane.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} html - Raw body, used for the URN scan the DOM cannot do
 * @param {{companyUrl: string, companyId: string, pageType: string}} ref
 * @returns {object} Public company fields
 */
export function parseCompanyAbout($, html, ref) {
    const ld = parseJsonLd($) ?? {};
    const definitions = parseAboutDefinitions($);

    // ─── Overview ────────────────────────────────────────────────
    const name = nullIfEmpty(ld.name)
        ?? nullIfEmpty($('.org-top-card-summary__title, .top-card-layout__title, h1').first().text());

    const tagline = nullIfEmpty($('.org-top-card-summary__tagline, .top-card-layout__second-subline .top-card-layout__headline').first().text())
        ?? nullIfEmpty($('h2.top-card-layout__second-subline').first().text());

    const about = nullIfEmpty(ld.description)
        ?? nullIfEmpty($('[data-test-id="about-us__description"], .about-us__description, .core-section-container__content p').first().text());

    const logoUrl = nullIfEmpty(typeof ld.logo === 'object' ? ld.logo?.contentUrl ?? ld.logo?.url : ld.logo)
        ?? nullIfEmpty($('.top-card-layout__entity-image, img.org-top-card-primary-content__logo').first().attr('data-delayed-url'))
        ?? nullIfEmpty($('.top-card-layout__entity-image, img.org-top-card-primary-content__logo').first().attr('src'));

    const coverImageUrl = nullIfEmpty($('.cover-img__image, .top-card-layout__cover-image, .org-top-card-module__hero').first().attr('data-delayed-url'))
        ?? nullIfEmpty($('.cover-img__image, .top-card-layout__cover-image, .org-top-card-module__hero').first().attr('src'))
        ?? nullIfEmpty($('meta[property="og:image"]').attr('content'));

    // ─── Firmographics ───────────────────────────────────────────
    const companySizeRange = nullIfEmpty(definitions.companySize);
    // LinkedIn prints two different employee numbers on the same page and they
    // are not interchangeable: the About panel's bucketed range ("10,001+
    // employees") and the top card's exact count of members who list this
    // company. The exact one is the only usable denominator for a percentage,
    // so it is preferred and the bucket is kept separately as a raw range.
    const employeeCount = parseCount(
        $('a[href*="/people"], .org-top-card-summary-info-list__info-item, .face-pile__text')
            .filter((_index, element) => /associated member|employee/i.test($(element).text()))
            .first()
            .text(),
    ) ?? parseCount(typeof ld.numberOfEmployees === 'object'
        ? ld.numberOfEmployees?.value ?? ld.numberOfEmployees?.minValue
        : ld.numberOfEmployees);

    const specialties = nullIfEmpty(definitions.specialties);

    // ─── Location & contact ──────────────────────────────────────
    const website = unwrapExternalUrl(
        $('[data-test-id="about-us__website"] dd a, a[data-tracking-control-name*="about_website"]').first().attr('href'),
    ) ?? nullIfEmpty(definitions.website) ?? nullIfEmpty(ld.url);

    const address = formatPostalAddress(ld.address)
        ?? nullIfEmpty($('[data-test-id="about-us__headquarters"] dd').first().text());

    // ─── Growth & engagement ─────────────────────────────────────
    const followerCount = parseCount(
        $('.org-top-card-summary-info-list__info-item, .top-card-layout__first-subline, .face-pile__text, h3')
            .filter((_index, element) => /follower/i.test($(element).text()))
            .first()
            .text(),
    );

    // Restricted to this company's own jobs link. The looser selector matched
    // the "Browse jobs" rail at the bottom of the page and reported Microsoft
    // as having 710,029 openings - that is every job on LinkedIn matching the
    // keyword "microsoft", not this page's postings. A confidently wrong
    // number is worse than null, so an unmatched selector yields null.
    const jobOpeningsCount = parseCount(
        $(`a[href*="/${ref.pageType}/${ref.companyId}/jobs"], a[data-tracking-control-name="org-jobs_see-all"]`)
            .filter((_index, element) => /\d/.test($(element).text()))
            .first()
            .text(),
    );

    // Showcase pages are children of a parent company. The guest page does not
    // label them, but the URL prefix does, and a page reached by slug alone can
    // still betray itself through a canonical link.
    const canonical = nullIfEmpty($('link[rel="canonical"]').attr('href'));
    const canonicalRef = canonical ? normalizeCompanyUrl(canonical) : null;
    const pageType = canonicalRef?.pageType ?? ref.pageType ?? PAGE_TYPE_PREFIXES.company;

    return {
        companyIdNumeric: null, // Filled by the caller from the raw HTML URN scan.
        pageType,

        name,
        tagline,
        about,
        logoUrl,
        coverImageUrl,

        industry: nullIfEmpty(definitions.industry)
            ?? nullIfEmpty($('.org-top-card-summary-info-list__info-item').first().text()),
        companyType: nullIfEmpty(definitions.organizationType),
        companySizeRange,
        employeeCount,
        foundedYear: parseCount(definitions.foundedOn),
        specialties: specialties ? specialties.split(/\s*,\s*/).filter(Boolean) : null,
        stockSymbol: nullIfEmpty(definitions.stockSymbol) ?? nullIfEmpty(ld.tickerSymbol),

        headquarters: nullIfEmpty(definitions.headquarters),
        address,
        locations: parseLocations($),
        phone: nullIfEmpty(definitions.phone) ?? nullIfEmpty(ld.telephone),
        website,

        followerCount,
        jobOpeningsCount,

        affiliatedCompanies: parseAffiliatedCompanies($),
        similarCompanies: parseSimilarCompanies($),
    };
}
