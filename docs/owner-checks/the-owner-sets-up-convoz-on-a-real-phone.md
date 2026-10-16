# Owner check: the owner sets up Convoz on a real phone

Scenario: `onboarding.feature` · "The owner sets up Convoz on a real phone" (`@needs-owner`, AC-2).
Run it on the first deploy, and again when the passkey or `tailscale serve` code changes.

## Needs
- The server deployed per the design (dedicated `convoz` user, `--listen unix:///run/convoz/http.sock`,
  `--host convoz.<tailnet>.ts.net`, `tailscale serve --bg unix:/run/convoz/http.sock`, funnel off).
- An iPhone with Safari and Tailscale on, signed in to your tailnet.

## First on a fresh deploy: what the tests cannot see (fake Tailscale only)
Record each answer in the evidence file. A "no" is a bug to file before you go on.
1. `tailscale serve` keeps the original name: `curl --unix-socket` cannot show it, so open
   `https://convoz.<tailnet>.ts.net/api/version` from the phone. It must answer JSON (not 421).
2. `tailscale serve` sets `X-Forwarded-For` and `Tailscale-User-*` on what it forwards. Look at the server log for 421s;
   the wall trusts these headers only on the unix socket.
3. The `convoz` user can run `tailscale serve status --json` and `tailscale whois --json <tailnet-ip>` (as that user).
   Without whois the machine-request "source" shows "unknown".

## Steps
1. On the server box: `convoz admin bootstrap-link`. It prints `https://convoz.<tailnet>.ts.net/bootstrap#cvz_b_...`.
2. Send the link to the phone (AirDrop or a note) and open it in Safari with Tailscale on.
3. Type a handle and a display name, tap **Register passkey**, and confirm with Face ID or Touch ID.
4. The page shows **Set up a second way in** with 10 recovery codes. Save them in your password manager. Tap **Copy codes** once.
5. Tap **Add a passkey** and add the laptop (or a hardware key) as the second passkey.
6. Tap **Continue**. The phone shows **Now**.
7. Close the tab, open `https://convoz.<tailnet>.ts.net/signin`, tap **Sign in with a passkey**. The phone shows **Now**.

## Pass
Steps 3 to 7 work with a real passkey; the recovery codes are not shown again anywhere afterwards; the link does not work a second time.

## Evidence
Write `evidence/<release>/the-owner-sets-up-convoz-on-a-real-phone.md` with the date, the phone model and iOS version, the three answers above and a pass or fail per step. Report this scenario as "needs owner", never as passed.
