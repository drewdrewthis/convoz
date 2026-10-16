# Source: S-U0 (Refs #16). The owner set up Convoz on an iPhone and said: "So ugly, and doesn't actually work correctly?
# The whole sign up and login and etc for mobile needs a ui/ux pass." This file pins what the owner sees and does on a phone:
# one passkey prompt per tap, plain error messages, a recovery codes page, a clear passkeys list and a layout that fits 390 px.
# Scenarios tagged @phone run in the Playwright "mobile" project (chromium, 390x844, touch). The others run on desktop and phone.
# Real-iPhone checks are @needs-owner; each has a runbook in docs/owner-checks/.
# The UI contract (names, messages) is the comment block at the top of e2e/tests/console-mobile.spec.ts.

Feature: Console on a phone
  As the owner
  I want sign up, sign in and settings to work in one tap on my phone
  So that I am never stuck at a passkey prompt that does nothing

  Background:
    Given a fresh Convoz server

  Rule: One tap starts one passkey prompt, at once

    @v1 @browser
    Scenario: Signing in takes one tap and one passkey prompt
      Given the owner has a passkey on this device
      When the owner opens the sign-in page and taps "Sign in with a passkey"
      Then one passkey prompt opens at once, with no network call waited on between the tap and the prompt
      And the app shows Now

    @v1 @browser
    Scenario: Adding a passkey takes a check and then a create, one prompt each
      Given the owner is signed in and opens Passkeys
      When the owner taps "Add a passkey", then "Confirm it's you", then "Create the new passkey" on a security key
      Then each of the last two taps opens exactly one passkey prompt, at once
      And the list shows two passkeys and the new one says "Added just now"

    @v1 @browser
    Scenario: A stale passkey prompt is renewed and the next tap works
      Given the owner opened the sign-in page more than 5 minutes ago
      When the owner taps "Sign in with a passkey"
      Then the app says the check timed out and asks for another tap
      And the next tap signs the owner in with one passkey prompt

    @v1 @browser
    Scenario: A device that already has a Convoz passkey gets a clear message
      Given the owner is signed in and opens Passkeys
      When the owner taps "Add a passkey", then "Confirm it's you", then "Create the new passkey" on the same device
      Then the app says this device already has a Convoz passkey and to use another device or a security key

    @v1 @browser
    Scenario: A closed passkey prompt shows a plain message and can be retried
      Given the owner opened the sign-in page
      When the owner closes the passkey prompt
      Then the app says the prompt was closed or timed out and to try again
      And the next tap signs the owner in

    @v1 @browser @phone
    Scenario: The owner approves and denies machines from a phone
      Given machines "box-2" and "box-3" wait for approval and the owner is signed in on a phone
      When the owner types the code, taps Approve on the card of "box-2" and Approve in the sheet
      Then the card showed the machine name, the source address and the code
      And one passkey prompt opens at once and the app says "Approved"
      And the Approve button in the sheet is in view and at least 44 px tall
      And one tap on Deny removes the card of "box-3"

  Rule: First run on a phone saves the codes before the second way in

    @v1 @browser @phone
    Scenario: First run on a phone creates the owner, saves the codes, then offers a second way in
      Given the owner opens a setup link on a phone
      When the owner creates the first passkey, saves the recovery codes and skips the second way in
      Then the first page says "Welcome to Convoz" and asks for a handle and a display name
      And step 2 of 3 shows the 10 recovery codes and Continue waits for "I saved them"
      And step 3 of 3 tells the owner to use a laptop or a security key and offers "Skip for now"
      And the app shows Now with a reminder to add a second way in

    @v1 @browser
    Scenario: Recovery codes are shown once with Copy and Download
      Given the owner registered the first passkey
      When the app shows the recovery codes
      Then the owner can copy all 10 codes
      And the owner can download all 10 codes as a text file

  Rule: A setup link that cannot be used says why

    @v1 @browser
    Scenario Outline: A used, expired or missing setup link says what happened and how to get a new one
      Given a setup link that is <state>
      When the owner opens the link
      Then the page says "<title>"
      And the page gives the command "convoz admin bootstrap-link" for a new link
      And the page has no form

      Examples:
        | state   | title                      |
        | used    | This link was already used |
        | expired | This link expired          |
        | missing | This link is not valid     |

    @v1 @browser
    Scenario: A used setup link opened while signed in offers Go to Convoz
      Given the owner is signed in
      When the owner opens a setup link that was already used
      Then the page offers "Go to Convoz" instead of the command

  Rule: Signing in again, and signing back in

    @v1 @browser
    Scenario: Opening sign-in while signed in goes to Now
      Given the owner is signed in
      When the owner opens the sign-in page
      Then the app shows Now

    @v1 @browser
    Scenario: An expired session sends the owner to sign in and back
      Given the owner is signed in on Recovery codes and the session ends
      When the owner taps "Make new codes"
      Then the app shows Sign in and keeps the page the owner was on
      And after signing in the app shows Recovery codes again

  Rule: Lost phone

    @v1 @browser
    Scenario: A lost phone is recovered with a recovery code and a new passkey
      Given the owner lost every passkey and types a recovery code with spaces
      When the owner taps "Lost your passkey? Use a recovery code" and then "Add a passkey"
      Then the page offers nothing else but adding a passkey
      And one passkey prompt opens at once
      And the app shows Now with the note that codes are left and that some actions are paused for 24 hours

  Rule: Recovery codes have their own page

    @v1 @browser
    Scenario: The recovery codes page says how many codes are left
      Given the owner used one recovery code
      When the owner opens Recovery codes
      Then the page says "9 of 10 codes left"

    @v1 @browser
    Scenario: New recovery codes need a passkey check and void the old set
      Given the owner is signed in and opens Recovery codes from the account menu
      When the owner taps "Make new codes"
      Then one passkey prompt opens at once
      And 10 new codes are shown once, with Copy and Download
      And the old codes no longer work
      And the codes are not shown again after the page reloads

    @v1 @browser
    Scenario: New recovery codes are refused while the newest passkey is under the 24-hour hold
      Given the owner signed in with a passkey added by a recovery code 2 hours ago
      When the owner taps "Make new codes"
      Then the app explains that the passkey is less than 24 hours old and that an older passkey is needed
      And the button "Make new codes" stays

    @v1 @browser
    Scenario: A lost answer on new recovery codes can be retried
      Given the answer to "Make new codes" is lost on the way
      When the owner taps "Make new codes" again
      Then the first try says to try again and keeps the button
      And the second try shows 10 codes that work

  Rule: The passkeys list explains each passkey, and removing one is a confirmed step

    @v1 @browser
    Scenario: Removing a passkey asks for confirmation and one passkey prompt
      Given the owner has two passkeys and is signed in with the first
      When the owner taps "Remove passkey" on the second, reads the confirm sheet naming it and confirms
      Then one passkey prompt opens at once
      And the second passkey is gone from the list


    @v1 @browser
    Scenario: The passkeys list shows last used, how each was added and this device
      Given the owner has two passkeys and signed in with the first on this device
      When the owner opens Passkeys
      Then the first passkey is marked "This device", shows its last use and says it was added with the setup link
      And the second passkey shows "Never used" and says it was added in settings
      And only one passkey is marked "This device"

  Rule: The app has a bar, a bottom nav and an account menu

    @v1 @browser @phone
    Scenario: The account menu lists Passkeys, Recovery codes and Sign out
      Given the owner is signed in on a phone
      When the owner opens the account menu
      Then the menu lists "Passkeys", "Recovery codes" and "Sign out"
      And the bottom nav shows "Now" and "Account"

    @v1 @browser @phone
    Scenario: Sign out from the account menu ends the session
      Given the owner is signed in on a phone
      When the owner picks "Sign out" in the account menu
      Then the app shows Sign in with the note "Signed out"
      And the old session no longer works

  Rule: The layout fits a phone

    @v1 @browser @phone
    Scenario: Forms on a phone have labels above full-width fields and a full-width main button
      Given the owner is on a phone
      When the owner opens the setup page, the recovery code page and the sign-in page
      Then every label sits above its field
      And every field is full width and at least 44 px tall
      And the main button is full width and at least 44 px tall
      And every button and menu item on a phone is at least 44 px tall

    @v1 @browser @phone
    Scenario Outline: No page scrolls sideways on a phone
      Given the owner is on a phone
      When the owner opens "<page>"
      Then the page is no wider than a 390 px screen and no wider than a 320 px screen

      Examples:
        | page               |
        | Sign in            |
        | Recovery code      |
        | Setup              |
        | Used setup link    |
        | Now                |
        | Machines           |
        | Passkeys           |
        | Recovery codes     |
        | Second way in      |

    @v1 @browser @phone
    Scenario: The console is dark by default and has a light look
      Given the owner is on a phone
      When the owner opens each page with no colour preference, with dark and with light
      Then the pages are dark with no preference and with dark
      And the pages are light with light
      And a screenshot of each page in dark and in light is attached

  Rule: Real iPhone checks are run by the owner

    @v1 @browser @phone @needs-owner
    Scenario: A real iPhone sets up a second passkey and new recovery codes
      Given the owner opens a setup link on an iPhone
      When the owner registers a passkey, adds a second one on a security key and makes new recovery codes
      Then every tap opens its passkey prompt and the codes are shown once

    @v1 @browser @phone @needs-owner
    Scenario: A real iPhone shows the duplicate passkey message
      Given the iPhone already has a Convoz passkey
      When the owner taps "Add a passkey" and then "Create passkey" on the iPhone
      Then the app says this device already has a Convoz passkey

    @v1 @browser @phone @needs-owner
    Scenario: A real iPhone signs in with one tap
      Given the iPhone has a Convoz passkey
      When the owner taps "Sign in with a passkey"
      Then Face ID or Touch ID opens at once and the app shows Now

    @v1 @browser @phone @needs-owner
    Scenario: The main button stays in view with the keyboard open on a real iPhone
      Given the owner is on the setup page on an iPhone
      When the owner taps the Handle field and the keyboard opens
      Then the main button is still in view and can be tapped
