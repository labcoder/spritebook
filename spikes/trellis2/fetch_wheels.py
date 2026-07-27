"""
Fetch the vendored CUDA extension wheels and verify them against the lock.

The lock is the pin. These are community builds by a single maintainer, pulled
from a raw.githubusercontent URL that can move under us at any time, so we check
the bytes we got against the bytes we recorded and REFUSE on a mismatch rather
than install something we have not seen.

    python fetch_wheels.py            # fetch missing, verify all
    python fetch_wheels.py --verify   # verify only, never download

Exit 0 means every wheel in the lock is present and matches.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = os.path.join(HERE, 'wheels', 'wheels.lock.json')


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify', action='store_true', help='never download')
    args = ap.parse_args()

    lock = json.load(open(LOCK, encoding='utf-8'))
    src = lock['source']
    print(f"source: {src['repo']} @ {src['commit'][:12]}  ({src['license']}, {src['built_by']})")
    t = lock['target']
    print(f"target: {t['python']} torch {t['torch']} cuda {t['cuda']} {t['platform']}\n")

    failures = []
    for w in lock['wheels']:
        path = os.path.join(HERE, 'wheels', w['file'])
        if not os.path.exists(path):
            if args.verify:
                print(f'MISSING  {w["file"]}')
                failures.append(w['file'])
                continue
            print(f'fetching {w["file"]} ...', flush=True)
            urllib.request.urlretrieve(w['url'], path)

        got = sha256(path)
        size = os.path.getsize(path)
        if got == w['sha256'] and size == w['bytes']:
            print(f'OK       {w["file"]}')
        else:
            # a mismatch is not a warning: it means the bytes we are about to
            # install are not the bytes anyone reviewed
            print(f'MISMATCH {w["file"]}\n  expected {w["sha256"]} ({w["bytes"]} bytes)'
                  f'\n  got      {got} ({size} bytes)')
            failures.append(w['file'])

    if failures:
        print(f'\nREFUSING: {len(failures)} wheel(s) do not match the lock: {failures}')
        return 1
    print(f'\nall {len(lock["wheels"])} wheels match the lock')
    return 0


if __name__ == '__main__':
    sys.exit(main())
