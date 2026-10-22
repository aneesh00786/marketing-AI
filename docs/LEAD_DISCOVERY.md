# AI Lead Discovery (Google Places API (New))

Leads CRM → **🔎 AI Lead Discovery** finds businesses with Google Places, shows them for review,
and imports the selected ones as leads.

## Flow

1. The user enters:
   - **Required:** business type, country, search scope (whole country, a state or region, or a
     city) and the target Digital Product.
   - **Optional:** keywords, the target number of unique businesses (default 50, at most 300), a
     Google request budget (default 10, at most 20), and whether to search related categories.
2. Optionally, `POST /api/v1/leads/discovery/plan` previews the categories and first queries, with
   the budget and estimated cost. The categories can be edited before searching.
3. `POST /api/v1/leads/discovery/search` runs several distinct Text Search queries (see
   *Coverage*). With `Accept: application/x-ndjson` it streams progress lines, then the result.
4. Results are checked for duplicates. The AI engine can assess product fit. The user reviews,
   selects and imports.
4. `POST /api/v1/leads/discovery/runs/:id/import` creates leads in one transaction.
5. `GET /api/v1/leads/discovery/leads/:id/place` shows an imported lead's business details live
   from Google.

`GET /api/v1/leads/discovery/config` reports whether Google is configured and the limits. It never
returns the key.

## What Google Places can and cannot provide

Google returns **at most 60 places per query** (20 per request), limited by its coverage and
ranking. A search never lists every business in an area, and a higher target does not guarantee
more unique businesses.

## Coverage: how a search runs

A broad type such as "B2B businesses" is not a Google place type, so one query finds little. A
search therefore runs several **distinct** queries within its request budget:

1. **Categories.** The user's business type always comes first. With "related categories" on, the
   AI engine suggests up to 7 more searchable kinds of business that fit the description and could
   buy the product (e.g. "Wholesale distributors", "Packaging suppliers"). Rules:
   - There is no built-in industry list.
   - Locations, brand names and repeats are rejected.
   - Companies selling the same kind of product are excluded unless the description asks for them.
   - Without AI, only the user's business type is searched, and the response says so.
