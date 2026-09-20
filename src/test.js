/**
 * Test suite for the LinkedIn Company Workforce & Profile Intelligence actor.
 *
 * Parsers are tested against sample HTML shaped like LinkedIn's guest company
 * about page, and the Voyager helpers against the response envelopes LinkedIn
 * actually returns. Nothing here touches the network.
 */
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import {
    parseCompanyAbout, parseJsonLd, parseAboutDefinitions, parseLocations,
    parseAffiliatedCompanies, parseSimilarCompanies, parseRecentUpdates, parseFeaturedEmployees,
} from './parsers.js';
import { findDeep, extractTotal, VoyagerClient, VoyagerBlockedError, VoyagerBudgetError } from './voyager.js';
import {
    cleanText, nullIfEmpty, parseCount, normalizeCompanyUrl, buildAboutUrl, extractOrgId,
    isChallengePage, makeCsrfPair, shouldStopScan, finalizeBreakdown, applyToggles,
    cacheKey, isCacheFresh,
} from './utils.js';
import { DEFAULT_COUNTRY_SCAN } from './constants.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${message}`);
    } else {
        failed++;
        console.error(`  ❌ ${message}`);
    }
}

// ─── Sample HTML ─────────────────────────────────────────────────────
// Mirrors LinkedIn's guest /company/<slug>/about/ markup: a JSON-LD block, the
// top card, the about definition list, and the affiliated/similar card grids.
const SAMPLE_ABOUT_HTML = `
<html>
<head>
  <link rel="canonical" href="https://www.linkedin.com/company/acme-corp/about/">
  <meta property="og:image" content="https://media.licdn.com/dms/image/cover.png">
  <script type="application/ld+json">
  {
    "@context": "http://schema.org",
    "@type": "Organization",
    "name": "Acme Corporation",
    "description": "Acme builds industrial hardware for road runners and coyotes alike.",
    "url": "https://www.acme-corp.example",
    "logo": { "@type": "ImageObject", "contentUrl": "https://media.licdn.com/dms/image/logo.png" },
    "telephone": "+1 555 0100",
    "tickerSymbol": "ACME",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "1 Anvil Way",
      "addressLocality": "Fairfield",
      "addressRegion": "NJ",
      "postalCode": "07004",
      "addressCountry": "US"
    },
    "numberOfEmployees": { "@type": "QuantitativeValue", "value": 4213 }
  }
  </script>
</head>
<body>
  <section class="top-card-layout">
    <a data-entity-urn="urn:li:organization:99887766" href="/company/acme-corp/">
      <img class="top-card-layout__entity-image" data-delayed-url="https://media.licdn.com/dms/image/logo.png">
    </a>
    <h1 class="org-top-card-summary__title">Acme Corporation</h1>
    <h2 class="org-top-card-summary__tagline">Building tomorrow's anvils, today</h2>
    <div class="org-top-card-summary-info-list">
      <div class="org-top-card-summary-info-list__info-item">Industrial Machinery Manufacturing</div>
      <div class="org-top-card-summary-info-list__info-item">Fairfield, NJ</div>
      <div class="org-top-card-summary-info-list__info-item">4,213 associated members</div>
      <div class="org-top-card-summary-info-list__info-item">182,405 followers</div>
    </div>
    <a href="/company/acme-corp/jobs/">See all 57 jobs</a>
  </section>

  <section class="core-section-container about-us">
    <p data-test-id="about-us__description">Acme builds industrial hardware.</p>
    <dl>
      <div data-test-id="about-us__website"><dt>Website</dt><dd><a href="https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fwww%2Eacme-corp%2Eexample&amp;urlhash=abcd">acme-corp.example</a></dd></div>
      <div data-test-id="about-us__phone"><dt>Phone</dt><dd>+1 555 0100</dd></div>
      <div data-test-id="about-us__industry"><dt>Industry</dt><dd>Industrial Machinery Manufacturing</dd></div>
      <div data-test-id="about-us__companySize"><dt>Company size</dt><dd>1,001-5,000 employees</dd></div>
      <div data-test-id="about-us__headquarters"><dt>Headquarters</dt><dd>Fairfield, NJ</dd></div>
      <div data-test-id="about-us__organizationType"><dt>Type</dt><dd>Public Company</dd></div>
      <div data-test-id="about-us__foundedOn"><dt>Founded</dt><dd>1952</dd></div>
      <div data-test-id="about-us__specialties"><dt>Specialties</dt><dd>Anvils, Rocket skates, Giant rubber bands</dd></div>
    </dl>
  </section>

  <section data-test-id="about-us__locations">
    <h2>Locations</h2>
    <ul>
      <li>1 Anvil Way, Fairfield, NJ 07004, US</li>
      <li>12 Pitfall Road, Dublin, D02, IE</li>
      <li>88 Rocket Lane, Bengaluru, KA, IN</li>
    </ul>
  </section>

  <section class="affiliated-companies">
    <h2>Affiliated pages</h2>
    <ul>
      <li class="base-card"><a href="https://www.linkedin.com/company/acme-europe?trk=x"><h3 class="base-main-card__title">Acme Europe</h3></a></li>
      <li class="base-card"><a href="/showcase/acme-rockets/"><h3 class="base-main-card__title">Acme Rockets</h3></a></li>
    </ul>
  </section>

  <section class="similar-pages">
    <h2>Similar pages</h2>
    <ul>
      <li class="base-card"><a href="/company/globex/"><h3 class="base-main-card__title">Globex</h3></a></li>
    </ul>
  </section>

  <section class="feed">
    <article class="main-feed-activity-card">
      <p class="attributed-text-segment-list__content">We just shipped the Mark VII anvil.</p>
      <time datetime="2026-09-01">3 weeks ago</time>
      <span data-test-id="social-actions__reaction-count">1,204</span>
      <span data-test-id="social-actions__comments">87 comments</span>
    </article>
  </section>

  <section class="people">
    <ul>
      <li class="base-card">
        <a href="https://www.linkedin.com/in/wile-e-coyote?trk=y">
          <img data-delayed-url="https://media.licdn.com/dms/image/wile.png" alt="Wile E. Coyote">
        </a>
        <h3 class="base-main-card__title">Wile E. Coyote</h3>
        <h4 class="base-main-card__subtitle">Chief Procurement Officer</h4>
      </li>
    </ul>
  </section>
</body>
</html>
`;

