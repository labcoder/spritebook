# Preparing a release

A version tag starts candidate builds; it does not sign the app or publish a GitHub Release with
downloads. Keep build evidence, artifact publication and native platform claims separate.

## 1. Prepare the version

Check existing tags before choosing a pre-1.0 version. Update the product version together in:

- `package.json` and its root package-lock entry;
- `apps/studio/package.json` and its package-lock entry;
- `apps/studio/src-tauri/tauri.conf.json`;
- `apps/studio/src-tauri/Cargo.toml` and its Cargo-lock package entry;
- `packages/cli/version.ts`.

Update the changelog with user-visible changes and known limits. Check installer/runtime notices and
dependency terms in the [BOM](dependencies.md). Leave `RENDERER_VERSION` alone unless pixels change;
[versioning](versioning.md) defines its separate cache contract. Schema and model-recipe versions
also move independently.

## 2. Check the exact source

Run formatting, lint, type checks and relevant behavior tests. For broad releases run the full suite
and native ownership tests. Check import, generation failure/retry, rig review, walking and jumping,
Look preview, Bake, export and reopening using disposable copies of real projects. For destructive
project deletion, verify original inputs and unrelated files survive and that active jobs prevent
deletion.

For the Windows preview, exercise the packaged app, not only `dev:desktop`. Use a writable path with
spaces and non-ASCII characters, check setup recovery/cancellation, and preserve the last usable
asset across failures. Record machine, adapter, driver, source revision and limits outside the
application repository. Signing, clean-machine prerequisites and native accessibility remain
separate requirements for a wider distribution claim.

## 3. Build and tag

From a clean `main`, after the version changes are committed:

```sh
git tag -a v0.x.0 -m "SpriteBook 0.x.0 Windows preview"
git push origin main
git push origin v0.x.0
```

Replace `0.x.0` with the prepared version. The
[release-candidates workflow](../../.github/workflows/release.yml) checks the tag against the CLI
version. It can also run manually against a chosen ref before tagging:

```sh
gh workflow run release.yml --ref main
```

Keep the tag on the commit that produced the reviewed artifacts. A fix after tagging needs a new
version; do not silently move a published tag.

## 4. Inspect and publish artifacts

Require green [source CI](../../.github/workflows/ci.yml) and candidate builds for the exact commit.
The candidate workflow uploads:

| Artifact                      | Contents                                    |
| ----------------------------- | ------------------------------------------- |
| `candidate-windows-installer` | Windows x64 NSIS installer                  |
| `candidate-win32-x64`         | Windows portable CLI and smoke report       |
| `candidate-linux-x64`         | Linux portable CLI and smoke reports        |
| `candidate-darwin-arm64`      | Apple Silicon portable CLI and smoke report |
| `candidate-darwin-x64`        | Intel Mac portable CLI and smoke report     |

Attach the selected installer/runtime archives and checksums to an explicit GitHub prerelease when
ready. Confirm that the README's download links resolve without access to a private checkout. An
Actions artifact is not a permanent public download, and a tag alone attaches no assets.

Describe the release as a Windows preview until the other native desktop/model targets pass their
own checks. Hosted build success and Linux software rendering do not establish consumer GPU,
downloaded-model or native desktop support on those platforms. Link the current
[platform support](../platform-support.md) and motion limitations from the release notes.
