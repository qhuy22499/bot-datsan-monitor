from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import subprocess
import tempfile
import queue
import threading
from urllib.request import Request, urlopen
from monitor.shared.domain import JST, Slot, TIMES, ScanResult
from monitor.storage import StorageError

ROOT = Path(__file__).resolve().parents[1]
T0 = datetime(2026, 10, 31, 8, 0, 0, tzinfo=JST)


def scan(at=T0, *, available=None, days=2):
    available = available if available is not None else {(at.date(), 'A', '20:30')}
    rows = tuple(Slot(at.date()+timedelta(days=i), court, start, end,
                     'AVAILABLE' if (at.date()+timedelta(days=i),court,start) in available else 'GENERAL_RESERVED')
                 for i in range(days) for court in ('A','B') for start,end in TIMES)
    return ScanResult(at, at+timedelta(seconds=1), 'COMPLETE', 'VERIFIED', rows,
                      tuple((at.date()+timedelta(days=i), at+timedelta(seconds=1)) for i in range(days)),
                      days, len(rows), 'ALL_BOOKABLE', days, 'OFFLINE_FIXTURE', True)


class Worker:
    """Calls the actual Worker JS and SQL through loopback, never a cloud API."""
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.at=T0+timedelta(seconds=2)
        self.backend='D1_LOCAL_WORKERD' if os.environ.get('MONITOR_TEST_STORAGE')=='workerd' else 'SQLITE_SHIM'
        self._start()

    def _start(self):
        self.process = subprocess.Popen([os.environ.get('NODE_BINARY', 'node'), '--disable-warning=ExperimentalWarning',
                                         str(ROOT/'worker/test/server.mjs'), str(Path(self.directory.name)/'test.db')],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        ready=queue.Queue()
        threading.Thread(target=lambda:ready.put(self.process.stdout.readline().strip()),daemon=True).start()
        try:
            metadata=json.loads(ready.get(timeout=40))
        except Exception:
            metadata={}
        if metadata.get('backend')!=self.backend or type(metadata.get('port')) is not int:
            self.close()
            raise RuntimeError('LOCAL_WORKER_START_FAILED')
        self.url = 'http://127.0.0.1:' + str(metadata['port'])
        self.clock(self.at)

    def clock(self, at):
        self.at=at
        request = Request(self.url+'/__clock', data=str(int(at.timestamp()*1000)).encode(),method='POST')
        with urlopen(request, timeout=5): pass

    def call(self, command, payload):
        from urllib.error import HTTPError
        request = Request(self.url+'/v1/'+command, data=json.dumps(payload).encode(),method='POST',headers={
            'Content-Type':'application/json','Authorization':'Bearer offline_test_only_01234567890123456789'})
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            result=json.load(response)
        if result.get('ok') is not True:
            raise StorageError(result.get('error'))
        return result

    def integrity(self):
        request=Request(self.url+'/__integrity',data=b'{}',method='POST')
        with urlopen(request,timeout=10) as response:return json.load(response)

    def restart(self):
        self._stop()
        self._start()

    def _stop(self):
        if getattr(self,'process',None):
            self.process.terminate()
            try:self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
            self.process.stdout.close();self.process.stderr.close()
            self.process=None

    def close(self):
        self._stop()
        self.directory.cleanup()
