# Source: owner-approved UX plan for the transcript (2026-10-23), sections 2 "The layout bug in msg 4291" and 3 "Day separators".
# Owner wording for the labels: "today, yesterday, older" (https://convoz.drewdrewthis.com/chats/117#m3077).
# A label is a row of the message list, in the browser's time zone: "Today", "Yesterday", "Wed 21 Oct", and "Wed 14 Sep 2025" for
# another year. A thread has no labels; a reply on another day than its root shows its day before its time. Every row of the
# transcript (messages, threads, notices, the New line, the day labels) sits in one centred column.
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Day labels
  As the owner
  I want to see on which day a message was written
  So that I know when things happened without opening each message

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are active participants of conversation 41 "Ship search filters"

  Rule: The main list labels each day once, above its first message

    @v1 @browser
    Scenario: A conversation labels each day once, above its first message
      Given "devtool" posted "Old news" 5 days ago, "Yesterday news" yesterday and "Today news" today in conversation 41
      When the owner opens conversation 41
      Then the day labels read the date of 5 days ago, "Yesterday" and "Today", in that order and once each
      And each label is above its day's message and below the message of the day before

  Rule: A thread has no day labels; a reply from another day says its day

    @v1 @browser
    Scenario: A thread has no day labels, and a reply from another day shows its day by its time
      Given "devtool" posted message 900 "Step 1 is the filter chips UI" 2 days ago
      And "devtool" replied "Same day reply" in thread 900 that day, and "docs" replied "Next day reply" yesterday at 5:24 PM
      When the owner opens conversation 41
      Then the thread under message 900 shows no day label
      And the time of "Next day reply" reads "Yesterday" and then the clock
      And the time of "Same day reply" is the clock alone

  Rule: The time of a message is the clock; its full date is one hover away

    @v1 @browser
    Scenario: Hovering the time of a message shows its full date and time
      Given "devtool" posted "Dated news" yesterday at 9:30 AM in conversation 41
      When the owner opens conversation 41 and hovers the time of "Dated news"
      Then the time shows its full date with the year as its title
      And the time carries the moment of the message as its machine-readable date

  Rule: Every row of the transcript shares one column

    @v1 @browser
    Scenario: On a wide screen a notice line starts at the same left edge as the messages
      Given the window is 1600 px wide
      And "devtool" posted "A message in the column" and the line "Added @docs" is in conversation 41
      When the owner opens conversation 41
      Then the line "Added @docs" starts within 2 px of the left edge of the message
