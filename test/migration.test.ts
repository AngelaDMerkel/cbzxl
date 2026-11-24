import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PathLike } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { migrate } from '../src/migrate.ts';
import { hashFile } from '../src/files.ts';
import { openDatabase, verifyDatabase } from '../src/database.ts';

function legacy(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE converted_archives(path TEXT PRIMARY KEY,original_size INTEGER,final_size INTEGER,status TEXT,conversion_mode TEXT,review_status TEXT,review_note TEXT,converted_at TEXT);"+
    "INSERT INTO converted_archives VALUES('Series/Book.cbz',1000,700,'processed','Lossless','dismissed','Old note','2026-01-01T00:00:00Z');"+
    "CREATE TABLE runs(id TEXT,status TEXT,processed INTEGER,skipped INTEGER,failed INTEGER,bytes_saved INTEGER,started_at TEXT);"+
    "INSERT INTO runs VALUES('old-run','running',1,0,0,300,'2026-01-01T00:00:00Z');"+
    "CREATE TABLE archive_results(run_id TEXT,path TEXT,status TEXT,original_size INTEGER,final_size INTEGER,bytes_saved INTEGER);"+
    "INSERT INTO archive_results VALUES('old-run','Series/Book.cbz','processed',1000,700,300)");
  db.close();
}
async function fixture() {
  const dir=await fs.mkdtemp(join(tmpdir(),'cbzxl-migration-'));
  return {dir,source:join(dir,'old.db'),target:join(dir,'new.db'),sourceRoot:join(dir,'comics')};
}

test('legacy dry run preserves source; success verifies history, removes source, and is repeatable', async () => {
  const f=await fixture();legacy(f.source);
  try {
    const before=await hashFile(f.source);
    const dry=await migrate({...f,dryRun:true});
    assert.equal(dry.counts.archives,1);
    assert.equal(await hashFile(f.source),before);
    await assert.rejects(fs.stat(f.target));
    const report=await migrate(f);
    assert.equal(report.sourceRemoved,true);
    await assert.rejects(fs.stat(f.source));
    const db=openDatabase(f.target);
    try {
      verifyDatabase(db);
      assert.equal(db.prepare('SELECT lossy_state FROM archives').get()!['lossy_state'],'unknown');
      assert.equal(db.prepare('SELECT status FROM runs').get()!['status'],'interrupted');
      assert.equal(db.prepare('SELECT state FROM issues').get()!['state'],'needs_review');
      assert.equal(db.prepare('SELECT note FROM issues').get()!['note'],'Old note');
    } finally {db.close();}
    assert.equal((await migrate(f)).sourceRemoved,true);
  } finally {await fs.rm(f.dir,{recursive:true,force:true});}
});

