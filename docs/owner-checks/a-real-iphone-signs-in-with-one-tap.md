# Owner check: a real iphone signs in with one tap

Scenario: `console-mobile.feature` - "A real iPhone signs in with one tap" (`@needs-owner`, S-U0).
Run it after the S-U0 deploy, and again when the console passkey code or layout changes.

## Needs
- The server deployed per the design, and an iPhone with Safari and Tailscale on.

## Steps
1. Close the tab. Open `https://convoz.<tailnet>.ts.net/signin` in Safari.
2. Tap **Sign in with a passkey** once.

## Pass
Face ID or Touch ID opens at once, with no second tap, and the app shows **Now**. Wait 6 minutes on the sign-in page before the tap: if it says the check timed out, tap again and it signs in.

## Evidence
Write `evidence/<release>/a-real-iphone-signs-in-with-one-tap.md` with the date, the phone model and iOS version, and a pass or fail per step. Report this scenario as "needs owner", never as passed.
