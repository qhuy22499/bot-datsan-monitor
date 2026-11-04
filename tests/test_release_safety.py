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


class WorkflowTelegramTransport(unittest.TestCase):
    def script(self):
        import textwrap
        workflow=(Path(__file__).resolve().parents[1]/'.github/workflows/monitor.yml').read_text(encoding='utf-8')
        block=workflow.split('      - name: Telegram transport TEST only\n',1)[1].split('      - name:',1)[0]
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.telegram_transport_test",block)
        return textwrap.dedent(block.split("          python - <<'PY'\n",1)[1].split('\n          PY',1)[0])

    def invoke(self, *, chat='-1001', error=None):
        from contextlib import redirect_stdout
        import io
        from types import SimpleNamespace
        from unittest.mock import Mock,patch
        adapter=Mock()
        adapter.send_message.return_value=SimpleNamespace(message_id=17)
        adapter.send_message.side_effect=error
        out=io.StringIO()
        with patch.dict('os.environ',{'TELEGRAM_TEST_CHAT_ID':chat,'TELEGRAM_DESTINATION':'TEST',
                       'TELEGRAM_BOT_TOKEN':'offline_test_only_value'},clear=True), \
             patch('monitor.shared.telegram.TelegramBotAdapter',return_value=adapter), redirect_stdout(out):
            with self.assertRaises(SystemExit) as stopped:
                exec(compile(self.script(),'<workflow-transport-test>','exec'),{})
        return json.loads(out.getvalue()),stopped.exception.code,adapter

    def test_transport_sends_once_without_collector_storage_or_booking(self):
        import ast
        tree=ast.parse(self.script())
        modules={n.module for n in ast.walk(tree) if isinstance(n,ast.ImportFrom)}
        self.assertEqual(modules,{'monitor.shared.telegram'})
        result,code,adapter=self.invoke()
        self.assertEqual((result['status'],result['message_id'],code),('SENT',17,0))
        self.assertFalse(result['execution_allowed']);self.assertFalse(result['auto_booking_allowed'])
        adapter.send_message.assert_called_once()
        self.assertIn('KHÔNG PHẢI THÔNG BÁO SÂN TRỐNG',adapter.send_message.call_args.args[1])

    def test_transport_failure_is_not_retried_and_ambiguous_is_uncertain(self):
        from monitor.shared.telegram import TelegramDeliveryError
        for error,status in [(TelegramDeliveryError('TELEGRAM_FORBIDDEN'),'FAILED'),
                             (TelegramDeliveryError('TELEGRAM_DELIVERY_UNKNOWN',True),'UNCERTAIN')]:
            with self.subTest(status=status):
                result,code,adapter=self.invoke(error=error)
                self.assertEqual((result['status'],code),(status,2))
                self.assertNotIn('message_id',result)
                adapter.send_message.assert_called_once()
                self.assertNotIn('offline_test_only_value',json.dumps(result))

    def test_transport_rejects_private_destination_without_sending(self):
        result,code,adapter=self.invoke(chat='1001')
        self.assertEqual((result['status'],code),('FAILED',2))
        adapter.send_message.assert_not_called()


class ScheduledTrialContract(unittest.TestCase):
    def test_jst_schedule_operating_hours_manual_and_safety_guards(self):
        from datetime import datetime,timedelta
        from zoneinfo import ZoneInfo
        root=Path(__file__).resolve().parents[1]
        workflow=(root/'.github/workflows/monitor.yml').read_text(encoding='utf-8')
        self.assertNotIn('\n  schedule:',workflow)
        cron=json.loads((root/'cron/wrangler.jsonc').read_text(encoding='utf-8'))
        self.assertEqual(cron['triggers']['crons'],['7,22,37,52 0-14,22-23 * * *'])
        self.assertFalse(cron['workers_dev']);self.assertFalse(cron['preview_urls'])
        self.assertIn('  workflow_dispatch:',workflow)
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.confirm_test_delivery",workflow)
        self.assertIn('group: katsushika-public-monitor-test\n  cancel-in-progress: false',workflow)
        self.assertIn('--baseline QUIET',workflow)
        self.assertIn('TELEGRAM_DESTINATION: TEST',workflow)
        hours=json.loads((root/'monitor/shared/data/mvp_monitoring_config.json').read_text(encoding='utf-8'))
        self.assertTrue(hours['hours_verified'])
        self.assertEqual((hours['website_opens_jst'],hours['website_closes_jst']),('07:00','24:00'))
        from datetime import timezone
        utc_ticks=[datetime(2026,11,3,h,m,tzinfo=timezone.utc) for h in (*range(15),22,23) for m in (7,22,37,52)]
        ticks=sorted(t.astimezone(ZoneInfo('Asia/Tokyo')).time() for t in utc_ticks)
        self.assertEqual(len(ticks),68)
        self.assertEqual((ticks[0].strftime('%H:%M'),ticks[-1].strftime('%H:%M')),('07:07','23:52'))
        self.assertTrue(all((b.hour*60+b.minute)-(a.hour*60+a.minute)==15 for a,b in zip(ticks,ticks[1:])))


if __name__=='__main__':unittest.main()