const $ = load(SAMPLE_ABOUT_HTML);
const REF = { companyUrl: 'https://www.linkedin.com/company/acme-corp', companyId: 'acme-corp', pageType: 'company' };

// ─── normalizeCompanyUrl() ───────────────────────────────────────────
console.log('\n🧪 Testing normalizeCompanyUrl()');
{
    assert(normalizeCompanyUrl('microsoft').companyUrl === 'https://www.linkedin.com/company/microsoft',
        'accepts a bare slug');
    assert(normalizeCompanyUrl('https://www.linkedin.com/company/acme-corp/about/?trk=x').companyId === 'acme-corp',
        'strips /about and tracking params');
    assert(normalizeCompanyUrl('linkedin.com/company/acme-corp').companyUrl
        === normalizeCompanyUrl('https://uk.linkedin.com/company/ACME-CORP/people/').companyUrl,
        'collapses locale subdomains and casing to one canonical URL');
    assert(normalizeCompanyUrl('https://www.linkedin.com/showcase/microsoft-azure').pageType === 'showcase',
        'detects showcase pages');
    assert(normalizeCompanyUrl('https://www.linkedin.com/school/mit/').pageType === 'school',
        'detects school pages');
    assert(normalizeCompanyUrl('https://www.linkedin.com/in/someone') === null,
        'rejects a member profile URL');
    assert(normalizeCompanyUrl('') === null && normalizeCompanyUrl(null) === null,
        'rejects empty input');
    assert(normalizeCompanyUrl({ url: 'microsoft' }).companyId === 'microsoft',
        'accepts the requestListSources object form');
    assert(buildAboutUrl('https://www.linkedin.com/company/acme-corp/')
        === 'https://www.linkedin.com/company/acme-corp/about/',
        'builds the about URL without doubling the slash');
}

// ─── parseCount() ────────────────────────────────────────────────────
console.log('\n🧪 Testing parseCount()');
{
    assert(parseCount('10,001+ employees') === 10001, 'parses a bucketed employee count');
    assert(parseCount('1.2M followers') === 1200000, 'expands the M suffix');
    assert(parseCount('24K followers') === 24000, 'expands the K suffix');
    assert(parseCount('2-10 employees') === 2, 'takes the first figure of a range');
    assert(parseCount('See all jobs') === null, 'returns null when there is no figure');
    assert(parseCount('') === null && parseCount(null) === null, 'returns null for empty input');
}

