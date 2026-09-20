/**
 * Request labels. Only the public company page goes through the Crawlee
 * request queue; the authenticated Voyager calls run in their own serialised
 * lane (see voyager.js) because they need a sticky proxy session and a fixed
 * inter-request delay, neither of which an autoscaled pool will respect.
 */
export const LABELS = {
    COMPANY: 'COMPANY',
};

export const LINKEDIN_BASE = 'https://www.linkedin.com';
export const VOYAGER_BASE = `${LINKEDIN_BASE}/voyager/api`;

/**
 * Page kinds LinkedIn serves under different path prefixes. All three render an
 * /about page with the same guest markup, so they share one parser and only the
 * reported `pageType` differs.
 */
export const PAGE_TYPE_PREFIXES = {
    company: 'company',
    showcase: 'showcase',
    school: 'school',
};

/**
 * Which record fields come from the public guest page and which need a session
 * cookie. Used to set `sourceType` per row, and to decide whether a run needs
 * the authenticated lane at all.
 */
export const AUTHENTICATED_FIELDS = ['countryBreakdown', 'totalEmployeesOnLinkedIn'];

/**
 * Voyager needs the CSRF token to equal the JSESSIONID cookie value. This is
 * the single most common reason a hand-rolled Voyager call 403s while the same
 * cookie works fine in a browser: the token is not optional and it is not
 * arbitrary, it has to match the cookie sent alongside it.
 */
