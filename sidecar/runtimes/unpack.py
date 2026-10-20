"""Extract already verified source archives into an owned staging directory."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath


def unpack(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        files = source.infolist()
        if sum(f.file_size for f in files) > 512 * 1024 * 1024:
            raise ValueError("Source archive exceeds the extraction budget")
        roots = set()
        for f in files:
            path = PurePosixPath(f.filename)
            if path.is_absolute() or any(p in ("..", ".") or ":" in p or "\\" in p for p in path.parts):
                raise ValueError(f"Unsafe archive path: {f.filename}")
            if f.external_attr >> 16 & 0o170000 == 0o120000:
                raise ValueError(f"Archive contains a symlink: {f.filename}")
            roots.add(path.parts[0])
        if len(roots) != 1:
            raise ValueError("Expected one source archive root")
        for f in files:
            parts = PurePosixPath(f.filename).parts[1:]
            if not parts:
                continue
            target = destination.joinpath(*parts)
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError(f"Archive path escapes destination: {f.filename}")
            if f.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(f) as src, target.open("wb") as dest:
                    shutil.copyfileobj(src, dest)


def main() -> None:
    recipe_path, stage = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    for i, item in enumerate(recipe["sources"]):
        source, destination = stage / "downloads" / str(i), stage / item["path"]
        if item["zip"]:
            unpack(source, destination)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    if prepare := recipe.get("prepare"):
        script = recipe_path.parent.parent / prepare["script"]
        subprocess.run([sys.executable, str(script), str(stage / prepare["source"])], check=True)
    shutil.rmtree(stage / "downloads")


if __name__ == "__main__":
    main()
