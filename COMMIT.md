# Commit & Pull Request Guidelines

Use Conventional Commits, matching the current history:

- `feat:` new features or user-visible functionality
- `fix:` bug fixes
- `docs:` documentation or content changes
- `refactor:` code restructuring without behavior changes
- `perf:` performance improvements
- `chore:` dependencies, configuration, build, generated maintenance
- `test:` test-related changes

## Commit Workflow

Treat the working tree, staging area, commit history, and remote repository as separate stages:

1. Inspect the working tree before committing:
   - `git status`
   - `git diff`
   - `git diff --cached` when staged changes exist

2. Group changes by logical purpose, not simply by file or directory.
   - Related changes across multiple files should normally be committed together.
   - Unrelated changes must be split into separate commits.
   - Do not create one commit per file unless each file represents an independent logical change.

3. Prefer selective staging:
   - Use `git add <file-or-directory>` for focused changes.
   - Do not use `git add .` by default.
   - Use `git add -p` when a single file contains multiple unrelated logical changes.

4. Each commit should represent one clear, self-contained logical change.
   - Commit messages must describe the actual change.
   - Avoid vague messages such as `update`, `modify`, `changes`, `fix stuff`, or `today's changes`.
   - Do not write a commit message merely to make the GitHub file list look cleaner.

5. Keep unrelated working-tree changes untouched.
   - If unrelated modifications already exist, do not include them in the current commit unless explicitly requested.
   - Do not revert, overwrite, or delete unrelated user changes.

6. Multiple focused commits may be pushed together with a single `git push`.
   - `git push` synchronizes the local commit history with the remote repository; it does not require one push per commit.

## Example

If a task updates icons, adds a post, and fixes a build script, prefer:

```bash
git add public/
git commit -m "feat: update icons with separate light and dark variants"

git add src/
git commit -m "docs: add Markdown format test post"

git add scripts/
git commit -m "fix: correct build script"
```
Do not run `git push` unless the user explicitly asks for the changes to be pushed.