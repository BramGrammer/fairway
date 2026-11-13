# Changelog

## [0.6.0](https://github.com/BramGrammer/fairway/compare/v0.5.0...v0.6.0) (2026-11-13)


### Features

* an Assistant, scheduled Reviews and model settings ([9500d4c](https://github.com/BramGrammer/fairway/commit/9500d4c8153af23bad57631225b779652d06b5be))
* an Assistant, scheduled Reviews and model settings ([d4bdb7c](https://github.com/BramGrammer/fairway/commit/d4bdb7c0c284684886fb5657a7f0789f33cb1503))

## [0.5.0](https://github.com/BramGrammer/fairway/compare/v0.4.0...v0.5.0) (2026-11-11)


### Features

* a sortable routes table with one line per route, and the Caddyfile in a popover ([1961de9](https://github.com/BramGrammer/fairway/commit/1961de98db2c8bf96837e3e4433b74b1f4a10ffb))
* an icon button for expand all, and dividers in the graph controls ([7449a46](https://github.com/BramGrammer/fairway/commit/7449a464a3279e14f85107af50f1ccb73bdd09d3))
* center the routes graph vertically when it opens ([756aabd](https://github.com/BramGrammer/fairway/commit/756aabd9db36c87708eeba99d06393195a73193e))
* dark mode switch in the user menu, and a plainer sidebar footer ([bee381a](https://github.com/BramGrammer/fairway/commit/bee381a06bf7b14750eabafe258d1a686b7f80e1))
* find and replace bar in the editor ([07f18d2](https://github.com/BramGrammer/fairway/commit/07f18d288f3c58db78487274c1b27e812eb1d975))
* Findings in the editor, find bar, icon toolbar and shortcuts popover ([bcdd514](https://github.com/BramGrammer/fairway/commit/bcdd514208ec2dc82c7a9f4f58af0b02446f5187))
* icon buttons for the switches and Refresh on the Routes page ([10b3726](https://github.com/BramGrammer/fairway/commit/10b37269bbd3431af7afd28918c8343c54500c16))
* icon buttons with tooltips and dividers in the Logs top bar ([122c07f](https://github.com/BramGrammer/fairway/commit/122c07f99ae924913de5cfa8903c7b8ac1239a6a))
* icon buttons with tooltips in the editor toolbar ([367fdd9](https://github.com/BramGrammer/fairway/commit/367fdd960d7e411df8d4d1538c12809e6eca642a))
* list the editor's keyboard shortcuts in a popover ([3367190](https://github.com/BramGrammer/fairway/commit/33671903856a7c82ad991c0197ee3db4052a44cd))
* neutral sidebar colours with a high-contrast selected item ([418f670](https://github.com/BramGrammer/fairway/commit/418f6705c9a66a116ed6039ab174c3ccf841f845))
* real addresses for the pages, with working Back and Forward ([ad4bcd0](https://github.com/BramGrammer/fairway/commit/ad4bcd008be16894c1bfcc7f3c1724c8b3255d4a))
* remove the by-destination view of the Routes page ([7642221](https://github.com/BramGrammer/fairway/commit/7642221347d192f6ebd5bb7f051fb34996c1f72e))
* show Caddy's errors and warnings at their line, with rules worth a look ([8235e84](https://github.com/BramGrammer/fairway/commit/8235e847cfa7792793cd132c79362350478e432b))
* show Caddy's state as a dot after the name, and the missing login as an alert ([8ab9abf](https://github.com/BramGrammer/fairway/commit/8ab9abfbe044665f28d50dec39a2f3ce09492863))
* show the Routes page summary as badges, and drop the graph hint ([6eac4a0](https://github.com/BramGrammer/fairway/commit/6eac4a06189e9aa4121b735e6fc695ba9196c3cc))
* tables, icon toolbars, real page addresses and a calmer sidebar ([e59a858](https://github.com/BramGrammer/fairway/commit/e59a8586d2a63673fc7a154e1faced1a0c8e743f))
* the Events page is a sortable table ([e1426c7](https://github.com/BramGrammer/fairway/commit/e1426c7ad78f713afad5e5a30178c3a68918a5ff))
* the Logs tab of the route drawer is a full-width bar and table ([8a8706f](https://github.com/BramGrammer/fairway/commit/8a8706feebb681cb70732e81dbc160cc50ac45fa))
* themed scrollbars in the detail drawer, the history diff and the review dialog ([923339e](https://github.com/BramGrammer/fairway/commit/923339ef5bd9769d86a407de0ed3e0a14783fa3f))


### Bug Fixes

* keep the Routes table's top bar in place while the rows scroll ([ecee8fa](https://github.com/BramGrammer/fairway/commit/ecee8fab1f105c14895f1d391b6c0541dfce2cec))
* no scrollbar flashing in the top bar while a button is pressed ([8199f9d](https://github.com/BramGrammer/fairway/commit/8199f9df6078253cea68b13b3b2d1cd49ea536a1))
* show one clear button in the search fields, the app's own ([0e73f45](https://github.com/BramGrammer/fairway/commit/0e73f45b4935eabb14507248f48cb3295271980e))

## [0.4.0](https://github.com/BramGrammer/fairway/compare/v0.3.1...v0.4.0) (2026-11-11)


### Features

* change alert settings from the interface ([6d9ffb5](https://github.com/BramGrammer/fairway/commit/6d9ffb5480174df17759a75cef60468b2aa8e419))
* choose which hosts send Alerts on the Routes page ([3f96b7a](https://github.com/BramGrammer/fairway/commit/3f96b7a1409249f282b3aacacbcf397f61a45f84))
* event history and ntfy alerts, with settings and per-host choice ([84b6ea6](https://github.com/BramGrammer/fairway/commit/84b6ea60181233f6a3bce5621fb76c849a10eb19))
* keep a history of Subject States and send Alerts through ntfy ([a70b7f9](https://github.com/BramGrammer/fairway/commit/a70b7f9668c670f9fde946ed9a47d810b7745457))
* **metrics:** keep traffic history across restarts ([66b9868](https://github.com/BramGrammer/fairway/commit/66b9868c30481a41fc8f4dc203e02b09a4650f41))
* **metrics:** keep traffic history across restarts ([3936b6d](https://github.com/BramGrammer/fairway/commit/3936b6d1d7885e9c2ab85ad61f174690a5d7cee6))
* **web:** add a settings dialog with a sidebar of categories ([ad80659](https://github.com/BramGrammer/fairway/commit/ad80659e5108c60593b2c779d956946d8bdc7d55))

## [0.3.1](https://github.com/BramGrammer/fairway/compare/v0.3.0...v0.3.1) (2026-11-10)


### Bug Fixes

* **routes:** hide the visitor details note when login is on ([1a744fa](https://github.com/BramGrammer/fairway/commit/1a744fa3a630dd1cc1ee7365085f25891bee899f))
* **routes:** newest log lines first, hold the list while reading ([403724d](https://github.com/BramGrammer/fairway/commit/403724d9f33d5e7c24aed6e10c5835cd96fdbb30))
* **routes:** show newest log lines first and hold the list while reading ([cc10424](https://github.com/BramGrammer/fairway/commit/cc104242a8a75981d13bbed7406130b19beeef7c))

## [0.3.0](https://github.com/BramGrammer/fairway/compare/v0.2.1...v0.3.0) (2026-11-09)


### ⚠ BREAKING CHANGES

* **auth:** REQUIRE_TAILSCALE_LOGIN and the tailscale compose profile (TS_AUTHKEY, TS_ALLOWED_LOGIN) are removed. Deployments that used the profile must publish the editor through the local profile and restrict access another way.

### Features

* **auth:** add the owner login ([c90e37d](https://github.com/BramGrammer/fairway/commit/c90e37d2b772f26c55bc556727d21e3eee1f52c5))
* **auth:** add the owner login and remove the Tailscale gate ([1921335](https://github.com/BramGrammer/fairway/commit/19213351ef540edead3f570551245a9c76254a12))
* **auth:** remove the Tailscale gate and profile ([ae9a1ef](https://github.com/BramGrammer/fairway/commit/ae9a1efd4ec96e89f0145c544b349af82ec7a639))
* **routes:** show a host's access log in its drawer ([465c33d](https://github.com/BramGrammer/fairway/commit/465c33d39164c78ca1a460756115c07c0ca6e522))
* **routes:** show a host's access log in its drawer ([f897dcc](https://github.com/BramGrammer/fairway/commit/f897dccb9fbfbc0f1340722f1878a7f7fd2aeaf2))

## [0.2.1](https://github.com/BramGrammer/fairway/compare/v0.2.0...v0.2.1) (2026-11-09)


### Bug Fixes

* **routes:** draw middleware that runs in a different order as a separate node ([b15fa99](https://github.com/BramGrammer/fairway/commit/b15fa99969b22ee24d524ced5017e0ab8e0b9214))

## [0.2.0](https://github.com/BramGrammer/fairway/compare/v0.1.0...v0.2.0) (2026-11-08)


### Features

* TLS status, certificate probing and upstream health APIs ([397990a](https://github.com/BramGrammer/fairway/commit/397990a4cbe3cac86fab37a6ff22b9312e694fd9))
* **web:** draw each middleware as its own node in the routes graph ([8ee1070](https://github.com/BramGrammer/fairway/commit/8ee107031d6f2746fdd8b71e0277c90da137588f))
* **web:** pan and zoom canvas for the routes graph ([fd24c62](https://github.com/BramGrammer/fairway/commit/fd24c62e3f4772fbd287e8a31bb9e759260cec6b))
* **web:** restyle the routes graph nodes and show open groups as panels ([d99a4ec](https://github.com/BramGrammer/fairway/commit/d99a4ec67a86ed15699f688121f4cbeeef4c3b0f))
* **web:** route drawer and graph search ([3a42546](https://github.com/BramGrammer/fairway/commit/3a4254689a00115f4bf2a63a16e2e73d53196a84))
* **web:** show how each host is secured in the routes graph ([b0058dd](https://github.com/BramGrammer/fairway/commit/b0058dd8511e54a8c1ac61f6ffda90f3e114b8ef))
* **web:** tidy the lines of the routes graph ([8714658](https://github.com/BramGrammer/fairway/commit/8714658cc16bfd2f9bc3c5aa20d4f99a7b098d43))

## 0.1.0 (2026-11-05)


### Features

* caddy editor with validate-and-reload, history, logs and shadcn UI ([0005500](https://github.com/BramGrammer/fairway/commit/0005500f0d65e6bda16d6c9aa9fbdfd8ff8fbedc))
* routes graph with live per-site traffic ([a7d5d06](https://github.com/BramGrammer/fairway/commit/a7d5d0619aa3347730074b0b1d6330dc34c58742))


### Bug Fixes

* run on Node.js 26 (LTS) in the image, CI and tooling ([31408eb](https://github.com/BramGrammer/fairway/commit/31408ebad4be4418ec93f17651bef5439dd62479))
