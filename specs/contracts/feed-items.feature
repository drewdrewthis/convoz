# Contracts for `features/feed-items.feature`: the item routes, the transitions, the owner's actions and the text rules.
# Owner (Drew, conv 179, msg 11684): "I don't need caps, don't be defensive prematurely." There is no cap on open blocking items.

Feature: Feed items (contracts)
  The agent writes only its own items; the owner alone reads the feed and acts on it.

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And machine "box-2" is logged in with allow-list "devtool" and "docs"
    And "devtool" and "docs" are participants of conversation 41 "Ship search filters"

  Rule: One now per agent and conversation; the next pending item is promoted when it leaves

    @v1 @api
    Scenario: Two blocking requests by one agent: the second is pending and is promoted when the first is accepted
      When "devtool" sends POST /api/conversations/41/items/a/block with a title and a recommendation, and then the same for key "b"
      Then the owner's GET /api/feed lists "a" as blocking and "b" as pending, in that order
      When the owner sends POST /api/feed/{a}/accept with the version of "a"
      Then the server answers 200 with "a" done, and GET /api/feed lists "b" as blocking
      And more than ten blocking items stay allowed: 12 blocking requests all answer 200

    @v1 @api
    Scenario: Every move that the state does not allow answers 409 and changes nothing
      Given "devtool" started "a"
      When "devtool" sends fyi for "a"
      Then the server answers 409 and "a" stays started at the same version
      And "docs" sending done for "a" answers 404, and the owner sending the agent route gets 401 or 403

  Rule: Accept names the version it saw; an item with no recommendation takes info only

    @v1 @api
    Scenario: A stale Accept answers 409, and no recommendation means no Accept
      Given "devtool" blocked "a" with a recommendation, and blocked it again with a new title
      When the owner sends POST /api/feed/{a}/accept with the first version
      Then the server answers 409 and "a" stays blocking
      Given "devtool" blocked "c" with no recommendation
      When the owner sends POST /api/feed/{c}/accept with its version
      Then the server answers 409 with the code "no_recommendation"
      When the owner sends POST /api/feed/{c}/answer with text and resolves true
      Then the server answers 200 with "c" done

  Rule: Got it hides an fyi and keeps its state; the owner may snooze

    @v1 @api
    Scenario: Got it sets acked_at and leaves the state; snooze sets the wake time
      Given "devtool" blocked "a" and then said fyi for it
      When the owner sends POST /api/feed/{a}/ack
      Then the server answers 200 with "a" still fyi and acked_at set, and GET /api/feed no longer lists it
      Given "devtool" started "b"
      When the owner sends PUT /api/feed/{b}/snooze with a time in the future
      Then the server answers 200 with snoozed_until set, and a time in the past answers 400
      And an agent lease gets 401 or 403 on every owner route

  Rule: Text is plain and within its length

    @v1 @api
    Scenario: Markdown, links and over-long text are refused with 400
      When "devtool" sends start with the title "See https://example.com"
      Then the server answers 400
      And a title of 201 characters, a context of 2001 and a recommendation of 501 answer 400
      And a title of 200, a context of 2000 and a recommendation of 500 answer 200

  Rule: An item opens a thread on one message in its conversation

    @v1 @api
    Scenario: The first move posts one message and keeps its id as the thread root; later moves post nothing
      When "devtool" sends block for key "a" with a title and a recommendation
      Then the answer has a thread_root_id, and that message in conversation 41 is by "devtool" and says the title
      When "devtool" sends block for key "a" again with a new title, and then done
      Then the thread_root_id is the same, and the conversation holds no second message for the item
