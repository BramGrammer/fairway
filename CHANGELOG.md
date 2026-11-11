# Changelog

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
