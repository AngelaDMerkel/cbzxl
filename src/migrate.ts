import { DatabaseSync, backup } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { json, lockDatabasePath, now, openDatabase, SCHEMA_ID, transaction, verifyDatabase } from './database.ts';
import type { Row } from './database.ts';
import { atomicJson, canonicalDestination, exists, hashFile, identity, relativePath, sameIdentity, syncDirectory, syncFile } from './files.ts';
import type { Identity } from './files.ts';

export interface MigrationOptions {
  source: string; target: string; sourceRoot: string; dryRun?: boolean;
  maps?: Record<string,string>;
}
export interface MigrationReport {
  version: 1; source: string; target: string; sourceKind: string; sourceDigest: string;
  targetDigest?: string; status: 'dry_run' | 'prepared' | 'published' | 'completed' | 'failed';
  sourceRoot: string; mappings: Record<string,string>;
  sourceRemoved: boolean; startedAt: string; finishedAt?: string;
  counts: Record<string,number>; omitted: string[]; warnings: string[]; error?: string;
}
type Kind = 'python-v2' | 'python-v3' | 'rust-v5';
const text = (value: unknown, fallback = '') => value === undefined || value === null ? fallback : String(value);
function number(value: unknown, fallback: number | null = null): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER) throw new Error('Legacy numeric value is outside the supported range');
  return parsed;
}
function date(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return '';
}
function tableNames(db: DatabaseSync): Set<string> {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row['name'])));
}
function detect(db: DatabaseSync, tables: Set<string>): Kind {
  if (tables.has('converted_archives')) return 'python-v2';
  const version = tables.has('schema_migrations') ? Number(db.prepare('SELECT max(version) AS version FROM schema_migrations').get()!['version']) : 0;
  if (tables.has('libraries') && tables.has('archives') && tables.has('jobs')) {
    if (tables.has('conversion_profiles') && version >= 1 && version <= 15) return 'python-v3';
    if (tables.has('policies') && tables.has('job_archive_outcomes') && version >= 1 && version <= 3) return 'rust-v5';
  }
  throw new Error('Unrecognized or unsupported source database schema');
}
function insert(db: DatabaseSync, table: string, record: Record<string,SQLInputValue>): number {
  const keys = Object.keys(record);
  return Number(db.prepare('INSERT INTO ' + table + '(' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')').run(...Object.values(record)).lastInsertRowid);
}
function sourceRows(db: DatabaseSync, tables: Set<string>, table: string): Iterable<Row> {
  return tables.has(table) ? db.prepare('SELECT * FROM ' + table).iterate() as Iterable<Row> : [];
}
function importedPath(value: unknown, root: string): string {
  const path = text(value);
  if (!path) throw new Error('Archive history contains a missing path');
  return relativePath(isAbsolute(path) ? relative(root, path).replaceAll('\\','/') : path.replaceAll('\\','/'));
}
function acceptedLossy(row: Row): boolean {
  return ['converted','optimized'].includes(text(row['outcome'] ?? row['status']).toLowerCase()) &&
    (text(row['mode']).toLowerCase() === 'lossy' || Number(row['distance'] ?? 0) > 0);
}