test('published destination survives a cleanup failure and retry does not duplicate history', async t => {
  const f=await fixture();legacy(f.source);
  const unlink=fs.unlink;
  const failure=t.mock.method(fs,'unlink',async (path: PathLike)=>{
    if(String(path)===f.source) throw Object.assign(new Error('simulated source cleanup failure'),{code:'EACCES'});
    return unlink(path);
  });
  try {
    await assert.rejects(migrate(f),/cleanup failure/);
    await fs.stat(f.source);await fs.stat(f.target);
    failure.mock.restore();
    const report=await migrate(f);
    assert.equal(report.sourceRemoved,true);
    const db=new DatabaseSync(f.target,{readOnly:true});
    assert.equal(db.prepare('SELECT count(*) AS n FROM archives').get()!['n'],1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM imports').get()!['n'],1);
    db.close();
  } finally {failure.mock.restore();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('recovery completes a receipt interrupted after the old database was removed',async t=>{
  const f=await fixture();legacy(f.source);
  const unlink=fs.unlink;
  const failure=t.mock.method(fs,'unlink',async(path:PathLike)=>{await unlink(path);if(String(path)===f.source)throw new Error('interrupted after removal');});
  try{
    await assert.rejects(migrate(f),/interrupted after removal/);await assert.rejects(fs.stat(f.source));
    failure.mock.restore();
    const receipt=await migrate(f);assert.equal(receipt.status,'completed');assert.equal(receipt.sourceRemoved,true);
    assert.equal((await migrate(f)).status,'completed');
  }finally{failure.mock.restore();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('captured Python v3 schema and real Rust v5 schema remain valid migration inputs',async()=>{
  for(const kind of ['python-v3','rust-v5']){
    const f=await fixture(),db=new DatabaseSync(f.source);
    try{
      db.exec(await fs.readFile(new URL('./fixtures/'+kind+'.sql',import.meta.url),'utf8'));
      if(kind==='rust-v5')db.exec("INSERT INTO schema_migrations VALUES(3,'2026-01-01T00:00:00Z');INSERT INTO libraries(id,name,root_path,created_at,updated_at) VALUES('lib','Comics','/old','2026-01-01','2026-01-01')");
      db.close();
      const report=await migrate(f);assert.equal(report.sourceKind,kind);assert.equal(report.counts.libraries,1);
      const target=new DatabaseSync(f.target,{readOnly:true});verifyDatabase(target);
      if(kind==='python-v3'){
        assert.equal(target.prepare('SELECT count(*) AS n FROM pages WHERE result_id IS NOT NULL').get()!['n'],1);
        assert.equal(target.prepare('SELECT current_bytes FROM snapshots').get()!['current_bytes'],700);
      }
      target.close();
    }finally{try{db.close();}catch{}await fs.rm(f.dir,{recursive:true,force:true});}
  }
});

test('interruption immediately after publication retains a durable receipt for recovery', async t => {
  const f=await fixture();legacy(f.source);
  const link=fs.link;
  const failure=t.mock.method(fs,'link',async(from: PathLike,to: PathLike)=>{
    await link(from,to);
    throw new Error('simulated interruption after publish');
  });
  try {
    await assert.rejects(migrate(f),/interruption/);
    const report=JSON.parse(await fs.readFile(f.target+'.migration.json','utf8'));
    assert.equal(report.status,'prepared');
    await fs.stat(f.source);
    failure.mock.restore();
    assert.equal((await migrate(f)).status,'completed');
  } finally {failure.mock.restore();await fs.rm(f.dir,{recursive:true,force:true});}
});

test('unrecognized input, pending replacements and unrelated destinations never delete source', async () => {
  const f=await fixture();
  try {
    let db=new DatabaseSync(f.source);db.exec('CREATE TABLE unrelated(n INTEGER)');db.close();
    await assert.rejects(migrate(f),/Unrecognized/);
    await fs.stat(f.source);await fs.rm(f.source);legacy(f.source);
    db=new DatabaseSync(f.source);db.exec('CREATE TABLE archive_commit_intents(path TEXT);INSERT INTO archive_commit_intents VALUES (\'Book.cbz\')');db.close();
    await assert.rejects(migrate(f),/pending archive replacements/);
    await fs.stat(f.source);
    db=new DatabaseSync(f.source);db.exec('DROP TABLE archive_commit_intents');db.close();
    db=new DatabaseSync(f.target);db.exec('CREATE TABLE unrelated(n INTEGER)');db.close();
    const before=await hashFile(f.target);
    await assert.rejects(migrate(f),/unrelated/);
    assert.equal(await hashFile(f.target),before);
    await fs.stat(f.source);
  } finally {await fs.rm(f.dir,{recursive:true,force:true});}
});

test('migration snapshots committed WAL data left by an interrupted writer', async () => {
  const f=await fixture();legacy(f.source);
  const program="const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA journal_mode=WAL;INSERT INTO converted_archives VALUES('Series/Wal.cbz',900,600,'processed','Lossless','open',NULL,'2026-01-02T00:00:00Z')\");process.stdout.write('ready');setInterval(()=>{},1000);";
  const child=spawn(process.execPath,['-e',program,f.source],{stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout!,'data');
    child.kill('SIGKILL');await once(child,'exit');
    assert.ok((await fs.stat(f.source+'-wal')).size>0);
    const report=await migrate(f);
    assert.equal(report.counts.archives,2);
    await assert.rejects(fs.stat(f.source));
    const target=new DatabaseSync(f.target,{readOnly:true});
    assert.equal(target.prepare('SELECT count(*) AS n FROM archives').get()!['n'],2);
    verifyDatabase(target);target.close();
  } finally {child.kill('SIGKILL');await fs.rm(f.dir,{recursive:true,force:true});}
});

for(const kind of ['python','rust'] as const) test(kind+' history preserves accepted lossy evidence and does not trust old reviews',async()=>{
  const f=await fixture(),db=new DatabaseSync(f.source);
  const archiveTable=kind==='rust'?'job_archive_outcomes':'archive_results';
  const pageTable=kind==='rust'?'page_outcomes':'page_decisions';
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER);INSERT INTO schema_migrations VALUES("+ (kind==='rust'?3:15) +");"+
      "CREATE TABLE libraries(id TEXT,name TEXT,root_path TEXT,enabled INTEGER);INSERT INTO libraries VALUES('lib','Comics','/old',1);"+
      "CREATE TABLE "+(kind==='rust'?'policies':'conversion_profiles')+"(id TEXT);"+
      "CREATE TABLE archives(id INTEGER,library_id TEXT,path TEXT,original_size INTEGER,final_size INTEGER,review_status TEXT);"+
      "INSERT INTO archives VALUES(1,'lib','one.cbz',1000,800,'open');INSERT INTO archives VALUES(2,'lib','two.cbz',1000,1000,'open');"+
      "CREATE TABLE jobs(id TEXT,library_id TEXT,status TEXT,policy_json TEXT);INSERT INTO jobs VALUES('job','lib','succeeded','{}');"+
      "CREATE TABLE "+archiveTable+"(id INTEGER,job_id TEXT,archive_id INTEGER,path TEXT,outcome TEXT);"+
      "INSERT INTO "+archiveTable+" VALUES(10,'job',1,'one.cbz','optimized');INSERT INTO "+archiveTable+" VALUES(11,'job',2,'two.cbz','retained');"+
      "CREATE TABLE "+pageTable+"(id INTEGER,job_outcome_id INTEGER,job_id TEXT,archive_id INTEGER,path TEXT,entry_path TEXT,outcome TEXT,mode TEXT,distance REAL,attempts_json TEXT);"+
      "INSERT INTO "+pageTable+" VALUES(20,10,'job',1,'one.cbz','page.jpg','converted','Lossy',0.5,'[]');"+
      "INSERT INTO "+pageTable+" VALUES(21,11,'job',2,'two.cbz','page.jpg','retained','Lossy',0.5,'[{\"mode\":\"Lossy\",\"reason\":\"larger\"}]');"+
      "CREATE TABLE review_actions(id INTEGER,archive_id INTEGER,action TEXT,note TEXT);INSERT INTO review_actions VALUES(30,1,'dismiss','Keep context');");
    db.close();
    const report=await migrate(f);
    assert.equal(report.counts.pages,2);
    const target=new DatabaseSync(f.target,{readOnly:true});
    assert.equal(target.prepare("SELECT lossy_state FROM archives WHERE id='1'").get()!['lossy_state'],'lossy');
    assert.equal(target.prepare("SELECT lossy_state FROM archives WHERE id='2'").get()!['lossy_state'],'unknown');
    assert.equal(target.prepare('SELECT count(*) AS n FROM issues').get()!['n'],1);
    assert.equal(target.prepare('SELECT state FROM issues').get()!['state'],'needs_review');
    assert.equal(target.prepare('SELECT root_path FROM libraries').get()!['root_path'],f.sourceRoot);
    assert.equal(target.prepare('SELECT count(*) AS n FROM pages WHERE result_id IS NOT NULL').get()!['n'],2);
    target.close();
  }finally{try{db.close();}catch{}await fs.rm(f.dir,{recursive:true,force:true});}
});
