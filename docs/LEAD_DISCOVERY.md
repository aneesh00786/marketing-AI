# AI Lead Discovery (Google Places API (New))

Leads CRM → **🔎 AI Lead Discovery** finds businesses with Google Places, shows them for review,
and imports the selected ones as leads.

## Flow

1. The user enters a business type and country (required), plus optional state/region, city,
   keywords, target Digital Product and maximum results (default 20, at most 60).
2. `POST /api/v1/leads/discovery/search` runs one Google Text Search query built only from those
   inputs ("Wholesale distributors (FMCG) in Kochi, Kerala, India"), following page tokens.
3. Results are checked for duplicates. If a product was chosen, the AI engine can assess product fit.
   The user reviews, selects and imports.
4. `POST /api/v1/leads/discovery/runs/:id/import` creates leads in one transaction.
5. `GET /api/v1/leads/discovery/leads/:id/place` shows an imported lead's business details live
   from Google.

`GET /api/v1/leads/discovery/config` reports whether Google is configured and the limits. It never
returns the key.

## What Google Places can and cannot provide

Google returns **at most 60 places per query** (20 per page), limited by its coverage and
ranking. A search never lists every business in an area, and asking for more results does not
guarantee more unique businesses. Narrow by state or city to find more.

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
| `LEAD_DISCOVERY_MAX_RESULTS` | 60 | per-search cap (never above Google's 60) |
| `LEAD_DISCOVERY_DAILY_SEARCHES` | 20 | searches per workspace per day (UTC) |
| `LEAD_DISCOVERY_DAILY_DETAILS` | 200 | live-detail lookups per workspace per day |
| `PLACES_TIMEOUT_MS` | 10000 | per Google request |
| `AI_ROUTE_RATE_MAX` / `AI_ROUTE_RATE_WINDOW_MS` | 20 / 10 min | per-member limit on the search route |

Other controls:
- The same search repeated within 2 minutes is refused, so it is not paid for twice.
- The smallest field mask is used. Phone and website are Google's higher-priced tier and can be
  turned off per search.
- No Place Details calls are made during a search.
- Every Google page and every details lookup is recorded in `usage_ledger` (`places_search`,
  `places_details`).

Google bills these requests to your Google Cloud account; the feature is not free.

## Permissions

| Action | Capability |
|---|---|
| Search, import | `leads.manage` |
| Config, live details | `leads.view` |

The workspace always comes from the session. Products, searches, imports and live details are
checked against it.
