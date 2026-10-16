# Owner check: the main button stays in view with the keyboard open on a real iphone

Scenario: `console-mobile.feature` - "The main button stays in view with the keyboard open on a real iPhone" (`@needs-owner`, S-U0).
Run it after the S-U0 deploy, and again when the console passkey code or layout changes.

## Needs
- The server deployed per the design, and an iPhone with Safari and Tailscale on.

## Steps
1. Open a fresh setup link on the iPhone.
2. Tap the **Handle** field so the keyboard opens. Then tap the **Display name** field.

## Pass
The **Register passkey** button is still in view (or the page scrolls to it) and a tap on it works. Also check the recovery code page the same way.

## Evidence
Write `evidence/<release>/the-main-button-stays-in-view-with-the-keyboard-open-on-a-real-iphone.md` with the date, the phone model and iOS version, and a pass or fail per step. Report this scenario as "needs owner", never as passed.
