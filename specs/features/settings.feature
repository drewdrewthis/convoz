# Source: design draft 9 §11 (with the draft 7 §11 registry), §9 (theme with no flash), §12.3 (media auto-load),
# §12.5 (Connection panel), I-29, AC-11.
# Device settings live on the device and are not synced: theme, text_size, reduced_motion, enter_to_send,
# badge_enabled, media_autoload, push_enabled.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Settings
  As the owner
  I want settings that apply at once, on the right scope, and never surprise me
  So that the app looks and behaves the way I want on each device

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey

  Rule: Appearance applies at once and without a flash

    @v1 @browser @AC-11
    Scenario: The system theme switches live
      Given the theme setting is "system" and the system is light
      When the system switches to dark
      Then the app turns dark with no reload
      And the screenshots before and after show no unstyled frame

    @v1 @browser @AC-11
    Scenario: A reload in dark mode paints dark from the first frame
      Given the theme setting is "dark"
      When the owner reloads the app
      Then the first painted frame is dark

    @v1 @browser
    Scenario: Device settings stay on the device
      Given the owner sets text size "xl" on the laptop
      When the owner opens the app on the phone
      Then the phone still uses text size "m"

    @v1 @browser
    Scenario: The palette follows the owner across devices
      When the owner picks a different palette on the laptop
      Then the phone uses the same palette after its next sync

  Rule: The server checks every setting (I-29)

    @v1 @api @I-29
    Scenario: A setting never changed reads as its default
      When the owner reads the settings
      Then "notify.previews" is "full", "notify.machine_requests" is true, "notify.urgent_bypass" is true and "brief.max_bytes" is 12288

    @v1 @api @unimplemented
    Scenario: The owner sets the workspace inbox and brief defaults
      When the owner sets "inbox.visibility_default" to "10m" and "brief.max_bytes" to 12000
      Then a new agent claim without a visibility holds its items for 10 minutes
      And "convoz brief" without --max-bytes returns at most 12000 bytes

  Rule: Media auto-load follows the network unless the owner says otherwise

    @v1 @browser @unimplemented
    Scenario Outline: Media auto-load decides when images load
      Given the device setting "media auto-load" is "<setting>" and the network is <network>
      When the owner opens a conversation with an image
      Then the image <loads>

      Examples:
        | setting | network                         | loads                      |
        | auto    | 4g with a 40 ms ping            | loads at once              |
        | auto    | 3g                              | waits for a tap            |
        | auto    | unknown with a 450 ms ping      | waits for a tap            |
        | always  | 3g                              | loads at once              |
        | never   | 4g with a 40 ms ping            | waits for a tap            |

  Rule: Privacy and security are in one place

    @v1 @browser
    Scenario: Privacy and security lists what the owner controls
      When the owner opens Settings → Privacy & security
      Then it lists devices, passkeys, machines, sessions, sign out all, export and delete
      And it does not list personal access tokens

    @v1 @browser @I-26 @unimplemented
    Scenario: Signing out all other devices needs a passkey
      Given the owner is signed in on a laptop and a phone
      When the owner signs out all other devices from the laptop with a passkey
      Then the phone shows sign in on its next request
