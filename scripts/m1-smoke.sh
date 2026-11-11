#!/usr/bin/env bash
set -euo pipefail

# M1 Live OMP smoke test runner
# Usage: bash scripts/m1-smoke.sh <scenario>
# Scenarios: s1 | s2 | s3 | s4 | s5 | s5-fix | s6 | s7 | s8 | checklist

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_MATT="${EI_MATT_ROOT:-$HOME/ei-skill-sources/matt}"
DEFAULT_POTETO="${EI_POTETO_ROOT:-$HOME/ei-skill-sources/cursor-plugins}"
DEFAULT_OSMANI="${EI_OSMANI_ROOT:-$HOME/ei-skill-sources/osmani}"

check_build() {
  if [ ! -f "dist/adapters/omp/extension.js" ]; then
    echo "dist/adapters/omp/extension.js not found. Running npm run build..."
    npm run build
  fi
}

set_standard_roots() {
  export EI_MATT_ROOT="$DEFAULT_MATT"
  export EI_POTETO_ROOT="$DEFAULT_POTETO"
  export EI_OSMANI_ROOT="$DEFAULT_OSMANI"
}

SCENARIO="${1:-help}"
shift || true

case "$SCENARIO" in
  s1)
    check_build
    set_standard_roots
    echo "=================================================================="
    echo "Scenario S1: Happy path, single skill, classifiedBy keyword"
    echo "Setup: all 3 roots set, lock hashes valid"
    echo "------------------------------------------------------------------"
    echo "Prompt to send in OMP:"
    echo 'Call ei_workflow with task "fix login bug", stage "investigate". Show me the raw tool result header.'
    echo "------------------------------------------------------------------"
    echo "Must observe:"
    echo "1. Tool ei_workflow is listed and called"
    echo "2. Tool result starts with precedence header: <!-- ksd-intelligence: workflow ... -->"
    echo "3. Contains matt:diagnosing-bugs, classifiedBy: keyword, and sha256 ... (matches lock)"
    echo "=================================================================="
    exec omp --extension ./dist/adapters/omp/extension.js "$@"
    ;;

  s2)
    check_build
    set_standard_roots
    echo "=================================================================="
    echo "Scenario S2: Non-English task, classifiedBy caller"
    echo "Setup: all 3 roots set, lock hashes valid"
    echo "------------------------------------------------------------------"
    echo "Prompt to send in OMP:"
    echo 'Call ei_workflow with task "แก้บั๊กการชำระเงิน", stage "investigate", type "bug".'
    echo "------------------------------------------------------------------"
    echo "Must observe:"
    echo "1. Tool ei_workflow called with type: bug"
    echo "2. Tool result contains classifiedBy: caller"
    echo "3. Delivers matt:diagnosing-bugs"
    echo "=================================================================="
    exec omp --extension ./dist/adapters/omp/extension.js "$@"
    ;;

  s3)
    check_build
    set_standard_roots
    echo "=================================================================="
    echo "Scenario S3: Multi-skill route (two skills for high risk review)"
    echo "Setup: all 3 roots set, lock hashes valid"
    echo "------------------------------------------------------------------"
    echo "Prompt to send in OMP:"
    echo 'Call ei_workflow with task "add OAuth login", stage "review", risk "high".'
    echo "------------------------------------------------------------------"
    echo "Must observe:"
    echo "1. Two skills delivered in result:"
    echo "   - matt:code-review"
    echo "   - poteto:blast-radius"
    echo "=================================================================="
    exec omp --extension ./dist/adapters/omp/extension.js "$@"
    ;;

  s4)
    check_build
    unset EI_MATT_ROOT || true
    export EI_POTETO_ROOT="$DEFAULT_POTETO"
    export EI_OSMANI_ROOT="$DEFAULT_OSMANI"
    echo "=================================================================="
    echo "Scenario S4: Provider root missing (fail open advice)"
    echo "Setup: EI_MATT_ROOT is UNSET; poteto and osmani set"
    echo "------------------------------------------------------------------"
    echo "Prompt to send in OMP:"
    echo 'Call ei_workflow with task "fix login bug", stage "investigate". Show me the raw tool result header.'
    echo "------------------------------------------------------------------"
    echo "Must observe:"
    echo "1. Tool returns an error result (isError: true), not a crashed session"
    echo "2. Text names PROVIDER_ROOT_MISSING / SKILLS_UNAVAILABLE for matt"
    echo "3. OMP session continues normally"
    echo "=================================================================="
    exec omp --extension ./dist/adapters/omp/extension.js "$@"
    ;;

  s5)
    check_build
    export EI_POTETO_ROOT="$DEFAULT_POTETO"
    export EI_OSMANI_ROOT="$DEFAULT_OSMANI"

    if [ ! -d "$DEFAULT_MATT" ]; then
      echo "Error: $DEFAULT_MATT not found. Cannot create temporary copy for S5."
      exit 1
    fi

    TMP_DIR="$(mktemp -d /tmp/ei-matt-s5-XXXXXX)"
    echo "$TMP_DIR" > /tmp/ei-s5-active-dir
    trap 'rm -rf "$TMP_DIR" /tmp/ei-s5-active-dir' EXIT

    echo "Creating temporary copy of matt checkout at $TMP_DIR/matt..."
    cp -r "$DEFAULT_MATT" "$TMP_DIR/matt"

    TARGET_FILE="$TMP_DIR/matt/skills/engineering/diagnosing-bugs/SKILL.md"
    printf '\n' >> "$TARGET_FILE"
    echo "Appended 1 newline byte to $TARGET_FILE (real checkout untouched)."

    export EI_MATT_ROOT="$TMP_DIR/matt"

    echo "=================================================================="
    echo "Scenario S5: Tampered skill (fail closed on hash mismatch)"
    echo "Setup: EI_MATT_ROOT points to temp copy with 1 byte appended to diagnosing-bugs"
    echo "------------------------------------------------------------------"
    echo "Prompt to send in OMP:"
    echo 'Call ei_workflow with task "fix login bug", stage "investigate". Show me the raw tool result header.'
    echo "------------------------------------------------------------------"
    echo "Must observe in Turn 1 (S5):"
    echo "1. Error result naming HASH_MISMATCH"
    echo "2. No skill text delivered"
    echo "3. Session continues"
    echo "------------------------------------------------------------------"
    echo "Instructions for S8 (run directly in THIS SAME session):"
    echo "1. Keep this session open!"
    echo "2. In a second terminal, run:"
    echo "     bash scripts/m1-smoke.sh s5-fix"
    echo "3. In this OMP session, prompt again:"
    echo '     Call ei_workflow with task "fix login bug", stage "investigate".'
    echo "4. Record S8 observation: Does agent call tool again? (yes/no and agent response)"
    echo "=================================================================="
    omp --extension ./dist/adapters/omp/extension.js "$@"
    ;;

  s5-fix)
    if [ ! -f /tmp/ei-s5-active-dir ]; then
      echo "Error: /tmp/ei-s5-active-dir not found. Is S5 running?"
      exit 1
    fi
    ACTIVE_TMP="$(cat /tmp/ei-s5-active-dir)"
    if [ ! -d "$ACTIVE_TMP/matt" ]; then
      echo "Error: $ACTIVE_TMP/matt does not exist."
      exit 1
    fi
    TARGET_FILE="$ACTIVE_TMP/matt/skills/engineering/diagnosing-bugs/SKILL.md"
    SRC_FILE="$DEFAULT_MATT/skills/engineering/diagnosing-bugs/SKILL.md"
    cp "$SRC_FILE" "$TARGET_FILE"
    echo "Restored $TARGET_FILE from $SRC_FILE."
    echo "Current sha256: $(sha256sum "$TARGET_FILE" | cut -d' ' -f1)"
    echo "Ready for S8 prompt in the running OMP session."
    ;;

  s6)
    check_build
    set_standard_roots
    echo "=================================================================="
    echo "Scenario S6: Schema validation error (invalid stage 'deploy')"
    echo "Setup: all 3 roots set, lock hashes valid"
    echo "------------------------------------------------------------------"
    echo "Prompt to send in OMP:"
    echo 'Call ei_workflow with task "fix login bug", stage "deploy".'
    echo "------------------------------------------------------------------"
    echo "Must observe:"
    echo "1. Schema validation error or INVALID_INPUT (deploy is not in allowed stages)"
    echo "2. Session continues without crashing"
    echo "=================================================================="
    exec omp --extension ./dist/adapters/omp/extension.js "$@"
    ;;

  s7)
    echo "=================================================================="
    echo "Scenario S7: Plugin coexistence inspection — STATUS: PARTIAL"
    echo "------------------------------------------------------------------"
    echo "Checked read-only (2026-11-11, omp/18.18.8):"
    echo "  omp plugin list  -> engineering-proxy, ponytail, caveman installed"
    echo "  omp skill list --json (135 skills):"
    echo "    - ask-matt: NOT present"
    echo "    - using-agent-skills: NOT present"
    echo "    - poteto-mode: present (native:user ~/.omp/agent/skills) but"
    echo "      disable-model-invocation: true (hide) -> manual-only, never auto-loaded"
    echo "------------------------------------------------------------------"
    echo "Still needs an interactive TUI session (owner):"
    echo "1. KSD indicator still visible (🛡 KSD: ...)"
    echo "=================================================================="
    ;;

  s8)
    echo "=================================================================="
    echo "Scenario S8: Tool re-calling after error in same session"
    echo "------------------------------------------------------------------"
    echo "S8 is run directly inside the session from S5 (or S4):"
    echo "1. Run: bash scripts/m1-smoke.sh s5"
    echo "2. Turn 1: trigger the HASH_MISMATCH error"
    echo "3. In another terminal: bash scripts/m1-smoke.sh s5-fix"
    echo "4. Turn 2: prompt the agent:"
    echo '   Call ei_workflow with task "fix login bug", stage "investigate".'
    echo "5. Record whether the agent still calls the tool after receiving error in turn 1."
    echo "=================================================================="
    ;;

  checklist)
    cat <<'EOF'
