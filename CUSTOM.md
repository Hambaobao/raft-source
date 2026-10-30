# Internal branch workflow

This fork keeps upstream release snapshots and internal changes separate:

- `main` tracks `botiverse/raft-source`. Do not add internal fixes there.
- `custom` is the stable branch used by internal deployments.
- Start each fix or feature on a new branch from `custom`, and merge it back through a pull request after validation.
- Bring upstream releases into `main` first, then review a `main` → `custom` pull request. Preserve upstream ancestry when merging these updates; do not squash the upstream synchronization.
- Feature fixes may use squash merge into `custom`. Do not force-push or rebase the shared stable branch.

The initial `custom` baseline is `v1.21.23-source.1` (`db5e399f017d584e49597e3a28757645d6807893`).

[raft-selfhost](https://github.com/Hambaobao/raft-selfhost) pins an exact validated `custom` commit in both its `vendor/raft-source` submodule and `versions.env`. Updating this branch does not automatically update a running deployment. Source updates, image builds and deployment changes remain explicit and reviewable.

The first internal fix preserves the live launch identity when editing an Agent's profile. It does not reconstruct identities already lost before the fix or change the handling of runtime resets. See [issue #1](https://github.com/Hambaobao/raft-source/issues/1).
