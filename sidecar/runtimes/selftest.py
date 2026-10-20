"""CPU-only checks of source archive and preparation trust boundaries."""
import hashlib
import tempfile
import zipfile
from pathlib import Path

from prepare_trellis2 import read
from unpack import unpack

with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    archive = root / "source.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("upstream/a.py", b"source bytes")
    unpack(archive, root / "valid")
    assert (root / "valid/a.py").read_bytes() == b"source bytes"
    assert read(root / "valid", "a.py", hashlib.sha256(b"source bytes").hexdigest()) == "source bytes"
    try:
        read(root / "valid", "a.py", "0" * 64)
        raise AssertionError("Modified upstream source was accepted")
    except ValueError:
        pass
    link = zipfile.ZipInfo("upstream/link")
    link.create_system = 3
    link.external_attr = 0o120777 << 16
    backslash = zipfile.ZipInfo("upstream/backslash")
    backslash.filename = "upstream/..\\..\\escape"
    for bad in ("upstream/../../escape", "upstream/C:/escape", backslash, link):
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("upstream/good.py", b"must not be extracted")
            z.writestr(bad, b"outside")
        destination = root / "unsafe"
        try:
            unpack(archive, destination)
            raise AssertionError(f"Unsafe source accepted: {bad}")
        except ValueError:
            pass
        assert not destination.exists(), "Validation must finish before extracting any file"
    assert not (root / "escape").exists()
print("PASS: verified source, changed hash, archive traversal and symlink refusal")