// ─── nullIfEmpty() ───────────────────────────────────────────────────
console.log('\n🧪 Testing nullIfEmpty()');
{
    assert(nullIfEmpty('  ') === null, 'whitespace-only becomes null, not an empty string');
    assert(nullIfEmpty('\n Acme  Corp \n') === 'Acme Corp', 'collapses internal whitespace');
    assert(cleanText(undefined) === '', 'cleanText tolerates undefined');
}

// ─── extractOrgId() ──────────────────────────────────────────────────
console.log('\n🧪 Testing extractOrgId()');
{
    assert(extractOrgId(SAMPLE_ABOUT_HTML) === '99887766', 'finds the organization URN in raw page HTML');
    assert(extractOrgId('{"entityUrn":"urn:li:fsd_company:1035"}') === '1035', 'handles the fsd_company URN form');
    assert(extractOrgId('<a href="/company/1234567/">x</a>') === '1234567', 'falls back to a numeric company path');
    assert(extractOrgId('<a href="/company/acme-corp/">x</a>') === null, 'does not mistake a slug for an ID');
    assert(extractOrgId(null) === null, 'tolerates missing HTML');
}

// ─── isChallengePage() ───────────────────────────────────────────────
console.log('\n🧪 Testing isChallengePage()');
{
    assert(isChallengePage('<html><a href="/checkpoint/challenge/x">') === true, 'detects a checkpoint page');
    assert(isChallengePage('<div class="authwall">') === true, 'detects the auth wall');
    assert(isChallengePage(SAMPLE_ABOUT_HTML) === false, 'passes a real company page through');
    assert(isChallengePage(null) === false, 'tolerates a missing body');
}

// ─── makeCsrfPair() ──────────────────────────────────────────────────
console.log('\n🧪 Testing makeCsrfPair()');
{
    const { token, cookie } = makeCsrfPair();
    // LinkedIn 403s when csrf-token and the JSESSIONID cookie disagree, which
    // is the usual reason a cookie that works in a browser fails here.
    assert(cookie === `JSESSIONID="${token}"`, 'the CSRF token and JSESSIONID cookie always match');
    assert(token.startsWith('ajax:'), 'token carries the ajax: prefix LinkedIn expects');
    assert(makeCsrfPair().token !== token, 'a fresh pair is minted per client');
}

// ─── parseJsonLd() / parseAboutDefinitions() ─────────────────────────
console.log('\n🧪 Testing JSON-LD and about-panel extraction');
{
    const ld = parseJsonLd($);
    assert(ld?.name === 'Acme Corporation', 'reads the Organization block');
    assert(parseJsonLd(load('<script type="application/ld+json">{ broken</script>')) === null,
        'a malformed JSON-LD block does not throw');
    assert(parseJsonLd(load('<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"G"}]}</script>'))?.name === 'G',
        'unwraps the @graph form');

    const defs = parseAboutDefinitions($);
    assert(defs.companySize === '1,001-5,000 employees', 'reads company size from the definition list');
    assert(defs.foundedOn === '1952', 'reads the founded year');
    assert(defs.specialties.includes('Rocket skates'), 'reads the specialties string');

    // The older layout has no data-test-id attributes at all.
    const legacy = parseAboutDefinitions(load('<dl><dt>Company size</dt><dd>51-200 employees</dd></dl>'));
    assert(legacy.companySize === '51-200 employees', 'falls back to dt label text when data-test-ids are absent');
}

