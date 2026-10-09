#!/bin/bash
# gh-fill.sh — fill the standard Greenhouse application block from the profile.
#   gh-fill.sh
# Values come from the profile (profile.json; $PIPELINE_PROFILE overrides). Edit the profile,
# never this script. Needs AGENT_BROWSER_SESSION (the applier's own browser session).
# Prefer greenhouse.js for anything beyond these base fields: it verifies every value.
set -u
[ -n "${AGENT_BROWSER_SESSION:-}" ] || { echo "gh-fill.sh: AGENT_BROWSER_SESSION is not set — refusing to run." >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
P="$HERE/gh-pick.sh"
AB="${AGENT_BROWSER:-agent-browser}"
PROFILE="${PIPELINE_PROFILE:-${PIPELINE_HOME:-$HOME/.job-pipeline}/profile.json}"
[ -f "$PROFILE" ] || { echo "gh-fill.sh: no profile at $PROFILE" >&2; exit 2; }

# get <dotted.path> — read one value from the profile ("" when absent)
get(){ node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  let v = d; for (const k of process.argv[2].split(".")) v = v == null ? v : v[k];
  process.stdout.write(v == null ? "" : String(v));' "$PROFILE" "$1"; }

FIRST="$(get contact.firstName)"     # LEGAL first name; a separate "preferred name" field gets contact.preferredName
LAST="$(get contact.lastName)"
EMAIL="$(get contact.email)"
PHONE="$(get contact.phone)"
LINKEDIN="$(get contact.linkedin)"
GITHUB="$(get contact.github)"
COUNTRY="$(get contact.country)"
CITY_FULL="$(get contact.currentLocation)"
CITY_SHORT="$(get contact.city)"
SCHOOL="$(get education.0.school)"
DEGREE="$(get education.0.degreeLevel)"
START_YEAR="$(get education.0.start | cut -c1-4)"
END_YEAR="$(get education.0.end | cut -c1-4)"

ref(){ "$AB" snapshot -i 2>/dev/null | grep -F "$1" | head -1 | sed -E 's/.*\[ref=(e[0-9]+)\].*/\1/'; }
fill(){ [ -n "$2" ] || return 0; local r; r=$(ref "$1"); [ -n "$r" ] && "$AB" fill "@$r" "$2" >/dev/null; }
fill 'textbox "First Name"' "$FIRST"
fill 'textbox "Last Name"'  "$LAST"
fill 'textbox "Email"'      "$EMAIL"
fill 'textbox "Phone"'      "$PHONE"
fill 'textbox "LinkedIn'    "$LINKEDIN"
fill 'textbox "GitHub'      "$GITHUB"
[ -n "$COUNTRY" ]   && "$P" "Country" "$COUNTRY" >/dev/null
[ -n "$CITY_FULL" ] && "$P" "Location (City)" "$CITY_FULL" "$CITY_SHORT" >/dev/null
[ -n "$SCHOOL" ]    && "$P" "School" "$SCHOOL" "$SCHOOL" >/dev/null
[ -n "$DEGREE" ]    && "$P" "Degree" "$DEGREE" "${DEGREE%%\'*}" >/dev/null
fill 'spinbutton "Start date year"' "$START_YEAR"
fill 'spinbutton "End date year"'   "$END_YEAR"
echo "base fields done — run greenhouse.js verify before submitting"
