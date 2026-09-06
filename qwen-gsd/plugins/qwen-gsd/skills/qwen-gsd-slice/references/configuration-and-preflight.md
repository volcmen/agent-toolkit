# Configuration and preflight

Read this before every Qwen GSD slice.

## Configuration layers

Each layer overrides the preceding layer:

1. `config/defaults.json` in this skill.
2. `~/.qwen-gsd/config.json`, or the path in `QWEN_GSD_CONFIG`.
3. `QWEN_GSD_<KEY>` environment variables.
4. One-run `qwen_slice.sh` flags.

Committed defaults are `wall_time=45m`, `max_tool_calls=200`, `max_turns=80`,
`max_subagent_depth=1`, `safe_mode=true`, `sandbox=false`,
`model_check=true`, `state_dir=~/.qwen-gsd`, plus economy warning thresholds.
Unknown configuration keys and invalid boolean values are hard errors.

Inspect the effective values and their sources:

```bash
python3 "$QGS_ROOT/scripts/qwen_config.py" show
```

Change persistent preferences in the user config rather than repeating flags.
Raise a budget only for a genuinely larger slice, and disclose the change.

## Model selection traps

Qwen Code 0.21.10 can accept an unknown model id, fall back to its own default,
exit successfully, and bill the wrong model. The wrapper therefore validates
the id against configured providers before launch and checks the `init` event
afterward. `--no-model-check` is only for a deliberate model absent from local
settings.

Provider ids can be ambiguous across plans. A provider `envKey` must exist in
`settings.env` or the process environment. List the locally configured ids:

```bash
python3 "$QGS_ROOT/scripts/qwen_model_check.py" --list
```

Resolve ambiguity by provider plan and confirm the actual `init.model`. Choose
models from measured ledger cost on comparable slices; the cheapest advertised
tier can cost more when retries and larger system prompts dominate.

## Required preflight

Run once before scoping:

```bash
qwen --version
python3 "$QGS_ROOT/scripts/qwen_model_check.py" --list
brief_file="$(mktemp)"
printf 'Reply with exactly: OK\n' > "$brief_file"
"$QGS_ROOT/scripts/qwen_slice.sh" \
  --prompt-file "$brief_file" --model <configured-id> --phase preflight \
  --wall-time 2m --max-tool-calls 0
```

Delete the temporary prompt after the command. Continue only on
`exit_code=0` with `result=success is_error=False`. Report the effective
budgets and classified failure when preflight aborts.

