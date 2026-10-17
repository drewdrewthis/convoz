# Source: design draft 9 §9 (PWA offline), §12.2 (client budget), §12.3 (poor connections), §12.5 (DERP), AC-10, AC-20.
# Kept from the draft-6 spec (D-1), tightened: an agent message reaches the owner's open browser with no reload;
# the phone check over Tailscale stays a hand-run owner check.
# The lossy profile is 400 ms RTT, 2% loss, 400 kbps both ways, by `tc netem` in a user + network namespace;
# when netem is not available on CI the stall proxy is used and the report says so.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Poor connections
  As the owner on mobile data, and as an agent on a tethered laptop
  I want Convoz to stay fast and lose nothing on slow, lossy and dropping links
  So that I can trust it from anywhere

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Nothing sent is lost or doubled (AC-20)

    @v1 @browser @lossy @I-24 @AC-20 @unimplemented
    Scenario: Twenty messages sent across three outages arrive once and in order
      Given the owner's browser is on the lossy profile
      When the owner sends 20 numbered messages and the browser goes offline 3 times while sending
      Then a second browser shows messages 1 to 20 exactly once and in order
      And the first browser shows no message as "failed · retry"

    @v1 @browser @lossy @I-27 @I-31 @AC-20 @unimplemented
    Scenario: A voice note upload cut halfway resumes
      Given the owner records a 5 MB voice note on the lossy profile
      When the connection drops at about 50% of the upload
      Then the upload resumes from the server's committed offset, which is above 0
      And the voice note plays in a second browser

    @v1 @browser @lossy @AC-20 @unimplemented
    Scenario: With Save-Data on, no media loads until tapped
      Given the browser reports Save-Data on
      When the owner opens a conversation with 3 images, an unfurl card and an app preview
      Then the network log shows 0 image, unfurl or app-preview requests
      And each placeholder shows its size and "tap to load"
      And tapping one image loads only that image

    @v1 @browser @lossy @unimplemented
    Scenario: A message sent offline waits in the outbox
      Given the owner's browser is offline
      When the owner sends "be back soon"
      Then the bubble shows "sending"
      And it is delivered once when the browser is back online

  Rule: The live link degrades gracefully

    @v1 @browser @unimplemented
    Scenario: A network error never wipes the offline cache
      Given the installed app has cached conversation 41
      When the server cannot be reached and then refuses one request for a reason other than a revoked device
      Then conversation 41 still opens from the cache with the last sync time shown

    @v1 @browser @unimplemented
    Scenario: A revoked device clears the offline cache
      Given the installed app has cached conversation 41
      When the owner revokes this device from another device
      Then on its next request the app clears its stored data and shows sign in

    @v1 @browser @unimplemented
    Scenario: The offline shell opens with the cached rail and Now
      Given the installed app synced the 20 most recent conversations
      When the device is offline and the app opens
      Then the rail, Now and the last 200 messages of each cached conversation show
      And a banner shows the last sync time

  Rule: The app is fast on a mid-range phone (AC-10)

    @v1 @browser @lossy
    Scenario: An agent message reaches the owner's open browser with no reload
      Given the owner's browser shows conversation 41 on the lossy profile
      When "devtool" runs "convoz post 41 hi"
      Then in at least 19 of 20 runs the message shows within 2 seconds

  Rule: The owner can see how the link behaves

    @v1 @browser @unimplemented
    Scenario: Settings shows the connection quality
      When the owner opens Settings → Advanced → Connection
      Then it shows the median RTT, the last 20 samples and the effective connection type

    @v1 @browser @phone @needs-owner @unimplemented
    Scenario: A message reaches the owner's phone over Tailscale
      Given the owner's phone is on mobile data with the installed app open
      When "devtool" runs "convoz post 41 hi"
      Then the message shows on the phone within 3 seconds with no reload

    @v1 @browser @phone @needs-owner @unimplemented
    Scenario: The admin health page shows a relayed phone link
      Given the owner's phone reaches the server through a DERP relay
      When the owner opens the admin health view
      Then the phone's client shows a median RTT and the path "relayed"
