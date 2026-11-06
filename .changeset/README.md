# Changesets

This directory contains the unreleased changes for CleanStack. Changesets drive
semantic versioning and generate `CHANGELOG.md`.

## Adding a changeset

Create one for any user-visible change before opening a pull request:

```sh
npm run changeset
```

Choose the release type for `cleanstack-generator`:

- `patch` for backwards-compatible fixes
- `minor` for backwards-compatible features
- `major` for breaking changes

Write the summary for users, not for reviewers. It becomes the changelog entry.

Commit the generated `.changeset/*.md` file with the change. The release
workflow opens a version pull request that bumps `package.json` and updates
`CHANGELOG.md`; merging that pull request publishes the package and creates the
GitHub release.

See the [Changesets documentation](https://changesets.dev) for details.
