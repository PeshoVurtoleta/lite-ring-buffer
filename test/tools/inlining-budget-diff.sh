#!/usr/bin/env bash
# inlining-budget-diff.sh -- TurboFan + Maglev inlining-DECISION diff plus a BUDGET report,
# BEFORE vs AFTER, for one or more NAMED functions, on one node binary.
#
#   ME=m0 inlining-budget-diff.sh [opts] DRIVER_BEFORE DRIVER_AFTER      # driver mode (any project)
#   inlining-budget-diff.sh [opts] --before-ref REF --after-ref REF       # lite-signal: builds from git refs
#   inlining-budget-diff.sh [opts] --before FILE --after FILE             # lite-signal: two Signal.js files
#
#   e.g. bench/inlining-budget-diff.sh --fn read.set,sharedSignalPeek --before-ref main --after-ref origin/1.6.0-dev
#
# Options
#   --fn LIST        named functions, comma/space separated (default: $ME, else m0)
#   --runs N         runs per side per tier, 2..50 (default 3). Run 1 vs runs 2..N is the null control.
#   --tiers LIST     turbo,maglev (default both)
#   --only-fn        narrow the verdict to lines that name <fn> or were made while compiling <fn> itself
#                    (blind to <fn>'s callees once <fn> is inlined into a caller; the default is not)
#   --concurrent     keep V8's concurrent recompilation (default: off, so compiles are synchronous)
#   --driver FILE    ref/file modes: driver importing './Signal.js' (default: the inline-diff driver). The import check
#                    strips // and /* */ comments and needs import, from or require before the quoted './Signal.js' on
#                    one line: a plain string holding that text passes it (Known limit); a mention in a comment is refused.
#   --repo DIR       ref mode: the git repo (default: the repo around the current directory)
#   --node BIN       node binary (default: $NODE, else node)
#   --v8-flags STR   extra V8 flags for BOTH sides, e.g. "--max-maglev-inlined-bytecode-size=120"
#                    Accepted: V8 flags this node lists in --v8-options -- bool as --flag or --no-flag (never
#                    --noflag), numeric as --flag=N -- except log / trace / print / prof / perf / dump / snapshot
#                    / file flags. Refused, exit 2 at the latest after one --v8-options read and before any
#                    measured run: every node option (--run, --test, --watch, --check, --inspect, --cpu-prof,
#                    --snapshot-blob, ...), every string-valued V8 flag, the tool's own flags above, and any
#                    *stress-concurrent-inlining* flag, every spelling (it implies --concurrent-recompilation in V8,
#                    which overrides the script's --no-concurrent-recompilation), before any spawn. Also refused,
#                    exit 2 after that read and before the --out dir is created: --turbolev and --turbolev-future,
#                    every spelling ("--turbolev changes which tier --trace-maglev-inlining describes; unsupported");
#                    --no-turbolev, --no-turbolev-future and the other turbolev tuning flags (--max-turbolev-inline-depth=N) pass.
#   --out DIR        artifact dir (default: $OUTDIR, else $TMPDIR/inl-diff-<timestamp>); always kept
#                    Must be new or empty: a symlinked, non-writable or non-empty raw/ dec/ bud/ ms/ stage/ is refused, exit 2.
#                    A refusal in ref / file mode can leave staged files in stage/, and a rerun needs a fresh --out.
#   --no-bytecode    skip the --print-bytecode length probe for each <fn>
#   --self-test      check the normalizer / multiset / guard on canned trace text, then exit
#
# Verdict (per tier; GATED):  exit 0 SAME, 1 DIFF, 2 NO-VERDICT (NO-VERDICT > DIFF > SAME).
#   * Decision lines are normalized (addresses, node ids, frequencies, scores, callee sizes; limits
#     are kept) and tagged with the compile unit they were made in ([step@TF], [read@ML#2]; taken
#     from --trace-opt, so a decision that moves to another caller is a DIFF). TurboFan keeps
#     Inlining / Cannot consider / Not inlining / Not considering, Maglev keeps == Inlining /
#     greedy inlining / cannot inline, and on newer V8 SKIP / INLINE / budget exhausted. Same line
#     set as lite-signal 1.6.0-dev bench/inline-diff.mjs, plus the unit tag and the newer format.
#   * Compared as a MULTISET (sort | uniq -c, never sort -u): inlined at 2 sites -> 1 site is a DIFF.
#   * Guard: a run with no decision line naming <fn> and no completed compile of <fn> by that tier (a unit that
#     reached `[completed compiling`; an aborted compile is no evidence) is NO-VERDICT, never "identical".
#     --concurrent attributes no compile, so there only a decision line counts.
#     The default scope is the whole trace, so the diff is printed once per tier for all <fn>;
#     --only-fn gives one diff per <fn>.
#   * Null control: all before runs must match each other, and all after runs, else NO-VERDICT.
#   * A driver that exits non-zero, or a tier that prints no trace at all, is NO-VERDICT.
#   * Driver output glued to a V8 compile line (no newline before it) is NO-VERDICT, exit 2; not checked under --concurrent.
#   * Without --concurrent, a run whose trace has a line starting `[compiling method ` with ConcurrencyMode::kConcurrent
#     is NO-VERDICT, exit 2 ("background compile (--no-concurrent-recompilation overridden by a V8 flag implication)": a
#     compile off the main thread makes the trace a race). Only compile lines count: `[marking ...` says kConcurrent on every run.
#
# Budget report (REPORTED from run 1, NEVER part of the verdict):
#   * bytecode length of each <fn> (from --print-bytecode; a torn stream prints ?) and every limit it crosses;
#     node's stdout and stderr go to one temp file per side, ${TMPDIR:-/tmp}/inlining-budget-diff.XXXXXX, never to a pipe
#     (V8's writes to a full pipe are dropped while the run ends cleanly). The file is read after node ends, then 64 KiB
#     of spaces are appended to it and it is removed. A failed mktemp or append prints "(<step> exited N)" for that side
#     (not measured; the verdict is unmoved); a failed node, tr or awk is a named die, exit 2 NO-VERDICT
#     ("bytecode probe of <fn>: <step> exited <rc>").
#   * per compile unit that involves <fn>: inlines, bytes charged and the cumulative budget.
#     TurboFan charges only non-small inlines and skips a candidate SILENTLY when
#     used + int(1.2 * (size + existing inlined size)) > 920 (V8 truncates the reserve; probed on
#     node v26.8.2); those are listed as "dropped".
#     Maglev budget counters ("generated N nodes. small_budget / regular_budget += B ~~> T") are reported when
#     present; V8 14.6 (node 26) prints them only for non-eager inlining.
#   * "small" CROSSES lines: TurboFan is small at <= max-inlined-bytecode-size-small (30), or <= the heapnum
#     limit (75) where a HeapNumber may cross the call; both are reported. Maglev's "greedy inlining ... small
#     function" follows max-maglev-eager-inlined-bytecode-size (< 30): measured on node v26.8.2, the cutoff was 29,
#     24 and 35 with that flag at 30, 25 and 36, and did not move with ...-size-small. The single-inline lines
#     (<= 460, < 100) match V8's own messages.
#   * Dropped candidates count call sites by node id ("- candidate: JSCall node #N"): inlining one callee can
#     expose new sites of another, so a site seen only in a later round still counts.
#   * --concurrent merges all compiles into one unit "*" (and interleaves lines): its used / dropped / model are "-".
#   * Limits this binary does not report fall back to node 26 defaults, and a NOTE lists them.
# Node 22: Maglev does not run by default, so the maglev tier is NO-VERDICT; use --tiers turbo.
# Artifacts: raw/ dec/ bud/ ms/ under the out dir, plus all.<tier>.diff.txt (<fn>.<tier>.diff.txt with
# --only-fn), budget.<tier>.tsv (every unit, both sides) and report.txt (this output).
#   The last budget.<tier>.tsv column is the TurboFan budget-model check ("-" under --concurrent): ok = the summed charged
#   inline sizes equal V8's last printed "Budget used"; ok(+N after last print) = inlines happened
#   after the last print; MISMATCH = V8 printed MORE than the model charged (the model is wrong for
#   this V8). REPORTED: a MISMATCH is printed as a NOTE and never changes the verdict.
#
# Tier: the verdict is STATISTICAL and the budget report is REPORTED. Inlining follows tier-up
# timing, so a real comparison is NEVER part of `npm test` / `npm run verify`; only --self-test is
# (canned trace text, deterministic). Run comparisons under the host quiet lock, e.g.
#   node ~/.claude/hooks/quiet-lock.mjs run "<pkg> inline-budget" -- inlining-budget-diff.sh ...
# Frozen "before" (file mode): --before, and the Watch.js beside it, must be FROZEN copies. It is
# refused with NO-VERDICT when it, or the end of its symlink chain, is git-tracked, or when it is the
# same file (device:inode) as a tracked <top>/Signal.js or <top>/<same name>, <top> = the repo around
# the current directory, around --after, around --before and its link target, and --repo. A hard
# link made from outside all of those repos is NOT detected. File mode needs git for this check. Ref and file modes refuse a
# set GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES (each can make
# a tracked --before read as untracked): each repo is found from its path. Driver mode does not read them.
# Ref mode (--before-ref) is frozen by construction.
# Newer V8 (> 14.6): the SKIP / INLINE / colour / emoji formats and the capital-G "Generated N nodes." budget counter are
# verified only against canned sample text in --self-test, not against a real newer node binary. The lowercase
# "generated N nodes. regular_budget += B ~~> T" line is V8 14.6's own (node v26.8.2, non-eager inlining).
# Any unexpected failure (a command that fails outside the checks above) exits 2 NO-VERDICT, never 1.
# Known limits: a refusal after the --out dir is created (a wrong mode combination or driver count, a DRIVER_BEFORE /
# DRIVER_AFTER path or --before / --after not found, an unknown --before-ref) leaves empty raw/ dec/ bud/ ms/ stage/ and
# a 0-byte report.txt there, and a rerun on that OUT is accepted; a refusal after files were staged (ref / file mode: an
# unknown --after-ref, a bad --driver) and a run that fails later (raw/ and report.txt partly written) leave a non-empty
# subdir, so a rerun on that OUT is refused. A refusal before the first write (an unknown option, a bad --runs or --fn,
# --v8-flags, the --out checks) leaves OUT as it was. Turbolev: when this node's --v8-options shows --turbolev or
# --turbolev-future on by default, or a listed default reads as neither on nor off, every tier is NO-VERDICT, exit 2
# ("Turbolev is on by default in this V8" / "cannot read the --turbolev default"), a refusal after the --out dir is
# created and before any driver spawn (driver mode leaves the empty subdirs above; ref / file mode also its staged files).
# A V8 that lists neither flag reads as off (ruling Q-B62-TL); if such a V8 runs Turbolev anyway, the maglev tier is
# NO-VERDICT only through its check for decision lines in TurboFan-tier (@TF) units, which --concurrent (units carry no
# tag) turns off. Driver output glued to a V8 compile line is a real case: it was
# observed on node v26.8.2 in front of a Maglev OSR compile; a glued TurboFan header is UNVERIFIED (never observed on a
# real node). Also refused, exit 2: --turbolev or --turbolev-future in --v8-flags; a report.txt under --out that is a
# symlink, not a regular writable file or hard-linked
# elsewhere; an fn or tier given twice; a value option given twice; --self-test with any other argument; a --v8-flags of
# only blanks; --before and --after the same file; an empty value on a value option; --runs of
# more than 2 digits (even 003); a failed <node> -p probe; a value on -h, --help, --self-test, --only-fn, --concurrent or
# --no-bytecode ("<flag> takes no value"); an empty --tiers; a backslash in --out, or in the current directory for a relative
# --out; an = in the resolved node path; a DRIVER_BEFORE / DRIVER_AFTER whose directory does not resolve to the file named (a
# symlink before '..'). Bytecode probe temp file: a signal mid-probe can leave one inlining-budget-diff.XXXXXX in
# TMPDIR; a TMPDIR that was full during the probe and freed before the 64 KiB append still passes that check, so a cut
# stream can read as a shorter length. Bytecode probe tear: driver output (a Worker's writes, say) interleaved with the
# --print-bytecode text prints ? for that side on a glued or broken header, a length line that is not exactly
# "Bytecode length: <digits>", a header with no length before the next header or EOF, or an orphan length; a driver
# write that starts with a newline, or with digits then a newline, inside or right after a length's digits is not
# detected: the length reads short or as other digits.

unset NODE_OPTIONS NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS   # Q-ENV: no node spawn sees one
unset CDPATH   # before the prologue: SELF, every cd and every "cd X && pwd" join resolve X itself, never a CDPATH entry
set -euo pipefail
[[ ! -o posix ]] || set +o posix   # inherited posix mode (POSIXLY_CORRECT, SHELLOPTS=posix, sh): no <( ) on bash 3.2, other -e rules; drops the var for children; only when set: an unconditional call turns bash 3.2's expand_aliases off
# Fail closed: an exit without FINAL=1 (a planned verdict) becomes 2 NO-VERDICT, rc 0 included (a bash 3.2
# set -u abort exits 0); a die / usage 2 stays silent; set +e keeps 2 with stderr closed. Subshells do not inherit this trap.
FINAL=""
trap 'rc=$?; if [[ -z $FINAL ]]; then set +e; [[ $rc -eq 2 ]] || printf "inlining-budget-diff: unexpected error (exit %s)\nVERDICT NO-VERDICT\n" "$rc" >&2; exit 2; fi' EXIT
REPORT=""   # die reads it: an inherited $REPORT is never a report file
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
export LC_ALL=C   # byte-wise sort / awk: stable multisets, emoji stripped as bytes

# ---------------------------------------------------------------------------------------------
# awk programs (POSIX awk: mawk, gawk, BSD awk)
# ---------------------------------------------------------------------------------------------

