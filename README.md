# 🌍 LinkedIn Company Workforce & Profile Intelligence

**Where a company *says* it operates, and where its people *actually are*.** Give this Actor a list of LinkedIn company URLs and get back a full company profile plus a complete employee-by-country breakdown — not just the top 5 locations LinkedIn shows on the page.

LinkedIn publishes a company's five largest employee locations and hides the rest behind a login. This Actor combines the public firmographic page with authenticated location facets to reconstruct the whole distribution.

---

## 📑 Table of Contents

- [🔍 What does this Actor do?](#-what-does-this-actor-do)
- [🚀 Why use this Actor?](#-why-use-this-actor)
- [⚙️ How it works](#️-how-it-works)
- [📥 Input](#-input)
- [📤 Output](#-output)
- [⏱️ Run time and cost](#️-run-time-and-cost)
- [🎯 Use cases](#-use-cases)
- [❓ FAQ](#-faq)
- [🏁 Getting started](#-getting-started)
- [⚠️ Limitations and known issues](#️-limitations-and-known-issues)
- [⚖️ Legal and responsible use](#️-legal-and-responsible-use)

---

## 🔍 What does this Actor do?

For every LinkedIn company, showcase, or school page you give it, this Actor returns **one row per declared office** (or one row per company, if you prefer — see [Output mode](#-output-mode)), containing:

- 🏢 **The full profile** — name, tagline, about text, industry, company type, size band, founded year, specialties, ticker, logo and cover image.
- 📍 **Location and contact** — headquarters, full structured address, *every* declared office location, phone, website (with an optional DNS check that the domain still resolves).
- 📈 **Growth signals** — follower count, open job count, and optionally recent posts with engagement.
- 🔗 **Relationships** — affiliated, subsidiary, regional and showcase pages, plus LinkedIn's own "similar companies" suggestions.
- 🌍 **The country breakdown** — employee headcount and percentage share *per country*, well past LinkedIn's default top-5 display.

The country breakdown is the reason this Actor exists. Everything else is available on the public page; that one field is not.

---

## 🚀 Why use this Actor?

- 🌍 **The whole map, not the top 5.** LinkedIn's page shows five locations. This returns every country where a company has staff on the platform, with counts and shares.
- 🔎 **Declared offices vs. actual distribution.** `locations` is where a company *says* it operates. `countryBreakdown` is where its people are. The gap between them is usually the most interesting thing in the row.
- 🧾 **Profile and workforce in one request.** No separate enrichment pass, no joining two datasets on a slug.
- 🛡️ **Built to protect the account you give it.** Authenticated calls are strictly serialised, jittered, pinned to one sticky proxy session, and bounded by a request budget you set. One block ends the authenticated pass instead of grinding through the rest of your list confirming it.
- 🧠 **It tells you when a sweep was cut short.** `countryScan.stopReason` and `countryScan.coverage` distinguish a complete sweep from a truncated one, so a partial breakdown is never mistaken for a full one.
- 💾 **Caching that actually saves money.** Firmographics and country distribution change slowly. A configurable TTL (default 7 days) reuses a stored row instead of re-spending authenticated request budget on an unchanged company.
- ✅ **Tested.** 160 automated tests cover the parsers, the scan logic, and the schema contract.

---

## ⚙️ How it works

The run has two deliberately separate lanes, because the two halves of the data have opposite constraints.

**Lane 1 — public pages (fast, concurrent, no login).**
Fetches each company's guest `/about/` page over plain HTTP and parses it with Cheerio, preferring the embedded JSON-LD over the DOM wherever it carries the field. This yields everything except the country breakdown, and it runs at whatever concurrency you set.

**Lane 2 — authenticated country sweep (slow, serialised, one request per country).**
For each company, LinkedIn's internal numeric organization ID is read out of the public page, then people-search totals are counted per country. This lane:

- runs **one request at a time**, never in parallel;
- waits a **jittered 1.5–2s** between requests (a metronome-regular request train is itself a bot signal);
- uses **one sticky proxy session for the entire run** — rotating IPs inside a single authenticated session is a bigger anomaly than any individual request;
- resolves country → geo ID through **LinkedIn's own typeahead**, cached across runs, rather than a hardcoded table (a wrong geo ID does not error — it returns a clean count for the wrong place, which is worse);
- **stops early** once enough of the company's headcount has been placed in a country, or once the tail goes quiet.

---

## 📥 Input

### 🏢 Companies

| Field | Type | Required | Description |
|---|---|---|---|
| `companyUrls` | array | ✅ | LinkedIn company / showcase / school URLs, or bare slugs. `microsoft`, `linkedin.com/company/microsoft`, and `https://uk.linkedin.com/company/Microsoft/about/` all resolve to the same row. |
| `outputMode` | select | — | `location` (**default**) = one row per declared office. `company` = one row per company. |

### 🏫 Output mode

**By default you get one row per campus** — Microsoft returns 45 rows, one for each declared office, with the company's identity repeated on every row and the address broken into components. Set `outputMode` to `company` if you want a single profile row per input URL instead:

| Field | Example |
|---|---|
| `city` / `region` / `postalCode` | `Redmond` / `Washington` / `98052` |
| `countryCode` / `country` | `US` / `United States` |
| `street` | `1 Microsoft Way` (including building and floor lines) |
| `formattedAddress` | `1 Microsoft Way, Redmond, Washington 98052, US` |
| `isPrimaryLocation` | `true` for the HQ |
| `mapUrl` | LinkedIn's "Get directions" link |
| `locationIndex` / `locationCount` | `0` / `45` |
| `employeesInCountry` | `118000` — joined from the country sweep, free |
| `percentOfWorkforceInCountry` | `50.9` |
| `employeesAtLocation` | metro-level headcount — opt-in, costs one request per campus |
| `locationGeoName` | `Redmond, Washington, United States` — the metro LinkedIn actually matched |

Address parsing was validated against all 45 live Microsoft campuses, which is where the awkward cases came from: two-token UK (`RG6 1WG`) and Canadian (`L5N 8L9`) postcodes, German addresses with no region, Danish addresses that lead with the postal code, Philippine addresses with a tower name on its own line, and Thai offices written in Thai script.

⚠️ **`employeesInCountry` is country-level, not campus-level.** Every campus in Germany carries Microsoft's German headcount. If a country has several offices, this does not tell you how they split — enable `includeLocationEmployeeCounts` for a metro-level figure, or read it as "this office is in a country where the company has N people".

### 🔑 Authentication

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionCookie` | string (secret) | Only for the country breakdown | The `li_at` cookie value from a logged-in LinkedIn session. Every other field works without it. |

> ⚠️ **Read before enabling the country breakdown.** LinkedIn gates location facets beyond the top 5 behind a login, so there is no cookie-free path to this field. Automated requests against an account can get it restricted — **use a secondary account, not your main one**, pair it with residential proxies, and leave the request delay at its default.

### 📦 Output sections

| Field | Type | Default | Description |
|---|---|---|---|
| `includeCountryBreakdown` | boolean | `true` | Employee count per country. Needs the cookie. The slowest part of any run. |
| `includeLocationEmployeeCounts` | boolean | `false` | Metro-level headcount per campus. Needs the cookie and `outputMode: "location"`. ~1 extra request per office — Microsoft's 45 campuses add ~90 seconds. |
| `includeLocations` | boolean | `true` | Every declared office, not just the HQ. Always on in location mode. |
| `includeSpecialties` | boolean | `true` | Self-declared focus tags. |
| `includeAffiliatedCompanies` | boolean | `true` | Subsidiary / regional / showcase pages. |
| `includeSimilarCompanies` | boolean | `false` | LinkedIn's "similar pages" suggestions. |
| `includeRecentUpdates` | boolean | `false` | Recent posts with dates and engagement. |
| `includeFeaturedEmployees` | boolean | `false` | The small profile sample LinkedIn shows publicly. |

Sections you switch off are **removed** from the row, not set to `null` — "you asked us not to look" is a different statement from "we looked and found none".

### 🌐 Country scan

| Field | Type | Default | Description |
|---|---|---|---|
| `countries` | array | `[]` | Restrict the sweep to these countries. Empty sweeps a built-in list of 125, ordered by LinkedIn membership. **Setting this is the single most effective way to cut run time.** |
| `countryScanCoveragePercent` | integer | `97` | Stop once this share of the company's LinkedIn headcount has been placed in a country. |
| `maxCountriesScanned` | integer | `130` | Hard ceiling per company. |
| `maxAuthenticatedRequests` | integer | — | Hard budget for the whole run. Once spent, remaining companies return public fields only. |
| `requestDelayMs` | integer | `1750` | Spacing between authenticated requests, jittered ±20%. |

### 🛠️ Run control

| Field | Type | Default | Description |
|---|---|---|---|
| `verifyWebsite` | boolean | `false` | DNS-check the listed website domain and report `websiteStatus`. One DNS lookup, no HTTP request. |
| `cacheTtlDays` | integer | `7` | Reuse a stored row scraped within this many days. `0` always re-scrapes. |
| `proxyConfiguration` | object | Apify Proxy | Residential strongly recommended, near-mandatory with a cookie. |
| `maxConcurrency` | integer | `8` | Public-page phase only. The authenticated lane is always serialised. |
| `maxRequestRetries` | integer | `4` | Retries before a public page is returned as `success: false`. |

### 📝 Example input

```json
{
  "companyUrls": [
    "https://www.linkedin.com/company/microsoft",
    "stripe",
    "linkedin.com/company/spotify"
  ],
  "sessionCookie": "AQEDAT...",
  "includeCountryBreakdown": true,
  "countries": ["United States", "India", "Ireland", "Germany", "United Kingdom", "Poland"],
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

---

## 📤 Output

One row per company. Abbreviated:

```json
{
  "companyUrl": "https://www.linkedin.com/company/acme-corp",
  "companyId": "acme-corp",
  "companyIdNumeric": "99887766",
  "pageType": "company",
  "success": true,
  "error": null,

  "name": "Acme Corporation",
  "tagline": "Building tomorrow's anvils, today",
  "industry": "Industrial Machinery Manufacturing",
  "companyType": "Public Company",
  "companySizeRange": "1,001-5,000 employees",
  "employeeCount": 4213,
  "foundedYear": 1952,
  "specialties": ["Anvils", "Rocket skates", "Giant rubber bands"],
  "stockSymbol": "ACME",

  "headquarters": "Fairfield, NJ",
  "address": "1 Anvil Way, Fairfield, NJ, 07004, US",
  "locations": [
    "1 Anvil Way, Fairfield, NJ 07004, US",
    "12 Pitfall Road, Dublin, D02, IE",
    "88 Rocket Lane, Bengaluru, KA, IN"
  ],
  "website": "https://www.acme-corp.example",
  "followerCount": 182405,
  "jobOpeningsCount": 57,

  "affiliatedCompanies": [
    { "name": "Acme Europe",  "url": "https://www.linkedin.com/company/acme-europe" },
    { "name": "Acme Rockets", "url": "https://www.linkedin.com/showcase/acme-rockets" }
  ],

  "totalEmployeesOnLinkedIn": 4213,
  "countryBreakdown": [
    { "country": "United States", "employeeCount": 2410, "percentOfTotal": 57.2 },
    { "country": "India",         "employeeCount": 980,  "percentOfTotal": 23.3 },
    { "country": "Ireland",       "employeeCount": 415,  "percentOfTotal": 9.9  },
    { "country": "Germany",       "employeeCount": 212,  "percentOfTotal": 5.0  }
  ],
  "countryScan": { "countriesQueried": 9, "stopReason": "coverageReached", "coverage": 0.952 },

  "dataFetchedAt": "2026-09-20T05:20:19.912Z",
  "sourceType": "authenticated"
}
```

### 📊 How to read the workforce numbers

These caveats are not fine print — they change what the numbers mean:

- **`countryBreakdown` counts LinkedIn profiles, not employees.** It counts members who list this company *and* a location. It is a directional signal about distribution, not verified corporate headcount, and it systematically undercounts workforces that are not on the platform.
- **Per-country figures will not sum to `totalEmployeesOnLinkedIn`.** Members who list no location appear in the total and in no country bucket; members with overlapping listed attributes can appear in more than one. `percentOfTotal` is computed against LinkedIn's own total rather than the bucket sum, precisely so a partial sweep does not look complete.
- **Check `countryScan.stopReason` before treating a breakdown as exhaustive.** `listExhausted` means the full country list was swept. `coverageReached`, `emptyTail`, and `countryLimit` all mean the sweep stopped early — usually correctly, but the tail was not enumerated.
- **`companySizeRange` and `employeeCount` are different numbers on the same page.** The first is LinkedIn's bucketed band; the second is its exact member count. Only the second is usable as a denominator.
- **Some fields are simply not on the guest page.** Verified against a live fetch of `linkedin.com/company/microsoft`: the public About panel serves website, industry, company size, headquarters, type and specialties — and nothing else. `foundedYear`, `phone`, `stockSymbol` and `tagline` are absent from both the visible panel and the embedded JSON-LD, so they come back `null` for most companies. The parsers read them when a page does publish them; they do not invent them.
- **`jobOpeningsCount` is null unless the page links its own jobs tab.** It is deliberately *not* read from the "Browse jobs" rail at the bottom of the page — those are LinkedIn-wide keyword searches (Microsoft's page carries a "710,029 open jobs" link that has nothing to do with Microsoft's postings).
- **Not every field is populated for every company.** Smaller pages often lack specialties or addresses. Absent fields are `null`, never `""`.
- **`sourceType` tells you which half you got.** `"public"` means no cookie was used and `countryBreakdown` is `null`; `"authenticated"` means the breakdown is real. Rows can be `success: true` with a populated `error` when the profile succeeded but the breakdown did not.

---

## ⏱️ Run time and cost

The public lane is fast — 8 concurrent HTTP requests, no browser. **The country sweep is what costs time**, and its cost is structural rather than an implementation detail: LinkedIn exposes a count per query, so a complete breakdown is one request per country.

At the default 1.75s spacing:

| Countries swept | Approx. time per company |
|---|---|
| 6 (`countries` set explicitly) | ~12 seconds |
| ~15 (typical, with early stop) | ~30 seconds |
| 125 (full list, global company) | ~4 minutes |

Three levers, in order of effectiveness:

1. **Set `countries`** to the markets you actually care about.
2. **Leave `cacheTtlDays` at 7 or raise it** — country distribution barely moves week to week.
3. **Leave `countryScanCoveragePercent` at 97**, which ends most sweeps in well under 20 requests.

Turning `includeCountryBreakdown` off makes runs near-instant and removes the cookie requirement entirely.

---

## 🎯 Use cases

- 🗺️ **Footprint mapping** — one row per campus, with city, region, country and coordinates-ready addresses, ready to drop into a map or a territory spreadsheet.
- 🌐 **Market entry** — see whether a competitor already has staff on the ground in a target country, and how many, before committing to it.
- 🗺️ **Territory and quota planning** — size sales territories against where a prospect's employees actually sit, not where its HQ is registered.
- 🕵️ **Competitive intelligence** — track headcount shifting between countries across scheduled runs to spot expansion, consolidation, or an offshoring programme.
- 💼 **M&A and investment diligence** — validate a target's claimed global footprint against its observable one, and catch declared offices with no measurable staff behind them.
- 👥 **HR and talent strategy** — benchmark where comparable companies concentrate engineering, support, or operations before opening a hub.
- 🎯 **ABM and account research** — enrich a target account list with firmographics and geography in one pass.

---

## ❓ FAQ

**Do I need a LinkedIn account?**
Only for `countryBreakdown`. Every other field comes from the public page. Leave `sessionCookie` empty and the Actor runs fully public — it just marks every row `sourceType: "public"` and returns `countryBreakdown: null`.

**Why can't the country breakdown be done without a cookie?**
LinkedIn publishes a company's top five employee locations and requires a session to query location facets beyond them. There is no public endpoint for the rest.

**Will this get my LinkedIn account banned?**
It can. Any automation against LinkedIn carries that risk, which is why the authenticated lane is serialised, jittered, proxy-pinned, budget-capped, and stops on the first block. Use a secondary account and residential proxies.

**Why does the breakdown not add up to the total?**
Members who list no location are counted in the total and in no country. This is inherent to LinkedIn's data, not a bug — see [How to read the workforce numbers](#-how-to-read-the-workforce-numbers).

**How do I get one row per company instead of per office?**
Set `outputMode` to `company`. The default is `location`, which returns one row per campus — Microsoft yields 45 — each with parsed address fields and its country's headcount. Add `includeLocationEmployeeCounts` for a metro-level count per office.

**Can I pass showcase or school pages?**
Yes. Both are accepted and reported via `pageType`. Showcase pages are sub-brands and typically carry far fewer employees than their parent.

**Why did my run return one row?**
Because this Actor returns **one row per company**, not one row per result page. One input URL means one row — that is the whole output, not a truncated run. Pass more URLs in `companyUrls` to get more rows.

**What happens if one company fails?**
That row comes back with `success: false` and an `error` string. Every input company produces exactly one row — a missing row would be indistinguishable from a company that was never in the list.

**Does it re-scrape companies I've already run?**
Not within `cacheTtlDays` (default 7). Cached rows are returned with `fromCache: true`. Set it to `0` to force a re-scrape.

---

## 🏁 Getting started

### 1️⃣ Run in Apify Console

Paste your company URLs into **Company URLs**, optionally add a `li_at` cookie under **Authentication**, and hit **Start**.

### 2️⃣ Run via API

```bash
curl -X POST "https://api.apify.com/v2/acts/YOUR~ACTOR/runs?token=YOUR_TOKEN" -H "Content-Type: application/json" -d '{"companyUrls":["microsoft","stripe"],"includeCountryBreakdown":false}'
```

### 3️⃣ Run locally

```bash
npm install && npm test && npm start
```

---

## ⚠️ Limitations and known issues

- **The country breakdown requires an authenticated session.** There is no way around this; it is how LinkedIn gates the data.
- **One request per country.** A complete global sweep is inherently slow. The early-stop heuristics reduce it a great deal but cannot remove it.
- **Counts are LinkedIn profiles, not verified headcount.** Treat as directional.
- **LinkedIn changes its markup and its internal API.** Parsers prefer JSON-LD and search response envelopes by key rather than by fixed path, so both degrade gracefully, but a field can still go `null` after a LinkedIn change.
- **Guest pages are sometimes gated.** LinkedIn serves sign-in walls as an HTTP **200** at the end of a redirect to `/uas/login`, so neither the status code nor the requested URL reveals them. Both the landing URL and the response body are checked; a walled page is retried with a fresh session, and a persistently gated company returns `success: false` rather than a row that claims success and carries nothing.
- **Do not request `/company/<slug>/about/`.** That suffix is walled for guests while the base `/company/<slug>` is not — and the base page carries the entire About panel anyway. This Actor always requests the base URL; the note is here because it is a genuinely surprising asymmetry if you build against this API yourself.
- **Use residential proxies even without a cookie.** Datacenter IPs raise the odds of being walled on the public lane, not just the authenticated one.
- **Recent updates and featured employees are samples**, limited to what the public page renders. Neither is a complete feed or a roster.

---

## ⚖️ Legal and responsible use

This Actor collects information that companies publish about themselves, plus aggregate employee counts. It returns **no personal data by default** — `includeFeaturedEmployees` is off, and when enabled it returns only the sample of public profiles LinkedIn itself displays on the page.

You are responsible for your own compliance. Scraping personal data is regulated under GDPR, CCPA, and similar regimes; using an account cookie to automate requests is contrary to LinkedIn's User Agreement and can result in account restriction. Use a secondary account, keep request rates conservative, and take your own legal advice for your jurisdiction and use case.
