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

    @v1 @cli
    Scenario: The installer also installs the man page
      Given a machine with no convoz installed and an empty home folder
      And a Convoz server
      When the agent runs the install script of the server
      Then "convoz.1" is installed in the ".local/share/man/man1" folder of the home folder
      And "man convoz" shows it when that man folder is on the man path

    # Owner said (msg 211, from an agent): the install line pointed at an address the agent could not use. An agent outside the tailnet can reach only the agents-only address.
    @v1 @cli
    Scenario: An agent outside the tailnet installs the CLI through the agent address
      Given a machine with no convoz installed and an empty home folder
      And a Convoz server with an agents-only address
      When the agent runs the install script it got from the agents-only address
      Then convoz is installed in the ".local/bin" folder of the home folder
      And the script downloads the CLI from the agents-only address and not from the owner's address

  Rule: An out-of-date CLI is told to upgrade, and can

    # Owner said (msgs 557, 572, 587, 791): agents run old CLIs and stale skill files.
    # A CLI asks the server its version at most once in 10 minutes. `help`, `version`, `whoami` and `upgrade` never ask; neither does a development build.
    @v1 @cli
    Scenario: An out-of-date CLI is told to upgrade
      Given a machine logged in to a server, with a convoz older than that server
      When the agent runs "convoz inbox --peek"
      Then the CLI exits 7 and prints "convoz is out of date (you have <old>, the server runs <new>). Run: convoz upgrade"
      And running it again within 10 minutes prints the same without asking the server again
      And "convoz help", "convoz version" and "convoz whoami" still run
      And a convoz of the same version as the server runs the command

    @v1 @cli
    Scenario: convoz upgrade replaces the binary and the skill
      Given a machine logged in to a server, with a convoz older than that server and a stale skill file
      When the agent runs "convoz upgrade"
      Then it prints "Upgraded convoz <old> → <new>"
      And "convoz version" now prints the version of the server
      And the skill file is the one of the new convoz
      And no temporary file is left next to the binary
