# Owner check: a device off the tailnet cannot connect

Scenario: `security.feature` · "A device off the tailnet cannot connect" (`@needs-owner`, I-41, AC-24).
Run it after every deploy that changes the unit, the Tailscale serve config or the tailnet ACL, and before each release.

## Needs
- The server running as the `convoz` user behind `tailscale serve`, funnel off.
- A phone (or any device) with Tailscale installed, and a way to turn Tailscale off on it.

## Steps
1. On the server box run `tailscale funnel status` and `tailscale serve status`. Funnel must show nothing for Convoz.
2. On the phone, turn Tailscale **off** (cellular or a network that is not yours).
3. Open `https://convoz.<tailnet>.ts.net` in the phone browser.
4. From a machine that is not on the tailnet run `curl --max-time 10 https://convoz.<tailnet>.ts.net/api/version`.

## Pass
- Step 3: the browser cannot connect. No Convoz page, no sign-in screen, no certificate warning page served by Convoz.
- Step 4: curl fails to connect (timeout or "could not resolve"). It must not print JSON.

## Fail
Any page or JSON from the server while off the tailnet. Stop the service, then check the funnel status and the serve config.

## Evidence
Write `evidence/<release>/a-device-off-the-tailnet-cannot-connect.md` with the date, the two `status` outputs, the phone result and the curl output. Report this scenario as "needs owner", never as passed.
