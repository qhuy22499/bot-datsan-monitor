"""Materialize only a reviewed allowlist. Never invokes Git, push or deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
try:
    from .audit_public import checked_manifest, safe_path
except ImportError:
    from audit_public import checked_manifest, safe_path

ROOT=Path(__file__).resolve().parents[1]


def export(root,destination,expected_manifest_sha256):
    root=Path(root).resolve();destination=Path(destination).absolute()
    actual=hashlib.sha256((root/'PUBLIC_MANIFEST.json').read_bytes()).hexdigest()
    if actual!=expected_manifest_sha256:raise ValueError('APPROVED_MANIFEST_CHANGED')
    manifest=checked_manifest(root)
    if destination.exists() or destination.is_symlink():raise ValueError('DESTINATION_MUST_BE_NEW')
    # Check existing ancestors before mkdir; do not write through a junction.
    for ancestor in [destination,*destination.parents]:
        if ancestor.is_symlink() or ancestor.is_junction():raise ValueError('LINK_NOT_ALLOWED')
    resolved=destination.resolve()
    if resolved.is_relative_to(root) or root.is_relative_to(resolved):raise ValueError('INVALID_EXPORT_DESTINATION')
    destination.mkdir(parents=True,exist_ok=False)
    for name in [*manifest,'PUBLIC_MANIFEST.json']:
        source=safe_path(root,name)
        target=destination/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target,follow_symlinks=False)
    checked_manifest(destination)
    copied={p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
    if copied!=set(manifest)|{'PUBLIC_MANIFEST.json'}:raise ValueError('EXPORT_CONTENT_MISMATCH')
    return {'status':'PASS','files_exported':len(copied),'manifest_sha256':actual,'git_history_copied':False,'push_performed':False}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--destination',type=Path,required=True)
    parser.add_argument('--expected-manifest-sha256',required=True);args=parser.parse_args()
    print(json.dumps(export(ROOT,args.destination,args.expected_manifest_sha256)))


if __name__=='__main__':
    try:main()
    except Exception:
        print(json.dumps({'status':'FAILED','reason':'EXPORT_STOPPED_NO_SECRET_OUTPUT'}));raise SystemExit(2) from None