// ─── parseCompanyAbout() ─────────────────────────────────────────────
console.log('\n🧪 Testing parseCompanyAbout()');
{
    const record = parseCompanyAbout($, SAMPLE_ABOUT_HTML, REF);

    assert(record.name === 'Acme Corporation', 'extracts the name');
    assert(record.tagline === "Building tomorrow's anvils, today", 'extracts the tagline');
    assert(record.about === 'Acme builds industrial hardware for road runners and coyotes alike.',
        'prefers the JSON-LD description over the truncated DOM copy');
    assert(record.logoUrl === 'https://media.licdn.com/dms/image/logo.png', 'extracts the logo');
    assert(record.coverImageUrl === 'https://media.licdn.com/dms/image/cover.png', 'falls back to og:image for the cover');

    assert(record.industry === 'Industrial Machinery Manufacturing', 'extracts the industry');
    assert(record.companyType === 'Public Company', 'extracts the company type');
    assert(record.companySizeRange === '1,001-5,000 employees', 'keeps the bucketed size band as text');
    // The band and the exact count are different numbers on the same page, and
    // only the exact one is usable as a percentage denominator.
    assert(record.employeeCount === 4213, 'prefers the exact member count over the size band');
    assert(record.foundedYear === 1952, 'extracts the founded year as a number');
    assert(Array.isArray(record.specialties) && record.specialties.length === 3,
        'splits specialties into an array');
    assert(record.stockSymbol === 'ACME', 'extracts the ticker symbol');

    assert(record.headquarters === 'Fairfield, NJ', 'extracts the headquarters');
    assert(record.address === '1 Anvil Way, Fairfield, NJ, 07004, US', 'flattens the JSON-LD postal address');
    assert(record.phone === '+1 555 0100', 'extracts the phone number');
    assert(record.website === 'https://www.acme-corp.example',
        'unwraps the website out of LinkedIn\'s outbound redirector');

    assert(record.followerCount === 182405, 'extracts the follower count');
    assert(record.jobOpeningsCount === 57, 'extracts the open jobs count');
    assert(record.pageType === 'company', 'resolves page type from the canonical link');

    assert(record.locations.length === 3, 'extracts every declared office, not just the HQ');
    assert(record.affiliatedCompanies.length === 2, 'extracts affiliated pages');
    assert(record.affiliatedCompanies[0].url === 'https://www.linkedin.com/company/acme-europe',
        'canonicalises affiliated company URLs');
    assert(record.similarCompanies.length === 1, 'extracts similar pages');
    assert(!record.similarCompanies.some((c) => /acme-europe/.test(c.url)),
        'does not leak affiliated pages into similar pages');
}

// ─── Optional sections ───────────────────────────────────────────────
console.log('\n🧪 Testing optional section parsers');
{
    const updates = parseRecentUpdates($);
    assert(updates.length === 1, 'extracts a recent post');
    assert(updates[0].likes === 1204, 'parses the reaction count');
    assert(updates[0].engagement.comments === 87, 'keeps comments separate from reactions');
    assert(updates[0].engagement.total === 1291, 'totals engagement across both');
    assert(updates[0].date === '2026-09-01', 'prefers the machine-readable datetime');

    const employees = parseFeaturedEmployees($);
    assert(employees.length === 1, 'extracts a featured employee');
    assert(employees[0].name === 'Wile E. Coyote', 'reads the employee name');
    assert(employees[0].title === 'Chief Procurement Officer', 'reads the employee title');
    assert(employees[0].profileUrl === 'https://www.linkedin.com/in/wile-e-coyote',
        'strips tracking params from the profile URL');

    assert(parseLocations(load('<section><h2>Locations</h2><p>Berlin, Germany</p></section>'))
        .includes('Berlin, Germany'), 'falls back to a heading walk when there is no list markup');
}

// ─── findDeep() / extractTotal() ─────────────────────────────────────
console.log('\n🧪 Testing Voyager response digging');
{
    // Voyager returns the same logical total under different envelopes
    // depending on endpoint generation and decoration ID.
    assert(extractTotal({ data: { data: { searchDashClustersByAll: { paging: { total: 4213 } } } } }) === 4213,
        'reads a total out of the dash/clusters envelope');
    assert(extractTotal({ data: { metadata: { totalResultCount: 99 }, paging: { total: 10 } } }) === 99,
        'prefers totalResultCount over a window-capped paging total');
    assert(extractTotal({ elements: [] }) === null, 'returns null when no total is present');
    assert(extractTotal(null) === null, 'tolerates a null payload');
    assert(Array.isArray(findDeep({ a: { b: { elements: [1, 2] } } }, ['elements'])),
        'finds a nested elements array');
    assert(findDeep({ a: 1 }, ['missing']) === undefined, 'returns undefined for an absent key');
}