function importRecords(source: DatabaseSync, target: DatabaseSync, kind: Kind, tables: Set<string>, options: MigrationOptions, report: MigrationReport): void {
  const libraryRoots = new Map<string,string>();
  const sourceLibraries = [...sourceRows(source,tables,'libraries')];
  for (const row of sourceLibraries) {
    const id = text(row['id']);
    if (!id) throw new Error('Library identity is missing');
    const oldRoot = text(row['root_path']);
    const mapped = options.maps?.[oldRoot] ?? (sourceLibraries.length === 1 ? options.sourceRoot : oldRoot);
    insert(target,'libraries',{id,name:text(row['name'],'Library'),root_path:resolve(mapped),enabled:Number(row['enabled'] ?? 1) ? 1 : 0,legacy_json:json(row)});
    libraryRoots.set(id,oldRoot);
  }
  if (!libraryRoots.size) {
    const oldRoot=Object.keys(options.maps ?? {})[0] ?? options.sourceRoot;
    insert(target,'libraries',{id:'main',name:'Comics',root_path:resolve(options.maps?.[oldRoot] ?? options.sourceRoot),enabled:1,legacy_json:'{}'});
    libraryRoots.set('main',oldRoot);
  }
  const primary = libraryRoots.keys().next().value!;
  if (libraryRoots.size > 1 && !target.prepare('SELECT 1 FROM libraries WHERE root_path=?').get(resolve(options.sourceRoot))) {
    throw new Error('Multiple legacy libraries require --map OLD_ROOT=SOURCE_DIR for the active library');
  }
  // shortcut: ID maps use memory proportional to history; use temporary SQL maps for multi-million-row imports.
  const archives = new Map<string,string>();
  const byPath = new Map<string,string>();
  const runIds = new Set<string>();
  const resultIds = new Map<string,number>();
  const resultByRunPath = new Map<string,number>();
  const archiveTable = kind === 'python-v2' ? 'converted_archives' : 'archives';
  for (const row of sourceRows(source,tables,archiveTable)) {
    const library = text(row['library_id'],primary);
    if (!libraryRoots.has(library)) throw new Error('Archive references a missing library');
    const path = importedPath(row['path'],libraryRoots.get(library)!);
    const id = text(row['id'],randomUUID());
    const created = date(row['created_at'],row['converted_at']);
    const lossy = Number(row['lossy_pages'] ?? 0) > 0;
    insert(target,'archives',{
      id,library_id:library,path,location:'source',status:text(row['status'],'imported'),
      baseline_size:number(row['baseline_size'] ?? row['original_size']),
      size:number(row['current_size'] ?? row['final_size']),
      fingerprint:null,mtime_ms:row['mtime_ns'] !== undefined && row['mtime_ns'] !== null ? Number(BigInt(text(row['mtime_ns'])) / 1000000n) : number(row['archive_mtime']) === null ? null : number(row['archive_mtime'])! * 1000,
      lossy_state:lossy?'lossy':'unknown',converted_pages:number(row['converted_pages'],0),
      created_at:created,updated_at:date(row['updated_at'],row['converted_at']),legacy_json:json(row),
    });
    archives.set(text(row['id'],path),id);byPath.set(library+'\0'+path,id);
    const review = text(row['review_status']);
    if ((review && !['open','unreviewed','none'].includes(review)) || row['review_note'] || row['reviewed_at']) insert(target,'issues',{
      archive_id:id,kind:'imported_review',message:'Imported archive decision requires a fresh review',
      state:'needs_review',note:text(row['review_note']),created_at:created,updated_at:now(),details_json:json({review_status:review,reviewed_at:row['reviewed_at']}),
    });
    if (kind === 'python-v2' && row['error_message']) insert(target,'issues',{
      archive_id:id,kind:'imported_issue',message:text(row['error_message']),state:'needs_review',
      created_at:created,updated_at:now(),details_json:json(row),
    });
  }
  const jobTable = kind === 'python-v2' ? 'runs' : 'jobs';
  for (const row of sourceRows(source,tables,jobTable)) {
    const id=text(row['id']);if (!id) throw new Error('Job history contains a missing identity');
    const library=text(row['library_id'],primary);
    if (!libraryRoots.has(library)) throw new Error('Job references a missing library');
    const status=text(row['status'],'imported');
    insert(target,'runs',{id,library_id:library,source:'import',status:['queued','running','stopping'].includes(status)?'interrupted':status,
      policy_json:text(row['policy_json'] ?? row['options_json'],'{}'),scope:'imported',
      queued_at:date(row['queued_at'],row['created_at'],row['started_at']),started_at:date(row['started_at'])||null,finished_at:date(row['finished_at'])||null,
      found:number(row['archives_found'],0),checked:Number(row['processed'] ?? 0)+Number(row['skipped'] ?? 0)+Number(row['failed'] ?? 0),
      optimized:number(row['processed'],0),unchanged:number(row['skipped'],0),failed:number(row['failed'],0),
      bytes_saved:number(row['net_bytes_saved'] ?? row['bytes_saved'],0),error:row['error_message']===undefined?null:text(row['error_message']),legacy_json:json(row)});
    runIds.add(id);
  }
  const outcomeTable=kind==='rust-v5'?'job_archive_outcomes':'archive_results';
  for (const row of sourceRows(source,tables,outcomeTable)) {
    const run=text(row['job_id'] ?? row['run_id']);
    const archiveId=archives.get(text(row['archive_id']));
    const knownArchive=archiveId?target.prepare('SELECT library_id FROM archives WHERE id=?').get(archiveId):undefined;
    const knownRun=runIds.has(run)?target.prepare('SELECT library_id FROM runs WHERE id=?').get(run):undefined;
    const library=text(row['library_id']??knownArchive?.['library_id']??knownRun?.['library_id'],primary);
    const path=importedPath(row['path'],libraryRoots.get(library) ?? options.sourceRoot);
    const archive=archiveId ?? byPath.get(library+'\0'+path);
    const id=insert(target,'results',{run_id:runIds.has(run)?run:null,archive_id:archive??null,path,
      outcome:text(row['outcome'] ?? row['status'],'unknown'),mode:row['mode']===undefined&&row['conversion_mode']===undefined?null:text(row['mode']??row['conversion_mode']),
      source_size:number(row['source_size']??row['original_size']),final_size:number(row['final_size']),
      bytes_saved:number(row['bytes_saved'],0),created_at:date(row['created_at'],row['converted_at']),details_json:json(row)});
    resultIds.set(text(row['id'],String(id)),id);resultByRunPath.set(run+'\0'+path,id);
  }
  const pageTable=kind==='rust-v5'?'page_outcomes':'page_decisions';
  for (const row of sourceRows(source,tables,pageTable)) {
    const entry=text(row['entry_path']);if(!entry) throw new Error('Page history contains a missing entry path');
    const sourceArchive=archives.get(text(row['archive_id']));
    const matched=sourceArchive ? target.prepare('SELECT id FROM results WHERE run_id=? AND archive_id=? ORDER BY id DESC LIMIT 1').get(text(row['job_id']),sourceArchive) : undefined;
    const result=kind==='rust-v5'?resultIds.get(text(row['job_outcome_id'])):matched?Number(matched['id']):resultByRunPath.get(text(row['job_id'])+'\0'+text(row['path']).replaceAll('\\','/'));
    const resultRow=result?target.prepare('SELECT archive_id,outcome FROM results WHERE id=?').get(result):undefined;
    const archive=archives.get(text(row['archive_id'])) ?? (resultRow?.['archive_id'] as string|undefined);
    insert(target,'pages',{result_id:result??null,archive_id:archive??null,entry_path:entry,source_format:row['source_format']===undefined?null:text(row['source_format']),
      outcome:text(row['outcome'],'unknown'),mode:row['mode']===undefined?null:text(row['mode']),distance:number(row['distance']),effort:number(row['effort']),
      source_size:number(row['source_size']),final_size:number(row['final_size']),created_at:date(row['created_at']),details_json:json(row)});
    if(archive && acceptedLossy(row) && (!resultRow||['processed','converted','optimized'].includes(text(resultRow['outcome']).toLowerCase()))) target.prepare("UPDATE archives SET lossy_state='lossy' WHERE id=?").run(archive);
  }
  for(const table of [kind==='rust-v5'?'issues':'archive_issues','review_actions']) for(const row of sourceRows(source,tables,table)){
    const archive=archives.get(text(row['archive_id']));
    insert(target,'issues',{archive_id:archive??null,kind:table==='review_actions'?'imported_review':text(row['kind'],'imported_issue'),
      message:table==='review_actions'?'Previous review action requires a fresh review':text(row['message'],'Imported issue'),
      state:'needs_review',note:text(row['note']),created_at:date(row['created_at']),updated_at:now(),details_json:json(row)});
  }
  const snapshotTable=kind==='rust-v5'?'library_snapshots':'library_stat_snapshots';
  for(const row of sourceRows(source,tables,snapshotTable)){
    const library=text(row['library_id'],primary);
    insert(target,'snapshots',{library_id:libraryRoots.has(library)?library:null,recorded_at:date(row['recorded_at']),
      archive_count:number(row['archive_count']),current_bytes:number(row['current_bytes']),saved_bytes:number(row['net_bytes']),
      formats_json:null,details_json:json(row)});
  }
  for(const table of ['libraries','archives','runs','results','pages','issues','snapshots']){
    report.counts[table]=Number(target.prepare('SELECT count(*) AS count FROM '+table).get()!['count']);
  }
  for(const library of libraryRoots.keys()){
    const savings=target.prepare('SELECT coalesce(sum(baseline_size-size),0) AS saved FROM archives WHERE library_id=? AND baseline_size IS NOT NULL AND size IS NOT NULL').get(library)!['saved'];
    insert(target,'meta',{key:'imported_savings:'+library,value:json(Number(savings))});
  }
  for(const [sourceTable,targetTable] of [[archiveTable,'archives'],[jobTable,'runs'],[outcomeTable,'results'],[pageTable,'pages'],[snapshotTable,'snapshots']]){
    const expected=tables.has(sourceTable!)?Number(source.prepare('SELECT count(*) AS count FROM '+sourceTable).get()!['count']):0;
    if(report.counts[targetTable!]!==expected) throw new Error('History count mismatch for '+sourceTable);
  }
  report.warnings.push('Imported archives retain conservative lossy protection; prior reviews require reassessment.');
  if(kind==='python-v2') report.warnings.push('This legacy format has no per-page history; it was not invented.');
  report.warnings.push('Current-only format inventory is rebuilt by scanning; historical format mixes are not inferred.');
}

