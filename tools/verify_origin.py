"""Optional original-workspace compatibility check, never required on Cloud."""
import hashlib
import json
from pathlib import Path

stage=Path(__file__).resolve().parents[1]
origin=stage.parents[1]
manifest=json.loads((stage/'CORE_PROVENANCE.json').read_text())
missing=[p for p in manifest['sources'] if not (origin/p).is_file()]
changed=[p for p,h in manifest['sources'].items() if (origin/p).is_file() and hashlib.sha256((origin/p).read_bytes()).hexdigest()!=h]
print(json.dumps({'status':'PASS' if not missing and not changed else 'FAILED','source_files':len(manifest['sources']),
                  'missing':missing,'changed':changed,'windows_source_modified':bool(changed)}))
raise SystemExit(1 if missing or changed else 0)
