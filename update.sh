#!/bin/bash
# ai-visualizer — update to the newest version, showing what changed first.
# Copyright (C) 2026 Jared Rhodenizer
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Your ai-visualizer.json is yours: nothing in this script can touch or overwrite it.
# Safe to run any time; when nothing is new it just says so.

main() {
  cd "$(dirname "$0")" || exit 1
  CFG="ai-visualizer.json"

  if [ ! -d .git ]; then
    # this folder arrived as a zip: wire it to updates, once, keeping the config
    #
    # Wired to the AI-Meridian fork, not upstream jaredrhod/ai-visualizer:
    # this IS the Meridian fork, carrying real fixes upstream never gets.
    # A seat whose .git ever went missing and ran this script would
    # otherwise silently re-wire itself to vanilla upstream on the next
    # pull, losing every Meridian fix and all branding with no warning.
    [ -f "$CFG" ] && cp "$CFG" "$CFG.mine"
    git init -q -b main
    git remote add origin https://github.com/AI-Meridian/ai-visualizer
    git fetch -q origin
    git reset -q --hard origin/main
    git branch -q --set-upstream-to=origin/main main
    [ -f "$CFG.mine" ] && mv "$CFG.mine" "$CFG"
    echo "wired this folder to updates."
  fi

  git fetch -q origin
  git log --oneline "..@{u}" 2>/dev/null | sed "s/^/  new: /"

  # Every incoming commit must be signed by the trusted maintainer key
  # before it's accepted, checked against THIS folder's own on-disk
  # .allowed_signers (the last known-good copy, not whatever an
  # incoming commit claims it should be) -- a compromised GitHub
  # account/token can push over HTTPS auth alone, but can't forge a
  # signature from a key that never touches GitHub. That's what
  # actually stops a hijacked push from reaching a seat, not just logs
  # it after the fact.
  if [ -f .allowed_signers ]; then
    BAD=0
    for commit in $(git rev-list "HEAD..@{u}" 2>/dev/null); do
      if ! git -c gpg.format=ssh \
               -c gpg.ssh.allowedSignersFile="$(pwd)/.allowed_signers" \
               verify-commit "$commit" >/dev/null 2>&1; then
        BAD=1
      fi
    done
    if [ "$BAD" = 1 ]; then
      echo "  REFUSING TO UPDATE: the newest commit(s) on the remote are"
      echo "  not signed by the trusted key. This can mean a compromised"
      echo "  account pushed something bad -- not pulling it in. Tell Seb."
      echo "update refused."
      exit 1
    fi
  fi

  # one-time migration: the config moved out of git tracking. If git here
  # still tracks the old copy, lift yours aside, let the pull retire the
  # tracked one, then put yours back exactly as it was.
  MIGRATE=0
  if git ls-files --error-unmatch "$CFG" >/dev/null 2>&1 && [ -f "$CFG" ]; then
    cp "$CFG" "$CFG.mine" && git checkout -q -- "$CFG" && MIGRATE=1
  fi

  git pull --ff-only || echo "  (couldn't fast-forward; your local edits win.)"

  if [ "$MIGRATE" = 1 ] && [ -f "$CFG.mine" ]; then
    mv "$CFG.mine" "$CFG"
  fi
  echo "update complete."
}
main "$@"
