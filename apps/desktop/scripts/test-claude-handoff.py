#!/usr/bin/env python3
"""Opt-in real-Claude smoke test for the bundled mobile-input plugin.

Creates one disposable interactive session and exercises native desktop input,
the bundled plugin's asUser input and permission hook, then native input again.
The local fake bridge replaces only authenticated Relay transport: this is NOT
an app/Cloud/mobile UI or process-backgrounding test. Requires Unix and an
already authenticated Claude supporting Mods (tested with 2.1.310). Writes no
user model/permission settings and never adopts/stops an existing session.

python3 scripts/test-claude-handoff.py --run --claude ~/.local/bin/claude
"""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def bridge_payload_valid(route, body, control_token):
    if not isinstance(body, dict):
        return False
    if route == 'poll':
        version = body.get('version')
        return set(body) == {'version'} and isinstance(version, str) and version.startswith('2.1.') and version[4:].isdigit() and int(version[4:]) >= 310
    if route == 'ack':
        try:
            uuid.UUID(body.get('lease_id', ''))
        except (ValueError, TypeError, AttributeError):
            return False
        return set(body) == {'lease_id', 'outcome'} and body.get('outcome') in ('started', 'failed')
    if route == 'result':
        return set(body) == {'turn_id', 'text', 'reason', 'control_token'} and body.get('control_token') == control_token and isinstance(body.get('turn_id'), str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', body['turn_id']) is not None and isinstance(body.get('text'), str) and bool(body['text'].strip()) and 0 < len(body['text'].encode()) <= 96*1024 and body.get('reason') in ('answer', 'aborted', 'refusal', 'error')
    if route == 'permission':
        return set(body) == {'request_id', 'tool_name', 'tool_input', 'control_token'} and isinstance(body.get('request_id'), str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', body['request_id']) is not None and body.get('control_token') == control_token and isinstance(body.get('tool_name'), str) and 0 < len(body['tool_name']) <= 128 and not any(ord(c) < 32 or ord(c) == 127 for c in body['tool_name']) and isinstance(body.get('tool_input'), dict)
    return False


def peer_pid(connection):
    if sys.platform == 'darwin':
        return connection.getsockopt(0, 2)  # SOL_LOCAL, LOCAL_PEERPID
    return struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        root = self.server.root
        route = self.path.removeprefix('/claude/mobile-handoff/')
        actual_pid = peer_pid(self.connection)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024*1024:
                raise ValueError('Invalid request size')
            body = json.loads(self.rfile.read(length))
            if actual_pid != self.server.claude_pid or not bridge_payload_valid(route, body, self.server.control_token):
                raise ValueError('Invalid protocol or native process identity')
        except (ValueError, TypeError) as error:
            (root/'invalid-bridge-request.json').write_text(json.dumps({'route': route, 'peer_pid': actual_pid, 'error': str(error)}))
            self.answer(403, {'ok': False, 'error': str(error)})
            return
        with (root/'bridge-requests.jsonl').open('a') as handle:
            handle.write(json.dumps({'route': route, 'body': body, 'peer_pid': actual_pid, 'at': time.time()})+'\n')
        answer = {}
        if route == 'poll':
            action = root/'action.json'
            if action.exists():
                claimed = root/'claimed-action.json'
                action.rename(claimed)
                answer = json.loads(claimed.read_text())
        elif route == 'permission':
            allowed = root/'workspace'/'denied.txt'
            if body['tool_name'] == 'Write' and body['tool_input'].get('file_path') == str(allowed):
                with self.server.ticket_lock:
                    if self.server.permission_ticket is None:
                        self.server.permission_ticket = {'body': body, 'deadline': time.monotonic()+45}
                    ticket = self.server.permission_ticket
                    if ticket['body'] != body:
                        (root/'invalid-bridge-request.json').write_text(json.dumps({'route': route, 'error': 'Permission identity or input changed between polls'}))
                        self.answer(409, {'ok': False, 'error': 'Permission ticket changed'})
                        return
                started = time.monotonic()
                time.sleep(min(15, max(0, ticket['deadline']-started)))
                pending = time.monotonic() < ticket['deadline']
                answer = {'handled': True, 'pending': True} if pending else {
                    'handled': True, 'decision': {'behavior': 'deny', 'message': 'Disposable owner denies this test write.'}}
                with (root/'permission-polls.jsonl').open('a') as handle:
                    handle.write(json.dumps({'request_id': body['request_id'], 'pending': pending, 'wait_seconds': time.monotonic()-started})+'\n')
                if not pending:
                    (root/'permission-returned.json').write_text(json.dumps({'at': time.time(), **answer}))
            else:
                answer = {'handled': False}
        self.answer(200, {'ok': True, 'data': answer})

    def answer(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)


class Bridge(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, root, control_token):
        self.root = root
        self.control_token = control_token
        self.claude_pid = None
        self.ticket_lock = threading.Lock()
        self.permission_ticket = None
        self.socket_path = root/'bridge.sock'
        super().__init__(str(self.socket_path), BridgeHandler)
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)

    def start(self, claude_pid):
        self.claude_pid = claude_pid
        self.thread.start()

    def close(self):
        if self.thread.is_alive():
            self.shutdown()
            self.thread.join(timeout=3)
        self.server_close()

OBSERVER = r'''async function snapshot($) {
 return {sessionId:await $.session.id(),cwd:await $.session.cwd(),model:await $.session.model(),tools:(await $.tool.list()).map(t=>t.name)};
}
export function register(on){
 on('session.start',async($,e,next)=>{await $.fs.write(ROOT+'/started.json',JSON.stringify(await snapshot($)));return next(e);});
 on('turn.start',async($,e,next)=>{await $.fs.write(ROOT+'/start-'+e.turnId+'.json',JSON.stringify({turnId:e.turnId,text:e.text,...await snapshot($)}));return next(e);});
 on('turn.complete',async($,e,next)=>{const result=await next(e);await $.fs.write(ROOT+'/turn-'+e.turnId+'.json',JSON.stringify({turnId:e.turnId,answer:result.text??e.answer,...await snapshot($)}));return result;});
}
'''


class Failure(RuntimeError):
    pass


class Terminal:
    def __init__(self, command, cwd, root):
        import pty
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execv(command[0], command)
        import fcntl, struct, termios
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        self.root = root
        self.output = ''
        self.log = (root/'terminal.log').open('wb')
        self.exited = False

    def read(self):
        if select.select([self.fd], [], [], .1)[0]:
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b''
            self.log.write(data)
            self.log.flush()
            self.output += data.decode(errors='replace')
        found, _ = os.waitpid(self.pid, os.WNOHANG)
        if found:
            self.exited = True
            raise Failure('Owned Claude process exited before proof completed')

    def wait(self, predicate, timeout=120):
        end = time.monotonic()+timeout
        while time.monotonic()<end:
            self.read()
            if (self.root/'invalid-bridge-request.json').exists():
                raise Failure('Bundled plugin sent an invalid bridge protocol payload')
            value = predicate()
            if value:
                return value
        raise Failure('Timed out waiting for disposable Claude proof')

    def send(self, text):
        os.write(self.fd, text.encode())
        for _ in range(5):
            self.read()
        os.write(self.fd, b'\r')

    def close(self):
        # Closing the master releases terminal output before waiting: on macOS
        # a dying TUI can otherwise block in terminal drain even after SIGKILL.
        try:
            if not self.exited:
                os.write(self.fd,b'\x03\x03')
        except OSError:
            pass
        os.close(self.fd)
        for sig in (None,signal.SIGTERM,signal.SIGKILL):
            if self.exited:break
            if sig is not None:
                try:os.kill(self.pid,sig)
                except ProcessLookupError:pass
            end=time.monotonic()+3
            while time.monotonic()<end:
                try:found,_=os.waitpid(self.pid,os.WNOHANG)
                except ChildProcessError:found=self.pid
                if found:
                    self.exited=True
                    break
                time.sleep(.1)
        self.log.close()
        return self.exited


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError,json.JSONDecodeError):
        return None


