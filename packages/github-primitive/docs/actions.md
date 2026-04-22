# GitHub Primitive Actions

All actions use the same adapter request layer, so local and cloud runtimes have
the same behavior after runtime selection.

## Repository

- `listRepos`: lists repositories visible to the authenticated user.
- `getRepo`: fetches a repository by owner and name.

## Issues

- `listIssues`: lists true issues and filters out pull request entries returned
  by the GitHub issues endpoint.
- `createIssue`: creates an issue.
- `updateIssue`: updates title, body, state, assignee, or labels.
- `closeIssue`: closes an issue with the same PATCH path used by
  `updateIssue`.

## Pull Requests

- `listPRs`: lists pull requests.
- `getPR`: fetches one pull request.
- `createPR`: creates a pull request.
- `updatePR`: updates title, body, state, base branch, or maintainer edit access.
- `mergePR`: merges a pull request and then fetches the refreshed pull request.

## Files

- `listFiles`: lists directory contents, or returns a single file as a one-item
  list.
- `readFile`: decodes base64 file content from the GitHub contents API.
- `createFile`: creates a file with a commit message.
- `updateFile`: updates a file by SHA with a commit message.
- `deleteFile`: deletes a file by SHA with a commit message.

## Branches And Commits

- `listBranches`: lists repository branches.
- `createBranch`: creates a branch from `fromBranch` or the repository default
  branch.
- `listCommits`: lists commits with optional filters.
- `createCommit`: creates a Git commit object without moving refs.

## Identity

- `getUser`: fetches the authenticated user, or a public user by username.
- `listOrganizations`: lists organizations for the authenticated user, or for a
  public user.
