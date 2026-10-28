# Source: design draft 9 §12.3 (resumable uploads, "voice notes start uploading while recording"), §6.2 (blobs),
# I-27, I-31, I-44, I-49, AC-20(c), open question 11 (transcription engine).
# Prototype: "Record a voice message", "Recording a voice message", "Cancel recording", "Send voice message",
# waveform playback, transcript.
# Every scenario runs end to end in a browser against a real `convoz serve` on a fresh `mktemp -d` data dir.

Feature: Voice notes
  As the owner
  I want to talk instead of type, and have agents get the words
  So that I can give direction on the move

  Background:
    Given a fresh Convoz server with owner "drew" signed in with a virtual passkey
    And the browser has a fake microphone that plays a fixture recording
    And machine "box-2" is logged in with allow-list "devtool"
    And "devtool" is an active participant of conversation 41 "Ship search filters"

  Rule: Recording, sending and cancelling

    @v1 @browser @I-31
    Scenario: A voice note uploads while it records
      When the owner records for 20 seconds
      Then the server's upload offset grows before the recording stops
      And sending posts one voice message with a 0:20 duration

    @v1 @browser
    Scenario: Cancelling a recording sends nothing
      When the owner records for 5 seconds and cancels
      Then conversation 41 shows no new message
      And the partial upload is gone after 24 hours

    # Owner: a voice note stopped by itself at 5 minutes, without a word. The cap is 30 minutes and the last minute counts down.
    # No end-to-end binding by owner order (no e2e for this change); the cap is a constant in the recorder and the server.
    @v1 @browser @unimplemented
    Scenario: A long voice note counts down its last minute and is sent at 30 minutes
      When the owner records for 29 minutes
      Then the recording shows how long is left, counting down from "1:00 left"
      And at 30 minutes the recording stops by itself and the note is sent, not dropped
      And the voice message has a 30:00 duration

    @v1 @browser
    Scenario: A voice note plays back
      Given the owner sent a voice note
      When the owner taps play
      Then the audio plays and the waveform shows progress

    @v1 @browser @lossy @I-31 @AC-20
    Scenario: A voice note upload resumes after a drop
      Given the network drops during the upload of a 5 MB voice note at about 50%
      When the network returns
      Then the upload continues from the committed offset, which is above 0
      And the voice note plays on a second browser

  Rule: Agents get the words

    @v1 @browser @cli
    Scenario: A transcript appears when transcription is on
      Given the workspace transcription engine is set
      When the owner sends a voice note that says "ship the filters on Thursday"
      Then the voice message shows the transcript
      And "devtool" reads the transcript with "convoz read 41"

    @v1 @browser
    Scenario: With no transcription engine the note has no transcript
      Given the workspace transcription engine is "none" (the default is "auto": the server's engine)
      When the owner sends a voice note
      Then the voice message shows no transcript and no error

    @v1 @browser @cli
    Scenario: A note sent before transcription was on gets its words later
      Given transcription was off when the owner sent a voice note
      When the owner sets the transcription engine
      Then the voice message shows the transcript, without the note being sent again
      And "devtool" reads the transcript with "convoz read 41"

    @v1 @browser
    Scenario: The owner can transcribe a voice note again
      Given the owner sent a voice note and its transcript is done
      When the owner chooses "Transcribe again" in the message menu of the voice note
      Then the voice message shows "Transcribing…" until the new transcript is done
      And the voice message shows the new transcript

    @v1 @browser @cli @AC-M11
    Scenario: Search finds words that are only in the transcript
      Given the owner sent a voice note that says "ZQX-thursday-filters"
      When the transcript is done
      Then the owner's search for "ZQX-thursday-filters" finds the voice message
      And "convoz search ZQX-thursday-filters" as "devtool" finds it too

  Rule: Voice notes work in a thread

    # Owner, 2026-10-19: "Also, the vocal is not an option in threads but should be"
    @v1 @browser
    Scenario: The owner can record a voice note in a thread
      Given "devtool" posted message 900 in conversation 41 and the owner opened its thread
      And the workspace transcription engine is set
      When the owner records a voice note in the thread's reply box and sends it
      Then the thread shows one voice reply with the transcript
      And the main list of conversation 41 shows no new message

  Rule: Audio is stored and served safely

    @v1 @api @I-49
    Scenario: Purging a voice note removes its transcript
      Given a voice note whose transcript says "ZQX-voice-secret"
      When the owner purges the message with a passkey
      Then search for "ZQX-voice-secret" returns nothing
      And the voice note no longer plays for anyone
