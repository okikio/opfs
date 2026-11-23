"""Bound the reviewed acquisition script's combined log and whole-process lifetime."""
import os,sys,pathlib,subprocess,selectors,time,signal,json
if len(sys.argv)!=2:raise SystemExit('usage: python3 acquire-run.py /acquire.sh')
root=pathlib.Path('/tool');root.mkdir(exist_ok=True)
child=subprocess.Popen(['sh',sys.argv[1]],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
selector=selectors.DefaultSelector();selector.register(child.stdout,selectors.EVENT_READ)
start=time.monotonic();deadline=start+180;count=0;limit=4*1024**2;reason=None
try:
    with (root/'continuation.log').open('wb') as log:
        while selector.get_map():
            if time.monotonic()>=deadline:reason='whole acquisition deadline';break
            for key,_ in selector.select(min(0.25,max(0,deadline-time.monotonic()))):
                data=os.read(key.fileobj.fileno(),65536)
                if not data:selector.unregister(key.fileobj);continue
                remaining=limit-count
                log.write(data[:remaining]);count+=min(remaining,len(data))
                if len(data)>remaining:reason='aggregate acquisition log cap';break
            if reason:break
    if reason:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    status=child.wait(timeout=max(0.1,min(15,deadline-time.monotonic()+15)))
finally:
    selector.close();child.stdout.close()
    if child.poll() is None:
        try:os.killpg(child.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        child.wait(timeout=15)
receipt={'script':sys.argv[1],'exit':status,'reason':reason,'logBytes':count,'maxLogBytes':limit,'deadlineSeconds':180,'elapsedSeconds':time.monotonic()-start,'scope':'test-only signed-package acquisition; original log prefix retained on bound failure'}
(root/'continuation-run.json').write_text(json.dumps(receipt,indent=2)+'\n')
if reason:raise SystemExit(124 if reason=='whole acquisition deadline' else 125)
raise SystemExit(status)
