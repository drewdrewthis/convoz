# Source: design draft 9 §4.1 (app-kit, Tier-2 sandbox runtime), SEC-5, I-46, §12.3 (app previews not auto-loaded),
# §11 apps_collapsed. Prototype: app cards (charts, tables, diff "Changed files", compare before/after, zoom), "expand app",
# "Open in conversation".
# Kept from the draft-6 spec (D-6), reworded: a rich message cannot reach the network → a Tier-2 app frame cannot.
# Draft 9 folds in docs/messages-apps-spec.md: 10 Tier-1 types (diff → code, compare → gallery), results by one
# tap (single picker) or a host sheet, Tier-2 apps built by `convoz app build`, never auto-loaded, closed when they
# navigate (I-46), the app contract (I-50).
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Apps inside messages
  As the owner
  I want agents to send small apps (charts, tables, diffs, forms) that render inside the conversation
  So that I can see and decide without leaving Convoz, while no app can act for me

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Tier-1 apps are our own components fed with data

    @v1 @browser
    Scenario Outline: A Tier-1 app renders from its data
      When "devtool" posts a Tier-1 "<kit>" app with the fixture data
      Then the owner sees <shown> in conversation 41

      Examples:
        | kit       | shown                                                    |
        | chart     | a bar chart "Tokens per day" with a "Cap 2M a day" line  |
        | table     | a sortable table                                         |
        | code      | "Changed files" with the changed lines of a diff         |
        | gallery   | a before and after slider of two uploaded images         |
        | kv        | key and value pairs                                      |
        | progress  | a progress bar with its steps                            |
        | checklist | a read-only checklist                                    |

    @v1 @browser
    Scenario: Apps start collapsed and expand on request
      Given "devtool" posted a Tier-1 table app
      When the owner opens conversation 41
      Then the app shows as a collapsed card
      And "expand app" shows it in full

  Rule: An app result reaches the conversation only by the owner's tap (SEC-5)

    @v1 @browser @I-46 @AC-25
    Scenario: The owner confirms an app result on a sheet drawn by the host
      Given a Tier-2 booking app from "devtool" offers "Book it" for "Thursday 10:00"
      When the owner taps "Book it" inside the app
      Then a host sheet outside the frame shows the message it will send
      And only the owner's tap on that sheet posts it, marked "via app by @devtool"

    @v1 @browser @cli @I-46 @AC-M6
    Scenario: One tap on a picker answers the agent
      Given "devtool" replied in a thread with a picker "Which runner should I compare first?" offering "Built-in", "vitest" and "jest"
      When the owner taps "vitest"
      Then the thread shows "Picked vitest" marked "via app by @devtool"
      And "devtool" gets one "app_result" item whose result selected "vitest"

    @v1 @browser @I-46
    Scenario: A form result is checked on a host sheet before it is sent
      Given "devtool" posted a form "Schedule the run" with a start time and lanes
      When the owner fills it and taps Submit
      Then a host sheet shows every value with Send and Cancel
      And Cancel sends nothing

    @v1 @browser @I-46 @AC-M7 @AC-25
    Scenario: An app that tries to leave is closed
      Given an open Tier-2 app from "devtool" whose script sends its page to an outside address
      When the app navigates away
      Then the app is closed with "This app tried to leave and was closed"
      And nothing was sent as the owner

    @v1 @browser @I-50 @AC-M5
    Scenario: A chart on an ask helps the owner decide but never answers
      Given "devtool" asked "Which lane first?" with a chart of the lanes
      When the owner clicks a bar of the chart
      Then the ask is still open
      And only the ask's own buttons answer it

  Rule: App previews respect a slow link

    @v1 @browser @lossy @AC-M10
    Scenario: App previews wait for a tap on a slow network
      Given the browser reports Save-Data on
      When the owner opens a conversation with a gallery, a chart with large data and a Tier-2 app
      Then each shows a placeholder with its size and "tap to load"
      And nothing of them loads until the owner taps it

    @v1 @browser @I-46
    Scenario: A Tier-2 app opens only when the owner taps it, on any network
      Given "devtool" posted the Tier-2 app "Deploy report" of 61 KB that can send a reply
      When the owner opens conversation 41 on a fast network
      Then a preview card shows "Deploy report", "App from @devtool", "61 KB" and "This app can send a reply for you"
      And the app loads only after the owner taps "Open app"

  Rule: Agents build and check apps before they post them

    @v1 @cli @I-50 @AC-M2
    Scenario: An agent checks an app before posting it
      When "devtool" runs "convoz app validate pick.json" on a picker with one option
      Then the CLI exits 2 and prints "/props/options: must have at least 2 items"
      And nothing is posted

    @v1 @cli @I-50 @AC-M3
    Scenario: A typo in an app is caught at post time
      When "devtool" runs "convoz post 41 --app chart.json Tokens" with the key "colour" in the props
      Then the CLI exits 2 naming "/props/colour"
      And conversation 41 shows no new message

    @v1 @cli @mcp @I-50
    Scenario: An agent builds a Tier-2 app without npm
      Given the source folder "deploy-report" with "convoz.app.json" and "index.html"
      When "devtool" runs "convoz app build ./deploy-report"
      Then it writes "dist/app.html" and "dist/app.json" and prints the size and SHA-256
      And "convoz post 41 --app deploy-report/dist/app.json --app-fallback 'Deploy report for box-3' Report" posts it

    @v1 @cli @I-50
    Scenario: A Tier-2 build refuses outside links
      Given "deploy-report/index.html" loads "https://cdn.example/x.js"
      When "devtool" runs "convoz app build ./deploy-report"
      Then the CLI exits 2 with "app_bundle_external_ref" and the file and line

    @v1 @browser @AC-M9
    Scenario: An app this version cannot show falls back to its text
      Given messages with an app of a newer version, an app of an unknown type and a frame that needs bridge 2
      When an older build of the web app shows the conversation
      Then each shows its fallback text with "Update Convoz to view this app"
      And the browser console shows no error
