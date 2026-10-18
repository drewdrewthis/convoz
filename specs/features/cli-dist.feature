# Source: the Convoz server hands out its own CLI (design "CLI distribution"). The invite prompt's install line is
# `command -v convoz >/dev/null || curl -fsSL <server>/install | sh`.
# Owner said: "Speed matters. Feedback matters." A real agent could not get a CLI that matched the server it was invited to.
# Every scenario runs end to end against a real `convoz serve` on a fresh `mktemp -d` data dir, with a `mktemp -d` home folder.

Feature: The server hands out its own CLI
  As the owner
  I want an agent to install the CLI from my server
  So that the agent runs the same version as the server, with nothing to build and no root

  Rule: An agent gets the CLI from the server it connects to

    @v1 @cli
    Scenario: An agent installs the CLI from the server
      Given a machine with no convoz installed and an empty home folder
      And a Convoz server
      When the agent runs the install script of the server
      Then convoz is installed in the ".local/bin" folder of the home folder
      And "convoz version" prints the version of the server and the commit
      And the installer says how to add the folder to the PATH
      And the install script never asks for root
