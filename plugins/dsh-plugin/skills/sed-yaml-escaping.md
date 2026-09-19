# sed/YAML escaping: the edit trap

**The symptom**: you `read` a file, see `\.` in a sed line; later a section re-read shows `\\.`; your `edit` with either form fails to match, and you burn turns reconciling them.

**The truth**: the read tool is byte-faithful — it does NOT escape or unescape. When you see different backslash counts, either you are looking at *different lines that legitimately differ* (sed match patterns and their replacements CAN carry different counts — `\.[0-9]` in the match, `\\1` in the replacement is correct sed), or you misread your own earlier observation. One agent spent measurable minutes on this exact spiral (transcript 32726524403); its conclusion is the rule:

## The rule

For lines where backslashes are load-bearing (sed programs, regex in YAML, `printf` formats):

1. **Don't `edit` them. Use bash to do the change** — `python3 - <<'EOF'` with a raw-string match, or `sed` itself:
   ```bash
   python3 - <<'EOF'
   import pathlib
   p = pathlib.Path("file.yml"); s = p.read_text()
   s = s.replace(r'literal\old\line', r'literal\new\line')  # raw strings: what you see is the bytes
   p.write_text(s)
   EOF
   ```
2. Python raw strings (`r'...'`) are exact byte literals — no escaping ambiguity in YOUR tooling either.
3. After the change, verify with `grep -F` (fixed-string) or `cat -v` (shows non-printing bytes) — not by re-reading and counting backslashes.

## YAML-adjacent traps in the same lines

- Unquoted `:` inside a `run:` value breaks the whole workflow file (parse-fatal; every dispatch 422s). Quote the value: `run: 'echo "..."'`.
- An indentation slip inside `steps:` escapes the step list entirely. After ANY workflow-file edit: `actionlint <file> && python3 -c "import yaml; yaml.safe_load(open('<file>'))"` before committing.
