#!/bin/bash
# SuccessFactors (career4.successfactors.com) picklist selector.
# usage: sf-pick.sh <input-element-id> <exact option text>
# SF picklists are <input role=combobox> backed by a popup list; typing alone
# does NOT commit — you must click the option row.
# Needs AGENT_BROWSER_SESSION=applier<i> (own browser instance); every call below uses it.
[ -n "${AGENT_BROWSER_SESSION:-}" ] || { echo "sf-pick.sh: AGENT_BROWSER_SESSION is not set — refusing to run." >&2; exit 2; }
AB="${AGENT_BROWSER:-agent-browser}"
id="$1"; want="$2"
"$AB" click "[id=\"$id\"]" >/dev/null 2>&1; sleep 1
"$AB" fill "[id=\"$id\"]" "$want" >/dev/null 2>&1; sleep 3
ref=$("$AB" snapshot -i 2>&1 | grep -iE "option \"$want\"( \[|$)" | head -1 | grep -o 'ref=e[0-9]*' | cut -d= -f2)
if [ -z "$ref" ]; then
  ref=$("$AB" snapshot -i 2>&1 | grep -iE "option \".*$want" | head -1 | grep -o 'ref=e[0-9]*' | cut -d= -f2)
fi
if [ -z "$ref" ]; then
  echo "MISS $id '$want' — options:"
  "$AB" eval "Array.from(document.querySelectorAll('[role=option]')).map(e=>e.innerText.trim()).slice(0,40).join(' ~ ')" 2>&1 | tail -1
  "$AB" press Escape >/dev/null 2>&1
  exit 1
fi
"$AB" click "@$ref" >/dev/null 2>&1; sleep 1
"$AB" press Escape >/dev/null 2>&1; sleep 1
echo "$id -> $("$AB" eval "document.querySelector('[id=\"$id\"]').value" 2>&1|tail -1)"
