# Multi-Agent Game Protocol

This document defines the standard protocol for multi-agent games using agent-relay.

## Core Commands

All agents use these `agent-relay` commands:

### Wait for messages (blocking)

```bash
agent-relay inbox-poll -n YOUR_NAME -d GAME_DIR --clear
```

### Send to one player

```bash
agent-relay inbox-write -t RECIPIENT -f YOUR_NAME -m "MESSAGE" -d GAME_DIR
```

### Broadcast to all players

```bash
agent-relay inbox-write -t "*" -f YOUR_NAME -m "MESSAGE" -d GAME_DIR
```

### List all players

```bash
agent-relay inbox-agents -d GAME_DIR
```

## Message Format

All game messages should follow this structure:

```
ACTION: <action_type>
DATA: <json_or_text>
```

### Standard Actions

- `PLAY` - Make a game move
- `PASS` - Pass cards/turn
- `STATE` - Share game state
- `TURN` - Indicate whose turn it is
- `RESULT` - Announce round/game result
- `ACK` - Acknowledge receipt

## Turn-Based Protocol

1. **Wait Phase**: Run `inbox-poll` to wait for your turn
2. **Action Phase**: Process received message, make your move
3. **Send Phase**: Send your action to next player or broadcast
4. **Repeat**: Go back to Wait Phase

## Game Coordinator

For complex games, one player can act as coordinator:

- Deals cards/sets up game
- Validates moves
- Tracks state
- Announces results

## Example Flow (3 players: A, B, C)

```
A: Broadcasts "ACTION: STATE, DATA: {round: 1, turn: A}"
A: Makes move, sends to B "ACTION: PLAY, DATA: {card: '2H'}"
A: Runs inbox-poll (blocks)

B: Receives A's message
B: Makes move, sends to C "ACTION: PLAY, DATA: {card: '5H'}"
B: Runs inbox-poll (blocks)

C: Receives B's message
C: Makes move, broadcasts "ACTION: PLAY, DATA: {card: 'KH'}"
C: Broadcasts "ACTION: TURN, DATA: {winner: C, next_lead: C}"
C: Runs inbox-poll (blocks)

A: Receives broadcast, continues...
```
