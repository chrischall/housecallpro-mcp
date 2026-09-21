# Changelog

## [1.0.1](https://github.com/chrischall/housecallpro-mcp/compare/v1.0.0...v1.0.1) (2026-09-21)


### Bug Fixes

* **tools:** say that declining an estimate is destructive ([#63](https://github.com/chrischall/housecallpro-mcp/issues/63)) ([0b9517b](https://github.com/chrischall/housecallpro-mcp/commit/0b9517b15f13a3577c198ce5e1fe108b3e21fb19))

## [1.0.0](https://github.com/chrischall/housecallpro-mcp/compare/v0.4.0...v1.0.0) (2026-09-20)


### Features

* **deps:** take mcp-utils 1.0.0, fixing server/discover ([#59](https://github.com/chrischall/housecallpro-mcp/issues/59)) ([dd811df](https://github.com/chrischall/housecallpro-mcp/commit/dd811df13907be14df2d672b80167a8d65cc55be))


### Bug Fixes

* **release:** drop bump-minor-pre-major so a breaking change cuts a major ([#61](https://github.com/chrischall/housecallpro-mcp/issues/61)) ([87d41dc](https://github.com/chrischall/housecallpro-mcp/commit/87d41dc92da97e9335a078dfae54101eef34e3f8))
* **release:** restate the Release-As footer the squash dropped ([#62](https://github.com/chrischall/housecallpro-mcp/issues/62)) ([25156ba](https://github.com/chrischall/housecallpro-mcp/commit/25156ba2fe456674dd9c26a173ef900d93090434))

## [0.4.0](https://github.com/chrischall/housecallpro-mcp/compare/v0.3.1...v0.4.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **mcp:** migrate server to SDK v2 ([#53](https://github.com/chrischall/housecallpro-mcp/issues/53))

### Features

* **mcp:** migrate server to SDK v2 ([#53](https://github.com/chrischall/housecallpro-mcp/issues/53)) ([2b60941](https://github.com/chrischall/housecallpro-mcp/commit/2b609415b956d09b93fb54df9eb160bc3b1e4789))


### Bug Fixes

* **mcp:** restore repository source style ([#56](https://github.com/chrischall/housecallpro-mcp/issues/56)) ([8e01cf3](https://github.com/chrischall/housecallpro-mcp/commit/8e01cf392b247f98662b750f5b5f01c101223fef)), closes [#54](https://github.com/chrischall/housecallpro-mcp/issues/54)

## [0.3.1](https://github.com/chrischall/housecallpro-mcp/compare/v0.3.0...v0.3.1) (2026-09-10)


### Bug Fixes

* **deps:** @chrischall/mcp-utils 0.26.1 ([#49](https://github.com/chrischall/housecallpro-mcp/issues/49)) ([045363a](https://github.com/chrischall/housecallpro-mcp/commit/045363a1934992009a7e7e357b17da011df6311b))
* **deps:** Bump hono from 4.13.2 to 4.13.7 ([#47](https://github.com/chrischall/housecallpro-mcp/issues/47)) ([7f1b1b2](https://github.com/chrischall/housecallpro-mcp/commit/7f1b1b2cc1175e099b97bacd85b331064f5c7407))
* **deps:** declare the peer floors mcp-utils 0.26.1 requires ([#50](https://github.com/chrischall/housecallpro-mcp/issues/50)) ([e943072](https://github.com/chrischall/housecallpro-mcp/commit/e9430725015916d0ba161732c53ab8399cdb112a))

## [0.3.0](https://github.com/chrischall/housecallpro-mcp/compare/v0.2.0...v0.3.0) (2026-09-04)


### Features

* **tools:** minify every response — no formatting whitespace on any payload ([#35](https://github.com/chrischall/housecallpro-mcp/issues/35)) ([091ee43](https://github.com/chrischall/housecallpro-mcp/commit/091ee43951cefee4d683179f0c2a32f666d69e41))
* **tools:** replace the boolean `raw` with the fleet `view` vocabulary ([#39](https://github.com/chrischall/housecallpro-mcp/issues/39)) ([0d31f1d](https://github.com/chrischall/housecallpro-mcp/commit/0d31f1dc8e4935521db1b1b563c5da58e166494d))

## [0.2.0](https://github.com/chrischall/housecallpro-mcp/compare/v0.1.0...v0.2.0) (2026-08-15)


### Features

* accept a link per call, so nothing needs configuring ([#13](https://github.com/chrischall/housecallpro-mcp/issues/13)) ([5083a8d](https://github.com/chrischall/housecallpro-mcp/commit/5083a8d3c1821b65fb51c00a1567ecded063d7a9))

## 0.1.0 (2026-08-15)


### Features

* Housecall Pro customer portal MCP server ([24bb6c3](https://github.com/chrischall/housecallpro-mcp/commit/24bb6c345c1b10bca37f71254e9804c0ff6477c6))
* read invoices, verified against a live invoice link ([#7](https://github.com/chrischall/housecallpro-mcp/issues/7)) ([95e8d31](https://github.com/chrischall/housecallpro-mcp/commit/95e8d31f71880c827816271a534f1212f6d6c0fc))


### Bug Fixes

* classify link config on the registry, not by matching its error prose ([#12](https://github.com/chrischall/housecallpro-mcp/issues/12)) ([2b8473e](https://github.com/chrischall/housecallpro-mcp/commit/2b8473ed9807c0b0a711dd246b09707563754de9))