def model_preference():
    value=read_json(Path.home()/'.claude/settings.json') or {}
    return {'present':'model' in value,'value':value.get('model')}


def run(args):
    root=Path(tempfile.mkdtemp(prefix='relay-handoff-', dir='/tmp')).resolve()
    root.chmod(0o700)
    workspace=root/'workspace';workspace.mkdir()
    plugin=root/'plugin';(plugin/'.claude-plugin').mkdir(parents=True);(plugin/'hooks').mkdir()
    source=Path(__file__).resolve().parents[1]/'probe/src/relay/claude_mobile_plugin/hooks/register.mjs'
    shutil.copyfile(source,plugin/'hooks/register.mjs')
    (plugin/'.claude-plugin/plugin.json').write_text(json.dumps({'name':'relay-mobile-proof','version':'0.0.1'}))
    (plugin/'hooks/hooks.json').write_text(json.dumps({'modules':['./register.mjs']}))
    observer=root/'observer'
    (observer/'.claude-plugin').mkdir(parents=True);(observer/'hooks').mkdir()
    (observer/'.claude-plugin/plugin.json').write_text(json.dumps({'name':'relay-proof-observer','version':'0.0.1'}))
    (observer/'hooks/hooks.json').write_text(json.dumps({'modules':['./register.mjs']}))
    (observer/'hooks/register.mjs').write_text(OBSERVER.replace('ROOT',json.dumps(str(root))))
    control_token=str(uuid.uuid4())
    bridge=Bridge(root, control_token)
    (plugin/'bridge.json').write_text(json.dumps({'socket':str(bridge.socket_path)}))
    (root/'bridge-control-token.txt').write_text(control_token)
    marker='HANDOFF_'+uuid.uuid4().hex[:12]
    before=model_preference()
    report={'status':'running','artifact_dir':str(root),'mobile_ui_test':False,'authenticated_core_test':False,
            'native_background_test':False,'bundled_module_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
            'provider_version':subprocess.check_output([args.claude,'--version'],text=True).strip()}
    print(json.dumps(report),flush=True)
    terminal=None
    try:
        terminal=Terminal([args.claude,'--plugin-dir',str(plugin),'--plugin-dir',str(observer),'--permission-mode','manual',
                           '--tools','Write','--setting-sources','','--strict-mcp-config',
                           '--mcp-config','{"mcpServers":{}}'],str(workspace),root)
        bridge.start(terminal.pid)
        terminal.wait(lambda: 'trustthisfolder' in re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', terminal.output) or (root/'started.json').exists(),args.timeout)
        if not (root/'started.json').exists():
            # The only approval automated is trust for this newly created empty fixture.
            time.sleep(2)
            os.write(terminal.fd,b'\x1b[B\r')
        terminal.wait(lambda:read_json(root/'started.json'),args.timeout)
        def turns():
            return [d for p in root.glob('turn-*.json') if (d:=read_json(p))]
        terminal.send(f'Remember {marker}. Reply only {marker}. Do not use tools.')
        first=terminal.wait(lambda:next((t for t in turns() if marker in (t.get('answer') or '')),None),args.timeout)
        seen={t['turnId'] for t in turns()}
        action={'action':'submit','control_token':control_token,'lease_id':str(uuid.uuid4()),'text':f'Recall the exact marker and include it in your response. Use Write once to create {workspace}/denied.txt containing PROOF_ONLY. If denied, stop and do not try any other path or tool.'}
        (root/'action.tmp').write_text(json.dumps(action))
        (root/'action.tmp').replace(root/'action.json')
        second=terminal.wait(lambda:next((t for t in turns() if t['turnId'] not in seen and marker in (t.get('answer') or '')),None),args.timeout)
        if not (root/'permission-returned.json').exists():
            raise Failure('Bundled plugin did not correlate the mobile turn with native permission handling')
        if (workspace/'denied.txt').exists():
            raise Failure('Explicitly denied disposable write unexpectedly executed')
        seen={t['turnId'] for t in turns()}
        terminal.send('Desktop return: reply only with the exact remembered marker. Do not use tools.')
        third=terminal.wait(lambda:next((t for t in turns() if t['turnId'] not in seen and marker in (t.get('answer') or '')),None),args.timeout)
        def result_requests():
            path=root/'bridge-requests.jsonl'
            return [json.loads(line)['body'] for line in path.read_text().splitlines() if json.loads(line)['route']=='result']
        terminal.wait(lambda:any(row['turn_id']==third['turnId'] for row in result_requests()),args.timeout)
        forwarded={row['turn_id'] for row in result_requests()}
        if first['turnId'] in forwarded or second['turnId'] not in forwarded:
            raise Failure('Result provenance did not respect mobile engagement')
        rows=[first,second,third]
        for key in ['sessionId','cwd','model','tools']:
            if any(row[key]!=first[key] for row in rows):raise Failure(f'{key} changed between control surfaces')
        if first['tools']!=['Write']:raise Failure('Unexpected native toolset')
        requests=[json.loads(line) for line in (root/'bridge-requests.jsonl').read_text().splitlines()]
        if any(r['peer_pid'] != terminal.pid for r in requests):
            raise Failure('Bridge request did not come directly from native Claude')
        permissions=[r for r in requests if r['route']=='permission']
        permission_ids={r['body']['request_id'] for r in permissions}
        poll_results=[json.loads(line) for line in (root/'permission-polls.jsonl').read_text().splitlines()]
        if len(permission_ids)!=1 or len(permissions)<3 or not any(row['pending'] for row in poll_results):
            raise Failure('Permission did not preserve one ticket across short polls')
        if any(row['wait_seconds']>=30 for row in poll_results):
            raise Failure('Permission poll exceeded native HTTP deadline')
        duration=read_json(root/'permission-returned.json')['at']-permissions[0]['at']
        if duration<45:raise Failure('Long-poll duration was not exercised')
        if model_preference()!=before:raise Failure('Global model preference changed during proof')
        report.update(status='passed',session_id=first['sessionId'],pid=terminal.pid,same_process=True,
                      native_user_continuity=True,native_http_peer_pid_verified=True,request_peer_pids=sorted({r['peer_pid'] for r in requests}),bridge_request_count=len(requests),pre_engagement_result_suppressed=True,
                      mobile_results_forwarded=True,control_token_echo_validated=True,permission_denied=True,permission_wait_seconds=round(duration,2),
                      permission_poll_count=len(permissions),permission_request_ids=sorted(permission_ids),permission_ticket_count=1,
                      tools_unchanged=first['tools'],cwd_unchanged=True,model_unchanged=True,
                      global_model_preference_unchanged=True,manual_mode_launch=True,
                      provider_turn_ids=[r['turnId'] for r in rows])
    except (Exception, KeyboardInterrupt) as error:
        report.update(status='failed',error=str(error))
    finally:
        if terminal:
            report['owned_process_reaped']=terminal.close()
            if not report['owned_process_reaped']:
                report['status']='failed'
                report['error']='Owned process termination pending after bounded cleanup'
        bridge.close()
        (root/'result.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report),flush=True)
    return 0 if report['status']=='passed' else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true',help='Run billable disposable real-Claude turns')
    parser.add_argument('--claude',default=shutil.which('claude'))
    parser.add_argument('--timeout',type=int,default=120)
    args=parser.parse_args()
    if not args.run:parser.error('Pass --run to opt in to real disposable provider calls')
    if sys.platform not in ('darwin', 'linux'):parser.error('This native PTY smoke harness requires macOS or Linux peer credentials')
    if not args.claude or not Path(args.claude).is_file():parser.error('Claude binary is unavailable')
    if not 60<=args.timeout<=300:parser.error('--timeout must be 60..300 seconds')
    args.claude=str(Path(args.claude).absolute())
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGINT, signal.default_int_handler)
    return run(args)


if __name__=='__main__':sys.exit(main())
