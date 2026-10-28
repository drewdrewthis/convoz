# Contracts for `features/dev-web.feature`: the /dev route, its folder and the build. Checked by Go unit tests
# (apps/convoz/internal/server/httpapi/dev_web_test.go), the web unit tests (apps/web/src/shared/basePath.test.ts, devScope.test.ts)
# and, for the service worker and the real listener, e2e/tests/dev-web.spec.ts (CI only: no browser on the sweatshop).

Feature: The owner's dev copy of the screens (contracts)
  `convoz serve --dev-web-dir` (default $CONVOZ_DEV_WEB_DIR) names the folder of the dev build: on prod the symlink
  /var/lib/convoz-devweb/current to a release folder. The server reads it at each request.

  Background:
    Given a fresh Convoz server

  Rule: Only the owner's device session reaches /dev, and nobody else learns it exists

    @v1 @api
    Scenario: The owner gets the dev build, uncached, under the console's policy
      Given --dev-web-dir names a dev build
      When the owner's device session asks for /dev/, /dev/chats/12 and /dev/assets/<file>
      Then each answers 200 with the console's Content-Security-Policy, and Cache-Control no-store (a hashed file under assets/ is kept a year)
      And a screen path answers the build's index.html, and a missing file under assets/ answers 404
      And /dev answers a redirect to /dev/

    @v1 @api
    Scenario: Everyone but the owner gets 404 at /dev, as for an unknown path
      Given --dev-web-dir names a dev build
      When a client with no cookie, an unknown cookie, an agent's lease, an unknown bearer, or a lease next to the owner's cookie asks for /dev, /dev/ or a file under it
      Then each answers 404, never 401, 403 or a redirect to sign in
      And the agent listener has no /dev route at all

    @v1 @api
    Scenario: With no folder, /dev is off
      When --dev-web-dir is empty, names a missing folder, or a folder with no index.html
      Then the owner gets 404 at /dev/ and at every path under it

  Rule: The route never serves a file outside the build

    @v1 @api
    Scenario: Traversal and symlinks are refused
      Given --dev-web-dir names a dev build that holds a symlink out of the folder and symlinks inside it
      When the owner asks for /dev/../secret.txt, /dev/%2e%2e/secret.txt, /dev/..%2f..%2fsecret.txt and each symlink
      Then no answer carries the file outside the folder
      And every symlink in the build answers 404: the build is served as an os.Root that follows none

    @v1 @api
    Scenario: A new build shows at the next request, with no restart
      Given the owner has loaded /dev/
      When a new current symlink to a new release folder is renamed over the old one
      Then the next request answers the new build

  Rule: The dev build stays under /dev/ and leaves the real app alone

    # Needs a vite build of the dev app inside the e2e job (apps/web unit tests cover the base path and the scope).
    @later @api
    Scenario: The dev build is the app with base /dev/, no service worker and a DEV badge
      When apps/web is built with `pnpm --filter @convoz/web build:dev`
      Then its index.html loads its files from /dev/assets/, and the app reads and writes every path under /dev/
      And it registers no service worker, and shows a DEV badge on every screen
      And the real build (pnpm --filter @convoz/web build) carries none of the dev code

    @v1 @browser
    Scenario: The real app's service worker never answers a request under /dev
      Given --dev-web-dir names a dev build whose page shows a DEV badge
      And the owner opened the real app and its service worker controls the page
      When the owner opens /dev/ in the same browser
      Then the page and its files come from the network, none from the service worker
      And the DEV badge renders, never the cached shell of the real app

    @v1 @api
    Scenario: The dev build is made in CI, gated, and handed over by checksum
      When a commit is force-pushed to the dev-web branch (scripts/dev-web-push.sh)
      Then .github/workflows/dev-web.yml fails unless the base branch's scripts/fast_lane.py says ELIGIBLE
      And its one job, dev-web, fails unless the build is regular files and folders named of [A-Za-z0-9._@+=,~-], index.html at the top, at most 5000 files, 150 MB unpacked and 50 MB packed
      And it uploads the artifact dev-web-<sha> holding only dev-web-<sha>.tar.gz, and prints its sha256 once as a notice titled sha256