// ─── VoyagerClient bookkeeping ───────────────────────────────────────
console.log('\n🧪 Testing VoyagerClient bookkeeping');
{
    const client = new VoyagerClient({ sessionCookie: 'fake', maxRequests: 2 });

    assert(client.cookieHeader.startsWith('li_at=fake; JSESSIONID="'),
        'the cookie header carries li_at and a matching JSESSIONID');
    assert(client.cookieHeader.includes(client.csrfToken),
        'the CSRF token sent as a header is the one in the cookie');
    assert(client.budgetExhausted === false, 'a fresh client has budget');

    client.requestsMade = 2;
    assert(client.budgetExhausted === true, 'budget is exhausted at the cap');
    // Budget exhaustion and a LinkedIn block both end authenticated work, but
    // they mean opposite things in the row's `error` string.
    assert(!(new VoyagerBudgetError('x') instanceof VoyagerBlockedError),
        'a spent budget is not reported as a LinkedIn block');

    client.primeGeoCache({ 'United States': '103644278', Atlantis: null });
    assert(client.geoCache.get('atlantis') === null,
        'a failed lookup stays memoised in-run so it is not retried per country');
    // Exporting it would mark the country as permanently geo-less for every
    // future run after a single flaky typeahead request.
    assert(!('Atlantis' in client.exportGeoCache()),
        'a failed lookup is never persisted to the cross-run geo cache');
    // Keys round-trip lowercased, matching how resolveGeoId looks them up.
    assert(client.exportGeoCache()['united states'] === '103644278',
        'successful lookups are persisted, keyed as they are looked up');
}

// ─── shouldStopScan() ────────────────────────────────────────────────
console.log('\n🧪 Testing shouldStopScan()');
{
    const stop = (s, o) => shouldStopScan(s, o).stop;

    assert(stop({ accounted: 980, total: 1000, emptyStreak: 0, scanned: 3 }) === true,
        'stops once coverage is reached');
    assert(stop({ accounted: 400, total: 1000, emptyStreak: 0, scanned: 3 }) === false,
        'keeps going while most of the workforce is unaccounted for');
    assert(stop({ accounted: 500, total: 1000, emptyStreak: 12, scanned: 40 }) === true,
        'stops on a long empty tail');
    // A company whose first countries are all empty has not been found yet;
    // stopping there would abandon the sweep before reaching its real market.
    assert(stop({ accounted: 0, total: 1000, emptyStreak: 40, scanned: 40 }) === false,
        'does not stop on an empty streak before anything has been found');
    assert(stop({ accounted: 10, total: null, emptyStreak: 0, scanned: 130 }) === true,
        'stops at the per-company country ceiling');
    assert(stop({ accounted: 0, total: null, emptyStreak: 0, scanned: 5 }) === false,
        'tolerates an unknown total');
    assert(shouldStopScan({ accounted: 990, total: 1000, emptyStreak: 0, scanned: 5 }).reason === 'coverageReached',
        'reports why it stopped');
}

// ─── finalizeBreakdown() ─────────────────────────────────────────────
console.log('\n🧪 Testing finalizeBreakdown()');
{
    const rows = finalizeBreakdown([
        { country: 'India', employeeCount: 300 },
        { country: 'United States', employeeCount: 600 },
        { country: 'Nowhere', employeeCount: 0 },
    ], 1000);

    assert(rows.length === 2, 'drops zero-count countries');
    assert(rows[0].country === 'United States', 'sorts by headcount descending');
    assert(rows[0].percentOfTotal === 60, 'computes share against the LinkedIn total');
    // Normalising to the bucket sum instead would report 66.7/33.3 and make a
    // partial sweep look like a complete one.
    assert(rows[1].percentOfTotal === 30, 'does not normalise shares to the bucket sum');
    assert(finalizeBreakdown([{ country: 'X', employeeCount: 5 }], null)[0].percentOfTotal === null,
        'leaves the share null when no denominator is known');
    assert(finalizeBreakdown([], 100).length === 0, 'handles an empty breakdown');
}

