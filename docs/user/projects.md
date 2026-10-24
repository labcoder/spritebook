# Projects and files

A character project is a workspace folder containing `character.json` and the assets SpriteBook
creates for that character. A projects root is a folder containing those workspaces. The gallery
lists the characters under the selected root; opening a character adds it to the editing list.

## Open and close

Choose a projects root in the gallery, then select a character. The character index lets you switch
between opened characters. Closing an entry, including with its close control or Delete key, closes
the editor tab and keeps files on disk.

## Delete a project

Right-click a character in the index or a gallery card and choose **Delete project…**, or use **Edit
→ Delete project…** for the active character. The command palette also offers this action. The
confirmation names the project and explains what it removes. **Cancel** has initial focus.

Deletion permanently removes SpriteBook's generated meshes, textures, rig/animation artifacts,
motion-review drafts, bakes, workspace-local exports and caches, preparation derivatives, manifest
and editing history. It has no undo. Keep a complete backup if you may need to resume editing.

Deletion preserves:

- the external original input and content-addressed original copies, including previous inputs
  recorded in history;
- files SpriteBook does not recognize as its generated output;
- exports outside the workspace;
- installed models, runtimes and extensions.

The source folder and small lock files can remain afterward. A small
`source/.spritebook-originals.json` index retains only validated original-file hashes, including
historical inputs, so a cleanup retry can preserve them after journal removal; it stores no external
paths. SpriteBook removes the manifest last, so a failed cleanup remains visible and can be retried.
A running job blocks deletion: finish or cancel it first. A partial failure can already have removed
generated files, so retrying cleanup does not restore them.

The CLI requires the exact character ID as confirmation:

```sh
spritebook delete --workspace ./characters/hero --confirm hero
```

This command is separate from closing a character tab and from uninstalling a model.

## What belongs where

| Location                 | Contents                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Character workspace      | Source copies, generation results, accepted mesh revisions, rig/animation data, bakes and workspace-local exports |
| Projects root            | Character folders and any shared project model/animation pins                                                     |
| Machine application data | Installed model weights, prepared Python/CUDA runtimes and optional tools                                         |
| Export destination       | Delivered spritesheets, engine metadata and optional GLB/textures                                                 |

SpriteBook retains the original reference in its content-addressed source store so background
removal and other preparation do not replace it. The external file you selected stays at its
original location. Model installations are shared machine data; deleting a character does not
uninstall them.

## Back up or move a character

Finish or cancel the character's jobs, then close the app before copying the complete workspace.
Keep canonical revisions and journal files with `character.json`; copying only the selected GLB does
not preserve editing history. If the project uses a shared `pins.json`, retain it at the same parent
level. Installed model files and external program paths remain machine-specific.

An export is a delivery artifact, not a complete project backup. It contains the selected bake or
model, with the metadata needed by its target format. To protect shipped game assets, export to a
directory separate from the character workspace.
