"""Bound the complete offline producer lifetime and preserve its diagnostic prefix."""
import json
import os
import pathlib
import selectors
import signal
import subprocess
import sys
import time

if len(sys.argv) != 1:
    raise SystemExit('usage: python3 producer-run.py')
root = pathlib.Path('/receipts')
root.mkdir(exist_ok=True)
child = subprocess.Popen([sys.executable, '-I', '/produce.py', '--output', '/tmp/independent.json'],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)
start = time.monotonic()
deadline = start + 210
count = 0
cap = 4 * 1024**2
reason = None
status = -1
try:
    with (root / 'production.log').open('wb') as log:
        while selector.get_map():
            if time.monotonic() >= deadline:
                reason = 'whole producer deadline'
                break
            for key, _ in selector.select(min(0.25, max(0, deadline - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                amount = min(cap - count, len(data))
                log.write(data[:amount])
                count += amount
                if amount != len(data):
                    reason = 'combined producer diagnostic cap'
                    break
            if reason:
                break
    if reason:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    status = child.wait(timeout=max(0.1, min(15, deadline - time.monotonic() + 15)))
finally:
    selector.close()
    child.stdout.close()
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=15)
    receipt = dict(exit=status, reason=reason, logBytes=count, maxLogBytes=cap,
                   deadlineSeconds=210, elapsedSeconds=time.monotonic() - start)
    (root / 'production-run.json').write_text(json.dumps(receipt, indent=2) + '\n')
if reason:
    raise SystemExit(124 if reason == 'whole producer deadline' else 125)
raise SystemExit(status)
