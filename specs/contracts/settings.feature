# Contracts for `features/settings.feature`: protocol, security and invariant checks that pin
# implementation details. They run end to end like every scenario; the user-facing
# behaviour lives in specs/features/settings.feature.
# Source: design draft 9 §11 (with the draft 7 §11 registry), §9 (theme with no flash), §12.3 (media auto-load),

Feature: Settings (contracts)
  Protocol, security and invariant rules behind settings.
  Status codes, headers, races and data-file checks live here, not in the user-facing file.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey

  Rule: The server checks every setting (I-29)

    @v1 @api @I-29
    Scenario Outline: Bad settings are refused
      When the owner sets <change>
      Then the server answers 400

      Examples:
        | change                                                   |
        | an unknown key "notify.everything" to true                |
        | "notify.previews" to "loud"                               |
        | "notify.quiet_hours" to {"start": "25:00", "end": "07:00"} |
        | the device-only key "theme" on the server                 |

    @later @api @I-29
    Scenario: A member cannot change workspace settings
      When member "mia" sets the workspace key "inbox.visibility_default" to "10m"
      Then the server answers 403
