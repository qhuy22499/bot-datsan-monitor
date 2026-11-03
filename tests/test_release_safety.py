import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import re
import tomllib
from tools.audit_public import checked_manifest,safe_path
from tools.export_release import export


class ReleaseSafety(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.folder=Path(self.temp.name)
        self.root=self.folder/'source';self.root.mkdir()
        (self.root/'safe.txt').write_text('public fixture only',encoding='utf-8')
        self.write_manifest({'safe.txt':hashlib.sha256((self.root/'safe.txt').read_bytes()).hexdigest()})

    def tearDown(self):self.temp.cleanup()

    def write_manifest(self,files):
        (self.root/'PUBLIC_MANIFEST.json').write_text(json.dumps({'schema':'public-allowlist-v1','files':files}),encoding='utf-8')
        self.digest=hashlib.sha256((self.root/'PUBLIC_MANIFEST.json').read_bytes()).hexdigest()

    def test_export_is_exact_allowlist_and_does_not_copy_untracked_or_history(self):
        (self.root/'unreviewed.txt').write_text('do not export')
        (self.root/'.git').mkdir();(self.root/'.git/config').write_text('private history')
        destination=self.folder/'release';r=export(self.root,destination,self.digest)
        self.assertEqual(r['files_exported'],2)
        self.assertEqual({p.name for p in destination.iterdir()},{'safe.txt','PUBLIC_MANIFEST.json'})

    def test_changed_content_or_review_hash_blocks_before_writing(self):
        with self.assertRaises(ValueError):export(self.root,self.folder/'wrong','0'*64)
        (self.root/'safe.txt').write_text('changed')
        with self.assertRaises(ValueError):export(self.root,self.folder/'changed',self.digest)
        self.assertFalse((self.folder/'changed').exists())

    def test_traversal_absolute_windows_and_hidden_private_paths_rejected(self):
        for name in ['../outside.txt','/safe.txt','C:/safe.txt','..\\safe.txt','.git/config','private/key.txt']:
            with self.subTest(name=name),self.assertRaises(ValueError):safe_path(self.root,name)

    def test_secret_database_and_trace_extensions_rejected(self):
        for name in ['.env','.dev.vars','data.sqlite3','data.sqlite3-wal','archive.backup','network.har','token.key','wrangler.deploy.json','storage_state.json']:
            (self.root/name).write_text('fake')
            with self.subTest(name=name),self.assertRaises(ValueError):safe_path(self.root,name)

    def test_case_collision_and_existing_destination_are_rejected(self):
        digest=hashlib.sha256((self.root/'safe.txt').read_bytes()).hexdigest()
        self.write_manifest({'safe.txt':digest,'SAFE.TXT':digest})
        with self.assertRaises(ValueError):checked_manifest(self.root)
        self.write_manifest({'safe.txt':digest})
        with self.assertRaises(ValueError):export(self.root,self.root,self.digest)

    def test_scanner_exception_only_matches_manifest_checksums(self):
        config=tomllib.loads((Path(__file__).resolve().parents[1]/'.gitleaks.toml').read_text(encoding='utf-8'))
        self.assertTrue(config['extend']['useDefault'])
        rule=config['rules'][0];self.assertEqual(rule['id'],'generic-api-key')
        allow=rule['allowlists'][0];self.assertEqual(allow['condition'],'AND');self.assertEqual(allow['regexTarget'],'secret')
        self.assertTrue(re.search(allow['paths'][0],'package/PUBLIC_MANIFEST.json'))
        self.assertFalse(re.search(allow['paths'][0],'package/source.py'))
        self.assertTrue(re.fullmatch(allow['regexes'][0],'a'*64))
        self.assertFalse(re.fullmatch(allow['regexes'][0],'synthetic_'+ 'Z9'*30))


if __name__=='__main__':unittest.main()
