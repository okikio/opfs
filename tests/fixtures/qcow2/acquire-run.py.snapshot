"""Bound the signed acquisition's combined diagnostic log and complete process group."""
import json
import os
import pathlib
import resource
import selectors
import signal
import subprocess
import sys
import time

if len(sys.argv) != 3 or sys.argv[2] not in ('download', 'install'):
    raise SystemExit('usage: python3 acquire-run.py /acquire.sh download|install')
root = pathlib.Path('/receipts')
root.mkdir(exist_ok=True)

def limit():
    # A larger individual archive/diagnostic cannot consume the host disk before
    # the semantic closure-admission checks get their turn.
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))

stage = sys.argv[2]
previous = json.loads((root / 'acquisition-download.json').read_text()) if stage == 'install' else {}
if previous and (previous['exit'] != 0 or previous['reason'] is not None):
    raise SystemExit('download admission did not succeed')
prior_seconds = previous.get('totalElapsedSeconds', 0)
prior_bytes = previous.get('totalLogBytes', 0)
if prior_seconds >= 180 or prior_bytes >= 4 * 1024**2:
    raise SystemExit('combined acquisition allowance exhausted')
child = subprocess.Popen(['sh', sys.argv[1], stage], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limit)
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)
start = time.monotonic()
deadline = start + 180 - prior_seconds
count = 0
cap = 4 * 1024**2 - prior_bytes
reason = None
status = -1
try:
    with (root / ('acquisition-' + stage + '.log')).open('wb') as log:
        while selector.get_map():
            if time.monotonic() >= deadline:
                reason = 'whole acquisition deadline'
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
                    reason = 'aggregate acquisition log cap'
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
    receipt = dict(script=sys.argv[1], stage=stage, exit=status, reason=reason, logBytes=count, maxLogBytes=cap,
                   deadlineSeconds=180, elapsedSeconds=time.monotonic() - start,
                   totalElapsedSeconds=prior_seconds + time.monotonic() - start, totalLogBytes=prior_bytes + count)
    (root / ('acquisition-' + stage + '.json')).write_text(json.dumps(receipt, indent=2) + '\n')
if reason:
    raise SystemExit(124 if reason == 'whole acquisition deadline' else 125)
raise SystemExit(status)