// ─── applyToggles() ──────────────────────────────────────────────────
console.log('\n🧪 Testing applyToggles()');
{
    const out = applyToggles({ name: 'X', locations: [], specialties: ['a'] },
        { locations: false, specialties: true });
    // Removed, not nulled: "you asked us not to look" is a different statement
    // from "we looked and found none".
    assert(!('locations' in out), 'a disabled section is removed, not set to null');
    assert(out.specialties.length === 1, 'an enabled section is kept');
    assert(out.name === 'X', 'untoggled fields pass through');
}

// ─── Caching ─────────────────────────────────────────────────────────
console.log('\n🧪 Testing cache helpers');
{
    assert(cacheKey('acme-corp', 'company') === 'CACHE-company-acme-corp', 'builds a readable cache key');
    assert(!/[^a-zA-Z0-9!\-_.'()]/.test(cacheKey('acme/corp ürgh', 'company').replace('CACHE-company-', '')),
        'sanitises slugs to the key-value store\'s allowed character set');

    const fresh = { dataFetchedAt: new Date().toISOString() };
    const stale = { dataFetchedAt: new Date(Date.now() - 30 * 864e5).toISOString() };
    assert(isCacheFresh(fresh, 7) === true, 'a same-day entry is fresh');
    assert(isCacheFresh(stale, 7) === false, 'a 30-day-old entry is stale at a 7-day TTL');
    assert(isCacheFresh(fresh, 0) === false, 'a TTL of 0 disables caching');
    assert(isCacheFresh(null, 7) === false, 'a missing entry is never fresh');
    assert(isCacheFresh({ dataFetchedAt: 'not a date' }, 7) === false, 'an unparseable timestamp is never fresh');
}

// ─── Country scan list ───────────────────────────────────────────────
console.log('\n🧪 Testing the country scan list');
{
    assert(new Set(DEFAULT_COUNTRY_SCAN).size === DEFAULT_COUNTRY_SCAN.length,
        'the default country list has no duplicates');
    assert(DEFAULT_COUNTRY_SCAN[0] === 'United States' && DEFAULT_COUNTRY_SCAN[1] === 'India',
        'the list leads with LinkedIn\'s largest markets, so the coverage early-stop fires sooner');
    assert(DEFAULT_COUNTRY_SCAN.every((c) => typeof c === 'string' && c.trim() === c),
        'every entry is a clean country name for typeahead resolution');
}

// ─── Dataset schema coverage ─────────────────────────────────────────
// Apify runs AJV validation on every dataset insert and discards items that do
// not match, returning HTTP 400 - so a field the pipeline emits but the schema
// does not declare loses data silently rather than erroring.
console.log('\n🧪 Testing dataset schema coverage');
{
    const schema = JSON.parse(readFileSync(new URL('../.actor/dataset_schema.json', import.meta.url)));
    const declared = new Set(Object.keys(schema.fields.properties));

    const emitted = [
        ...Object.keys(parseCompanyAbout($, SAMPLE_ABOUT_HTML, REF)),
        'companyUrl', 'companyId', 'success', 'error', 'dataFetchedAt', 'sourceType',
        'countryBreakdown', 'totalEmployeesOnLinkedIn', 'countryScan',
        'recentUpdates', 'featuredEmployees', 'websiteStatus', 'fromCache',
    ];
    const undeclared = [...new Set(emitted)].filter((field) => !declared.has(field));
    assert(undeclared.length === 0, `every emitted field is declared in dataset_schema.json${undeclared.length ? ` (missing: ${undeclared.join(', ')})` : ''}`);

    assert(!('required' in schema.fields),
        'the dataset schema declares no required fields, so partial rows are not discarded');
    assert(Object.values(schema.fields.properties).every((f) => f.type.includes('null')),
        'every dataset field is a nullable union');
    assert(schema.actorSpecification === 1, 'dataset_schema.json uses the actorSpecification marker, not schemaVersion');

    const inputSchema = JSON.parse(readFileSync(new URL('../.actor/input_schema.json', import.meta.url)));
    assert(inputSchema.schemaVersion === 1, 'input_schema.json uses the schemaVersion marker');
    const outputSchema = JSON.parse(readFileSync(new URL('../.actor/output_schema.json', import.meta.url)));
    assert(outputSchema.actorOutputSchemaVersion === 1,
        'output_schema.json uses actorOutputSchemaVersion and links storages, not fields');
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
    console.error('\n💥 Some tests FAILED!');
    process.exit(1);
} else {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
}