# raw trace -> dec (unit TAB normalized decision line) + bud (budget events, raw numbers)
# shellcheck disable=SC2016
NORMALIZE_AWK='
function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
function sfi(s,   i, r, j) {                     # first <SharedFunctionInfo NAME> in s
  i = index(s, "<SharedFunctionInfo"); if (i == 0) return "?"
  r = substr(s, i + 19); if (substr(r, 1, 1) == ">") return "(anon)"
  r = substr(r, 2); j = index(r, ">"); return (j > 0) ? substr(r, 1, j - 1) : "?"
}
function num_after(s, re, skip) { return match(s, re) ? substr(s, RSTART + skip, RLENGTH - skip) : "" }
function addr(l,   o, c) {                       # collapse V8 addresses only: a 0x at line start or after a space, { or (
  # (the only address contexts in real traces; Q-B62-ADDR); after any other byte, ASCII or not, it is part of a name (h0x1)
  o = ""
  while (match(l, /0x[0-9a-fA-F]+/)) {
    c = (RSTART > 1) ? substr(l, RSTART - 1, 1) : ""
    o = o substr(l, 1, RSTART - 1) ((c == "" || c == " " || c == "{" || c == "(") ? "0x" : substr(l, RSTART, RLENGTH))
    l = substr(l, RSTART + RLENGTH)
  }
  return o l
}
# unit key of a compile line, its completion and its abort: <JSFunction NAME (sfi = A)> (target X), plus " OSR" when it
# follows (an OSR and a non-OSR unit of one function never share a key); "" when the line has no such text
function ukey(s,   i, j) {
  i = index(s, "<JSFunction "); if (i == 0) return ""
  s = substr(s, i); j = index(s, "> (target "); if (j == 0) return ""
  i = index(substr(s, j + 10), ")"); if (i == 0) return ""
  j = j + 9 + i
  return substr(s, 1, j) ((substr(s, j + 1, 4) == " OSR") ? " OSR" : "")
}
function norm_turbo(l) {
  l = addr(l); gsub(/#[0-9]+/, "#N", l)
  gsub(/frequency [0-9.eE+-]+/, "frequency F", l); gsub(/took [0-9.]+ ?ms/, "took T ms", l)
  return l
}
function norm_maglev(l) {
  l = addr(l); gsub(/frequency \([0-9.eE+-]+\)/, "frequency (F)", l)
  gsub(/max-size \(/, "@MAXSIZE@", l); gsub(/size \([0-9]+\)/, "size (S)", l); gsub(/@MAXSIZE@/, "max-size (", l)
  gsub(/Score: ?[0-9.]+/, "Score: F", l); gsub(/Node: n[0-9]+/, "Node: nN", l)
  gsub(/\([0-9]+ \+ [0-9]+ >/, "(U + S >", l); gsub(/exhausted \([0-9]+ >/, "exhausted (U >", l)
  gsub(/took [0-9.]+ ?ms/, "took T ms", l)
  return l
}
function reason_of(l,   p) {
  if ((p = index(l, "(reason: ")) > 0) { l = substr(l, p + 9); sub(/\)$/, "", l); return l }
  if ((p = index(l, " because ")) > 0) return substr(l, p + 9)
  if ((p = index(l, "for inlining (")) > 0) { l = substr(l, p + 14); sub(/\)$/, "", l); return l }
  if ((p = index(l, "}: ")) > 0) return substr(l, p + 3)
  return ""
}
function emit(l) { print unit "\t" l > dec }
function ev(s) { print s > bud }
BEGIN { unit = (tag == 1) ? "?" : "*"; greedy = 0 }
{
  l = $0
  gsub(/\033\[[0-9;]*[mK]/, "", l)               # ANSI colours (newer Maglev tracer)
  sub(/^\[(ML|TLV):[0-9]+\] */, "", l)            # --trace-with-compilation-id prefix
}
l ~ /^\[compiling method / {
  greedy = 0; cn = ""
  if (tag != 1) next
  nm = ""; i = index(l, "<JSFunction ")
  if (i > 0) { r = substr(l, i + 12); j = index(r, " (sfi"); if (j > 1) nm = substr(r, 1, j - 1) }
  if (nm == "") nm = "(anon)"
  t = (l ~ /target MAGLEV/) ? "ML" : (l ~ /target TURBOFAN/) ? "TF" : "?"
  if (l ~ /\) OSR/) t = t "-OSR"
  u = nm "@" t; occ[u]++; unit = (occ[u] > 1) ? u "#" occ[u] : u
  ev("K\t" unit "\t" nm); key = ukey(l)
  next
}
# D = the open unit reached `[completed compiling` (its own key, never an abort or the completion of another unit; Q-B57-COMPILE)
l ~ /^\[(completed compiling|aborted|bailout)/ {
  greedy = 0
  if (tag != 1) next
  if (substr(l, 1, 21) == "[completed compiling " && key != "" && ukey(l) == key) ev("D\t" unit "\t" nm)
  unit = "?"; key = ""
  next
}
l ~ /^\[/ { next }
tier == "turbo" {
  l = trim(l)
  # One "Inlining small function(s)" marker covers EVERY Inlining line of that call site (a polymorphic small site
  # prints two), so greedy stays set until the next Considering / Budget used / compile boundary. Every regular
  # inline follows a "Budget used:" line, so it is never counted as small.
  if (l ~ /^(Budget used:|Considering )/ || l ~ /candidate\(s\) for inlining:/) greedy = 0
  if (l ~ /^Budget used: [0-9]+\/[0-9]+/) { cn = ""; split(substr(l, 14), a, /[\/ ]/); ev("U\t" unit "\t" a[1] "\t" a[2]); next }
  if (l ~ /^- candidate: /) { cn = num_after(l, "node #[0-9]+", 6); next }   # the call site the next targets belong to
  if (l ~ /^- target: /) {
    sz = num_after(l, "bytecode size: [0-9]+", 15); if (sz == "") sz = "?"
    ex = num_after(l, "inlined bytecode size: [0-9]+", 23); if (ex == "") ex = 0
    ev("C\t" unit "\t" sfi(l) "\t" sz "\t" ex "\t" cn); next
  }
  if (l ~ /^Inlining small function/) { greedy = 1; next }
  if (l ~ /^Inlining 0x/) ev("I\t" unit "\t" sfi(l) "\t" greedy)
  else if (l ~ /^(Cannot consider|Not inlining|Not considering) /) ev("X\t" unit "\t" sfi(l) "\t" reason_of(l))
  n = norm_turbo(l)
  if (n ~ /^(Inlining 0x|Cannot consider |Not inlining |Not considering )/) emit(n)
  next
}
tier == "maglev" {
  eager = (index(l, "\342\232\241") > 0)          # U+26A1: eager INLINE on newer V8
  sub(/^[^A-Za-z=]+/, "", l); gsub(/[ \t]+/, " ", l); l = trim(l)
  split(l, f, " ")
  if (l ~ /^greedy inlining /) greedy = 1
  else if (l ~ /^== Inlining /) { ev("I\t" unit "\t" sfi(l) "\t" greedy); greedy = 0 }
  else if (l ~ /^cannot inline /) { greedy = 0; ev("X\t" unit "\t" sfi(l) "\t" reason_of(l)) }
  else if (l ~ /^INLINE /) { ev("I\t" unit "\t" f[2] "\t" eager); if (eager) l = "INLINE(eager)" substr(l, 7) }
  else if (l ~ /^SKIP /) ev("X\t" unit "\t" f[2] "\t" substr(l, length(f[2]) + 7))
  else if (l ~ /^[Gg]enerated [0-9]+ nodes\. (small|regular)_budget \+= [0-9]+ ~~> [0-9]+/)
    ev("B\t" unit "\t" (l ~ /small_budget/ ? "small" : "regular") "\t" f[6] "\t" f[8])
  else if (l ~ /^(Small|Main) budget exhausted/) ev("E\t" unit "\t" f[1])
  n = norm_maglev(l)
  if (n ~ /^(== Inlining|greedy inlining|cannot inline|SKIP |INLINE|Small budget exhausted|Main budget exhausted)/) emit(n)
  next
}
'

# dec file -> 0 if the run carries evidence about fn (exact name; read never matches read.set)
# shellcheck disable=SC2016
GUARD_AWK='
BEGIN { tok = "SharedFunctionInfo " fn ">" }
{ u = $0; sub(/\t.*/, "", u); sub(/@.*/, "", u); l = $0; sub(/^[^\t]*\t/, "", l); split(l, f, " ") }
index(l, tok) > 0 || u == fn || ((f[1] == "SKIP" || f[1] ~ /^INLINE/) && f[2] == fn) { found = 1; exit }
END { exit !found }
'

# bud file -> 0 if a unit of fn compiled by THIS tier (t = @TF or @ML, OSR and #N units included) reached
# `[completed compiling` (a D row; an aborted compile writes none). --concurrent writes no K / D rows.
# shellcheck disable=SC2016
DONE_AWK='
$1 == "D" && $3 == fn && index($2, fn t) == 1 { f = 1; exit }
END { exit !f }
'

# bytecode probe exits (node tr awk append) -> BC_RC: the first failed step of awk > tr > append, else node's exit. An
# append failure outranks node's: a TMPDIR that is full can be why node failed (Q-B60-TMPFULL)
bc_rc() { if [[ $3 != 0 ]]; then BC_RC="awk:$3"; elif [[ $2 != 0 ]]; then BC_RC="tr:$2"; elif [[ $4 != 0 ]]; then BC_RC="append:$4"; else BC_RC=$1; fi; }

# dec file -> lines in scope (all, or only lines naming fn / made while compiling fn)
# shellcheck disable=SC2016
SCOPE_AWK='
BEGIN { tok = "SharedFunctionInfo " fn ">" }
only != 1 { print; next }
{ u = $0; sub(/\t.*/, "", u); sub(/@.*/, "", u); l = $0; sub(/^[^\t]*\t/, "", l); split(l, f, " ") }
index(l, tok) > 0 || u == fn || ((f[1] == "SKIP" || f[1] ~ /^INLINE/) && f[2] == fn) { print }
'

# raw trace (NUL read as ?) -> prints "concurrent" if a line starts `[compiling method ` and says ConcurrencyMode::kConcurrent (a
# background compile: a V8 flag implication overrode --no-concurrent-recompilation; `[marking ...` says kConcurrent on every run and is
# not read), else "glued" if driver text is glued in front of a V8 compile line, else "clean", after the same ANSI +
# compilation-id strip NORMALIZE_AWK does. No early exit: awk leaving first under pipefail is a SIGPIPE, a fail-open.
# shellcheck disable=SC2016
GLUE_AWK='
{
  l = $0
  gsub(/\033\[[0-9;]*[mK]/, "", l)
  sub(/^\[(ML|TLV):[0-9]+\] */, "", l)
  if (index(substr(l, 2), "[compiling method ") || index(substr(l, 2), "[completed compiling ")) f = 1
  if (substr(l, 1, 18) == "[compiling method " && index(l, "ConcurrencyMode::kConcurrent")) c = 1
}
END { print (c ? "concurrent" : (f ? "glued" : "clean")) }
'

# two `uniq -c` files -> lines whose counts differ: "before=N after=M  [unit] line"
# shellcheck disable=SC2016
MSDIFF_AWK='
function key(s) { sub(/^ *[0-9]+ /, "", s); return s }
function show(k,   u, l) { u = k; sub(/\t.*/, "", u); l = k; sub(/^[^\t]*\t/, "", l); return (u == "*") ? l : "[" u "] " l }
FILENAME == ARGV[1] { k = key($0); b[k] = $1 + 0; all[k] = 1; next }   # not FNR == NR: an empty first file breaks it
{ k = key($0); a[k] = $1 + 0; all[k] = 1 }
END { for (k in all) if (b[k] + 0 != a[k] + 0) printf "  before=%d after=%d  %s\n", b[k], a[k], show(k) }
'

# `node --v8-options` -> name=value for the inlining limits; then --v8-flags overrides.
# Two formats: "default: --flag=value" (node 26) and an older "default: value" under a "  --flag (...)" header.
# shellcheck disable=SC2016
LIMITS_AWK='
/^  --(max-(maglev-)?(eager-)?inlined-bytecode-size[a-z-]*|reserve-inline-budget-scale-factor) / { k = $1; sub(/^--/, "", k); next }
/^  --/ { k = "" }
/default: --(max-(maglev-)?(eager-)?inlined-bytecode-size|reserve-inline-budget-scale-factor)/ {
  s = $0; sub(/.*default: --/, "", s); print s; k = ""; next
}
k != "" && /default:/ { s = $0; sub(/.*default: */, "", s); sub(/ .*/, "", s); print k "=" s; k = "" }
'

# --print-bytecode output -> distinct "Bytecode length" values of functions named exactly fn; `?` when the stream is torn:
# a header glued after other text on its line; a header line that is not whole, `[generated bytecode for function: <name>
# (0x<hex> <SharedFunctionInfo[ <name>]>)]` (an anonymous function's <name> is empty; a newline inside it breaks it); a
# length line that is not exactly `Bytecode length: <digits>` (an optional trailing CR passes, as before); a header with no
# length line before the next header or EOF; or an orphan length (no header since the previous length line).
# shellcheck disable=SC2016
BYTECODE_AWK='
index(substr($0, 2), "[generated bytecode for function: ") { torn = 1; next }
/^\[generated bytecode for function: / {
  if (pend || !/^\[generated bytecode for function: .* \(0x[0-9a-f]+ <SharedFunctionInfo( .*)?>\)\]\r?$/) torn = 1
  s = $0; sub(/^\[generated bytecode for function: /, "", s); sub(/ \(0x.*$/, "", s); want = (s == fn); pend = 1; next
}
want && /^Bytecode length: [0-9]+/ { v = $3 + 0; if (!(v in seen)) { seen[v] = 1; ord[++nv] = v }; want = 0 }
/^Bytecode length:/ && !/^Bytecode length: [0-9]+\r?$/ { torn = 1 }
/^Bytecode length:/ { if (!pend) torn = 1; pend = 0 }
END { if (pend) torn = 1; out = ""; for (i = 1; i <= nv; i++) out = out (out == "" ? "" : ",") ord[i]; print (torn ? "?" : out) }   # first-seen order
'

# Turbolev default (Q-RL-TURBO 2), read from the same --v8-options capture (0 extra spawns): one row turbolev=on|off|?,
# none when neither `  --turbolev (` nor `  --turbolev-future (` is listed (absent = off, ruling Q-B62-TL). Per header, its
# first default: line before the next `  --` header, trailing spaces / CR trimmed: the flag's own --name or true = on,
# --no-name or false = off, any other text or no default line = ?. Any on -> on, else any ? -> ?, else off. Put in FRONT
# of the limit rules (they `next` past their own headers, which must still close a Turbolev section); tl_* names only.
# shellcheck disable=SC2016
LIMITS_AWK='
/^  --/ { tl_k = "" }
/^  --turbolev(-future)? \(/ { tl_k = $1; tl_v[tl_k] = "?"; tl_n++ }
tl_k != "" && !/^  --/ && index($0, "default:") {
  tl_s = substr($0, index($0, "default:") + 8); sub(/^ +/, "", tl_s); sub(/[ \r]+$/, "", tl_s)
  tl_v[tl_k] = (tl_s == tl_k || tl_s == "true") ? "on" : (tl_s == "--no-" substr(tl_k, 3) || tl_s == "false") ? "off" : "?"
  tl_k = ""
}
END {
  if (tl_n) {
    tl_o = "off"
    for (tl_k in tl_v) { if (tl_v[tl_k] == "on") tl_o = "on"; else if (tl_v[tl_k] == "?" && tl_o != "on") tl_o = "?" }
    print "turbolev=" tl_o
  }
}
'"$LIMITS_AWK"

# bud(before run 1) + bud(after run 1) -> per-unit budget rows (TSV) for every unit
# shellcheck disable=SC2016
BUDGET_AWK='
function base(u) { sub(/@.*/, "", u); return u }
{ k = $1; u = $2 }
k == "K" { units[side, u] = 1; ord[side, ++nu[side]] = u; next }
k != "K" && !((side, u) in units) { units[side, u] = 1; ord[side, ++nu[side]] = u }
# Call sites per callee = distinct call-site node ids ($6, from "- candidate: JSCall node #N"). Each "Budget used"
# round reprints the REMAINING candidates, and inlining one callee can expose NEW sites of another, so neither the
# total over rounds nor the first round is the site count. Without node ids, fall back to the largest per-round count.
k == "C" { csz[side, u, $3] = $4; cex[side, u, $3] = $5; if (!((side, u, $3) in cand)) { cand[side, u, $3] = 1; clist[side, u] = clist[side, u] SUBSEP $3 }
           if ($6 != "") { if (!((side, u, $3, $6) in site)) { site[side, u, $3, $6] = 1; ns[side, u, $3]++ } }
           r = rnd[side, u] + 0; if (++rc[side, u, r, $3] > cmax[side, u, $3] + 0) cmax[side, u, $3] = rc[side, u, r, $3]
           if ($3 == fn) inv[side, u] = 1 }
k == "U" { rnd[side, u]++; if (!((side, u) in peak) || $3 + 0 > peak[side, u] + 0) peak[side, u] = $3; lim[side, u] = $4 }
k == "I" { inl[side, u]++; if ($4 == 1) small[side, u]++; else { nsmall[side, u, ++ni[side, u]] = $3; gn[side, u, $3]++ } ; if ($3 == fn) inv[side, u] = 1 }
k == "X" { rej[side, u]++; if ($3 == fn) inv[side, u] = 1 }
k == "B" { bt[side, u, $3] = $5 }
k == "E" { exh[side, u] = exh[side, u] + 1 }
END {
  for (s = 1; s <= 2; s++) {
    sd = (s == 1) ? "before" : "after"
    for (i = 1; i <= nu[sd]; i++) {
      u = ord[sd, i]; if (seen[sd, u]++) continue
      if (u !~ ("@" want) && u != "?" && u != "*") continue
      charged = 0; unk = 0
      for (j = 1; j <= ni[sd, u]; j++) { nm = nsmall[sd, u, j]; z = csz[sd, u, nm]; if (z ~ /^[0-9]+$/) charged += z; else unk = 1 }
      # want (not the unit name) decides the tier: under --concurrent every unit is "*", which names no tier.
      # "*" merges every compile (and concurrent lines can be cut mid-line), so its used / dropped / model are "-".
      used = (want == "TF") ? ((u == "*") ? "-" : (unk ? "?" : charged)) : ((sd, u, "regular") in bt ? bt[sd, u, "regular"] : "-")
      sm = (want == "TF") ? "-" : ((sd, u, "small") in bt ? bt[sd, u, "small"] : "-")
      L = (want == "TF") ? (lim[sd, u] != "" ? lim[sd, u] : tfcum) : mgcum
      drop = ""
      if (want == "TF" && u != "*") {
        n = split(clist[sd, u], cl, SUBSEP)
        for (c = 2; c <= n; c++) {
          nm = cl[c]; sites = (ns[sd, u, nm] > 0) ? ns[sd, u, nm] : cmax[sd, u, nm]
          miss = sites - gn[sd, u, nm]; if (miss <= 0) continue   # some call site of nm was not inlined
          z = csz[sd, u, nm]; e = cex[sd, u, nm]
          why = (z ~ /^[0-9]+$/ && used ~ /^[0-9]+$/ && used + int((z + e) * scale) > L) ? "budget?" : "other"
          drop = drop (drop == "" ? "" : " ") nm "(" z (e > 0 ? "+" e : "") "," why ")" (miss > 1 ? "x" miss : "")
        }
      }
      chk = "-"
      if (want == "TF" && u != "*" && used ~ /^[0-9]+$/ && ((sd, u) in peak)) {
        if (used + 0 == peak[sd, u] + 0) chk = "ok"
        else if (used + 0 > peak[sd, u] + 0) chk = "ok(+" (used - peak[sd, u]) " after last print)"
        else chk = "MISMATCH(model " used " < printed " peak[sd, u] ")"
      }
      printf "%s\t%s\t%d\t%d\t%d\t%s\t%s\t%s\t%s\t%d\t%d\t%s\t%s\n", sd, u, (base(u) == fn || inv[sd, u]) ? 1 : 0,
        inl[sd, u], small[sd, u], used, (((sd, u) in peak) ? peak[sd, u] : "-"), sm, L, rej[sd, u], exh[sd, u], (drop == "" ? "-" : drop), chk
    }
  }
}
'

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
die() { # the report gets the line only from the main shell and only once it has its head (a 0-byte report stays 0 bytes)
  printf 'inlining-budget-diff: %s\nVERDICT NO-VERDICT\n' "$*" >&2
  if [[ $BASH_SUBSHELL -eq 0 && -s "${REPORT:-/dev/null}" ]]; then { printf 'inlining-budget-diff: %s\nVERDICT NO-VERDICT\n' "$*" >>"$REPORT"; } 2>/dev/null || true; fi
  exit 2
}
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
sha8() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | tr -d '\\' | cut -c1-8; }
usage() { sed -n '2,/^$/{s/^# \{0,1\}//;p;}' "$0"; }
multiset() { sort | uniq -c; }   # the ONE multiset: judge() and --self-test both use it (never sort -u)
devino() { # device:inode, following symlinks (GNU stat, else BSD / macOS stat)
  if stat -L -c '%d:%i' -- "$1" >/dev/null 2>&1; then stat -L -c '%d:%i' -- "$1"; else stat -L -f '%d:%i' -- "$1"; fi
}
top_of() { # dir file: 0 and TOP_OF = the toplevel of the work tree around dir; 1 outside a work tree (or no git); dies
  # on any other git answer, naming file. The classifier is is_tracked's (lib/tracked.sh), copied word for word.
  local d="$1" out rc=0 l
  TOP_OF=""
  command -v git >/dev/null 2>&1 || return 1
  out=$(LC_ALL=C git -C "$d" rev-parse --is-inside-work-tree 2>&1) || rc=$?
  l=${out%%$'\n'*}
  if [[ $rc -ne 0 ]]; then
    case "$l" in "fatal: not a git repository (or any "*) return 1 ;; esac
  elif [[ "$out" == false ]]; then
    return 1
  elif [[ "$out" == true ]]; then
    rc=0
    out=$(LC_ALL=C git -C "$d" rev-parse --show-toplevel 2>&1) || rc=$?
    l=${out%%$'\n'*}
    [[ $rc -ne 0 ]] || { TOP_OF="$out"; return 0; }
  fi
  die "${what:-top_of}: git failed while checking whether $2 is tracked (${l:-no output, exit $rc}): fix it (e.g. git config --global --add safe.directory DIR) or use --before-ref"
}
live_tops() { # file dirs...: LIVE_TOPS = the repo toplevels around cwd, --after, --repo and each given dir (sort -u, one
  # per line); a git error dies naming file (top_of). CURRENT shell only: never in $( ), <( ) or a pipe
  local f="$1" x r t="" TOP_OF=""
  shift
  LIVE_TOPS=""
  if top_of . "$f"; then t="$t$TOP_OF"$'\n'; fi
  if [[ -n "$AFTER_FILE" ]] && top_of "$(dirname -- "$AFTER_FILE")" "$f"; then t="$t$TOP_OF"$'\n'; fi
  if [[ -L "$AFTER_FILE" && -e "$AFTER_FILE" ]]; then
    r=$(resolve_links "$AFTER_FILE" 2>/dev/null) || die "--after: cannot resolve its symlink chain: $AFTER_FILE"
    if top_of "$(dirname -- "$r")" "$f"; then t="$t$TOP_OF"$'\n'; fi
  fi
  if [[ -n "$REPO" ]] && top_of "$REPO" "$f"; then t="$t$TOP_OF"$'\n'; fi
  for x in "$@"; do if top_of "$x" "$f"; then t="$t$TOP_OF"$'\n'; fi; done
  [[ -z "$t" ]] || LIVE_TOPS=$(printf '%s' "$t" | sort -u)
}
resolve_links() { # path: follow a symlink chain (at most 40 hops) and print its end. A relative link joins onto the
  # PHYSICAL directory of the link (a logical join collapses a symlinked dir's '..' onto the wrong parent); dies if
  # that directory cannot be entered
  local p="$1" l n=0 d
  while [[ -L "$p" ]]; do
    n=$((n + 1)); [[ $n -le 40 ]] || die "symlink chain too long (or a loop) at $1"
    l=$(readlink -- "$p") || die "cannot read the symlink $p (in the chain of $1)"
    case "$l" in /*) p="$l" ;; *) d=$(dirname -- "$p"); [[ $d != -* ]] || d="./$d"
      d=$(CDPATH= cd -P -- "$d" 2>/dev/null && pwd -P) || die "cannot resolve the directory of $p (a link in the symlink chain of $1)"; p="$d/$l" ;; esac
  done
  printf '%s\n' "$p"
}
is_tracked() { # path: 0 iff git tracks it in the work tree around it
  local d b
  d=$(dirname -- "$1"); [[ $d != -* ]] || d="./$d"
  d=$(CDPATH= cd -P -- "$d" 2>/dev/null && pwd -P) || return 1
  b=$(basename -- "$1")
  git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 && git -C "$d" ls-files --error-unmatch -- "$b" >/dev/null 2>&1
}
refuse_live() { # file label: die unless file is a FROZEN copy (not tracked, not an alias of a tracked file)
  local f="$1" what="$2" p me top t LIVE_TOPS=""
  p=$(resolve_links "$f")
  for t in "$f" "$p"; do
    if is_tracked "$t"; then die "$what is a git-tracked working-tree file ($t): use a FROZEN copy (untracked) or --before-ref"; fi
  done
  me=$(devino "$f")
  live_tops "$f" "$(dirname -- "$f")" "$(dirname -- "$p")"
  while IFS= read -r top; do
    [[ -n "$top" ]] || continue
    for t in "$top/Signal.js" "$top/$(basename -- "$f")" "$top/$(basename -- "$p")" \
      ${AFTER_FILE:+"$top/$(basename -- "$AFTER_FILE")"}; do
      if [[ -e "$t" ]] && [[ "$(devino "$t")" == "$me" ]] && is_tracked "$t"; then
        die "$what is the same file as the live $t (hard link / symlink): use a FROZEN copy or --before-ref"
      fi
    done
  done < <(printf '%s\n' "$LIVE_TOPS")
}
worst() { # NO-VERDICT > DIFF > SAME
  if [[ $1 == NO-VERDICT || $2 == NO-VERDICT ]]; then echo NO-VERDICT
  elif [[ $1 == DIFF || $2 == DIFF ]]; then echo DIFF
  else echo SAME; fi
}
nl_refuse() { # label str...: die if any str holds a newline or a CR (a path the report prints would forge report lines);
  # the value is never printed
  local l="$1" s
  shift
  for s in "$@"; do
    case "$s" in *$'\n'*|*$'\r'*) die "$l: a newline or a CR is not allowed (it would forge report lines)" ;; esac
  done
}
nl_dir() { # label dir: nl_refuse dir and the name the head prints for dir once `mkdir -p` made it (read-only, no write).
  # P = mkdir -p's physical walk, replayed: the deepest existing ancestor (the OUT_UP walk, its `!= .` guard kept) by
  # cd -P, then the rest one name at a time (an existing name -> cd -P, a new name is a new real dir, `..` pops a new
  # name, else goes to the physical parent). The head prints the logical name (PWD joined, `.` / `..` folded) when it is
  # -ef P (the same walk over it ends at P), else P (pwd -P). An unreplayable walk (a file or a dangling link in the way)
  # checks nothing more: the root's own check or mkdir dies, and its post-resolve backstop stays
  local x e t c cur new p="" lg=""
  nl_refuse "$1" "$2"
  t="$2"; [[ $t == /* ]] || t="$PWD/$t"
  while [[ -n $t ]]; do
    c=${t%%/*}; if [[ $t == */* ]]; then t=${t#*/}; else t=""; fi
    case "$c" in ""|.) ;; ..) lg=${lg%/*} ;; *) lg="$lg/$c" ;; esac
  done
  for x in "$2" "${lg:-/}"; do
    [[ $x != -* ]] || x="./$x"
    e=$x; while [[ ! -e "$e" && ! -L "$e" && "$e" != . ]]; do e=$(dirname -- "$e"); done
    if [[ $e == . ]]; then t=$x; else t=${x#"$e"}; fi
    cur=$(CDPATH= cd -P -- "$e" 2>/dev/null && pwd -P) || break
    new=""
    while [[ -n $t ]]; do
      c=${t%%/*}; if [[ $t == */* ]]; then t=${t#*/}; else t=""; fi
      case "$c" in
        ""|.) ;;
        ..) if [[ -n $new ]]; then new=${new%/*}; else cur=${cur%/*}; fi ;;
        *) if [[ -z $new && ( -e "$cur/$c" || -L "$cur/$c" ) ]]; then cur=$(CDPATH= cd -P -- "$cur/$c" 2>/dev/null && pwd -P) || break 2
           else new="$new/$c"; fi ;;
      esac
    done
    cur="${cur%/}$new"; [[ -n $cur ]] || cur=/
    if [[ -z $p ]]; then p=$cur; elif [[ $cur == "$p" ]]; then p=${lg:-/}; fi
  done
  [[ -z $p ]] || nl_refuse "$1" "$p"
}
is_tracked() { # path: 0 iff git tracks it in the work tree around it; a git error dies
  local d b out rc=0 l
  local e hit
  command -v git >/dev/null 2>&1 || return 1
  d=$(dirname -- "$1"); [[ $d != -* ]] || d="./$d"
  d=$(cd -P -- "$d" 2>/dev/null && pwd -P) || return 1
  b=$(basename -- "$1")
  out=$(LC_ALL=C git -C "$d" rev-parse --is-inside-work-tree 2>&1) || rc=$?
  l=${out%%$'\n'*}
  if [[ $rc -ne 0 ]]; then
    case "$l" in "fatal: not a git repository (or any "*) return 1 ;; esac
  elif [[ "$out" == false ]]; then
    return 1
  elif [[ "$out" == true ]]; then
    hit=0
    while IFS= read -r -d '' e; do
      if [[ "$e" == "$b" || "$d/$e" -ef "$1" ]]; then hit=1; fi
    done < <(exec 3>&1; rc=0; x=$(LC_ALL=C git --icase-pathspecs -C "$d" ls-files -z --error-unmatch -- ":(literal)$b" 2>&1 >&3) || rc=$?; printf '%s\n@rc=%s' "$x" "$rc")
    rc=${e##*@rc=}; out=${e%$'\n@rc='*}; l=${out%%$'\n'*}
    if [[ "$rc" == 0 ]]; then return $((1 - hit)); fi
    if [[ "$rc" == 1 && "$out" == *"did not match"* ]]; then   # icase folds ASCII only (LC_ALL=C): a name that did not match is matched by inode (Unicode case, ASCII aliases, NFC / NFD)
      while IFS= read -r -d '' e; do
        [[ ! "$d/$e" -ef "$1" ]] || return 0
      done < <(exec 3>&1; rc=0; x=$(LC_ALL=C git -C "$d" ls-files -z 2>&1 >&3) || rc=$?; printf '%s\n@rc=%s' "$x" "$rc")
      rc=${e##*@rc=}; out=${e%$'\n@rc='*}; l=${out%%$'\n'*}
      [[ "$rc" != 0 ]] || return 1
      out=""
    fi
    if [[ "$rc" == 1 ]]; then case "$out" in *"did not match"*) return 1 ;; esac; fi
  fi
  die "${what:-is_tracked}: git failed while checking whether $1 is tracked (${l:-no output, exit $rc}): fix it (e.g. git config --global --add safe.directory DIR) or use --before-ref"
}
# `node --v8-options` -> "name type" per flag. A name line is exactly `  --<name> (` (one space before the paren: the
# synopsis lines and uppercase names drop out); the NEXT line must be its `type:` line, else the name is dropped.
# shellcheck disable=SC2016
V8FL_AWK='
p != "" { if (match($0, /^ +type: [a-z0-9_]+/)) { t = substr($0, RSTART, RLENGTH); sub(/^ +type: /, "", t); print p " " t }; p = "" }
/^  --[a-z0-9_-]+ \(/ { p = $1; sub(/^--/, "", p); gsub(/_/, "-", p) }
'
# MD-53 deny families, matched against "-<name>-" (= `(^|-)X(-|$)` on the bare name)
V8FL_RE='-(log|logfile|prof|profile|profiling|profiler|trace|print|perf|redirect|dump|stats|verbose|snapshot|gdbjit|counters|help|abort|fuzzing|file|logger)-'
V8FL_TAB=""
v8fl_read() { # NODE: V8FL_TAB from ONE `NODE --v8-options` capture; fails closed (die) on a spawn error, rc, 0 rows
  local raw rows rc=0
  raw=$(env -u NODE_OPTIONS -u NODE_COMPILE_CACHE "$1" --v8-options 2>/dev/null) || rc=$?
  [[ $rc -eq 0 ]] || die "cannot run $1 --v8-options"
  [[ -n "$raw" ]] || die "$1 --v8-options printed nothing"
  rows=$(printf '%s\n' "$raw" | LC_ALL=C awk "$V8FL_AWK") || rows=""
  [[ -n "$rows" ]] || die "$1 --v8-options lists no V8 flag"
  V8FL_TAB=$'\n'"$rows"$'\n'
}
v8fl_ok() { # TOKEN: 0 iff TOKEN is a V8 tuning flag in V8FL_TAB, in its value form (pure bash, 0 spawns)
  local nl=$'\n' g b t re v=0 neg=0
  g=${1//_/-}
  [[ "$g" == --* ]] || return 1
  b=${g#--}
  if [[ "$b" == *=* ]]; then v=1; [[ -n "${b#*=}" ]] || return 1; b=${b%%=*}; fi
  if [[ "$b" == no-* && "$V8FL_TAB" != *"$nl$b "* ]]; then b=${b#no-}; neg=1; fi
  case "$b" in ''|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) return 1 ;; esac
  re="$nl$b ([a-z0-9_]+)$nl"
  [[ "$V8FL_TAB" =~ $re ]] || return 1                  # not a V8 flag of this node (every node option)
  t=${BASH_REMATCH[1]}
  [[ "$t" != string ]] || return 1                      # string-typed: a file name, path or filter
  if [[ "-$b-" =~ $V8FL_RE ]]; then return 1; fi        # MD-53 family
  if [[ $neg -eq 1 && "$t" != bool && "$t" != maybe_bool ]]; then return 1; fi   # --no- on a non-bool
  case "$t" in bool|maybe_bool) [[ $v -eq 0 ]] ;; *) [[ $v -eq 1 ]] ;; esac     # value form (MD-58)
}
v8fl_check() { # NODE: one read (MD-56: also with no --v8-flags), then die on the first refused V8_EXTRA token
  local f
  v8fl_read "$1"
  for f in ${V8_EXTRA[@]+"${V8_EXTRA[@]}"}; do
    v8fl_ok "$f" || die "--v8-flags must not set $f: only V8 tuning flags of this node binary are accepted (node's own options, and V8 flags that log, trace, print, profile, dump or take a file or path, are refused)"
  done
}

# ---------------------------------------------------------------------------------------------
# --self-test: canned node 26 / newer-V8 text through the same awk programs
# ---------------------------------------------------------------------------------------------
self_test() {
  local d; d=$(mktemp -d)
  local fails=0 oks=0
  check() { if [[ "$2" == "$3" ]]; then oks=$((oks + 1)); echo "ok   $1"; else echo "FAIL $1"; echo "     want: $3"; echo "     got:  $2"; fails=$((fails + 1)); fi; }
  local ESC=$'\033' XM=$'\xe2\x9d\x8c' CK=$'\xe2\x9c\x85' MG=$'\xf0\x9f\x94\x8d'   # U+274C U+2705 U+1F50D
  cat >"$d/t1" <<'EOF'
[compiling method 0x1d8653c8 <JSFunction read.set (sfi = 0x11ec74af73f1)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]
Considering 0x1d866858 {0x11ec74af3511 <SharedFunctionInfo markDownstream>} for inlining with 0x1d8870a0 {0x11ec74af8929 <FeedbackVector[33]>}
Budget used: 0/920 -- 2 candidate(s) for inlining:
- candidate: JSCall node #268 with frequency 0.624484, has_heapnum_param:0, 1 target(s):
  - target: 0x1d866858 {0x11ec74af3511 <SharedFunctionInfo markDownstream>}, bytecode size: 194
- candidate: JSCall node #280 with frequency 0.125172, has_heapnum_param:0, 1 target(s):
  - target: 0x1d866930 {0x11ec74af3559 <SharedFunctionInfo flushEffects>}, bytecode size: 440, existing opt code's inlined bytecode size: 128
Inlining 0x1d866858 {0x11ec74af3511 <SharedFunctionInfo markDownstream>} into 0x1d8653c8 {0x11ec74af73f1 <SharedFunctionInfo read.set>}
Inlining small function(s) at call site #314:JSCall
Inlining 0x1d866580 {0x11ec74af3361 <SharedFunctionInfo runCleanup>} into 0x1d8653c8 {0x11ec74af73f1 <SharedFunctionInfo read.set>}
Inlinee contains 2 calls without local exception handler; linking to surrounding exception handler.
Cannot consider 0x9 {0x8 <SharedFunctionInfo refreshComputed>} for inlining (reason: exceeds bytecode limit)
[completed compiling 0x1d8653c8 <JSFunction read.set (sfi = 0x11ec74af73f1)> (target TURBOFAN_JS) - took 0.1, 2.0, 0.1 ms]
EOF
  sed -e 's/0x1d8/0x9a9/g; s/#268/#999/; s/0\.624484/0.5/; s/bytecode size: 194/bytecode size: 190/' "$d/t1" >"$d/t2"
  awk -v tier=turbo -v tag=1 -v dec="$d/t1.dec" -v bud="$d/t1.bud" "$NORMALIZE_AWK" "$d/t1"
  awk -v tier=turbo -v tag=1 -v dec="$d/t2.dec" -v bud="$d/t2.bud" "$NORMALIZE_AWK" "$d/t2"
  check "turbo: addresses / ids / frequencies / callee sizes do not reach the verdict" "$(cmp -s "$d/t1.dec" "$d/t2.dec" && echo same)" same
  check "turbo: kept lines + unit tag" "$(cut -f1 "$d/t1.dec" | sort -u)|$(wc -l <"$d/t1.dec" | tr -d ' ')" "read.set@TF|3"
  check "turbo: Considering / Budget used / small-call-site / Inlinee lines dropped" \
    "$(grep -cE 'Considering|Budget used|call site|Inlinee' "$d/t1.dec" || true)" 0
  check "turbo: Cannot consider normalized" "$(grep 'Cannot' "$d/t1.dec" | cut -f2)" \
    "Cannot consider 0x {0x <SharedFunctionInfo refreshComputed>} for inlining (reason: exceeds bytecode limit)"
  awk -v fn=read.set -v want=TF -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/t1.bud" side=after "$d/t2.bud" >"$d/b.tsv"
  check "turbo budget: charged = non-small inlines only (194), small inline counted apart" \
    "$(awk -F '\t' '$1=="before"{print $4"/"$5"/"$6"/"$12}' "$d/b.tsv")" "2/1/194/flushEffects(440+128,other)"

  printf '%s\n' \
    '[compiling method 0x45 <JSFunction step (sfi = 0x3f)> (target MAGLEV), mode: ConcurrencyMode::kSynchronous]' \
    '  cannot inline 0x45b10e78 {0x3f3c6b9b73f1 <SharedFunctionInfo read.set>}: big function, size (285) >= max-size (100)' \
    '  cannot inline 0x45b10e79 {0x3f3c6b9b73f2 <SharedFunctionInfo read.set>}: big function, size (285) >= max-size (100)' \
    '  cannot inline 0x45 {0x3f <SharedFunctionInfo markDownstream>}: call frequency (0.624484) < minimum threshold (0.95)' \
    '  greedy inlining 0x45 {0x3f <SharedFunctionInfo batch>}: small function, skipping max-depth' \
    '== Inlining 0x3f3c6b9ae4b1 <SharedFunctionInfo batch>' \
    "${ESC}[90m[ML:7] ${ESC}[0m${ESC}[91m${XM} SKIP   ${ESC}[0m${ESC}[36mm0                            ${ESC}[0m big function" \
    "${ESC}[92m${CK} INLINE ${ESC}[0m${ESC}[36mpullComputed                  ${ESC}[0m " \
    "          Generated 41 nodes. regular_budget += 64 ~~> 64${ESC}[0m" \
    "${ESC}[93m${MG} TRY    ${ESC}[0m${ESC}[36mm0                            ${ESC}[0m Score:   1.25, Node: n42" \
    >"$d/m1"
  awk -v tier=maglev -v tag=1 -v dec="$d/m1.dec" -v bud="$d/m1.bud" "$NORMALIZE_AWK" "$d/m1"
  check "maglev: size collapsed, max-size kept" "$(sed -n 1p "$d/m1.dec" | cut -f2)" \
    "cannot inline 0x {0x <SharedFunctionInfo read.set>}: big function, size (S) >= max-size (100)"
  check "maglev: newer-V8 colour / prefix / emoji stripped; TRY dropped" "$(cut -f2 "$d/m1.dec" | grep -E '^(SKIP|INLINE|TRY)' | tr '\n' '|')" \
    "SKIP m0 big function|INLINE pullComputed|"
  check "maglev: newer-V8 regular_budget event" "$(grep '^B' "$d/m1.bud" | cut -f3-)" "$(printf 'regular\t64\t64')"
  multiset <"$d/m1.dec" >"$d/m1.ms"
  check "multiset keeps call-site multiplicity (sort -u would merge the two read.set lines)" \
    "$(grep -c 'read.set' "$d/m1.ms")|$(grep 'read.set' "$d/m1.ms" | awk '{print $1}')" "1|2"
  head -2 "$d/m1.dec" | multiset >"$d/one.ms"; grep -v 'read.set' "$d/m1.dec" | multiset >>"$d/one.ms"
  head -1 "$d/m1.dec" | multiset >"$d/two.ms"; grep -v 'read.set' "$d/m1.dec" | multiset >>"$d/two.ms"
  check "multiset diff reports 2 -> 1" "$(awk "$MSDIFF_AWK" "$d/one.ms" "$d/two.ms" | cut -c1-21)" "  before=2 after=1  ["
  check "guard: read does not match read.set" "$(awk -v fn=read "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" miss
  check "guard: read.set matches" "$(awk -v fn=read.set "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" hit
  check "guard: newer-V8 name field (m0)" "$(awk -v fn=m0 "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" hit
  check "guard: compile unit of fn counts as evidence" "$(awk -v fn=step "$GUARD_AWK" "$d/m1.dec" && echo hit || echo miss)" hit
  check "--only-fn scope: lines naming fn or compiled in fn" \
    "$(awk -v fn=batch -v only=1 "$SCOPE_AWK" "$d/m1.dec" | wc -l | tr -d ' ')" 2
  printf '%s\n' '[generated bytecode for function: read (0x1 <SharedFunctionInfo read>)]' 'Bytecode length: 106' \
    '[generated bytecode for function: read.set (0x2 <SharedFunctionInfo read.set>)]' 'Bytecode length: 285' >"$d/bc"
  check "bytecode probe: exact name" "$(awk -v fn=read "$BYTECODE_AWK" "$d/bc")" 106
  printf 'K\tf@TF\tf\nU\tf@TF\t0\t920\nC\tf@TF\tg\t767\t0\nC\tf@TF\th\t768\t0\n' >"$d/t3.bud"
  awk -v fn=f -v want=TF -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/t3.bud" side=after "$d/t3.bud" >"$d/b3.tsv"
  check "turbo budget: reserve compare truncates like V8: int(1.2*767)=920 is not > 920, int(1.2*768)=921 is" \
    "$(awk -F '\t' '$1=="before"{print $12}' "$d/b3.tsv")" "g(767,other) h(768,budget?)"
  check "turbo budget model: equal -> ok" "$(awk -F '\t' '$1=="before"{print $13}' "$d/b3.tsv")" "ok"
  check "turbo budget model: inlines after the last print" "$(awk -F '\t' '$1=="before"{print $13}' "$d/b.tsv")" "ok(+194 after last print)"
  printf 'K\tf@TF\tf\nU\tf@TF\t500\t920\nC\tf@TF\tg\t100\t0\nI\tf@TF\tg\t0\n' >"$d/t4.bud"
  awk -v fn=f -v want=TF -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/t4.bud" side=after "$d/t4.bud" >"$d/b4.tsv"
  check "turbo budget model: V8 printed more than the model charged -> MISMATCH" \
    "$(awk -F '\t' '$1=="before"{print $13}' "$d/b4.tsv")" "MISMATCH(model 100 < printed 500)"
  local fk="$d/fake" rc2
  mkdir -p "$fk"
  printf '%s\n' '#!/bin/sh' 'case "$1" in --v8-options) echo "  --turbofan (enable TurboFan)"; echo "        type: bool  default: --turbofan"; echo "  --stack-size (stack size)"; echo "        type: int  default: --stack-size=984"; echo "  --max-inlined-bytecode-size (maximum size of bytecode for a single inlining)"; echo "        type: int  default: --max-inlined-bytecode-size=460"; echo "  --turbolev (enable Turbolev)"; echo "        type: bool  default: --no-turbolev"; echo "  --turbolev-future (enable future Turbolev features)"; echo "        type: bool  default: --no-turbolev-future"; exit 0 ;; -p) echo "v0 (V8 0)"; exit 0 ;; esac' \
    'for a; do last="$a"; done' 'cat "$last"' >"$fk/node"
  chmod +x "$fk/node"
  if command -v git >/dev/null 2>&1; then
    local rc out x
    # the six GIT_* vars ref / file mode refuses: unset for the repo set-up and every spawn below, so the rows also run from a git hook
    nogit() { (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_CEILING_DIRECTORIES; "$@"); }
    mkdir -p "$d/repo/sub" "$d/alias" "$d/alias2" "$d/sym" "$d/frozen" "$d/frozen3" "$d/frozen4" "$d/after"
    printf 'export const x = 1;\n' >"$d/repo/Signal.js"; printf 'export const w = 1;\n' >"$d/repo/Watch.js"
    cp "$d/repo/Signal.js" "$d/after/Signal.js"
    for x in frozen frozen3 frozen4; do cp "$d/repo/Signal.js" "$d/$x/Signal.js"; done
    nogit git -C "$d/repo" init -q && nogit git -C "$d/repo" add Signal.js Watch.js
    ln "$d/repo/Signal.js" "$d/alias/Signal.js"; ln "$d/repo/Signal.js" "$d/alias2/Signal.js"
    ln "$d/repo/Signal.js" "$d/repo/sub/Signal.js"; ln -s ../repo/Signal.js "$d/sym/Signal.js"
    ln -s "$d/repo/Watch.js" "$d/frozen3/Watch.js"; ln "$d/repo/Watch.js" "$d/frozen4/Watch.js"
    # failnode (the frozen row only): -p and the first --v8-options (v8fl_check) succeed, the second (the lib/v8limits.sh read) exits 1
    printf '%s\n' '#!/bin/sh' 'case "$1" in -p) echo "v0 (V8 0)" ;; --v8-options) [ ! -e "$0.read" ] || exit 1; : >"$0.read"; echo "  --turbofan (enable TurboFan)"; echo "        type: bool  default: --turbofan" ;; esac' >"$d/failnode"; chmod +x "$d/failnode"
    refusal() { # cwd pattern args... -> "rc|lines matching pattern" (the fake node answers -p and --v8-options; the driver is never spawned)
      local cwd="$1" pat="$2" x nd; shift 2
      nd=(--node "$fk/node"); for x in "$@"; do [[ "$x" != --node ]] || nd=(); done   # a row's own --node replaces the fake one (given once)
      out=$(cd "$cwd" && nogit "$BASH" "$SELF" ${nd[@]+"${nd[@]}"} "$@" 2>&1) && rc=0 || rc=$?
      printf '%s|%s' "$rc" "$(printf '%s\n' "$out" | grep -c -- "$pat" || true)"
    }
    check "file mode: a git-tracked --before is refused (exit 2)" \
      "$(refusal "$d" 'git-tracked' --before "$d/repo/Signal.js" --after "$d/after/Signal.js" --out "$d/o1")" "2|1"
    check "file mode: a hard link to the live tracked file is refused (cwd in the repo)" \
      "$(refusal "$d/repo" 'same file as the live' --before "$d/alias/Signal.js" --after "$d/after/Signal.js" --out "$d/o2")" "2|1"
    check "file mode: a hard link found through the --after repo is refused (cwd outside)" \
      "$(refusal "$d" 'same file as the live' --before "$d/alias2/Signal.js" --after "$d/repo/Signal.js" --out "$d/o4")" "2|1"
    check "file mode: a hard link inside the repo around --before is refused (cwd outside)" \
      "$(refusal "$d" 'same file as the live' --before "$d/repo/sub/Signal.js" --after "$d/after/Signal.js" --out "$d/o5")" "2|1"
    check "file mode: a symlink to the live tracked file is refused (cwd outside)" \
      "$(refusal "$d" 'git-tracked' --before "$d/sym/Signal.js" --after "$d/after/Signal.js" --out "$d/o6")" "2|1"
    check "file mode: a symlinked Watch.js beside --before is refused (cwd outside)" \
      "$(refusal "$d" 'Watch.js beside --before is a git-tracked' --before "$d/frozen3/Signal.js" --after "$d/after/Signal.js" --out "$d/o7")" "2|1"
    check "file mode: a hard-linked Watch.js beside --before is refused (cwd in the repo)" \
      "$(refusal "$d/repo" 'Watch.js beside --before is the same file' --before "$d/frozen4/Signal.js" --after "$d/after/Signal.js" --out "$d/o8")" "2|1"
    out=$(cd "$d/repo" && nogit "$BASH" "$SELF" --node "$d/failnode" --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o3" 2>&1) && rc=0 || rc=$?
    check "file mode: a frozen copy passes the check; an unexpected failure exits 2, never 1" \
      "$rc|$(printf '%s\n' "$out" | grep -ci 'frozen' || true)|$(printf '%s\n' "$out" | grep -c 'cannot run' || true)" "2|0|1"
    check "options: --node resolving to a builtin (false) is refused (exit 2, named die)" \
      "$(refusal "$d" 'is not a file on PATH' --node false --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-f11")" "2|1"
    check "options: a newline in an input (--fn) is refused (exit 2, named die)" \
      "$(refusal "$d" 'a newline is not allowed' --fn $'read.set\nx' --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-f3")" "2|1"
    check "options: a --v8-flags shape token and a non-numeric limit value are refused (exit 2, named dies)" \
      "$(refusal "$d" 'takes flags only' --v8-flags x.js --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-f12a")/$(refusal "$d" 'needs =N' --v8-flags=--max-inlined-bytecode-size=abc --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-f12b")" "2|1/2|1"
    check "--v8-flags: a refused node option (--snapshot-blob) exits 2 with a named die and OUT not created" \
      "$(refusal "$d" 'must not set --snapshot-blob' --v8-flags=--snapshot-blob=./s --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-f2")|$([[ -e "$d/o-f2" ]] && echo present || echo absent)" "2|1|absent"
    mkdir -p "$d/fw"; printf "export * from './Watch.js';\n" >"$d/fw/Signal.js"
    check "file mode: a single-quoted ./Watch.js re-export with no Watch.js beside --before is refused (exit 2)" \
      "$(refusal "$d" 'no Watch.js beside' --before "$d/fw/Signal.js" --after "$d/after/Signal.js" --out "$d/o-f4b")" "2|1"
    # b62 G5a: one of the six GIT_* vars set (the rest unset) -> refused by name in ref / file mode only
    genv() { # NAME=VALUE cwd pattern args... -> "rc|lines matching pattern"
      local kv="$1" cwd="$2" pat="$3"; shift 3
      out=$(cd "$cwd" && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_CEILING_DIRECTORIES && export "$kv" && "$BASH" "$SELF" --node "$fk/node" "$@" 2>&1) && rc=0 || rc=$?
      printf '%s|%s' "$rc" "$(printf '%s\n' "$out" | grep -c -- "$pat" || true)"
    }
    x='GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES is set'
    check "file mode: a set GIT_DIR / GIT_CEILING_DIRECTORIES is refused by name (exit 2), not read as untracked" \
      "$(genv "GIT_DIR=$d/nogit" "$d" "$x" --before "$d/repo/Signal.js" --after "$d/after/Signal.js" --out "$d/o-g1")/$(genv "GIT_CEILING_DIRECTORIES=$d/repo" "$d" "$x" --before "$d/repo/Signal.js" --after "$d/after/Signal.js" --out "$d/o-g2")" "2|1/2|1"
    printf '%s\n' '// import { x } from "./Signal.js";' "import { x } from '$d/frozen/Signal.js';" \
      '/* import { x } from "./Signal.js"; */' '/**' ' * example:' " * import { x } from './Signal.js';" ' */' "const s = './Signal.js';" >"$d/cdrv.mjs"
    printf '%s\n' '/* c */ import { x } from "./Signal.js"; // ok' >"$d/idrv.mjs"
    check "file mode: a --driver that names ./Signal.js only in a comment is refused; a real import passes the check" \
      "$(refusal "$d" "must import './Signal.js'" --driver "$d/cdrv.mjs" --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-cd")/$(refusal "$d" "must import './Signal.js'" --driver "$d/idrv.mjs" --before "$d/frozen/Signal.js" --after "$d/after/Signal.js" --out "$d/o-id")" "2|1/2|0"
  else
    check "git available (the file-mode frozen-copy checks need it)" "missing" "present"
  fi
  cp "$d/t1" "$fk/before.trace"; cp "$d/t2" "$fk/same.trace"
  grep -v '^Inlining 0x1d866858' "$d/t1" >"$fk/drop.trace"      # markDownstream no longer inlined into read.set
  printf '%s\n' '[compiling method 0x1 <JSFunction read.set (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]' \
    'Budget used: 500/920 -- 1 candidate(s) for inlining:' \
    '  - target: 0x3 {0x4 <SharedFunctionInfo helper>}, bytecode size: 100' \
    'Inlining 0x3 {0x4 <SharedFunctionInfo helper>} into 0x1 {0x2 <SharedFunctionInfo read.set>}' \
    '[completed compiling 0x1 <JSFunction read.set (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]' >"$fk/mm.trace"
  fake() { # before after -> "rc|verdict line"
    "$BASH" "$SELF" --node "$fk/node" --tiers turbo --no-bytecode --fn read.set --out "$d/o-$2" "$fk/$1" "$fk/$2" \
      >"$d/fake-$2.out" 2>&1 && rc2=0 || rc2=$?
    printf '%s|%s' "$rc2" "$(grep '^VERDICT ' "$d/fake-$2.out" || true)"
  }
  check "driver mode (fake node): a real DIFF exits 1 (the EXIT trap keeps a planned exit)" "$(fake before.trace drop.trace)" "1|VERDICT DIFF"
  check "driver mode (fake node): addresses / frequencies only -> SAME, exit 0" "$(fake before.trace same.trace)" "0|VERDICT SAME"
  check "driver mode (fake node): a budget-model MISMATCH prints a NOTE and leaves the verdict SAME" \
    "$(fake mm.trace mm.trace)|$(grep -c 'NOTE budget model MISMATCH' "$d/fake-mm.trace.out" || true)" "0|VERDICT SAME|1"
  check "driver mode (fake node): limits the binary does not report are ASSUMED, with a NOTE" \
    "$(grep -c 'NOTE    limits not reported by this node binary, ASSUMED' "$d/fake-same.trace.out" || true)" 1
  check "ASSUMED fallbacks are the node 26 defaults (TurboFan small 30, Maglev eager 30)" \
    "$(grep 'ASSUMED' "$d/fake-same.trace.out" | grep -o -e ' max-inlined-bytecode-size-small=[0-9]*' -e ' max-maglev-eager-inlined-bytecode-size=[0-9]*' | tr -d '\n')" \
    " max-inlined-bytecode-size-small=30 max-maglev-eager-inlined-bytecode-size=30"
  check "driver mode (fake node): a SAME run leaves all.turbo.diff.txt at 0 bytes" \
    "$([[ -f "$d/o-same.trace/all.turbo.diff.txt" ]] && wc -c <"$d/o-same.trace/all.turbo.diff.txt" | tr -d ' ')" 0
  check "--out: a reused non-empty subdir is refused (exit 2, named die)" \
    "$(refusal "$d" 'is not empty' --tiers turbo --no-bytecode --fn read.set --out "$d/o-same.trace" "$fk/before.trace" "$fk/same.trace")" "2|1"
  sed '1s/^/driver text/' "$d/t1" >"$fk/glued.trace"; sed '1s/^/driver text/' "$d/t2" >"$fk/glued2.trace"
  sed '1s/^/[ML:7] /' "$d/t2" >"$fk/idprefix.trace"
  check "driver mode (fake node): driver output glued to a compile line is refused (exit 2, named die, not DIFF)" \
    "$(refusal "$d" 'driver output glued to a V8 compile line' --tiers turbo --no-bytecode --fn read.set --out "$d/o-n2" "$fk/before.trace" "$fk/glued.trace")" "2|1"
  check "driver mode (fake node): a legal [ML:7] compilation-id prefix is not read as glue" "$(fake before.trace idprefix.trace)" "0|VERDICT SAME"
  # b62 G5a rows: refusals before any spawn, the -ef driver join, the GIT_* driver control, the kConcurrent evidence check
  local A=(--tiers turbo --no-bytecode --fn read.set)
  check "options: a value on a boolean flag is refused (--only-fn=0 / --concurrent=no / --no-bytecode=x / --help=x: exit 2, named die)" \
    "$(refusal "$d" '^inlining-budget-diff: --only-fn takes no value$' "${A[@]}" --only-fn=0 --out "$d/o-b1" "$fk/before.trace" "$fk/drop.trace")/$(refusal "$d" '^inlining-budget-diff: --concurrent takes no value$' "${A[@]}" --concurrent=no --out "$d/o-b2" "$fk/before.trace" "$fk/drop.trace")/$(refusal "$d" '^inlining-budget-diff: --no-bytecode takes no value$' "${A[@]}" --no-bytecode=x --out "$d/o-b3" "$fk/before.trace" "$fk/drop.trace")/$(refusal "$d" '^inlining-budget-diff: --help takes no value$' --help=x)" "2|1/2|1/2|1/2|1"
  check "driver mode: GIT_DIR set does not refuse (the GIT_* refusal is ref / file mode only)" \
    "$(genv "GIT_DIR=$d/nogit" "$d" '^VERDICT SAME$' "${A[@]}" --out "$d/o-gd" "$fk/before.trace" "$fk/same.trace")" "0|1"
  mkdir -p "$d/x" "$d/real/a/b"; ln -s "$d/real/a/b" "$d/x/lnk"; cp "$fk/before.trace" "$d/real/a/drv.trace"; cp "$fk/drop.trace" "$d/x/drv.trace"
  check "driver mode: a symlink before '..' in a driver path is refused (DRIVER_AFTER / DRIVER_BEFORE, exit 2), never measured as another file" \
    "$(refusal "$d/x" 'DRIVER_AFTER: cannot resolve the directory of' "${A[@]}" --out "$d/o-e1" "$d/real/a/drv.trace" lnk/../drv.trace)/$(refusal "$d/x" 'DRIVER_BEFORE: cannot resolve the directory of' "${A[@]}" --out "$d/o-e2" lnk/../drv.trace "$d/real/a/drv.trace")" "2|1/2|1"
  mkdir -p "$d/bs\\q"
  check "--out: a backslash in DIR, or in the cwd of a relative DIR, is refused (exit 2); an absolute DIR under that cwd runs" \
    "$(refusal "$d/bs\\q" 'a backslash is not allowed' "${A[@]}" --out rel "$fk/before.trace" "$fk/same.trace")/$(refusal "$d" 'a backslash is not allowed' "${A[@]}" --out "o/x\\ty" "$fk/before.trace" "$fk/same.trace")/$(refusal "$d/bs\\q" '^VERDICT SAME$' "${A[@]}" --out "$d/o-bsabs" "$fk/before.trace" "$fk/same.trace")" "2|1/2|1/0|1"
  mkdir -p "$d/a=b"; cp "$fk/node" "$d/a=b/node"
  check "options: an empty --tiers and an = in the resolved node path are refused (exit 2, named dies)" \
    "$(refusal "$d" 'tiers is empty' --tiers " " --no-bytecode --fn read.set --out "$d/o-t1" "$fk/before.trace" "$fk/same.trace")/$(refusal "$d" 'an = is not allowed in the resolved path' "${A[@]}" --node "$d/a=b/node" --out "$d/o-t2" "$fk/before.trace" "$fk/same.trace")" "2|1/2|1"
  check "--v8-flags: any *stress-concurrent-inlining* spelling is refused by name (exit 2)" \
    "$(refusal "$d" 'must not set --stress-concurrent-inlining: --stress-concurrent-inlining implies' "${A[@]}" --v8-flags=--stress-concurrent-inlining --out "$d/o-s1" "$fk/before.trace" "$fk/same.trace")/$(refusal "$d" 'must not set --no-stress-concurrent-inlining: --stress-concurrent-inlining implies' "${A[@]}" --v8-flags=--no-stress-concurrent-inlining --out "$d/o-s2" "$fk/before.trace" "$fk/same.trace")" "2|1/2|1"
  sed '1s/kSynchronous]$/kConcurrent]/' "$d/t2" >"$fk/kc.trace"
  { printf '%s\n' '[marking 0x1 <JSFunction read.set (sfi = 0x2)> for optimization to TURBOFAN_JS, ConcurrencyMode::kConcurrent, reason: hot and stable]'; cat "$d/t2"; } >"$fk/km.trace"
  check "driver mode: a kConcurrent compile line without --concurrent is NO-VERDICT (exit 2, named)" \
    "$(refusal "$d" 'background compile (--no-concurrent-recompilation overridden' "${A[@]}" --out "$d/o-k1" "$fk/before.trace" "$fk/kc.trace")" "2|1"
  check "driver mode: a kConcurrent compile line under --concurrent, and a kConcurrent [marking line, still give a verdict" \
    "$(refusal "$d" '^VERDICT SAME$' "${A[@]}" --concurrent --out "$d/o-k2" "$fk/before.trace" "$fk/kc.trace")/$(fake before.trace km.trace)" "0|1/0|VERDICT SAME"
  # awk PATH shim: exits 2 on the GLUE program only (keyed on code the live and parked forms share, not on the word "glued")
  mkdir -p "$d/shim"
  printf '%s\n' '#!/bin/sh' 'case "$*" in *"index(substr(l, 2)"*) exit 2 ;; esac' "exec \"$(command -v awk)\" \"\$@\"" >"$d/shim/awk"; chmod +x "$d/shim/awk"
  check "driver mode (fake node): a failing glue scan is refused (exit 2, named die), never read as no glue" \
    "$(PATH="$d/shim:$PATH"; refusal "$d" 'cannot scan' --tiers turbo --no-bytecode --fn read.set --out "$d/o-scan" "$fk/glued.trace" "$fk/glued2.trace")" "2|1"
  cat "$d/t1" "$d/bc" >"$fk/bcb.trace"; cat "$d/t2" "$d/bc" >"$fk/bca.trace"
  "$BASH" "$SELF" --node "$fk/node" --tiers turbo --fn read.set --v8-flags=--max-inlined-bytecode-size=09 --out "$d/o-09" "$fk/bcb.trace" "$fk/bca.trace" \
    >"$d/o-09.out" 2>&1 && rc2=0 || rc2=$?
  check "--v8-flags: a leading-zero limit (=09) reads as base 10 in the bytecode report (SAME, no unexpected error)" \
    "$rc2|$(grep '^VERDICT ' "$d/o-09.out" || true)|$(grep -c 'unexpected' "$d/o-09.out" || true)" "0|VERDICT SAME|0"

  # b62 G5b rows (audit 2026-11-09 IBD-opus-1 = R9, IBD-fable-1 = IBD-opus-6 = R15; Q-B57-COMPILE): a 0x inside a name is
  # kept, an address collapses; a compile of fn by THIS tier that reached `[completed compiling` is evidence
  printf '%s\n' 'Inlining 0x3 {0x4 <SharedFunctionInfo a_0x1$0x2.0x3h0x4k90x5>} into 0x1 {0x2 <SharedFunctionInfo M0xa>}' >"$d/an"
  printf '%s\n' '== Inlining 0x3 <SharedFunctionInfo a_0x1$0x2.0x3h0x4k90x5>' >"$d/am"
  awk -v tier=turbo -v tag=0 -v dec="$d/an.dec" -v bud="$d/an.bud" "$NORMALIZE_AWK" "$d/an"
  awk -v tier=maglev -v tag=0 -v dec="$d/am.dec" -v bud="$d/am.bud" "$NORMALIZE_AWK" "$d/am"
  check "normalize: a 0x after a byte other than line start, space, { or ( stays in the name, an address collapses (turbo + maglev, exact lines)" \
    "$(cut -f2 "$d/an.dec")|$(cut -f2 "$d/am.dec")" \
    'Inlining 0x {0x <SharedFunctionInfo a_0x1$0x2.0x3h0x4k90x5>} into 0x {0x <SharedFunctionInfo M0xa>}|== Inlining 0x <SharedFunctionInfo a_0x1$0x2.0x3h0x4k90x5>'
  fkr() { # out tiers fn before after -> "rc|VERDICT line|guard ok / NO-VERDICT line of fn"
    "$BASH" "$SELF" --node "$fk/node" --tiers "$2" --no-bytecode --runs 2 --fn "$3" --out "$d/o-$1" "$fk/$4" "$fk/$5" >"$d/fkr-$1.out" 2>&1 && rc2=0 || rc2=$?
    printf '%s|%s|%s' "$rc2" "$(grep '^VERDICT ' "$d/fkr-$1.out" || true)" "$(grep -e '^  guard ok:' -e "^  $3: NO-VERDICT" "$d/fkr-$1.out" || true)"
  }
  local TC='[compiling method 0x1 <JSFunction m0 (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]'
  local TE='[completed compiling 0x1 <JSFunction m0 (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]'
  local OC='[compiling method 0x5 <JSFunction oth (sfi = 0x6)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]'
  local OI='Inlining 0x7 {0x8 <SharedFunctionInfo leaf>} into 0x5 {0x6 <SharedFunctionInfo oth>}'
  local OE='[completed compiling 0x5 <JSFunction oth (sfi = 0x6)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]'
  printf '%s\n' "$TC" 'Inlining 0x3 {0x4 <SharedFunctionInfo h0x1>} into 0x1 {0x2 <SharedFunctionInfo m0>}' "$TE" >"$fk/h1.trace"
  sed 's/h0x1/h0x2/' "$fk/h1.trace" >"$fk/h2.trace"
  printf '%s\n' "${TC/TURBOFAN_JS/MAGLEV}" '== Inlining 0x3 <SharedFunctionInfo h0x1>' "${TE/TURBOFAN_JS/MAGLEV}" >"$fk/g1.trace"
  sed 's/h0x1/h0x2/' "$fk/g1.trace" >"$fk/g2.trace"
  check "driver mode (fake node): m0 inlining h0x1 vs h0x2 is a DIFF (turbo), not an erased name" "$(fkr r9t turbo m0 h1.trace h2.trace)" "1|VERDICT DIFF|  guard ok: m0"
  check "driver mode (fake node): --fn h0x1 finds its own decision line (no h0x1 compile): SAME" "$(fkr r9s turbo h0x1 h1.trace h1.trace)" "0|VERDICT SAME|  guard ok: h0x1"
  check "driver mode (fake node): Maglev == Inlining h0x1 vs h0x2 is a DIFF" "$(fkr r9m maglev m0 g1.trace g2.trace)" "1|VERDICT DIFF|  guard ok: m0"
  # Q-B62-ADDR: a 0x after a non-ASCII byte (U+00E9 as UTF-8 \303\251) is part of the name, never an address
  printf '%s\n%b\n%s\n' "$TC" 'Inlining 0x3 {0x4 <SharedFunctionInfo \0303\02510x1>} into 0x1 {0x2 <SharedFunctionInfo m0>}' "$TE" >"$fk/n1.trace"
  printf '%s\n%b\n%s\n' "$TC" 'Inlining 0x3 {0x4 <SharedFunctionInfo \0303\02510x2>} into 0x1 {0x2 <SharedFunctionInfo m0>}' "$TE" >"$fk/n2.trace"
  check "driver mode (fake node): m0 inlining <e-acute>0x1 vs <e-acute>0x2 is a DIFF (a 0x after a non-ASCII byte is kept)" "$(fkr rna turbo m0 n1.trace n2.trace)" "1|VERDICT DIFF|  guard ok: m0"
  local NV="2|VERDICT NO-VERDICT|  m0: NO-VERDICT -- no trace of m0 in before run 1 (no decision line names it, no completed turbo compile of it: no evidence)"
  printf '%s\n' "$TC" "$TE" "$OC" "$OI" "$OE" >"$fk/ca.trace"
  printf '%s\n' "${TC/TURBOFAN_JS/MAGLEV}" "${TE/TURBOFAN_JS/MAGLEV}" "$OC" "$OI" "$OE" >"$fk/cb.trace"
  printf '%s\n' "$TC" '[aborted optimizing 0x1 <JSFunction m0 (sfi = 0x2)> (target TURBOFAN_JS) because: Function is too big to be optimized - took 0.1, 0.0, 0.0 ms]' \
    "$OC" "$OI" "$OE" >"$fk/cc.trace"
  printf '%s\n' "$TC" "$OE" "$OC" "$OI" "$OE" >"$fk/cd.trace"
  printf '%s\n' "${TC/), mode:/) OSR, mode:}" "$TE" "$OC" "$OI" "$OE" >"$fk/ce.trace"
  check "guard (fake node): a completed TurboFan compile of m0 with no decision line naming it is evidence: SAME" "$(fkr r15a turbo m0 ca.trace ca.trace)" "0|VERDICT SAME|  guard ok: m0"
  check "guard (fake node): only a Maglev compile of m0 is no turbo evidence: NO-VERDICT" "$(fkr r15b turbo m0 cb.trace cb.trace)" "$NV"
  check "guard (fake node): an aborted TurboFan compile of m0 is no evidence: NO-VERDICT" "$(fkr r15c turbo m0 cc.trace cc.trace)" "$NV"
  check "guard (fake node): another unit's completion (or a non-OSR completion of an OSR unit) does not complete m0: NO-VERDICT" \
    "$(fkr r15d turbo m0 cd.trace cd.trace)/$(fkr r15e turbo m0 ce.trace ce.trace)" "$NV/$NV"

  # b65 G5c rows (Q-RL-TURBO, Q-B62-TL): --turbolev on the command line is refused by name; a --v8-options default of
  # --turbolev refuses every tier before any driver spawn; a maglev decision line in a TurboFan-tier unit is NO-VERDICT;
  # V8 14.6's lowercase `generated N nodes.` line is a budget event (the fake node lists both Turbolev flags, default off)
  check "--v8-flags: --turbolev and --turbolev_future are refused by name (exit 2, OUT not created); --no-turbolev passes (SAME)" \
    "$(refusal "$d" 'must not set --turbolev: --turbolev changes which tier --trace-maglev-inlining describes; unsupported' "${A[@]}" --v8-flags=--turbolev --out "$d/o-tl1" "$fk/before.trace" "$fk/same.trace")|$([[ -e "$d/o-tl1" ]] && echo present || echo absent)/$(refusal "$d" 'must not set --turbolev_future: --turbolev changes' "${A[@]}" --v8-flags=--turbolev_future --out "$d/o-tl2" "$fk/before.trace" "$fk/same.trace")/$(refusal "$d" '^VERDICT SAME$' "${A[@]}" --v8-flags=--no-turbolev --out "$d/o-tl3" "$fk/before.trace" "$fk/same.trace")" "2|1|absent/2|1/0|1"
  mkdir -p "$d/tl"; sed 's/default: --no-turbolev"/default: --turbolev"/' "$fk/node" >"$d/tl/node"; chmod +x "$d/tl/node"
  check "Turbolev: a --v8-options default of --turbolev is NO-VERDICT for every tier before any driver spawn (exit 2, raw/ dec/ empty)" \
    "$(refusal "$d" 'Turbolev is on by default in this V8 (--v8-options)' "${A[@]}" --node "$d/tl/node" --out "$d/o-tlon" "$fk/before.trace" "$fk/same.trace")|$(find "$d/o-tlon/raw" "$d/o-tlon/dec" -type f | wc -l | tr -d ' ')" "2|1|0"
  local MLC="${TC/TURBOFAN_JS/MAGLEV}" MLE="${TE/TURBOFAN_JS/MAGLEV}" MLI='== Inlining 0x3 <SharedFunctionInfo l1>' HQI='== Inlining 0x7 <SharedFunctionInfo q>'
  local HTC='[compiling method 0x5 <JSFunction hot (sfi = 0x6)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]'
  local HTE='[completed compiling 0x5 <JSFunction hot (sfi = 0x6)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]'
  printf '%s\n' "$MLC" "$MLI" "$MLI" "$MLE" "$HTC" "$HQI" "$HQI" "$HTE" >"$fk/tf1.trace"
  printf '%s\n' "$MLC" "$MLI" "$MLI" "$MLE" "${HTC/), mode:/) OSR, mode:}" "$HQI" "${HTE/) - took/) OSR - took}" >"$fk/tf2.trace"
  check "Turbolev (fake node): maglev decision lines in TurboFan-tier units (@TF before, @TF-OSR after) are NO-VERDICT and counted, never a DIFF" \
    "$(fkr tfa maglev m0 tf1.trace tf2.trace)|$(grep -cxF '=== maglev: NO-VERDICT -- 6 decision line(s) in TurboFan-tier (@TF) units (Turbolev?)' "$d/fkr-tfa.out" || true)" "2|VERDICT NO-VERDICT||1"
  printf '%s\n' "$MLC" '> generated 13 nodes. regular_budget += 54 ~~> 54' "$MLE" >"$d/lg"
  awk -v tier=maglev -v tag=1 -v dec="$d/lg.dec" -v bud="$d/lg.bud" "$NORMALIZE_AWK" "$d/lg"
  check "maglev: V8 14.6's lowercase '> generated N nodes. regular_budget' line is a budget event of its unit" "$(grep '^B' "$d/lg.bud" | cut -f2-)" "$(printf 'm0@ML\tregular\t54\t54')"

  # b62 G5b rows (audit R2, Q-B57-PIPE, Q-B60-TMPFULL): the bytecode probe reads a regular temp file, appends 64 KiB, removes it
  local bq bs=""
  for bq in "3 5 7 1" "3 5 0 1" "3 0 0 1" "3 0 0 0" "0 0 0 0"; do bc_rc $bq; bs="$bs/$BC_RC"; done
  check "bytecode probe: step precedence awk > tr > append > node" "$bs" "/awk:7/tr:5/append:1/3/0"
  bcr() { # out -> "rc|count of lines matching $2|VERDICT line"; the rest of the argv picks node / env (fake node, both .bc traces)
    local o="$1" pat="$2"; shift 2
    "$@" --tiers turbo --fn read.set --out "$d/o-$o" "$fk/bcb.trace" "$fk/bca.trace" >"$d/bcr-$o.out" 2>&1 && rc2=0 || rc2=$?
    printf '%s|%s|%s' "$rc2" "$(grep -cE -- "$pat" "$d/bcr-$o.out" || true)" "$(grep '^VERDICT ' "$d/bcr-$o.out" || true)"
  }
  mkdir -p "$d/rt/rel"
  check "bytecode probe: a relative TMPDIR names the caller-cwd temp file, read then removed (285 -> 285, 0 left)" \
    "$(cd "$d/rt" && TMPDIR=rel bcr rt '^  read\.set: 285 -> 285 bytes \(\+0\)$' "$BASH" "$SELF" --node "$fk/node")|$(ls "$d/rt/rel" | wc -l | tr -d ' ')" \
    "0|1|VERDICT SAME|0"
  : >"$d/notadir"
  check "bytecode probe: a failed mktemp prints (mktemp exited N) for each side; the verdict is unmoved (SAME)" \
    "$(TMPDIR="$d/notadir" bcr mt '^  read\.set: \(mktemp exited [1-9][0-9]*\) -> \(mktemp exited [1-9][0-9]*\)$' "$BASH" "$SELF" --node "$fk/node")" "0|1|VERDICT SAME"
  check "bytecode probe: ulimit -f 32 (XFSZ ignored) fails the 64 KiB append: (append exited N) for each side, SAME" \
    "$(trap '' XFSZ; ulimit -f 32; bcr ul '^  read\.set: \(append exited [1-9][0-9]*\) -> \(append exited [1-9][0-9]*\)$' "$BASH" "$SELF" --node "$fk/node")" "0|1|VERDICT SAME"
  { printf '%s\n' '#!/bin/sh' 'case " $* " in *" --print-bytecode "*) exit 3 ;; esac'; tail -n +2 "$fk/node"; } >"$fk/node3"; chmod +x "$fk/node3"
  check "bytecode probe: node failing --print-bytecode is a named die (exit 2, one VERDICT NO-VERDICT line)" \
    "$(bcr n3 '^inlining-budget-diff: bytecode probe of read\.set: node exited 3$' "$BASH" "$SELF" --node "$fk/node3")" "2|1|VERDICT NO-VERDICT"

  # --- 2026-10-30 fixes, each from a real node v26.8.2 trace shape -------------------------------------------
  bud() { # canned-trace tag want fn [tier] -> BUDGET_AWK rows for side=before
    awk -v tier="${5:-turbo}" -v tag="$2" -v dec="$d/x.dec" -v bud="$d/x.bud" "$NORMALIZE_AWK" "$d/$1"
    awk -v fn="$4" -v want="$3" -v tfcum=920 -v mgcum=920 -v scale=1.2 -F '\t' "$BUDGET_AWK" side=before "$d/x.bud" side=after "$d/x.bud" \
      | awk -F '\t' '$1 == "before"'
  }
  printf '%s\n' '[compiling method 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]' \
    'Considering 0x3 {0x4 <SharedFunctionInfo t1>} for inlining with 0x5 {0x6 <FeedbackVector[1]>}' \
    'Considering 0x7 {0x8 <SharedFunctionInfo t2>} for inlining with 0x9 {0xa <FeedbackVector[1]>}' \
    'Inlining small function(s) at call site #49:JSCall' \
    'Inlining 0x3 {0x4 <SharedFunctionInfo t1>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    'Inlining 0x7 {0x8 <SharedFunctionInfo t2>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    'Considering 0xb {0xc <SharedFunctionInfo big>} for inlining with 0xd {0xe <FeedbackVector[9]>}' \
    'Budget used: 0/920 -- 1 candidate(s) for inlining:' \
    '- candidate: JSCall node #60 with frequency 1, has_heapnum_param:0, 1 target(s):' \
    '  - target: 0xb {0xc <SharedFunctionInfo big>}, bytecode size: 120' \
    'Inlining 0xb {0xc <SharedFunctionInfo big>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    '[completed compiling 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]' >"$d/poly"
  check "turbo budget: a polymorphic small site (1 marker, 2 Inlining lines) counts BOTH as small" \
    "$(bud poly 1 TF hot | awk -F '\t' '{print $4"/"$5"/"$6"/"$13}')" "3/2/120/ok(+120 after last print)"
  printf '%s\n' '[compiling method 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]' \
    'Considering 0x3 {0x4 <SharedFunctionInfo s>} for inlining with 0x5 {0x6 <FeedbackVector[1]>}' \
    'Inlining small function(s) at call site #12:JSCall' \
    'Not inlining 0x3 {0x4 <SharedFunctionInfo s>} into 0x1 {0x2 <SharedFunctionInfo hot>} because of a test bailout' \
    'Budget used: 0/920 -- 1 candidate(s) for inlining:' \
    '  - target: 0xb {0xc <SharedFunctionInfo x>}, bytecode size: 100' \
    'Inlining 0xb {0xc <SharedFunctionInfo x>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    '[completed compiling 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]' >"$d/leak"
  check "turbo budget: a small marker with no Inlining does not leak into the next regular inline" \
    "$(bud leak 1 TF hot | awk -F '\t' '{print $4"/"$5"/"$6}')" "1/0/100"
  printf '%s\n' '[compiling method 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]' \
    'Budget used: 0/920 -- 3 candidate(s) for inlining:' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo h>}, bytecode size: 454' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo h>}, bytecode size: 454' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo h>}, bytecode size: 454' \
    'Inlining 0x5 {0x6 <SharedFunctionInfo h>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    'Budget used: 454/920 -- 2 candidate(s) for inlining:' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo h>}, bytecode size: 454' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo h>}, bytecode size: 454' \
    '[completed compiling 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]' >"$d/sites"
  check "turbo budget: no node ids -> sites = largest count in one round (3 sites, 1 inlined -> dropped x2)" \
    "$(bud sites 1 TF h | awk -F '\t' '$2 == "hot@TF" {print $4"/"$6"/"$12"/"$13}')" "1/454/h(454,budget?)x2/ok"
  # real node v26.8.2 shape (--max-inlined-bytecode-size-cumulative=300): med inlined at #18; inlining wrap then
  # EXPOSES two new med sites (#178, #169) that are both dropped. Largest-per-round would say 2 sites -> x1.
  printf '%s\n' '[compiling method 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS), mode: ConcurrencyMode::kSynchronous]' \
    'Budget used: 0/300 -- 2 candidate(s) for inlining:' \
    '- candidate: JSCall node #18 with frequency 0.947368, has_heapnum_param:0, 1 target(s):' \
    '  - target: 0x3 {0x4 <SharedFunctionInfo med>}, bytecode size: 131' \
    '- candidate: JSCall node #64 with frequency 0.263158, has_heapnum_param:1, 1 target(s):' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo wrap>}, bytecode size: 80' \
    'Inlining 0x3 {0x4 <SharedFunctionInfo med>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    'Budget used: 131/300 -- 1 candidate(s) for inlining:' \
    '- candidate: JSCall node #64 with frequency 0.263158, has_heapnum_param:1, 1 target(s):' \
    '  - target: 0x5 {0x6 <SharedFunctionInfo wrap>}, bytecode size: 80' \
    'Inlining 0x5 {0x6 <SharedFunctionInfo wrap>} into 0x1 {0x2 <SharedFunctionInfo hot>}' \
    'Budget used: 211/300 -- 2 candidate(s) for inlining:' \
    '- candidate: JSCall node #178 with frequency 0.262118, has_heapnum_param:1, 1 target(s):' \
    '  - target: 0x3 {0x4 <SharedFunctionInfo med>}, bytecode size: 131' \
    '- candidate: JSCall node #169 with frequency 0.262118, has_heapnum_param:0, 1 target(s):' \
    '  - target: 0x3 {0x4 <SharedFunctionInfo med>}, bytecode size: 131' \
    '[completed compiling 0x1 <JSFunction hot (sfi = 0x2)> (target TURBOFAN_JS) - took 0.1, 0.1, 0.1 ms]' >"$d/exposed"
  check "turbo budget: sites counted by node id; sites exposed in a later round count (med: 3 sites, 1 inlined -> x2)" \
    "$(bud exposed 1 TF med | awk -F '\t' '$2 == "hot@TF" {print $4"/"$6"/"$12"/"$13}')" "2/211/med(131,budget?)x2/ok"
  check "turbo budget under --concurrent (unit *): used / model '-' (all compiles merged)" \
    "$(bud t1 0 TF read.set | awk -F '\t' '{print $2"/"$6"/"$12"/"$13}')" "*/-/-/-"
  printf '%s\n' '[compiling method 0x1 <JSFunction hot (sfi = 0x2)> (target MAGLEV), mode: ConcurrencyMode::kSynchronous]' \
    '  greedy inlining 0x3 {0x4 <SharedFunctionInfo s>}: small function, skipping max-depth' \
    '  cannot inline 0x3 {0x4 <SharedFunctionInfo s>}: test rejection' \
    '== Inlining 0x5 <SharedFunctionInfo y>' >"$d/mgleak"
  check "maglev budget: a greedy line rejected by 'cannot inline' does not mark the next inline as small" \
    "$(bud mgleak 1 ML y maglev | awk -F '\t' '$2 == "hot@ML" {print $4"/"$5}')" "1/0"
  printf '%s\n' '  --max-inlined-bytecode-size (maximum size of bytecode for a single inlining)' '        type: int  default: --max-inlined-bytecode-size=460' \
    '  --max-inlined-bytecode-size-small (maximum size of bytecode considered for small function inlining)' '        type: int  default: --max-inlined-bytecode-size-small=30' \
    '  --reserve-inline-budget-scale-factor (scale factor)' '        type: float  default: --reserve-inline-budget-scale-factor=1.2' \
    '  --max-maglev-eager-inlined-bytecode-size (maximum size of bytecode considered for eager inlining)' \
    '        type: int  default: --max-maglev-eager-inlined-bytecode-size=30' >"$d/opts-new"
  sed -E 's/default: --[a-z0-9-]+=/default: /' "$d/opts-new" >"$d/opts-old"
  check "limits: node 26 'default: --flag=value' format (incl. the Maglev eager limit)" "$(awk "$LIMITS_AWK" "$d/opts-new" | tr '\n' ' ')" \
    "max-inlined-bytecode-size=460 max-inlined-bytecode-size-small=30 reserve-inline-budget-scale-factor=1.2 max-maglev-eager-inlined-bytecode-size=30 "
  check "limits: older 'default: value' format gives the same values" "$(awk "$LIMITS_AWK" "$d/opts-old" | tr '\n' ' ')" \
    "max-inlined-bytecode-size=460 max-inlined-bytecode-size-small=30 reserve-inline-budget-scale-factor=1.2 max-maglev-eager-inlined-bytecode-size=30 "
  : >"$d/empty.ms"; printf '      1 *\tInlining 0x {0x <SharedFunctionInfo f>} into 0x {0x <SharedFunctionInfo g>}\n' >"$d/one-line.ms"
  check "multiset diff: an EMPTY first file still reads as before=0 (FILENAME, not FNR == NR)" \
    "$(awk "$MSDIFF_AWK" "$d/empty.ms" "$d/one-line.ms" | cut -c1-21)" "  before=0 after=1  I"
  printf '%s\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' 'Bytecode length: 106' \
    '[generated bytecode for function: f (0x2 <SharedFunctionInfo f>)]' 'Bytecode length: 35' \
    '[generated bytecode for function: f (0x3 <SharedFunctionInfo f>)]' 'Bytecode length: 210' \
    '[generated bytecode for function: f (0x4 <SharedFunctionInfo f>)]' 'Bytecode length: 106' >"$d/bc2"
  # (for-in order printed 210,106,35 here on BSD awk: the order of the SET, not of the input)
  check "bytecode probe: same-name functions -> first-seen order, no duplicates" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc2")" "106,35,210"
  # Q-B62-TEAR / -TEAR2: the two tear shapes measured on node v26.8.2 (a driver Worker's newlines inside the probe text) + digits then junk
  printf '%s\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' 'Bytecode length: 3' \
    '[generated bytecode for function: ' 'f (' '0x2 <SharedFunctionInfo f>)]' 'Bytecode length: 50' >"$d/bc-hdr"
  check "bytecode probe: a header split by a newline (not whole) -> ?" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-hdr")" "?"
  printf '%s\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' 'Bytecode length: 3' \
    '[generated bytecode for function: f (0x2 <SharedFunctionInfo f>)]' 'Bytecode length: ' '50' >"$d/bc-len"
  check "bytecode probe: a length line split before its digits -> ?" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-len")" "?"
  printf '%s\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' 'Bytecode length: 5w' >"$d/bc-junk"
  check "bytecode probe: digits then junk on a length line -> ?" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-junk")" "?"
  printf '%s\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' \
    '[generated bytecode for function: f (0x2 <SharedFunctionInfo f>)]' 'Bytecode length: 5' >"$d/bc-pend"
  check "bytecode probe: a header with no length before the next header -> ?" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-pend")" "?"
  printf '%s\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' 'Bytecode length: 3' \
    '[generated bytecode for function: f (0x2 <SharedFunctionInfo f>)]' >"$d/bc-eof"
  check "bytecode probe: a header with no length before EOF -> ?" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-eof")" "?"
  printf '%s\n' '[generated bytecode for function:  (0x1 <SharedFunctionInfo>)]' 'Bytecode length: 7' \
    '[generated bytecode for function: f (0x2 <SharedFunctionInfo f>)]' 'Bytecode length: 106' >"$d/bc-anon"
  check "bytecode probe: an anonymous function's header (empty name) is whole, not torn" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-anon")" "106"
  printf '%s\r\n' '[generated bytecode for function: f (0x1 <SharedFunctionInfo f>)]' 'Bytecode length: 5' >"$d/bc-cr"
  check "bytecode probe: a CR-terminated length line still reads (as before the tear rules)" "$(awk -v fn=f "$BYTECODE_AWK" "$d/bc-cr")" "5"
  rm -rf "$d"; echo
  if [[ $fails -eq 0 && $oks -gt 0 ]]; then echo "self-test: $oks check(s) ok"; return 0; fi
  echo "self-test: $((fails > 0 ? fails : 1)) check(s) FAILED"; return 1
}

# ---------------------------------------------------------------------------------------------
# options
# ---------------------------------------------------------------------------------------------
FNS="${ME:-m0}"; RUNS=3; TIERS="turbo,maglev"; ONLY=0; CONCURRENT=0; DRIVER=""; REPO=""
NODE_BIN="${NODE:-node}"; V8FLAGS=""; OUT="${OUTDIR:-}"; BYTECODE=1
BEFORE_REF=""; AFTER_REF=""; BEFORE_FILE=""; AFTER_FILE=""; POS=(); GOTOPT=" "; SELFTEST=0
OPTS="--fn --runs --tiers --node --v8-flags --out --self-test --help --only-fn --concurrent --no-bytecode --before-ref --after-ref --before --after --driver --repo"
hint() { local o; for o in $OPTS; do if [[ "$o" == "$1"* || "$1" == "$o"* ]]; then printf ' (did you mean %s?)' "$o"; return 0; fi; done; }
need() { # value from --opt=value (returns 0) or from the next argument (returns 1: caller shifts)
  if [[ -n "$v" ]]; then return 0; fi
  [[ $# -ge 2 ]] || die "$a needs a value"
  v="$2"; return 1
}
while [[ $# -gt 0 ]]; do
  a="$1"; v=""; EQ=0
  case "$a" in --*=*) v="${a#*=}"; a="${a%%=*}"; EQ=1 ;; esac
  case "$a" in
    -h|--help) [[ $EQ -eq 0 ]] || die "$a takes no value"; usage; exit 2 ;;
    --self-test) [[ $EQ -eq 0 ]] || die "$a takes no value"; SELFTEST=1 ;;
    --only-fn) [[ $EQ -eq 0 ]] || die "$a takes no value"; ONLY=1 ;;
    --concurrent) [[ $EQ -eq 0 ]] || die "$a takes no value"; CONCURRENT=1 ;;
    --no-bytecode) [[ $EQ -eq 0 ]] || die "$a takes no value"; BYTECODE=0 ;;
    --fn|--runs|--tiers|--driver|--repo|--node|--v8-flags|--out|--before-ref|--after-ref|--before|--after)
      [[ "$GOTOPT" != *" $a "* ]] || die "$a given twice (give one comma list)"
      GOTOPT="$GOTOPT $a "
      if [[ $EQ -eq 0 ]] && ! need "$@"; then shift; fi
      [[ -n "$v" ]] || die "$a needs a non-empty value"
      case "$a" in
        --fn) FNS="$v" ;; --runs) RUNS="$v" ;; --tiers) TIERS="$v" ;; --driver) DRIVER="$v" ;;
        --repo) REPO="$v" ;; --node) NODE_BIN="$v" ;; --v8-flags) V8FLAGS="$v" ;; --out) OUT="$v" ;;
        --before-ref) BEFORE_REF="$v" ;; --after-ref) AFTER_REF="$v" ;;
        --before) BEFORE_FILE="$v" ;; --after) AFTER_FILE="$v" ;;
      esac ;;
    --*) die "unknown option $a$(hint "$a") (see --help)" ;;
    *) POS+=("$a") ;;
  esac
  shift
