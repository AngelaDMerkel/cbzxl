import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { configFromEnv } from '../src/config.ts';
import { openDatabase, lockDatabasePath, now } from '../src/database.ts';
import { activeLibrary, addIssue } from '../src/library.ts';
import { Worker } from '../src/worker.ts';
import { applicationServer } from '../src/http.ts';

test('HTTP authenticates, rejects cross-origin writes, validates jobs, and retains review protections',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cbzxl-http-')),config=configFromEnv({SOURCE_DIR:join(dir,'source'),SCRATCH_DIR:join(dir,'work'),DB_PATH:join(dir,'db.sqlite3'),API_TOKEN:'fixture-token'});
  await mkdir(config.source);await mkdir(config.scratch);await writeFile(join(dir,'index.html'),'<title>CBZXL</title>');
  const db=openDatabase(config.database),library=activeLibrary(db,config.source),worker=new Worker(db,config,{encoder:'unused',decoder:'unused',imagemagick:'unused'});
  const server=applicationServer(db,config,worker,dir);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const headers={Authorization:'Bearer fixture-token','Content-Type':'application/json','X-CBZXL-Request':'1'};
  try{
    assert.equal((await fetch(base+'/api/overview')).status,401);
    const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    assert.equal((await fetch(base+'/api/runs',{method:'POST',headers:{...headers,Origin:'https://unrelated.example'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/api/runs',{method:'POST',headers:{Authorization:headers.Authorization,'Content-Type':'application/json'},body:'{}'})).status,415);
    assert.equal((await fetch(base+'/api/runs',{method:'POST',headers,body:JSON.stringify({policy:{mode:'lossy',distance:0}})})).status,400);
    assert.equal((await fetch(base+'/api/runs',{method:'POST',headers,body:JSON.stringify({archiveId:'missing'})})).status,409);
    const queued=await fetch(base+'/api/runs',{method:'POST',headers,body:'{}'});assert.equal(queued.status,202);await worker.idle();
    const data=await (await fetch(base+'/api/overview',{headers})).json();assert.equal(data.previous.status,'succeeded');assert.equal(data.previous.policy_json,'{"mode":"lossless","effort":7,"distance":0}');
    db.prepare('INSERT INTO archives(id,library_id,path,lossy_state,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('protected',library.id,'book.cbz','lossy',now(),now());
    addIssue(db,'protected','imported_review','Please re-review');
    const issue=db.prepare('SELECT id FROM issues').get()!['id'];
    assert.equal((await fetch(base+'/api/issues/'+issue,{method:'PATCH',headers,body:JSON.stringify({state:'reviewed',note:''})})).status,400);
    assert.equal((await fetch(base+'/api/issues/'+issue,{method:'PATCH',headers,body:JSON.stringify({state:'reviewed',note:'Examined original history',lossy_state:'lossless'})})).status,200);
    assert.equal(db.prepare('SELECT lossy_state FROM archives').get()!['lossy_state'],'lossy');
    assert.equal((await (await fetch(base+'/api/issues',{headers})).json()).items.length,0);
    assert.equal((await (await fetch(base+'/api/issues?state=all',{headers})).json()).items.length,1);
    assert.equal((await fetch(base+'/api/issues?limit=-1',{headers})).status,400);
    assert.equal((await fetch(base+'/api/settings',{method:'PATCH',headers,body:JSON.stringify({name:'Comics',enabled:false,effort:2})})).status,200);
    assert.equal((await fetch(base+'/api/runs',{method:'POST',headers,body:'{}'})).status,409);
  }finally{await worker.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();await rm(dir,{recursive:true,force:true});}
});

test('only one application or migration can hold the destination gate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cbzxl-lock-')),path=join(dir,'app.sqlite3');
  const unlock=lockDatabasePath(path);
  try{assert.throws(()=>lockDatabasePath(path),/in use/);}finally{unlock();}
  const release=lockDatabasePath(path);release();await rm(dir,{recursive:true,force:true});
});
