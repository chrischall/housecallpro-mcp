# Housecall Pro consumer API

Reverse-engineered from the `client.housecallpro.com` single-page app
(webpack bundles + lazy chunks under `/assets/<Name>-<hash>.chunk.js`).

**Nothing in this file is a captured credential.** Retrieval tokens, customer
uuids and organization uuids that appear here are placeholders. Real tokens are
bearer credentials — see [Security](#security).

## Two surfaces, and this repo covers the consumer one

| | Pro API | Consumer portal (**this repo**) |
| --- | --- | --- |
| Host | `api.housecallpro.com` | `app.housecallpro.com` |
| Serves | the business running on Housecall Pro | that business's customers |
| Auth | `Authorization: Token <api key>` from the pro's account | a per-document retrieval token emailed/texted to the customer |
| Docs | <https://docs.housecallpro.com> (Stoplight) | none — this file |

Both are reachable from a plain server-side `fetch`. Neither is bot-walled:
`curl` gets a `200` from the SPA host and a clean `401 {"message":"Unauthorized"}`
from the pro API. **No browser bridge is required for either**, which is why this
repo has no `@fetchproxy/server` dependency and hosts cleanly on mcp-host.

## How a customer link resolves

A pro sends a short link. It `301`s to the SPA route carrying the long token:

```
GET https://pro.housecallpro.com/mobile_estimate/<short>
  -> 301 Location: https://client.housecallpro.com/estimates/<retrieval-token>
```

**Retrieval tokens come in two shapes, and they are not interchangeable.** An
estimate token is 129 characters — two 64-char lowercase hex halves joined by
`_`. An **invoice token is a bare 32-char lowercase hex string**. Both verified
against live links. They address different endpoints, so a single "retrieval
token" regex is wrong; `src/links.ts` keeps them distinguishable and the client
refuses a token pointed at the wrong endpoint before spending a request. `client.housecallpro.com` serves a 1,407-byte SPA shell for *every*
route — there is no server-rendered data — so all data comes from XHR against
`app.housecallpro.com`.

Known short-link prefixes: `/mobile_estimate/<short>` and
`/mobile_invoice/<short>` — both verified. SPA routes: `/estimates/:token`,
`/invoices/:token`, `/service_agreement/:token`, `/add_tip/:token`.

## Auth

The SPA builds headers with one function. Reproduced faithfully:

```js
{
  'Segment-Device-Context': btoa(JSON.stringify({os: {name: 'Web'}, userAgent})),
  // only when a token is passed:
  AUTHORIZATION: `Token ${token}`,
}
```

So the retrieval token is sent as **`Authorization: Token <retrieval-token>`** —
the same header scheme the pro API uses for its API keys, with a different
credential in it.

Two placements coexist, and they are not interchangeable:

- **reads** put the token in the **path** (`/alpha/customer_estimates/<token>`)
  and need no `Authorization` header at all — verified with the header omitted.
- **writes** put it in the **`Authorization` header** and carry the subject in
  the body (`estimate_option_uuids`).

## Verified endpoints

Status column: **verified** = a real request was issued and its response
recorded. **shape-only** = the request shape is transcribed from the SPA's own
code but no live call was made.

### `GET /alpha/customer_estimates/<retrieval-token>` — verified

`200 application/json`, ~4.8 KB. No auth header needed. The envelope is
JSON:API-flavoured — objects nest under `{object, data}` wrappers, so
`flattenJsonApi` from `@chrischall/mcp-utils` applies.

```
object: "customer_estimate"
estimate: {object, data: {
  object, id, estimate_uuid, name, description, address_id, customer_uuid,
  organization_id, pro_ids[], estimate_number, expiration_date,
  customer_approval_mode,           // e.g. "single_option"
  address: {object, data: {street, street_line_2, city, state, zip, latitude,
            longitude, time_zone, printable_address, id, country, customer,
            url, notes, billing}}}}
options: {object: "list", data: [{
  object: "option", id, name, option_number, option_date,
  service_subtotal, material_subtotal, sub_total, total_amount,
  status,                            // e.g. "Awaiting Approval"
  approval_date,                     // null until approved
  employees[], discounts, summary, cover_photo, financing,
  tax: {object, data: {object, rate, name, amount, display_name}},
  line_items: {object, data: [{object, id, name, description, unit_price,
    quantity, amount, subtotal, order_index, kind, image_url,
    color_key, color_name, color_image_url}]},
  payment_information: {deposit_amount, deposit_due_date}}]}
customer_name, customer_company_name, customer_email, customer_card_on_file
estimate_date, service_date, message_from_pro, founding_pro_uuid
show_side_by_side_comparison, layout, presentation_mode, source_type
deposit_requirement, deposit_payment_options: {allow_ach_payment_option,
  allow_credit_card_payment_option, allow_save_card_on_file_payment_option,
  allow_klarna_payment_option, allow_paypal_payment_option,
  allow_paypal_venmo_payment_option, allow_paypal_pay_later_payment_option}
document_attachments[], visual_attachments[]
company_phone_number, company_email, company_name, company_logo_url,
company_printable_address, company_website, company_terms_url, company_country
estimate_setting: {object, data: {show_* display flags…}}
feature_flags, signatures_enabled, wisetack
payment_options: {can_pay_online}
```

### Money is integer cents

Every monetary field in this response — `service_subtotal`, `sub_total`,
`total_amount`, `tax.amount`, and each line item's `unit_price` / `amount` — is
an **integer number of cents**. The live estimate the portal renders as
`$346.39` returns `total_amount: 34639`.

`tax.rate` is the exception: it is a fraction (`0.0825` = 8.25%) and must not be
scaled. `quantity` is a plain number.

This is not visible from a synthetic fixture, and reporting the raw value
overstates every figure 100x, so `src/normalize.ts` emits each money field twice
— `*_cents` verbatim and `*_usd` derived.

`options.data[].status` and `.approval_date` are the **proof fields** for
verifying an approve/decline actually landed. Do not diff the whole object:
several fields are presentation state.

### `GET /api/invoices/consumer/v1/invoices/<invoice-token>` — verified

`200 application/json`, ~1 KB. No auth header needed. **Note the `v1` segment:**
`/api/invoices/consumer/invoices/<token>` — the same path without it — returns
`404`, as do `/api/v2/consumer/invoices/<token>` and
`/api/v2/consumer/sent_invoices/<token>`. All four appear in the SPA's bundles;
only the `v1` one answers. This is exactly why endpoints get probed rather than
transcribed.

The document is **flat** — none of the estimate's `{object, data}` wrappers.

```
object: "consumer_invoice"
amount, subtotal, total, due_amount        // integer cents
invoice_number, invoice_count, status      // status e.g. "paid"
template                                   // e.g. "dynamic"
company_info: {name, logo_url, organization_uuid, can_accept_gratuity,
               country, analytics_uuid, phone_number, email, website}
customer: {email, card_on_file, uuid, mobile_number}
payment_options: {cc_enabled, ach_enabled, can_save_card_on_file,
                  can_pay_online, klarna_enabled, paypal_enabled,
                  paypal_pay_later_enabled, paypal_venmo_enabled}
financing_options[], videos[], cross_selling_products
```

**There are no line items.** Not an omission in the capture — a paid invoice
renders in the portal as a summary ("Thanks for your payment / $0.00 due"), and
the API returns exactly that. There is also **no tax field**: the portal's tax
figure is `total - subtotal`, which `summarizeInvoice` derives.

Money is integer cents here too — a live invoice returned `total: 37888`,
`subtotal: 35000` for a document showing $378.88 with $28.88 tax.

`due_amount` is the field that decides paid-ness; `status` is a display string.

### `GET /alpha/organizations/<organization-uuid>` — verified

`200 application/json`, ~635 B. No auth header needed. The org uuid comes from
`estimate.data.organization_id`.

```
object, id, phone_number, email, company_name, logo_url, address, website,
default_arrival_window, founding_pro_uuid, terms_url, feature_flags
```

### `POST /api/estimates/estimate_options/customer_declines` — shape-only

Form-encoded body, token in the header.

```
Authorization: Token <retrieval-token>
estimate_option_uuids: [<option id>, …]      // options.data[].id, e.g. est_…
```

No captcha token is involved — the SPA's decline path sends nothing else.

### `POST /api/estimates/estimate_options/customer_approvals` — shape-only, and blocked

```
Authorization: Token <retrieval-token>
estimate_option_uuids: [<option id>, …]
response_token: <reCAPTCHA v3 token>         // action "estimates_customer_approvals"
signature: {signature, signatory_name, signatory_user_agent}   // when signatures_enabled
include_service_agreement_proposal: true     // when a service agreement rides along
cross_selling_products: {service_agreement_proposal: {payment_option_duration}}
```

**`response_token` is a reCAPTCHA v3 token**, minted in-page by
`grecaptcha.execute(..., {action: 'estimates_customer_approvals'})`. A
server-side client cannot produce one, and neither can the fetchproxy bridge
(it issues `fetch` calls, it does not execute page JS). Approval is therefore
**not automatable** — see `estimates_approve`'s behaviour in the README.

Grepping every chunk, `estimates_customer_approvals` is the *only* reCAPTCHA
action in the consumer app: approve is gated, decline is not.

## Endpoint inventory

Every consumer endpoint referenced by the SPA, for future work. Unmarked
entries are unprobed.

**Estimates** — `/alpha/customer_estimates/{token}` (verified),
`/api/estimates/estimate_options/customer_approvals`,
`/api/estimates/estimate_options/customer_declines`,
`/api/estimates/presentations`,
`/api/consumer_financing/estimate_financing_details/{id}`,
`/api/pre_qualifications`

**Invoices** — `/api/invoices/consumer/v1/invoices/{token}` (verified). Probed
and **404 for an invoice token**: `/api/invoices/consumer/invoices/{token}`,
`/api/v2/consumer/invoices/{token}`, `/api/v2/consumer/sent_invoices/{token}`,
`/api/invoices/linking/consumer/sources/{token}`,
`/api/v2/consumer/invoices/{token}/invoice_or_estimate_pdf`.
`/alpha/jobs/{token}` answers **401** with or without an `Authorization: Token`
header — it exists but takes a different credential.
Unprobed: `/api/v2/consumer/invoices/{preview,download,pay_invoice,pay_invoice_ach,create_failed_transaction}`

**Customer portal (account-level, OTP)** — `/api/customer_portal/request_otp`,
`/api/customer_portal/verify_otp`, `/api/customer_portal/organization/{id}`,
`/api/v2/customer_portal/magic_links`, `/api/v2/customer_portal/organizations`,
`/api/v2/consumer/customer_portal/sessions/magic_link_create`,
`/api/v2/consumer/customer_portal/messages`,
`/api/v2/consumer/user/{log_in,log_out,profile,send_reset_password_email,service_agreements}`,
`/api/v2/consumer/phone_number_lookup`

**Org / jobs / media** — `/alpha/organizations/{id}` (verified),
`/alpha/jobs/{id}`, `/alpha/after_actions/{id}`, `/alpha/industries`,
`/api/customer_gallery/{id}`, `/api/attachments/customer_gallery/{id}`,
`/api/v2/consumer/organization/{id}` (404 for an org uuid — different id space),
`/api/v2/pro/organization/{id}`, `/api/ref/{id}`

**Service agreements** — `/api/consumer/service_agreement/{id}`,
`/api/v2/consumer/service_agreement/{id}`

**Payments / cards** — `/alpha/card_on_file`,
`/alpha/card_on_file/send_manage_card_link`,
`/alpha/customer_card_on_file_add_requests/{id}`,
`/alpha/core_jobs/card_on_file_tipping/{id}`,
`/api/customer_payments/consumer/client_tokens`,
`/api/unauthenticated/client_token/{id}`, `/api/payment_service/private`,
`/pro/jobs/checkout/is_complete`

**Communications** — `/communications/consumer/organizations`,
`/communications/consumer/preferences/{id}`,
`/communications/consumer/sms/delivery_status/{id}`,
`/communications/consumer/consents/{opt_in,opt_out}`,
`/api/communications/consumer/sessions`

**Bill pay / marketing / reviews** — `/alpha/bill_pay/vendor/*`,
`/alpha/marketing/unauthenticated/audiences/{id}`,
`/alpha/reviews/request_info`,
`/api/private/unauthenticated/reviews/google_sign_ins`

## The account-level portal

`request_otp` / `verify_otp` and the magic-link endpoints are a real
account-level session — one login that spans every estimate, invoice and
appointment from a given pro, rather than a token per document. That is a
strictly better surface than per-link tokens, and it is the obvious next
increment. It is not built here because standing it up requires a human to
receive and enter a one-time code, and that bootstrap was out of scope for the
first cut.

## Security

- A retrieval token is a **bearer credential**: anyone holding it can read the
  document and, for decline, act on it. It is read from the environment, never
  logged, and never echoed back in a tool result.
- Recon through `claude-in-chrome` redacts token- and cookie-shaped strings
  (`[BLOCKED: …]`). Probes were written to return status codes and key names,
  never values.
- No captured token appears in this repo, its tests, or its fixtures. Test
  fixtures use synthetic tokens of the correct shape.