2. **First-tier queries:** each category in the chosen location ("Wholesale distributors in
   India"). Each query is followed through its pages (`nextPageToken`, up to 60 places). The
   remaining pages are skipped when a page brings under 20% new places.
3. **Progressive locations** (country or state scope only), taken from **addresses in Google's own
   results**, most frequent first:
   - Country-wide: the states.
   - State-wide: the cities in that state.

   Each category runs again there, e.g. "Wholesale distributors in Kerala, India". Nothing is
   guessed: a state appears only if Google returned businesses there.
4. **Stop conditions:**
   - the target number of unique businesses is reached;
   - the request budget is used;
   - the workspace's daily request budget is used;
   - no queries are left;
   - Google reports a quota or permission error (results so far are kept);
   - the user cancels (no further requests are sent).

Places are de-duplicated across all queries before counting. The response separates:
- **raw** results;
- **repeats** across queries;
- **unique** businesses;
- **CRM duplicates** and **possible duplicates**;
- **excluded** (permanently closed) businesses;
- businesses **eligible** to import.

It also lists every query run, with its requests, places, new unique businesses and status. A
query that fails (timeout, server error, invalid query) is recorded and the search continues.
Identical query texts never run twice.

If the target is more than the budget allows (20 places per request), the plan and the result say
so explicitly.

Google Places does **not** provide contact people, decision-maker names, email addresses, company
size or revenue. These are never filled in or guessed.

## Google terms and what is stored

Google Maps Platform Terms of Service 3.2.3(a) *No Scraping* forbids pre-fetching, indexing,
storing or rehosting Google Maps Content, including "copy and save business names, addresses".
3.2.3(b) *No Caching* allows caching only where the Service Specific Terms permit it. For Places,
those terms permit caching `place_id` (section 3, *Google ID Caching*) and latitude/longitude for up
to 30 days (section 14.3). Displaying Places data without a map requires Google attribution.

So, as implemented:

| Data | Where it lives |
|---|---|
| Name, category, address, city, state, postal code, country, phone, website, Maps link, business status | **Review screen and live-details view only.** Never written to the database. Shown with "Google Maps" attribution. |
| Place ID | Stored: `lead_place_refs` (one per lead, unique per workspace) and `lead_discovery_places` (per search, for import validation and duplicate checks). |
| Search criteria, counts, errors | Stored in `lead_discovery_runs`. These are the user's own inputs, not Google content. |
| AI product-fit score and evidence | Review screen only, because it is derived from Places content. |
| Latitude/longitude | Not requested. |

Check the current terms before changing this behaviour:
https://cloud.google.com/maps-platform/terms and https://cloud.google.com/maps-platform/terms/maps-service-terms

## Field mapping to the Leads CRM (`leads` table)

| Lead field | Value for an imported lead | Source |
|---|---|---|
| `name` (required) | `Prospect N: <business type> (<city, region, country>)` | the user's search criteria |
| `company_name`, `phone`, `email` | left empty | not storable (Google content) / not provided by Google |
| `notes` | how and when the lead was found, and that details are shown live | generated text, no Google content |
| `status` | `Imported` (same as the CSV import) | default |
| `product_id`, `product_interest` | the selected product, checked against the workspace again at import | existing product link |
| `ai_score`, `ai_category` | existing rule-based score (base score, since no contact data is stored) | `scoreLead` |
| `estimated_budget`, `ai_suggestion` | empty until the user or the existing AI advice fills them | unchanged behaviour |
| `lead_place_refs.place_id` | the Google place ID | Google (storable) |

Contact details the user has verified (by calling or visiting the business) can be entered with
the normal Edit form. Imports never overwrite existing leads.

## Duplicate detection

| Match against existing leads in the workspace | Treatment |
|---|---|
| Same place ID (already imported) | duplicate, not importable |
| Same phone number (last 10 digits, at least 8) | duplicate, not importable |
| Website domain equals a lead's email domain (free-mail domains ignored) | duplicate, not importable |
| Same normalised business name only | **possible** duplicate: shown, not pre-selected, importable |
| Google business status `CLOSED_PERMANENTLY` | not importable |

Import reports created, duplicate, skipped and failed records separately. Re-importing a place is
always refused.

## Product-aware qualification

When a product is selected and "Assess product fit with AI" is on, the existing AI engine
(`aiEngine.js`, Telnyx first) scores each eligible business 0–100 with confidence, cited evidence
and an `inference` flag. It may use only the given facts. A category match alone scores at most
50 with low confidence and is marked as an inference. Assessments are metered against the
workspace AI quota. If AI is unavailable, discovery still works without them.

The product is not added to the Google query. Searching for the product's own terms would find
competitors and vendors, not customers.

## Setup

1. In Google Cloud: create or choose a project, enable billing, and enable **Places API (New)**
   (`places.googleapis.com`).
2. Create an API key. Restrict it to the Places API (New), and to the server's IP address where
   possible. It is used only server-side.
3. Set `GOOGLE_PLACES_API_KEY` in `backend/.env` and restart the API.
4. Apply migration `013_lead_discovery` (`npm run migrate`). The Leads CRM keeps working before it
   is applied.

## Configuration and cost controls

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | none | required; server only |
| `LEAD_DISCOVERY_MAX_RESULTS` | 300 | most unique businesses per search (hard limit 500) |
| `LEAD_DISCOVERY_MAX_REQUESTS` | 20 | most Google requests per search (hard limit 50) |
| `LEAD_DISCOVERY_MAX_CATEGORIES` | 8 | categories per search, including the user's business type |
| `LEAD_DISCOVERY_MAX_SUBLOCATIONS` | 10 | states or cities covered progressively |
| `LEAD_DISCOVERY_AI_FIT_MAX` | 60 | businesses per search assessed for product fit |
| `LEAD_DISCOVERY_DAILY_SEARCHES` | 20 | searches per workspace per day (UTC) |
| `LEAD_DISCOVERY_DAILY_REQUESTS` | 300 | Google Text Search requests per workspace per day (UTC) |
| `PLACES_PRICE_PER_1000_ENTERPRISE` / `_PRO` | 35 / 32 | list price used for cost estimates |
| `LEAD_DISCOVERY_DAILY_DETAILS` | 200 | live-detail lookups per workspace per day |
| `PLACES_TIMEOUT_MS` | 10000 | per Google request |
| `AI_ROUTE_RATE_MAX` / `AI_ROUTE_RATE_WINDOW_MS` | 20 / 10 min | per-member limit on the search route |

Other controls:
- Every limit is enforced on the server.
- A search uses at most min(its request budget, the workspace's remaining daily requests).
- The same search repeated within 2 minutes is refused, so it is not paid for twice.
- The smallest field mask is used. Phone and website are Google's higher-priced tier and can be
  turned off per search.
- No Place Details calls are made during a search.
- Every Google page and every details lookup is recorded in `usage_ledger` (`places_search`,
  `places_details`).

Google bills these requests to your Google Cloud account; the feature is not free.

**Cost.** Each Text Search request with phone and website is billed as *Text Search Enterprise*:
**$35 per 1,000 requests** after a free cap of 1,000 per month. Without them it is *Text Search
Pro*: **$32 per 1,000**, free cap 5,000 per month. These are list prices from Google's pricing page
when this was written. A search with a budget of 10 requests therefore costs at most about $0.35,
before the free usage. The UI shows this estimate; your Google Cloud bill is authoritative.

Live details are *Place Details* calls: Enterprise $20 per 1,000, Pro $17 per 1,000.

## Permissions

| Action | Capability |
|---|---|
| Search, import | `leads.manage` |
| Config, live details | `leads.view` |

The workspace always comes from the session. Products, searches, imports and live details are
checked against it.
