"""Fail closed against the explicit public file list, not .gitignore alone.

No file contents or matched secrets are printed. Review findings locally.
This complements provider secret scanning; it cannot audit nonexistent history.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

ROOT=Path(__file__).resolve().parents[1]
MANIFEST=ROOT/'PUBLIC_MANIFEST.json'
SKIP={'node_modules','__pycache__','.wrangler','.venv','artifacts','.git'}
FORBIDDEN_SUFFIX={'.sqlite3','.sqlite','.db','.zip','.log','.bak','.backup','.exe','.dll','.har','.pem','.pfx','.key','.pcap','.session','.db-wal','.db-shm'}
PRIVATE_NAMES={'wrangler.local.json','wrangler.deploy.json','cookies.json','storage_state.json'}
PATTERNS=[
    re.compile(rb'(?<![A-Za-z0-9])\d{8,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}'),
    re.compile(rb'(?i)(?:cloudflare[_-]?api[_-]?token|monitor[_-]?api[_-]?secret|api[_-]?secret|bot[_-]?token|password)\s*[:=]\s*[\x22\x27](?!offline_test_only_|[\x22\x27])[A-Za-z0-9_/-]{24,}[\x22\x27]'),
]


def files():
    return {p.relative_to(ROOT).as_posix():p for p in ROOT.rglob('*') if p.is_file()
            and not set(p.relative_to(ROOT).parts)&SKIP and p!=MANIFEST}


def safe_path(root,name):
    if not isinstance(name,str) or '\\' in name or ':' in name:
        raise ValueError('UNSAFE_MANIFEST_PATH')
    relative=PurePosixPath(name)
    if relative.is_absolute() or str(relative)!=name or any(p in {'..','.'} | SKIP | {'private'} for p in relative.parts):
        raise ValueError('UNSAFE_MANIFEST_PATH')
    path=root
    for part in relative.parts:
        path=path/part
        if path.is_symlink() or path.is_junction():raise ValueError('LINK_NOT_ALLOWED')
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():raise ValueError('INVALID_PUBLIC_FILE')
    if path.suffix.lower() in FORBIDDEN_SUFFIX or path.name in PRIVATE_NAMES or '.sqlite' in path.name.lower() or path.name.startswith(('.env','.dev.vars')):raise ValueError('PRIVATE_FILE_NOT_ALLOWED')
    return path


def checked_manifest(root=ROOT):
    manifest=root/'PUBLIC_MANIFEST.json'
    if manifest.is_symlink() or manifest.is_junction():raise ValueError('LINK_NOT_ALLOWED')
    data=json.loads(manifest.read_text(encoding='utf-8'))
    if set(data)!={'schema','files'} or data['schema']!='public-allowlist-v1' or not isinstance(data['files'],dict) or not data['files']:
        raise ValueError('INVALID_MANIFEST')
    if len({name.casefold() for name in data['files']})!=len(data['files']):raise ValueError('CASE_COLLISION')
    for name,digest in data['files'].items():
        if name=='PUBLIC_MANIFEST.json' or not re.fullmatch(r'[a-f0-9]{64}',digest):raise ValueError('INVALID_MANIFEST')
        path=safe_path(root,name)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise ValueError('MANIFEST_MISMATCH')
    return data['files']


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--refresh-reviewed-manifest',action='store_true');args=parser.parse_args()
    found=files()
    violations=[]
    for name,p in found.items():
        try:safe_path(ROOT,name)
        except ValueError:
            violations.append(name)
            continue
        raw=p.read_bytes()
        if len(raw)>1_000_000 or any(pattern.search(raw) for pattern in PATTERNS):violations.append(name)
    if violations:
        print(json.dumps({'status':'FAILED','finding_files':sorted(set(violations))}));return 2
    hashes={name:hashlib.sha256(p.read_bytes()).hexdigest() for name,p in sorted(found.items())}
    if args.refresh_reviewed_manifest:
        MANIFEST.write_text(json.dumps({'schema':'public-allowlist-v1','files':hashes},indent=2)+'\n',encoding='utf-8')
    expected=checked_manifest() if MANIFEST.exists() else {}
    mismatch=sorted(name for name in set(expected)|set(hashes) if expected.get(name)!=hashes.get(name))
    print(json.dumps({'status':'PASS' if not mismatch else 'FAILED','files_checked':len(hashes),
                      'manifest_mismatches':mismatch,'secrets_printed':False,'git_history_checked':False}))
    return 2 if mismatch else 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        print(json.dumps({'status':'FAILED','reason':'PUBLIC_AUDIT_STOPPED_NO_SECRET_OUTPUT'}));raise SystemExit(2) from None