| # | Scenario | Status | Observed Output / Evidence |
|---|---|---|---|
| S1 | Happy path (task "fix login bug", stage "investigate") | VERIFIED 2026-11-11 | Result starts "# KSD Workflow" precedence header; Type: bug (classifiedBy: keyword); matt:diagnosing-bugs; sha256 849198df… (matches lock) |
| S2 | Caller type (task "แก้บั๊กการชำระเงิน", stage "investigate", type "bug") | VERIFIED 2026-11-11 | classifiedBy: caller; matt:diagnosing-bugs; hash matches lock |
| S3 | Multi-skill (task "add OAuth login", stage "review", risk "high") | VERIFIED 2026-11-11 | Both matt:code-review and poteto:blast-radius delivered |
| S4 | Missing root (unset EI_MATT_ROOT) | VERIFIED 2026-11-11 | Error result "SKILLS_UNAVAILABLE: … PROVIDER_ROOT_MISSING"; session continued |
| S5 | Tampered skill (temp copy + 1 byte) | VERIFIED 2026-11-11 | Error result "SKILLS_UNAVAILABLE: … HASH_MISMATCH"; no skill text; session continued; real checkout untouched |
| S6 | Schema invalid input (stage "deploy") | VERIFIED 2026-11-11 | isError result: stage must be "plan", "investigate", "implement", "verify", "review" or "ship" (was "deploy"); agent recovered |
| S7 | Plugin coexistence | PARTIAL | Plugins: engineering-proxy + ponytail present. Skills: poteto-mode present but hide:true (manual-only); ask-matt and using-agent-skills not found in any of 135 discovered skills. KSD indicator needs interactive TUI (owner) |
| S8 | Tool retry after error (same session S5 -> restore -> re-call) | VERIFIED 2026-11-11 | YES: after S5's HASH_MISMATCH error the same session (resumed) called ei_workflow again and got the full skill result |
EOF
    ;;

  *)
    echo "M1 OMP Smoke Test Runner"
    echo "Usage: bash scripts/m1-smoke.sh <scenario>"
    echo ""
    echo "Available scenarios:"
    echo "  s1        - Happy path single skill (matt:diagnosing-bugs)"
    echo "  s2        - Non-English task with caller-asserted type: bug"
    echo "  s3        - High risk review with two skills"
    echo "  s4        - Unset EI_MATT_ROOT (PROVIDER_ROOT_MISSING error)"
    echo "  s5        - Modified skill file in temp dir (HASH_MISMATCH error)"
    echo "  s5-fix    - Helper for S8: restores modified skill during S5 session"
    echo "  s6        - Schema validation rejection (invalid stage: deploy)"
    echo "  s7        - Check installed plugins and KSD coexistence"
    echo "  s8        - Instructions for testing agent retry after error in same session"
    echo "  checklist - Display markdown verification checklist"
    exit 1
    ;;
esac