done
[[ $SELFTEST == 0 ]] || { [[ -z "${GOTOPT// /}" && ${#POS[@]} -eq 0 && $ONLY$CONCURRENT$BYTECODE == 001 ]] || die "--self-test takes no other argument"; if self_test; then FINAL=1; exit 0; else FINAL=1; exit 1; fi; }

# a value that starts with - must never reach a tool as an option; the ./ form names the same file (--out and the path options, then POS)
for x in BEFORE_FILE AFTER_FILE DRIVER REPO OUT; do [[ ${!x} != -* ]] || printf -v "$x" './%s' "${!x}"; done
for ((i = 0; i < ${#POS[@]}; i++)); do [[ ${POS[$i]} != -* ]] || POS[$i]="./${POS[$i]}"; done

[[ "$FNS$TIERS$V8FLAGS$OUT$NODE_BIN$DRIVER$BEFORE_FILE$AFTER_FILE$REPO${POS[*]-}" != *$'\n'* ]] \
  || die "--fn / --tiers / --v8-flags / --out / --node / --driver / --before / --after / --repo / driver paths: a newline is not allowed"
IFS=', ' read -r -a TARGETS <<<"$FNS"
[[ ${#TARGETS[@]} -gt 0 ]] || die "--fn is empty"
SEEN="|"
for t in "${TARGETS[@]}"; do
  [[ "$t" =~ ^[A-Za-z_\$][A-Za-z0-9_\$.]*$ ]] || die "--fn must name NAMED functions (e.g. m0, read.set), got '$t'"
  [[ "$SEEN" != *"|$t|"* ]] || die "fn '$t' is given twice"
  SEEN="$SEEN$t|"
done
[[ "$RUNS" =~ ^[0-9]{1,2}$ ]] && RUNS=$((10#$RUNS)) && [[ $RUNS -ge 2 && $RUNS -le 50 ]] \
  || die "--runs must be an integer in [2, 50] (null control), got '$RUNS'"
IFS=', ' read -r -a TIER_LIST <<<"$TIERS"
[[ ${#TIER_LIST[@]} -gt 0 ]] || die "--tiers is empty"
SEEN="|"
for t in "${TIER_LIST[@]}"; do
  [[ $t == turbo || $t == maglev ]] || die "unknown tier '$t' (turbo, maglev)"
  [[ "$SEEN" != *"|$t|"* ]] || die "tier '$t' is given twice"
  SEEN="$SEEN$t|"
done
read -r -a V8_EXTRA <<<"$V8FLAGS" || true
[[ -z "$V8FLAGS" || ${#V8_EXTRA[@]} -gt 0 ]] || die "--v8-flags needs at least one flag, got only blanks"
for f in ${V8_EXTRA[@]+"${V8_EXTRA[@]}"}; do
  [[ "$f" == --[A-Za-z]* ]] || die "--v8-flags takes flags only (each starts with -- and a letter), got '$f'"
  g="${f//_/-}"; g="${g#--}"; g="${g%%=*}"; g="${g#no}"; g="${g#-}"
  case "$g" in
    *stress-concurrent-inlining*)
      die "--v8-flags must not set $f: --stress-concurrent-inlining implies --concurrent-recompilation in V8, which overrides the script's --no-concurrent-recompilation (a background compile makes the inlining trace a race; every spelling of the flag is refused)" ;;
    max*inlined*bytecode*)
      [[ "$f" =~ ^--[^=]+=[0-9]{1,9}$ && "${f:2:2}" != no ]] || die "--v8-flags: $f needs =N (an integer of 1..9 digits)" ;;
    reserve*inline*budget*)
      [[ "$f" =~ ^--[^=]+=[0-9]{1,9}(\.[0-9]{1,9})?$ && "${f:2:2}" != no ]] || die "--v8-flags: $f needs =X (a decimal number, e.g. 1.2)" ;;
  esac
done
NODE_RES=$NODE_BIN
if [[ "$NODE_BIN" != */* ]]; then NODE_RES=$(command -v -- "$NODE_BIN" 2>/dev/null) || die "node binary not found: $NODE_BIN"; fi
[[ "$NODE_RES" == */* ]] || die "node binary is not a file on PATH (a function, alias or builtin?): $NODE_BIN -> $NODE_RES"
[[ -f "$NODE_RES" && -x "$NODE_RES" ]] || die "node binary is not an executable file: $NODE_RES"
NODE_DIR=$(dirname -- "$NODE_RES"); [[ "$NODE_DIR" != - ]] || NODE_DIR=./-
NODE_DIR=$(cd -- "$NODE_DIR" 2>/dev/null && pwd) || die "node binary: cannot resolve the directory of $NODE_RES"
NODE_BIN="${NODE_DIR%/}/$(basename -- "$NODE_RES")"
[[ "$NODE_BIN" -ef "$NODE_RES" ]] || die "node binary is not an executable file: $NODE_RES"
[[ "$NODE_BIN" != *$'\n'* ]] || die "node binary: a newline is not allowed in the resolved path"
[[ "$NODE_BIN" != *=* ]] || die "node binary: an = is not allowed in the resolved path (env would read it as a NAME=value operand, not as the program): $NODE_BIN"

# ---------------------------------------------------------------------------------------------
# stage BEFORE / AFTER
# ---------------------------------------------------------------------------------------------
OUT="${OUT:-${TMPDIR:-/tmp}/inl-diff-$(date +%Y%m%d-%H%M%S)-$$}"
[[ "$OUT" != *\\* && ( "$OUT" == /* || "$PWD" != *\\* ) ]] || die "--out: a backslash is not allowed in DIR or, for a relative DIR, in the current directory (awk -v would rewrite the path): $OUT"
for sub in raw dec bud ms stage; do
  [[ ! -L "$OUT/$sub" ]] || die "--out: $OUT/$sub is a symlink (refused: the writes would follow it)"
  if [[ -e "$OUT/$sub" ]]; then
    [[ -d "$OUT/$sub" && -r "$OUT/$sub" && -w "$OUT/$sub" && -x "$OUT/$sub" ]] || die "--out: $OUT/$sub is not a readable, writable directory"
    n=$(ls -A -- "$OUT/$sub") || die "--out: cannot list $OUT/$sub"
    [[ -z "$n" ]] || die "--out: $OUT/$sub is not empty (give a new or empty DIR)"
  fi
done
OUT_UP="$OUT"; while [[ ! -e "$OUT_UP" && ! -L "$OUT_UP" && "$OUT_UP" != . ]]; do OUT_UP=$(dirname -- "$OUT_UP"); done
[[ -d "$OUT_UP" && -w "$OUT_UP" && -x "$OUT_UP" ]] || die "--out: cannot create $OUT ($OUT_UP is not a writable directory)"
[[ ! -L "$OUT/report.txt" ]] || die "--out: $OUT/report.txt is a symlink (refused: the write would follow it)"
[[ ! -e "$OUT/report.txt" || ( -f "$OUT/report.txt" && -w "$OUT/report.txt" ) ]] || die "--out: cannot write $OUT/report.txt"
[[ ! -f "$OUT/report.txt" ]] || { RL=$(find "$OUT/report.txt" -links +1 2>/dev/null) && [[ -z "$RL" ]]; } || die "--out: $OUT/report.txt has another hard link (refused: the write would change that file too)"
# G-X6 (ruling Q-B66-X6): every path the report prints, refused before the first spawn or write if it holds a newline or a
# CR (it would forge report lines): the cwd, --node, the drivers and the name --out resolves to (nl_refuse, nl_dir)
nl_refuse "the cwd" "$PWD"
nl_refuse "--node (resolved)" "$NODE_BIN"
nl_refuse "DRIVER (resolved)" ${POS[@]+"${POS[@]}"}
for f in ${POS[@]+"${POS[@]}"}; do nl_dir "DRIVER (resolved)" "$(dirname -- "$f")"; done
nl_dir "--out (resolved)" "$OUT"
[[ -z "$BEFORE_FILE$AFTER_FILE" ]] || nl_refuse "--before / --after / --driver (resolved)" "$BEFORE_FILE" "$AFTER_FILE"   # file mode prints them (Q-B68-IBDCR)
# node version + the --v8-flags allowlist: after the read-only preflight, before the first write. The preflight refuses a
# bad --out with 0 spawns; a path only mkdir can see through (ENAMETOOLONG) still takes these 2 spawns (LEDGER #76)
NODE_V=$(env -u NODE_OPTIONS "$NODE_BIN" -p 'process.version + " (V8 " + process.versions.v8 + ")"') || die "cannot run $NODE_BIN -p"
v8fl_check "$NODE_BIN"
# Turbolev on the command line (Q-RL-TURBO 1): exact names only, every =value form too; --no-turbolev* and the other
# *turbolev-* tuning flags (--max-turbolev-inline-depth=N, ...) pass. After v8fl_check, before the first write.
for f in ${V8_EXTRA[@]+"${V8_EXTRA[@]}"}; do
  g="${f//_/-}"
  case "$g" in
    --turbolev|--turbolev=*|--turbolev-future|--turbolev-future=*)
      die "--v8-flags must not set $f: --turbolev changes which tier --trace-maglev-inlining describes; unsupported" ;;
  esac
done
mkdir -p "$OUT"/raw "$OUT"/dec "$OUT"/bud "$OUT"/ms "$OUT"/stage 2>/dev/null || die "--out: cannot create $OUT/raw .. $OUT/stage"
OUT=$(cd "$OUT" && pwd) || die "--out: cannot resolve $OUT"
nl_refuse "--out (resolved)" "$OUT"   # backstop (G-X6): a name the pre-spawn replay could not foresee
REPORT="$OUT/report.txt"; { : >"$REPORT"; } 2>/dev/null || die "--out: cannot write $REPORT"

DEFAULT_DRIVER="// inline-diff default driver: signal read / set / peek, computed, effect, batch hot paths.
import { signal, computed, effect, batch } from './Signal.js';
const a = signal(0), b = signal(1);
const c = computed(() => a() + b());
const d = computed(() => c() * 2);
const sink = new Int32Array(1);
effect(() => { sink[0] = (sink[0] + d()) | 0; });
function step(i) {
    a.set(i);
    b.set(i ^ 1);
    batch(() => { a.set(i + 1); b.set(i); });
    return (a.peek() + c.peek() + d()) | 0;
}
let acc = 0;
for (let i = 0; i < 300000; i++) acc = (acc + step(i)) | 0;
if (acc === 7 && sink[0] === 7) console.log('');
"

write_driver() { # dir
  if [[ -n "$DRIVER" ]]; then
    [[ -f "$DRIVER" ]] || die "--driver not found: $DRIVER"
    # a comment or a plain mention of the name must not pass: comments are stripped, then import / from / require must lead the
    # quoted name on its line (lib/stage.sh's check, STAGE_IMP=./Signal.js)
    STAGE_IMP=./Signal.js awk '
      BEGIN { q[1] = "\047" ENVIRON["STAGE_IMP"] "\047"; q[2] = "\"" ENVIRON["STAGE_IMP"] "\"" }
      { s = $0; o = ""
        while (s != "") {
          if (inb) { i = index(s, "*/"); if (!i) { s = ""; break }; s = substr(s, i + 2); inb = 0; continue }
          i = index(s, "/*"); j = index(s, "//")
          if (j && (!i || j < i)) { o = o substr(s, 1, j - 1); s = ""; break }
          if (!i) { o = o s; s = ""; break }
          o = o substr(s, 1, i - 1); s = substr(s, i + 2); inb = 1
        }
        for (k = 1; k <= 2; k++) { i = index(o, q[k]); if (i && substr(o, 1, i - 1) ~ /(^|[^A-Za-z0-9_$.])(import|from|require)[ \t]*\(?[ \t]*$/) found = 1 }
      }
      END { exit !found }' <"$DRIVER" || die "--driver must import './Signal.js'"
    cp "$DRIVER" "$1/driver.mjs"
  else
    printf '%s' "$DEFAULT_DRIVER" >"$1/driver.mjs"
  fi
}

DESC_B=""; DESC_A=""; STAGED=1
if [[ -n "$BEFORE_REF$AFTER_REF$BEFORE_FILE$AFTER_FILE" ]]; then
  [[ -z "${GIT_DIR+x}${GIT_WORK_TREE+x}${GIT_INDEX_FILE+x}${GIT_OBJECT_DIRECTORY+x}${GIT_COMMON_DIR+x}${GIT_CEILING_DIRECTORIES+x}" ]] || die "GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES is set: unset it (ref / file mode finds each repo from its path)"
fi
if [[ -n "$BEFORE_REF$AFTER_REF" ]]; then
  [[ -n "$BEFORE_REF" && -n "$AFTER_REF" ]] || die "--before-ref and --after-ref go together"
  [[ ${#POS[@]} -eq 0 && -z "$BEFORE_FILE$AFTER_FILE" ]] || die "ref mode takes no driver paths / --before / --after"
  REPO="${REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
  [[ -n "$REPO" ]] || die "ref mode: not inside a git repo (use --repo)"
  for side in before after; do
    if [[ $side == before ]]; then ref="$BEFORE_REF"; else ref="$AFTER_REF"; fi
    sha=$(git -C "$REPO" rev-parse --short --verify --quiet "$ref^{commit}") || die "unknown git ref '$ref' in $REPO (git fetch origin $ref?)"
    dir="$OUT/stage/$side"; mkdir -p "$dir"
    git -C "$REPO" show "$sha:Signal.js" >"$dir/Signal.js" 2>/dev/null || die "$ref has no Signal.js"
    if git -C "$REPO" cat-file -e "$sha:Watch.js" 2>/dev/null; then git -C "$REPO" show "$sha:Watch.js" >"$dir/Watch.js"; fi
    write_driver "$dir"
    d="$ref @ $sha  Signal.js sha256/8 $(sha8 "$dir/Signal.js")"
    if [[ $side == before ]]; then DESC_B="$d"; else DESC_A="$d"; fi
  done
  DRV_B="$OUT/stage/before/driver.mjs"; DRV_A="$OUT/stage/after/driver.mjs"
elif [[ -n "$BEFORE_FILE$AFTER_FILE" ]]; then
  [[ -n "$BEFORE_FILE" && -n "$AFTER_FILE" ]] || die "--before and --after go together"
  [[ ${#POS[@]} -eq 0 ]] || die "file mode takes no driver paths"
  command -v git >/dev/null 2>&1 || die "file mode needs git to check that --before is a frozen copy (or use --before-ref)"
  [[ -f "$BEFORE_FILE" ]] || die "--before not found: $BEFORE_FILE"
  [[ -f "$AFTER_FILE" ]] || die "--after not found: $AFTER_FILE"
  refuse_live "$BEFORE_FILE" "--before"
  if [[ -f "$(dirname "$BEFORE_FILE")/Watch.js" ]]; then refuse_live "$(dirname "$BEFORE_FILE")/Watch.js" "the Watch.js beside --before"; fi
  [[ ! "$BEFORE_FILE" -ef "$AFTER_FILE" ]] || die "--before and --after are the same file (hard link / symlink): --before must be a FROZEN copy"
  for side in before after; do
    if [[ $side == before ]]; then f="$BEFORE_FILE"; else f="$AFTER_FILE"; fi
    [[ -f "$f" ]] || die "--$side not found: $f"
    dir="$OUT/stage/$side"; mkdir -p "$dir"
    cp -- "$f" "$dir/Signal.js"     # the copy IS the freeze: edits to $f during the run cannot leak in
    w="$(dirname -- "$f")/Watch.js"
    if [[ -f "$w" ]]; then cp -- "$w" "$dir/Watch.js"
    elif grep -qE "['\"]\./Watch\.js['\"]" "$dir/Signal.js"; then die "no Watch.js beside $f (Signal.js re-exports it)"; fi
    write_driver "$dir"
    d="$f  sha256/8 $(sha8 "$dir/Signal.js")"
    if [[ $side == before ]]; then DESC_B="$d"; else DESC_A="$d"; fi
  done
  DRV_B="$OUT/stage/before/driver.mjs"; DRV_A="$OUT/stage/after/driver.mjs"
else
  STAGED=0
  [[ ${#POS[@]} -eq 2 ]] || { usage >&2; die "need DRIVER_BEFORE DRIVER_AFTER, --before-ref/--after-ref, or --before/--after"; }
  for f in "${POS[@]}"; do [[ -f "$f" ]] || die "driver not found: $f"; done
  DRV_B=$(cd "$(dirname "${POS[0]}")" && pwd)/$(basename "${POS[0]}")
  DRV_A=$(cd "$(dirname "${POS[1]}")" && pwd)/$(basename "${POS[1]}")
  [[ "$DRV_B" -ef "${POS[0]}" ]] || die "DRIVER_BEFORE: cannot resolve the directory of ${POS[0]} (a symlink before '..'?)"
  [[ "$DRV_A" -ef "${POS[1]}" ]] || die "DRIVER_AFTER: cannot resolve the directory of ${POS[1]} (a symlink before '..'?)"
  DESC_B="$DRV_B  sha256/8 $(sha8 "$DRV_B")"; DESC_A="$DRV_A  sha256/8 $(sha8 "$DRV_A")"
fi
nl_refuse "DRIVER (resolved)" "$DRV_B" "$DRV_A"   # backstop (G-X6)

# ---------------------------------------------------------------------------------------------
# limits (from this node binary, then --v8-flags overrides)
# ---------------------------------------------------------------------------------------------
LIMITS=$(env -u NODE_OPTIONS -u NODE_COMPILE_CACHE "$NODE_BIN" --v8-options 2>/dev/null | awk "$LIMITS_AWK") || die "cannot run $NODE_BIN --v8-options"
for f in ${V8_EXTRA[@]+"${V8_EXTRA[@]}"}; do
  case "$f" in --max*inlined*bytecode*=*|--reserve*inline*budget*=*)
    f="${f#--}"; f="${f//_/-}"; LIMITS=$(printf '%s\n%s\n' "$LIMITS" "$f") ;;
  esac
done
# lim VAR KEY DEFAULT: VAR = this binary's value (or the last --v8-flags override). A limit the binary does not
# report falls back to the node 26 default and is listed in ASSUMED, which the report prints as a NOTE.
ASSUMED=""
lim() {
  local v
  v=$(printf '%s\n' "$LIMITS" | awk -F= -v k="$2" '$1 == k { v = $2 } END { print v }')
  if [[ -z "$v" ]]; then v="$3"; ASSUMED="$ASSUMED $2=$3"; fi
  printf -v "$1" '%s' "$v"   # bash >= 3.1, so macOS /bin/bash 3.2 too
}
lim TF_SMALL max-inlined-bytecode-size-small 30; lim TF_SMALL_HN max-inlined-bytecode-size-small-with-heapnum-in-out 75
lim TF_ONE max-inlined-bytecode-size 460; lim TF_CUM max-inlined-bytecode-size-cumulative 920
lim SCALE reserve-inline-budget-scale-factor 1.2
lim MG_SMALL max-maglev-inlined-bytecode-size-small 27; lim MG_ONE max-maglev-inlined-bytecode-size 100
lim MG_EAGER max-maglev-eager-inlined-bytecode-size 30
lim MG_CUM max-maglev-inlined-bytecode-size-cumulative 920
# Turbolev on by default (Q-RL-TURBO 2): every tier NO-VERDICT before any driver spawn; a row other than on / off fails closed
if [[ $'\n'"$LIMITS"$'\n' == *$'\n'turbolev=* ]]; then
  [[ $'\n'"$LIMITS"$'\n' != *$'\n'turbolev=on$'\n'* ]] || die "Turbolev is on by default in this V8 (--v8-options): --trace-maglev-inlining may describe TurboFan-tier units; every tier is NO-VERDICT"
  [[ $'\n'"$LIMITS"$'\n' == *$'\n'turbolev=off$'\n'* ]] || die "cannot read the --turbolev default in --v8-options: every tier is NO-VERDICT"
fi

# ---------------------------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------------------------
TAG=1; [[ $CONCURRENT == 1 ]] && TAG=0   # concurrent compiles interleave: unit attribution is off
run_trace() { # tier side k driver
  local flag glue b raw="$OUT/raw/$1.$2.$3.txt"
  if [[ $1 == turbo ]]; then flag=--trace-turbo-inlining; else flag=--trace-maglev-inlining; fi
  local -a cmd=("$NODE_BIN" ${V8_EXTRA[@]+"${V8_EXTRA[@]}"} --trace-opt "$flag")
  [[ $CONCURRENT == 1 ]] || cmd+=(--no-concurrent-recompilation)
  b=$(basename "$4"); [[ $b != -* ]] || b="./$b"
  cmd+=("$b")
  if ! (cd "$(dirname "$4")" && env -u NODE_OPTIONS "${cmd[@]}") >"$raw" 2>&1; then
    tail -n 20 "$raw" >&2
    die "driver exited non-zero: ${cmd[*]} (in $(dirname "$4"); trace in $raw)"
  fi
  if [[ $TAG == 1 ]]; then
    glue=$(tr '\000' '?' <"$raw" | awk "$GLUE_AWK") || die "cannot scan $raw for driver output glued to a V8 compile line"
    [[ "$glue" != concurrent ]] || die "background compile (--no-concurrent-recompilation overridden by a V8 flag implication): a [compiling method .. ConcurrencyMode::kConcurrent] line in $raw (a compile off the main thread makes the inlining trace a race)"
    [[ "$glue" == clean ]] || die "driver output glued to a V8 compile line ($raw): end driver writes with a newline"
  fi
  tr '\000' '?' <"$raw" | awk -v tier="$1" -v tag="$TAG" -v dec="$OUT/dec/$1.$2.$3.tsv" -v bud="$OUT/bud/$1.$2.$3.tsv" "$NORMALIZE_AWK"
  touch "$OUT/dec/$1.$2.$3.tsv" "$OUT/bud/$1.$2.$3.tsv"
}

# judge TIER KEY FN: multiset per run (FN empty = all lines), null control, then before vs after
judge() {
  local tier=$1 key=$2 fn=$3 v="" why="" shown="" side k nb na n label
  for k in $(seq 1 "$RUNS"); do
    for side in before after; do
      awk -v fn="$fn" -v only="$([[ -n $fn ]] && echo 1 || echo 0)" "$SCOPE_AWK" "$OUT/dec/$tier.$side.$k.tsv" \
        | multiset >"$OUT/ms/$key.$tier.$side.$k.txt"
    done
  done
  nb=$(awk '{s += $1} END {print s + 0}' "$OUT/ms/$key.$tier.before.1.txt")
  na=$(awk '{s += $1} END {print s + 0}' "$OUT/ms/$key.$tier.after.1.txt")
  for side in before after; do
    for k in $(seq 2 "$RUNS"); do
      if [[ -z "$v" ]] && ! cmp -s "$OUT/ms/$key.$tier.$side.1.txt" "$OUT/ms/$key.$tier.$side.$k.txt"; then
        v=NO-VERDICT; why="null control: $side run 1 vs $side run $k differ (tier-up noise on this host)"
        shown=$(awk "$MSDIFF_AWK" "$OUT/ms/$key.$tier.$side.1.txt" "$OUT/ms/$key.$tier.$side.$k.txt" | sort -k3)
      fi
    done
  done
  if [[ -z "$v" ]]; then
    shown=$(awk "$MSDIFF_AWK" "$OUT/ms/$key.$tier.before.1.txt" "$OUT/ms/$key.$tier.after.1.txt" | sort -k3)
    if [[ -z "$shown" ]]; then v=SAME; why="identical multiset"
    else v=DIFF; why="$(printf '%s\n' "$shown" | wc -l | tr -d ' ') line(s) differ"; fi
  fi
  if [[ -n $fn ]]; then label="$fn (--only-fn)"; else label="all decision lines"; fi
  say "  $label: $v -- $why  (lines before/after run 1: $nb/$na)"
  : >"$OUT/$key.$tier.diff.txt"
  if [[ -n "$shown" ]]; then
    printf '%s\n' "$shown" >"$OUT/$key.$tier.diff.txt"
    printf '%s\n' "$shown" | awk 'NR <= 60' | tee -a "$REPORT"
    n=$(printf '%s\n' "$shown" | wc -l | tr -d ' ')
    if [[ $n -gt 60 ]]; then say "  ... $((n - 60)) more in $OUT/$key.$tier.diff.txt"; fi
  fi
  VERDICT=$(worst "$VERDICT" "$v")
}

say "inlining-budget-diff  node $NODE_V  $NODE_BIN  (same binary both sides, NODE_OPTIONS, NODE_V8_COVERAGE, NODE_COMPILE_CACHE, NODE_REDIRECT_WARNINGS stripped)"
say "before  $DESC_B"
say "after   $DESC_A"
if [[ $STAGED == 1 ]] && cmp -s "$DRV_B" "$DRV_A" && cmp -s "$(dirname "$DRV_B")/Signal.js" "$(dirname "$DRV_A")/Signal.js"; then
  say "NOTE    before and after are byte-identical: this run is a null control (expect SAME)"
fi
say "fn ${TARGETS[*]}  runs $RUNS  tiers ${TIER_LIST[*]}  scope $([[ $ONLY == 1 ]] && echo "--only-fn (lines naming fn / compiled in fn)" || echo "all decision lines (guarded on fn)")"
say "v8 flags ${V8FLAGS:+$V8FLAGS }--trace-opt <trace flag>$([[ $CONCURRENT == 1 ]] || echo ' --no-concurrent-recompilation')"
say "limits  TurboFan small<=$TF_SMALL (<=$TF_SMALL_HN if a HeapNumber may cross) single<=$TF_ONE cumulative $TF_CUM (reserve x$SCALE) | Maglev eager (greedy small)<$MG_EAGER small<=$MG_SMALL single<$MG_ONE cumulative $MG_CUM"
if [[ -n "$ASSUMED" ]]; then
  say "NOTE    limits not reported by this node binary, ASSUMED (node 26 defaults; REPORTED lines may be wrong):$ASSUMED"
fi
say "out     $OUT"
say ""

VERDICT=SAME
for tier in "${TIER_LIST[@]}"; do
  for k in $(seq 1 "$RUNS"); do   # interleaved, so slow drift on the host hits both sides alike
    run_trace "$tier" before "$k" "$DRV_B"
    run_trace "$tier" after "$k" "$DRV_A"
  done

  if [[ ! -s "$OUT/dec/$tier.before.1.tsv" && ! -s "$OUT/dec/$tier.after.1.tsv" ]]; then
    hint=""; [[ $tier == maglev ]] && hint=" (node <= 22 does not run Maglev by default: use --tiers turbo)"
    say "=== $tier: NO-VERDICT -- the trace has no inlining decisions at all$hint"
    VERDICT=NO-VERDICT; say ""; continue
  fi
  # Turbolev (Q-RL-TURBO 3): a TurboFan-tier unit in a maglev trace means --trace-maglev-inlining described a TF compile
  if [[ $tier == maglev && $TAG == 1 ]]; then
    ntf=$(awk -F '\t' '$1 ~ /@TF(-OSR)?(#[0-9]+)?$/ { n++ } END { print n + 0 }' "$OUT"/dec/maglev.*.tsv) \
      || die "cannot scan $OUT/dec for TurboFan-tier units in the maglev trace"
    if [[ $ntf != 0 ]]; then
      say "=== maglev: NO-VERDICT -- $ntf decision line(s) in TurboFan-tier (@TF) units (Turbolev?)"
      VERDICT=NO-VERDICT; say ""; continue
    fi
  fi

  say "=== $tier"
  # guard: every run must carry evidence about each fn
  guarded=""
  for fn in "${TARGETS[@]}"; do
    g=ok
    for k in $(seq 1 "$RUNS"); do
      for side in before after; do
        if [[ $g == ok ]] && ! awk -v fn="$fn" "$GUARD_AWK" "$OUT/dec/$tier.$side.$k.tsv" \
          && ! awk -F '\t' -v fn="$fn" -v t="@$([[ $tier == turbo ]] && echo TF || echo ML)" "$DONE_AWK" "$OUT/bud/$tier.$side.$k.tsv"; then
          g="$side run $k"
        fi
      done
    done
    if [[ $g == ok ]]; then guarded="$guarded $fn"
    else say "  $fn: NO-VERDICT -- no trace of $fn in $g (no decision line names it, no completed $tier compile of it: no evidence)"; VERDICT=NO-VERDICT; fi
  done
  if [[ $ONLY == 1 ]]; then
    for fn in $guarded; do judge "$tier" "$fn" "$fn"; done
  elif [[ -n "$guarded" ]]; then
    say "  guard ok:${guarded}"
    judge "$tier" all ""
  fi

  # ---- budget report (REPORTED, run 1) ----------------------------------------------------
  say "  --- budget, run 1 (REPORTED, not gated)"
  : >"$OUT/budget.$tier.tsv"
  for fn in "${TARGETS[@]}"; do
    awk -F '\t' -v fn="$fn" -v want="$([[ $tier == turbo ]] && echo TF || echo ML)" -v tfcum="$TF_CUM" -v mgcum="$MG_CUM" \
      -v scale="$SCALE" "$BUDGET_AWK" side=before "$OUT/bud/$tier.before.1.tsv" side=after "$OUT/bud/$tier.after.1.tsv" \
      | awk -v fn="$fn" '{ print fn "\t" $0 }' >>"$OUT/budget.$tier.tsv"
  done
  for fn in "${TARGETS[@]}"; do
    rows=$(awk -F '\t' -v fn="$fn" '$1 == fn && $4 == 1' "$OUT/budget.$tier.tsv")
    if [[ -z "$rows" ]]; then say "  $fn: no compile unit involves $fn"; continue; fi
    say "  $fn: units that compile $fn or decide about it   (inl N [small], used = bytes charged, rej = rejected)"
    printf '%s\n' "$rows" | awk -F '\t' -v tier="$tier" '
      { u = $3; if (!(u in seen)) { seen[u] = 1; ord[++n] = u }
        if (tier == "turbo") s = sprintf("inl %d [%d]  used %s/%s (last printed %s)  rej %d  model %s", $5, $6, $7, $10, $8, $11, $14)
        else s = sprintf("inl %d [%d]  regular %s/%s  small %s  rej %d  exhausted %d", $5, $6, $7, $10, $9, $11, $12)
        txt[$2, u] = s; dr[$2, u] = $13 }
      END { for (i = 1; i <= n; i++) { u = ord[i]
              b = ((("before", u) in txt) ? txt["before", u] : "(not compiled as a unit)")
              a = ((("after", u) in txt) ? txt["after", u] : "(not compiled as a unit)")
              printf "    %-24s before: %s\n    %-24s after:  %s\n", u, b, "", a
              if (!(("before", u) in dr)) dr["before", u] = "-"
              if (!(("after", u) in dr)) dr["after", u] = "-"
              if (tier == "turbo" && (dr["before", u] != "-" || dr["after", u] != "-"))
                printf "    %-24s dropped (size[+existing],why): before %s | after %s\n", "", dr["before", u], dr["after", u] } }' \
      | tee -a "$REPORT"
  done
  if grep -q 'MISMATCH' "$OUT/budget.$tier.tsv"; then
    say "  NOTE budget model MISMATCH (see budget.$tier.tsv): V8 printed more than the summed inline sizes (REPORTED; verdict unaffected)"
  fi
  if [[ $tier == maglev ]] && ! grep -q '^B' "$OUT/bud/maglev.before.1.tsv" "$OUT/bud/maglev.after.1.tsv" 2>/dev/null; then
    say "  (no Maglev budget counter in run 1 (V8 14.6 prints them only for non-eager inlining): regular/small show '-'; sizes and limits below still apply)"
  fi
  say ""
done

# ---------------------------------------------------------------------------------------------
# bytecode lengths of each fn vs the limits (REPORTED)
# ---------------------------------------------------------------------------------------------
if [[ $BYTECODE == 1 ]]; then
  say "=== bytecode length (REPORTED: --print-bytecode, exact name; several values = several functions with that name)"
  probe() { # driver fn -> "<status> <lengths>"; status = node's exit, or <step>:<rc> (bc_rc; mktemp:<rc> when no file was made)
    local b; b=$(basename "$1"); [[ $b != -* ]] || b="./$b"
    local tmp line st nrc=0 ar=0 re='^@ ([0-9]+) ([0-9]+) ([0-9]+)$'
    # stdout is a regular file, never a pipe (Q-B57-PIPE): once JS touches process.stdout, libuv makes a pipe non-blocking and
    # V8's C++ writes to a full pipe are dropped (EAGAIN), so a length vanishes while the run still ends cleanly. probe runs in
    # $( ), where bash clears set -e outside posix mode: every step below carries its own guard. The redirect sits on the
    # OUTER subshell, ahead of the cd, so a relative TMPDIR still names the same file
    tmp=$(mktemp "${TMPDIR:-/tmp}/inlining-budget-diff.XXXXXX") || { printf 'mktemp:%s \n' "$?"; return 0; }
    (cd "$(dirname "$1")" && env -u NODE_OPTIONS "$NODE_BIN" ${V8_EXTRA[@]+"${V8_EXTRA[@]}"} --print-bytecode \
      --print-bytecode-filter="$2" "$b") >"$tmp" 2>&1 || nrc=$?
    line=$(tr '\000' '?' <"$tmp" | awk -v fn="$2" "$BYTECODE_AWK"; printf '@ %s %s\n' "$nrc" "${PIPESTATUS[*]}")
    # the file has been read: 64 KiB more fails if TMPDIR is still full now (Q-B60-TMPFULL). The brace silences a
    # redirect-open failure too; an inline 2>/dev/null comes after the >> and would not
    { printf '%65536s' '' >>"$tmp"; } 2>/dev/null || ar=$?
    rm -f "$tmp" || true
    # the exits ride on a last "@ node tr awk" line, so a tr / awk failure is never reported as node's
    st=${line##*$'\n'}
    if [[ "$line" == *$'\n'* ]]; then line=${line%$'\n'*}; else line=""; fi
    [[ "$st" =~ $re ]] || die "bytecode probe of $2: cannot read the exit status of the run of $1 (got '$st')"
    bc_rc "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "$ar"
    printf '%s %s\n' "$BC_RC" "$line"
  }
  cross() { # name op limit before after
    local b=$4 a=$5 ib ia
    if [[ $2 == "<=" ]]; then ib=$((b <= 10#$3)); ia=$((a <= 10#$3)); else ib=$((b < 10#$3)); ia=$((a < 10#$3)); fi
    if [[ $ib != "$ia" ]]; then printf '      CROSSES %s (%s%s): %s -> %s\n' "$1" "$2" "$3" \
      "$([[ $ib == 1 ]] && echo inside || echo outside)" "$([[ $ia == 1 ]] && echo inside || echo outside)"; fi
  }
  bc_side() { # fn "<status> <lengths>" -> BC_SIDE: the lengths, or "(<step> exited N)" for a failed mktemp / append (that
    # side is not measured; REPORTED, the verdict is unmoved). A node / tr / awk failure is a named die, here in the main shell
    local s=${2%% *}
    BC_SIDE=${2#* }
    case $s in
      0) ;;
      mktemp:*|append:*) BC_SIDE="(${s%%:*} exited ${s#*:})" ;;
      *:*) die "bytecode probe of $1: ${s%%:*} exited ${s#*:}" ;;
      *) die "bytecode probe of $1: node exited $s" ;;
    esac
  }
  for fn in "${TARGETS[@]}"; do
    b=$(probe "$DRV_B" "$fn"); bc_side "$fn" "$b"; b=$BC_SIDE
    a=$(probe "$DRV_A" "$fn"); bc_side "$fn" "$a"; a=$BC_SIDE
    if [[ "$b" =~ ^[0-9]+$ && "$a" =~ ^[0-9]+$ ]]; then
      say "  $fn: $b -> $a bytes ($( [[ $a -ge $b ]] && echo + )$((a - b)))"
      {
        cross "TurboFan small" "<=" "$TF_SMALL" "$b" "$a"
        cross "TurboFan small where a HeapNumber may cross the call" "<=" "$TF_SMALL_HN" "$b" "$a"
        cross "TurboFan single-inline limit" "<=" "$TF_ONE" "$b" "$a"
        # Maglev's "greedy inlining ... small function" follows the EAGER limit (<30), not ...-size-small (27)
        cross "Maglev eager (greedy small) limit" "<" "$MG_EAGER" "$b" "$a"
        cross "Maglev single-inline limit" "<" "$MG_ONE" "$b" "$a"
      } | tee -a "$REPORT"
    else
      say "  $fn: ${b:-not compiled} -> ${a:-not compiled}"
    fi
  done
  say ""
fi

say "VERDICT $VERDICT"
FINAL=1
case "$VERDICT" in SAME) exit 0 ;; DIFF) exit 1 ;; *) exit 2 ;; esac