export const VOYAGER_HEADERS = {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-track': '{"clientVersion":"1.13.0","osName":"web","timezoneOffset":0,"deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
};

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

/**
 * HTTP status codes that mean the session/proxy has been rate-limited or
 * blocked. 999 is LinkedIn-specific.
 */
export const BLOCKED_STATUS_CODES = [401, 403, 429, 999];

/**
 * Text fragments that mean LinkedIn served a login wall, checkpoint, or bot
 * challenge instead of content. These come back with HTTP 200, so a status-code
 * check alone misses them entirely.
 */
export const CHALLENGE_MARKERS = [
    'checkpoint/challenge',
    'authwall',
    'id="captcha"',
    'class="challenge-dialog"',
    'unusual activity from your account',
    // LinkedIn's sign-in wall. Verified against a live gated response: it
    // carries none of the markers above, arrives with HTTP 200, and parses
    // into a company record whose name is "Sign in" and whose every other
    // field is null.
    //
    // The title is the only body string that separates the two. 'session_redirect='
    // looks like a better marker and is a trap: a normal company page carries
    // it 69 times, once per "Sign in" link in its own chrome, so matching on it
    // rejects every real page. Body markers here must appear ONLY on the wall -
    // anything a logged-out company page also renders is disqualified.
    '<title>LinkedIn Login, Sign in',
];

/**
 * Path fragments that mean a request was redirected to a wall rather than the
 * page asked for.
 *
 * Checked against the *final* URL, which is the sturdier signal: the gated
 * response is a 200 at the end of a redirect chain to /uas/login, so only the
 * landing URL reliably says what happened. Body markers are the backstop.
 */
export const WALLED_URL_PATTERNS = [
    '/uas/login',
    '/login?',
    '/authwall',
    '/checkpoint/',
    '/signup/',
];

/**
 * Countries swept when building the country breakdown, ordered by approximate
 * LinkedIn membership so the coverage early-stop (see utils.shouldStopScan)
 * fires as early as possible: a company whose staff are all in one country is
 * usually resolved within a handful of requests instead of the full list.
 *
 * These are names, not geo IDs, on purpose. LinkedIn's numeric geo URNs are
 * stable but not published, and a wrong ID does not error - it silently counts
 * employees in some other place. They are resolved through LinkedIn's own
 * typeahead at run time and cached in the key-value store, so the mapping is
 * always LinkedIn's own rather than a guess baked into this file.
 */
export const DEFAULT_COUNTRY_SCAN = [
    'United States', 'India', 'Brazil', 'United Kingdom', 'France', 'Canada',
    'Mexico', 'Italy', 'Spain', 'Germany', 'Netherlands', 'Australia',
    'Colombia', 'Argentina', 'Philippines', 'Indonesia', 'Poland', 'Turkey',
    'China', 'Japan', 'Chile', 'Peru', 'Ireland', 'Portugal', 'Belgium',
    'Sweden', 'Switzerland', 'Romania', 'South Africa', 'Nigeria', 'Egypt',
    'United Arab Emirates', 'Saudi Arabia', 'Israel', 'Singapore', 'Malaysia',
    'Thailand', 'Vietnam', 'Pakistan', 'Bangladesh', 'Kenya', 'Morocco',
    'Czechia', 'Austria', 'Denmark', 'Norway', 'Finland', 'Greece', 'Hungary',
    'Ukraine', 'New Zealand', 'South Korea', 'Hong Kong', 'Taiwan',
    'Costa Rica', 'Ecuador', 'Uruguay', 'Guatemala', 'Dominican Republic',
    'Sri Lanka', 'Nepal', 'Ghana', 'Tunisia', 'Serbia', 'Bulgaria', 'Croatia',
    'Slovakia', 'Lithuania', 'Latvia', 'Estonia', 'Luxembourg', 'Qatar',
    'Kuwait', 'Jordan', 'Lebanon', 'Panama', 'Bolivia', 'Paraguay', 'Venezuela',
    'Puerto Rico', 'Russia', 'Kazakhstan', 'Azerbaijan', 'Georgia', 'Armenia',
    'Cyprus', 'Malta', 'Iceland', 'Slovenia', 'Bosnia and Herzegovina',
    'Albania', 'North Macedonia', 'Moldova', 'Belarus', 'Uzbekistan',
    'Algeria', 'Ethiopia', 'Tanzania', 'Uganda', 'Zimbabwe', 'Senegal',
    'Cameroon', "Cote d'Ivoire", 'Angola', 'Mozambique', 'Zambia', 'Botswana',
    'Mauritius', 'Myanmar', 'Cambodia', 'Mongolia', 'Fiji', 'Oman', 'Bahrain',
    'Iraq', 'Afghanistan', 'Honduras', 'Nicaragua', 'El Salvador', 'Jamaica',
    'Trinidad and Tobago', 'Barbados', 'Bahamas', 'Cuba', 'Haiti',
];

/**
 * Default tunables. Everything here is overridable from actor input; nothing in
 * the crawler should hardcode a number that appears in this object.
 */
export const DEFAULTS = {
    /** Public guest pages need no login, so they can run wide. */
    MAX_CONCURRENCY: 8,
    MIN_CONCURRENCY: 1,
    REQUESTS_PER_MINUTE_MULTIPLIER: 30,

    MAX_REQUEST_RETRIES: 4,
    REQUEST_HANDLER_TIMEOUT_SECS: 60,
    RETRY_BACKOFF_BASE_MS: 2000,
    RETRY_BACKOFF_CAP_MS: 60_000,

    SESSION_POOL_MAX_SIZE: 20,
    SESSION_MAX_USAGE_COUNT: 10,

    /**
     * Seconds between authenticated Voyager requests. The spec's 1.5-2s band,
     * midpoint. Jittered per request (see voyager.js) rather than fixed: a
     * metronome-regular request train is itself a bot signal.
     */
    REQUEST_DELAY_SECONDS: 1.75,
    /** Voyager calls are serialised. Raising this is how accounts get burned. */
    VOYAGER_CONCURRENCY: 1,
    VOYAGER_TIMEOUT_MS: 30_000,
    VOYAGER_MAX_RETRIES: 3,

    /**
     * Stop the country sweep once this share of totalEmployeesOnLinkedIn has
     * been accounted for. Not 1.0: members with no listed location never show
     * up in any country bucket, so a sweep waiting for a perfect reconciliation
     * would always run the full list.
     */
    COUNTRY_SCAN_COVERAGE: 0.97,
    /** Consecutive empty countries before the sweep gives up on the tail. */
    COUNTRY_SCAN_EMPTY_STREAK: 12,
    /** Hard ceiling on countries queried per company, regardless of coverage. */
    MAX_COUNTRIES_SCANNED: 130,

    /** Cached rows younger than this are reused instead of re-scraped. */
    CACHE_TTL_DAYS: 7,

    /** Minimum attempts before the error rate is trusted enough to act on. */
    ERROR_RATE_MIN_SAMPLE: 10,
    ERROR_RATE_THRESHOLD: 0.3,
};
