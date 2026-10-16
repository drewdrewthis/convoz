# Owner check: a real iphone sets up a second passkey and new recovery codes

Scenario: `console-mobile.feature` - "A real iPhone sets up a second passkey and new recovery codes" (`@needs-owner`, S-U0).
Run it after the S-U0 deploy, and again when the console passkey code or layout changes.

## Needs
- The server deployed per the design, and an iPhone with Safari and Tailscale on.

## Steps
1. On the server box run `convoz admin bootstrap-link`. Open the link in Safari on the iPhone.
2. See **Welcome to Convoz**. Type a handle and a display name. Tap **Register passkey**. Face ID opens at once.
3. See **Step 2 of 3**. The 10 codes show. Tap **Copy codes**, then **Download codes**. Tick **I saved them**. Tap **Continue**.
4. See **Step 3 of 3**. The page tells you to use a laptop or a security key. Tap **Add a passkey**, **Confirm it's you** (Face ID opens at once), then **Create the new passkey** and use the security key.
5. Open the account menu, then **Recovery codes**. See "10 of 10 codes left". Tap **Make new codes**. Face ID opens at once. 10 new codes show once.

## Pass
Every tap opens its passkey prompt at once (no tap does nothing), and the codes show once.

## Evidence
Write `evidence/<release>/a-real-iphone-sets-up-a-second-passkey-and-new-recovery-codes.md` with the date, the phone model and iOS version, and a pass or fail per step. Report this scenario as "needs owner", never as passed.
