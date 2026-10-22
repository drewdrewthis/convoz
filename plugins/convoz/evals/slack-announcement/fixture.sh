#!/usr/bin/env bash
# Scaffold (same in every case; a case runs only its own script): a small Go repo where an agent works for a Convoz owner.
set -e
git init -q .
printf 'package chat\n\n// Conversation is one chat thread.\ntype Conversation struct {\n\tID    int\n\tTitle string\n}\n' > chat.go
printf '# demo\n\nA small chat package.\n' > README.md
git add -A && git -c user.email=e@x -c user.name=eval commit -qm init
