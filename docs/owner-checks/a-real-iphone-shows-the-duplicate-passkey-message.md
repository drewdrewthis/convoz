# Owner check: a real iphone shows the duplicate passkey message

Scenario: `console-mobile.feature` - "A real iPhone shows the duplicate passkey message" (`@needs-owner`, S-U0).
Run it after the S-U0 deploy, and again when the console passkey code or layout changes.

## Needs
- The server deployed per the design, and an iPhone with Safari and Tailscale on.

## Steps
1. Sign in on the iPhone. Open **Passkeys**.
2. Tap **Add a passkey**, **Confirm it's you**, then **Create the new passkey** and choose the iPhone itself (iCloud Keychain).

## Pass
The page says: This device already has a Convoz passkey. Use another device or a security key. The list still shows the same passkeys.

## Evidence
Write `evidence/<release>/a-real-iphone-shows-the-duplicate-passkey-message.md` with the date, the phone model and iOS version, and a pass or fail per step. Report this scenario as "needs owner", never as passed.
