# Source: design draft 9 §2.3 (pin, star, mute, read state per user), §4.2 (`prefs` and `pins`), I-21, I-22.
# Prototype: star toggle on rail rows and the header ("Starred" / "Unstarred" toast), "Pinned in this conversation",
# message pin action, "Muted" in the header subline.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Pins, stars and mute
  As the owner
  I want to star the conversations I care about, pin key messages and mute noisy ones
  So that the important things stay in reach and the noise stays quiet

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And conversations 41 "Ship search filters", 52 "Deploy alerts runbook" and 60 "Weekly usage" exist with "devtool"

  Rule: Stars move a conversation to the top of Starred

    @v1 @browser @I-21
    Scenario: Starring a conversation puts it at the top of Starred
      Given conversation 52 is starred
      When the owner stars conversation 60
      Then the Starred group lists 60 above 52
      And a toast says "Starred"

    @v1 @browser @I-21
    Scenario: Unstarring puts a conversation at the top of Conversations
      Given conversation 60 is starred
      When the owner unstars it
      Then conversation 60 is first in the Conversations group

    @v1 @browser
    Scenario: The star state survives a reload and shows on other devices
      When the owner stars conversation 41
      Then a second browser of the owner shows 41 in Starred with no reload

  Rule: Pins collect key messages per conversation

    @v1 @browser
    Scenario: Pinning a message adds it to the pinned list
      Given "devtool" posted "Runbook: https://docs.acme.dev/runbooks/deploy-alerts" in conversation 52
      When the owner pins that message
      Then "Pinned in this conversation" lists it
      And the message shows a pin mark

    @v1 @browser
    Scenario: Unpinning removes it from the list
      Given a pinned message in conversation 52
      When the owner unpins it
      Then "Pinned in this conversation" no longer lists it

  Rule: Mute silences pushes but not Now

    @v1 @browser
    Scenario: A muted conversation shows Muted and sends no push
      When the owner mutes conversation 60
      Then the conversation title bar shows "Muted"
      And a new message in conversation 60 creates a notification record with the reason "muted" and no push

  Rule: Personal state stays personal (I-22)

    @later @browser @I-22
    Scenario: Stars, pins and mutes of one person never reach another
      Given member "mia" is in conversations 41 and 52
      When the owner stars 41, pins a message in 52 and mutes 52
      Then "mia" sees 41 unstarred, the message unpinned and 52 unmuted

    @v1 @api @I-22
    Scenario: An agent's read state is its own
      Given "devtool" and "docs" are in conversation 41 and "docs" read it all
      When "devtool" asks for its conversations
      Then conversation 41 shows unread for "devtool"