async function companions(source: string): Promise<Map<string,Identity>> {
  const result=new Map<string,Identity>();
  for(const path of [source,source+'-wal',source+'-shm']) if(await exists(path)) result.set(path,await identity(path));
  return result;
}

export async function migrate(options: MigrationOptions): Promise<MigrationReport> {
  const sourcePath=resolve(options.source),targetPath=await canonicalDestination(options.target);
  const reportPath=targetPath+'.migration.json';
  if(sourcePath===targetPath) throw new Error('Source and destination databases must be different');
  if(!await exists(sourcePath)){
    if(await exists(reportPath)&&await exists(targetPath)){
      const receipt=JSON.parse(await readFile(reportPath,'utf8')) as MigrationReport;
      if(receipt.source===sourcePath&&receipt.target===targetPath&&['prepared','published','completed'].includes(receipt.status)){
        if(receipt.sourceRoot!==resolve(options.sourceRoot)||json(receipt.mappings)!==json(Object.fromEntries(Object.entries(options.maps??{}).sort(([a],[b])=>a.localeCompare(b)))))throw new Error('Migration mappings changed; recovery refused');
        const release=lockDatabasePath(targetPath);
        try{
        const existing=new DatabaseSync(targetPath,{readOnly:true,timeout:5000});
        try{verifyDatabase(existing);if(!existing.prepare('SELECT 1 FROM imports WHERE digest=?').get(receipt.sourceDigest))throw new Error('Migration receipt does not match destination');}
        finally{existing.close();}
        if(receipt.status!=='completed'){
          if(receipt.targetDigest!==await hashFile(targetPath))throw new Error('Destination changed before migration cleanup completed');
          if(options.dryRun)return {...receipt,status:'dry_run',sourceRemoved:true};
          receipt.status='completed';receipt.sourceRemoved=true;receipt.finishedAt=now();
          for(const suffix of ['-wal','-shm'])if(await exists(sourcePath+suffix))receipt.warnings.push('Source is removed; an unverified residual sidecar was retained: '+sourcePath+suffix);
          await atomicJson(reportPath,receipt);
        }
        return receipt;
        }finally{release();}
      }
    }
    throw new Error('Source database not found: '+sourcePath);
  }
  const sourceIdentity=await identity(sourcePath);
  if(await exists(targetPath)){
    const targetIdentity=await identity(targetPath);
    if(sourceIdentity.dev===targetIdentity.dev&&sourceIdentity.ino===targetIdentity.ino) throw new Error('Source and destination must not be aliases');
  }
  const mappings=Object.fromEntries(Object.entries(options.maps ?? {}).sort(([a],[b])=>a.localeCompare(b)));
  const report:MigrationReport={version:1,source:sourcePath,target:targetPath,sourceKind:'unknown',sourceDigest:'',sourceRoot:resolve(options.sourceRoot),mappings,status:options.dryRun?'dry_run':'failed',sourceRemoved:false,startedAt:now(),counts:{},omitted:['saved_policies','schedules','diagnostic_events','progress_samples','derived_caches','current_format_inventory'],warnings:[]};
  let source:DatabaseSync|undefined,target:DatabaseSync|undefined;
  const unlock=lockDatabasePath(targetPath);
  let workspace:string|undefined;
  try{
    workspace=await mkdtemp(resolve(dirname(targetPath),'.cbzxl-migrate-'));
    // Exclusive WAL locking needs a writable handle; no source SQL is changed.
    source=new DatabaseSync(sourcePath,{readOnly:options.dryRun??false,timeout:5000,readBigInts:true});
    source.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
    const protectedFiles=await companions(sourcePath);
    const snapshot=resolve(workspace,'source.sqlite3');
    await backup(source,snapshot);
    const snapshotDb=new DatabaseSync(snapshot,{readOnly:true,readBigInts:true});
    try{
      const integrity=snapshotDb.prepare('PRAGMA integrity_check').all();
      if(integrity.length!==1||Object.values(integrity[0]!)[0]!=='ok') throw new Error('Source database failed integrity verification');
      const tables=tableNames(snapshotDb),kind=detect(snapshotDb,tables);
      report.sourceKind=kind;report.sourceDigest=await hashFile(snapshot);
      for(const pending of ['archive_commit_intents','commit_intents']) if(tables.has(pending)&&Number(snapshotDb.prepare('SELECT count(*) AS count FROM '+pending).get()!['count'])>0) throw new Error('Reconcile pending archive replacements with the old application before migration');
      if(await exists(targetPath)){
        const existing=new DatabaseSync(targetPath,{readOnly:true,timeout:5000});
        try{
          if(Number(existing.prepare('PRAGMA application_id').get()!['application_id'])!==SCHEMA_ID) throw new Error('Destination already exists and is unrelated');
          verifyDatabase(existing);
          const imported=existing.prepare('SELECT report_json FROM imports WHERE digest=?').get(report.sourceDigest);
          if(!imported) throw new Error('Destination already exists; histories will not be merged');
          const receipt=JSON.parse(await readFile(reportPath,'utf8')) as MigrationReport;
          if(receipt.source!==sourcePath||receipt.sourceDigest!==report.sourceDigest||receipt.targetDigest!==await hashFile(targetPath)||receipt.sourceRoot!==report.sourceRoot||json(receipt.mappings)!==json(mappings)) throw new Error('Destination, mapping, or migration receipt changed; source cleanup refused');
          Object.assign(report,receipt);
        }finally{existing.close();}
      }else{
        const staging=resolve(workspace,'target.sqlite3');
        target=openDatabase(staging);
        transaction(target,()=>{
          importRecords(snapshotDb,target!,kind,tables,options,report);
          verifyDatabase(target!);
          insert(target!,'imports',{digest:report.sourceDigest,source_path:sourcePath,source_kind:kind,imported_at:now(),report_json:json(report)});
        });
        verifyDatabase(target);
        target.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
        target.close();target=undefined;
        if(options.dryRun){report.status='dry_run';report.finishedAt=now();return report;}
        await syncFile(staging);
        report.targetDigest=await hashFile(staging);
        if(await exists(reportPath)){
          const prior=JSON.parse(await readFile(reportPath,'utf8')) as MigrationReport;
          if(prior.sourceDigest!==report.sourceDigest) throw new Error('An existing migration receipt belongs to a different source');
        }
        report.status='prepared';
        await atomicJson(reportPath,report);
        await fs.link(staging,targetPath);
        await syncDirectory(dirname(targetPath));
        report.status='published';
        await atomicJson(reportPath,report);
      }
      if(options.dryRun){return {...report,status:'dry_run',sourceRemoved:false};}
      for(const [path,before] of protectedFiles) if(!sameIdentity(before,await identity(path))) throw new Error('Source changed during migration; cleanup refused');
      await fs.unlink(sourcePath);
      report.sourceRemoved=true;
      source.close();source=undefined;
      for(const [path,before] of protectedFiles) if(path!==sourcePath&&await exists(path)){
        const after=await identity(path);
        if(after.dev===before.dev&&after.ino===before.ino) await fs.unlink(path);
      }
      await syncDirectory(dirname(sourcePath));
      report.status='completed';report.finishedAt=now();
      await atomicJson(reportPath,report);
      return report;
    }finally{snapshotDb.close();}
  }catch(error){
    report.status='failed';report.error=error instanceof Error?error.message:String(error);report.finishedAt=now();
    if(!options.dryRun) await atomicJson(targetPath+'.migration-failed-'+randomUUID()+'.json',report);
    throw error;
  }finally{
    target?.close();source?.close();unlock();
    if(workspace) await rm(workspace,{recursive:true,force:true});
  }
}
