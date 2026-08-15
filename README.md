# Housecall Pro MCP

[![CI](https://github.com/chrischall/housecallpro-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/housecallpro-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chrischall/housecallpro-mcp)](https://www.npmjs.com/package/@chrischall/housecallpro-mcp)
[![license](https://img.shields.io/npm/l/@chrischall/housecallpro-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects
Claude to the **customer side** of [Housecall Pro](https://housecallpro.com) —
the estimate or invoice link a contractor (HVAC, plumbing, electrical, cleaning)
emails or texts you.

> [!WARNING]
> **AI-developed project.** This codebase was built and is actively maintained
> by [Claude Code](https://www.anthropic.com/claude). No human has audited the
> implementation. Review all code and tool permissions before use.

## This is the customer side, not the business side

Housecall Pro has two surfaces, and they share nothing:

| | Public API | Customer portal (**this repo**) |
| --- | --- | --- |
| Host | `api.housecallpro.com` | `app.housecallpro.com` |
| Serves | the business running on Housecall Pro | that business's customers |
| Auth | an API key from the pro's account | the link your contractor sent you |
| Docs | [docs.housecallpro.com](https://docs.housecallpro.com) | [`docs/HOUSECALLPRO-API.md`](docs/HOUSECALLPRO-API.md) |

If you *run* a business on Housecall Pro, you want the public API instead. This
server is for being someone's customer.

## What you can do

- *"What did Queen City quote me for the tankless flush?"*
- *"What's on that estimate, line by line?"*
- *"How much of that $346 is tax?"*
- *"Am I still on the hook to respond to this?"*
- *"Decline option 2."*

## Install

```sh
npx -y @chrischall/housecallpro-mcp
```

Configure it with the link your contractor sent you:

```sh
HOUSECALLPRO_LINK='https://pro.housecallpro.com/mobile_estimate/XXXXXXXXXX'
```

Both link forms work — the short `pro.housecallpro.com/mobile_estimate/…` one
and the long `client.housecallpro.com/estimates/…` one. For several documents:

```sh
HOUSECALLPRO_LINKS='[{"label":"tankless","url":"…"},{"label":"hvac","url":"…"}]'
```

Then every tool takes an optional `link` selector; with one configured you never
need it.

> [!IMPORTANT]
> **Your link is a bearer credential.** Anyone holding it can read the estimate
> and decline it. It is read from the environment, never logged, and never
> returned in a tool result — `housecallpro_list_links` reports labels only.

## Tools

| Tool | |
| --- | --- |
| `housecallpro_get_estimate` | Line items, totals, tax, company, approval state |
| `housecallpro_get_company` | The contractor: phone, email, website, arrival window |
| `housecallpro_list_links` | Configured links, labels only |
| `housecallpro_decline_estimate` | Decline options — confirm-gated |
| `housecallpro_approve_estimate` | Always refuses; explains why |
| `housecallpro_healthcheck` | Reachability + whether a link still resolves |

### Money is returned twice

The upstream API returns **integer cents** — the estimate the portal renders as
`$346.39` arrives as `total_amount: 34639`. Reporting that raw overstates every
figure 100×, so each money field is emitted as both `*_cents` (verbatim) and
`*_usd` (derived). `tax.rate` is a fraction (`0.0825` = 8.25%) and is never
scaled.

### Why you can't approve an estimate

`housecallpro_approve_estimate` always refuses, and that is deliberate.

Approval posts a `response_token` — a **reCAPTCHA v3 token** minted in-page for
the action `estimates_customer_approvals`. No server-side client can produce
one, and neither can a browser-bridge transport: the bridge issues `fetch`
calls, it does not execute page JS. Declining carries no such token, which is
why decline works and approve does not.

Rather than post a request that would be rejected — or worse, might *not* be,
binding you to a quoted price — the tool refuses and tells you to approve in a
browser.

Declining is confirm-gated: without `confirm: true` it makes no network call and
returns a preview of exactly what would be sent. After a real decline it
**re-reads the estimate** and reports the option's actual status, because a 2xx
is not proof a write landed.

## Without the MCP

[`skills/housecallpro`](skills/housecallpro/SKILL.md) does the same reads from a
shell with plain `curl` and `jq`, for scripts or machines where the server isn't
installed. No browser bridge is involved there either.

## No browser bridge

Unlike much of this fleet, `app.housecallpro.com` is not bot-walled — a bare
`curl` gets a `200`. So this server talks to it directly over HTTPS, has no
`@fetchproxy/server` dependency, needs no extension or signed-in tab, and hosts
cleanly as a remote connector.

## What isn't here

- **Invoices.** The endpoints are enumerated in
  [`docs/HOUSECALLPRO-API.md`](docs/HOUSECALLPRO-API.md) but unverified — read
  out of the app's JavaScript, never exercised against a real invoice link.
- **Payments and cards.** Deliberately out of scope.
- **The account-level portal.** Housecall Pro has an OTP/magic-link customer
  portal that spans every document from one contractor, which is a strictly
  better surface than per-document links. Standing it up needs a human to
  receive a one-time code, so it is the obvious next increment rather than part
  of this first cut.

## Development

```sh
npm install
npm run build
npm test
```

## License

MIT
