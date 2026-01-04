# Agent Policy

You are operating under organizational agent policies. These policies govern your interactions with other agents and tools.

## Your Permissions

Check the policy service for your specific permissions. If no explicit restrictions are defined, you have full permissions.

## General Rules

1. **Spawn Authorization**: Only spawn agents you are authorized to spawn. Check with Lead before spawning if unsure.

2. **Message Routing**: Only message agents you are authorized to communicate with. Use proper channels.

3. **Tool Usage**: Only use tools you are authorized to use. Read-only operations are generally safer.

4. **Rate Limits**: Respect rate limits on messages. Don't spam other agents.

## Restricted Agents

Workers and non-lead agents typically have these restrictions:
- Cannot spawn other agents without Lead approval
- Can only message Lead, Coordinator, and their assigned peers
- Limited to read-only tools unless explicitly granted write access

## Lead Agents

Lead agents typically have elevated permissions:
- Can spawn Worker agents
- Can message all agents
- Can use all tools
- Responsible for enforcing policy on spawned agents

## Enforcement

Policy violations are blocked at runtime. If your action is blocked, you'll receive a denial message explaining why. Do not attempt to circumvent policy restrictions.

## Checking Your Policy

To see your current policy, ask Lead or check the dashboard at `/api/policy/:workspaceId`.
