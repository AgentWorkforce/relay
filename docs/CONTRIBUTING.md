# Contributing to agent-relay

Thank you for your interest in contributing to agent-relay! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Node.js >= 18 (20+ recommended)
- npm
- macOS or Linux (Windows support is not currently tested)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/khaliqgant/agent-relay.git
cd agent-relay

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Start development mode (watch for changes)
npm run dev
```

### Project Structure

```
agent-relay/
├── src/
│   ├── cli/           # CLI commands (start, wrap, send, etc.)
│   ├── daemon/        # Relay daemon and message router
│   ├── wrapper/       # PTY wrapper and message parsing
│   ├── supervisor/    # Spawn-per-message agent supervisor
│   ├── games/         # Game engines (Hearts, Tic-tac-toe)
│   └── utils/         # Utilities (name generator, etc.)
├── examples/          # Usage examples
├── dist/              # Compiled output
└── tests/             # Test files
```

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/khaliqgant/agent-relay/issues)
2. If not, create a new issue with:
   - Clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - Your environment (OS, Node version)
   - Relevant logs or error messages

### Suggesting Features

1. Check existing issues and discussions first
2. Open a new issue with the "feature request" label
3. Describe the use case and proposed solution

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Ensure tests pass: `npm test`
5. Ensure linting passes: `npm run lint`
6. Commit with a descriptive message
7. Push to your fork
8. Open a Pull Request

### Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation as needed
- Follow existing code style
- Write clear commit messages

## Code Style

- TypeScript with strict mode
- Use ESLint configuration provided
- Prefer async/await over callbacks
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Example

```typescript
/**
 * Send a message to another agent.
 * @param recipient - Target agent name or '*' for broadcast
 * @param body - Message content
 * @param type - Message type (default: 'message')
 * @returns true if message was sent successfully
 */
sendMessage(recipient: string, body: string, type?: MessageType): boolean {
  // Implementation
}
```

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run specific test file
npm test -- src/wrapper/parser.test.ts
```

### Writing Tests

- Place tests next to source files (`.test.ts`) or in `tests/`
- Use descriptive test names
- Test both success and failure cases
- Mock external dependencies

## Documentation

- Update README.md for user-facing changes
- Add JSDoc comments for new public APIs
- Update examples if adding new features
- Keep `docs/PROTOCOL.md` updated for protocol changes

## Release Process

1. Update version in `package.json`
2. Update `docs/CHANGELOG.md`
3. Create a GitHub release
4. npm publish is automated via GitHub Actions

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues and documentation first
- Be respectful and constructive in discussions

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
