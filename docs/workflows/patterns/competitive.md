# Competitive Pattern

Multiple agents independently implement solutions to the same problem, then a judge compares outputs and selects the best approach.

## When to Use

- **Exploratory problems** where multiple valid solutions exist
- **High-stakes decisions** that benefit from diverse approaches
- **Innovation challenges** where fresh perspectives help
- **Architecture decisions** with significant trade-offs
- **Spike work** to evaluate different technologies

## Structure

```
      ┌─────────────────────────────────────┐
      │           Define Spec               │
      │           (Lead)                    │
      └───────────────┬─────────────────────┘
                      │
     ┌────────────────┼────────────────┐
     │                │                │
     ▼                ▼                ▼
┌─────────┐    ┌─────────┐    ┌─────────┐
│ Team A  │    │ Team B  │    │ Team C  │
│ Impl    │    │ Impl    │    │ Impl    │
└────┬────┘    └────┬────┘    └────┬────┘
     │              │              │
     │    ┌─────────┼─────────┐    │
     │    │         │         │    │
     └────┼─────────┴─────────┼────┘
          │                   │
          ▼                   ▼
      ┌─────────────────────────────────────┐
      │         Compare Solutions           │
      │         (Lead)                      │
      └───────────────┬─────────────────────┘
                      │
                      ▼
      ┌─────────────────────────────────────┐
      │         Select Winner               │
      │         (Lead)                      │
      └─────────────────────────────────────┘
```

## Key Characteristics

- **Isolation**: Teams work independently without seeing each other's approach
- **Diversity**: Different CLIs/models encourage varied solutions
- **Objectivity**: Judge evaluates based on predefined rubric
- **Synthesis**: Winner selection can combine best elements from multiple solutions

## Configuration

```yaml
swarm:
  pattern: competitive
  maxConcurrency: 4
  timeoutMs: 5400000

agents:
  - name: lead
    cli: claude
    role: "Defines spec, judges implementations, selects winner"
  - name: team-alpha
    cli: claude
    role: "Independent implementation team"
  - name: team-beta
    cli: codex
    role: "Independent implementation team"
  - name: team-gamma
    cli: gemini
    role: "Independent implementation team"

coordination:
  barriers:
    - name: implementations-complete
      waitFor: [implement-alpha, implement-beta, implement-gamma]
      timeoutMs: 3600000
```

## Workflow Steps

1. **define-spec** — Lead defines requirements and evaluation criteria
2. **implement-*** — Teams build solutions in parallel, isolated from each other
3. **compare-solutions** — Lead reviews all outputs against rubric
4. **select-winner** — Lead chooses best solution or synthesizes hybrid

## Best Practices

- **Clear rubric**: Define evaluation criteria upfront (performance, maintainability, simplicity)
- **Team diversity**: Use different CLIs/models to encourage varied approaches
- **Strict isolation**: Teams must not see each other's work until comparison
- **Time boxing**: Set appropriate timeouts to prevent runaway implementations
- **Synthesis option**: Consider combining best elements rather than picking one winner

## Variations

### Two-Team Competitive
Simpler variant with only two competing teams:
```yaml
agents:
  - name: lead
    cli: claude
  - name: team-alpha
    cli: claude
  - name: team-beta
    cli: codex
```

### Iterative Competitive
Multiple rounds where losing teams can improve:
```yaml
workflows:
  - name: round-one
    steps: [define-spec, implement-alpha, implement-beta, compare]
  - name: round-two
    steps: [feedback, re-implement, final-compare, select-winner]
```

### Hybrid Selection
Instead of selecting one winner, synthesize the best parts:
```yaml
steps:
  - name: select-winner
    agent: lead
    task: |
      Create a hybrid solution combining:
      - Architecture from the most scalable approach
      - Implementation details from the cleanest code
      - Edge case handling from the most thorough solution
```

## Example Use Cases

- **API Design**: Three teams propose different API structures
- **Algorithm Selection**: Compare performance of different approaches
- **Framework Evaluation**: Build same feature with different frameworks
- **Refactoring Strategy**: Multiple approaches to restructure legacy code
