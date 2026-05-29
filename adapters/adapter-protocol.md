# Swarm Adapter Protocol

## How Non-Claude Agents Participate

Any LLM can join a swarm by following this protocol:

### Loop

```
while True:
    git pull                      # get latest state
    state = read .swarm/ files    # parse YAML
    prompt = format_as_prompt(state)  # build system prompt
    response = call_llm(prompt)   # ask the LLM
    actions = parse_actions(response) # look for ##SWARM:ACTION## markers
    apply_actions(actions)        # write YAML files
    git push                      # share changes
    sleep(interval)
```

### Action Markers

The LLM embeds these markers in its response text:

```
##SWARM:CLAIM:task-uuid##          — claim a task
##SWARM:DONE:task-uuid:result##    — complete a task with result
##SWARM:MSG:agent-uuid:text##      — send direct message
##SWARM:BROADCAST:text##           — broadcast to team
##SWARM:STATUS:working|idle##      — update status
```

### Writing a New Adapter

1. Copy `codex-wrapper.py` as template
2. Replace `call_openai()` with your API call
3. Set provider name, API key env var, model name
4. Run: `python your-wrapper.py --swarm-root /path/to/repo --name "YourAgent" --capabilities skill1,skill2`

### File Format

All `.swarm/` files use simple YAML (scalars, lists, flat maps). The Python YAML parser in the adapters handles this subset — no PyYAML dependency needed.

### Credit Exhaustion

When your API returns 429 or quota error:
1. Set agent status to `credits_exhausted`
2. Broadcast alert to team
3. Wait 5 minutes and retry (or exit)

Other agents will automatically reassign your tasks.
