import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { ArchiveError, imageFormat } from './archive.ts';
import type { ArchiveEntry } from './archive.ts';
import type { Config, Policy } from './config.ts';
import { hashFile } from './files.ts';

export interface Tools { encoder:string; decoder:string; imagemagick:string; }
export interface PageResult {
  entry:string; outputEntry:string; sourceFormat:string; sourceSize:number; finalSize:number;
  outcome:'converted'|'retained'|'unchanged'|'failed'; mode?:'lossless'|'lossy';
  distance?:number; effort?:number; reason?:string;
}
interface ImageInfo { width:number; height:number; depth:number; colorspace:string; orientation:string; profiles:string; }

async function command(binary:string,args:string[],config:Config,signal?:AbortSignal,hashOutput=false):Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],
      env:{...process.env,MAGICK_TEMPORARY_PATH:config.scratch,MAGICK_THREAD_LIMIT:String(config.threads),OMP_NUM_THREADS:String(config.threads)}});
    const hash=createHash('sha256');let stdout='',stderr='',settled=false,cancelled=false,timedOut=false;
    function kill(){
      if(child.pid){try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH') child.kill('SIGKILL');}}
    }
    const abort=()=>{cancelled=true;kill();};
    signal?.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(()=>{timedOut=true;kill();},config.commandSeconds*1000);
    child.stdout.on('data',(chunk:Buffer)=>{if(hashOutput)hash.update(chunk);else stdout=(stdout+chunk.toString()).slice(-65536);});
    child.stderr.on('data',(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-65536);});
    const finish=(error?:Error)=>{
      if(settled)return;settled=true;clearTimeout(timeout);signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(hashOutput?hash.digest('hex'):stdout);
    };
    child.on('error',finish);
    child.on('close',code=>{
      if(cancelled) finish(new DOMException('Conversion cancelled','AbortError'));
      else if(timedOut) finish(new Error(binary+' exceeded the command timeout'));
      else if(code!==0) finish(new Error(binary+' failed: '+stderr.trim().slice(-4000)));
      else finish();
    });
  });
}

export async function findTools(config:Config):Promise<Tools> {
  const tools={encoder:'cjxl',decoder:'djxl',imagemagick:'magick'};
  await command(tools.encoder,['--version'],config);
  await command(tools.decoder,['--version'],config);
  try{await command('magick',['-version'],config);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;tools.imagemagick='convert';await command('convert',['-version'],config);}
  return tools;
}
function imageArgs(config:Config):string[] {
  return ['-limit','memory',config.memoryMb+'MiB','-limit','map','0','-limit','disk',Math.min(config.memoryMb*4,32768)+'MiB','-limit','thread',String(config.threads)];
}
async function info(path:string,tools:Tools,config:Config,signal?:AbortSignal):Promise<ImageInfo>{
  const args=tools.imagemagick==='magick'?['identify','-ping','-format','%w|%h|%z|%[colorspace]|%[orientation]|%[profiles]\n',path]:['-ping',path,'-format','%w|%h|%z|%[colorspace]|%[orientation]|%[profiles]\n','info:'];
  const output=await command(tools.imagemagick,args,config,signal);
  const frames=output.trim().split('\n');
  if(frames.length!==1) throw new ArchiveError('unsupported','Multi-frame images are kept unchanged');
  const [width,height,depth,colorspace,orientation,profiles]=frames[0]!.split('|');
  const result={width:Number(width),height:Number(height),depth:Number(depth),colorspace:colorspace??'',orientation:orientation??'',profiles:profiles??''};
  if(!Number.isSafeInteger(result.width)||!Number.isSafeInteger(result.height)||result.width<=0||result.height<=0) throw new Error('Image dimensions are unavailable');
  if(result.width*result.height*64>config.memoryMb*1024**2) throw new ArchiveError('resource','Image exceeds the configured processing memory budget');
  return result;
}
function dimensions(value:ImageInfo):string {
  return ['LeftTop','RightTop','RightBottom','LeftBottom'].includes(value.orientation)?value.height+'x'+value.width:value.width+'x'+value.height;
}
async function pixelHash(path:string,tools:Tools,config:Config,signal?:AbortSignal):Promise<string>{
  return command(tools.imagemagick,[...imageArgs(config),path,'-auto-orient','-depth','16','rgba:-'],config,signal,true);
}
async function profileHash(path:string,image:ImageInfo,output:string,tools:Tools,config:Config,signal?:AbortSignal):Promise<string|null>{
  if(!image.profiles.toLowerCase().includes('icc')) return null;
  await command(tools.imagemagick,[...imageArgs(config),path,'ICC:'+output],config,signal);
  return hashFile(output,signal);
}

export async function convertPage(entry:ArchiveEntry,output:string,policy:Policy,tools:Tools,config:Config,signal?:AbortSignal):Promise<{entry:ArchiveEntry;result:PageResult}> {
  const result:PageResult={entry:entry.name,outputEntry:entry.name,sourceFormat:entry.format,sourceSize:entry.size,finalSize:entry.size,outcome:'unchanged'};
  if(!['JPEG','PNG','TIFF','BMP'].includes(entry.format)) return {entry,result};
  if(!entry.path) throw new Error('Image has no workspace file');
  if(/\.jxl$/i.test(entry.name)) return {entry,result:{...result,reason:'A .jxl entry with a different signature was preserved for review',outcome:'failed'}};
  let sourceInfo:ImageInfo;
  try{sourceInfo=await info(entry.path,tools,config,signal);}
  catch(error){
    if(/corrupt|insufficient image data|premature end|improper image header|invalid jpeg|crc error/i.test((error as Error).message)) throw new ArchiveError('invalid','Source image could not be decoded: '+entry.name);
    throw error;
  }
  if(sourceInfo.depth>16||(!/^(s?rgb|gray)$/i.test(sourceInfo.colorspace)&&entry.format!=='JPEG')){
    return {entry,result:{...result,outcome:'retained',reason:'This colour space or bit depth is preserved without conversion'}};
  }
  let input=entry.path;
  if(entry.format==='TIFF'||entry.format==='BMP'){
    input=output+'.png';
    // Explicit RGBA PNG avoids palette conversion rounding 16-bit transparency.
    await command(tools.imagemagick,[...imageArgs(config),entry.path,'-auto-orient','-define','png:preserve-iCCP=true',(sourceInfo.depth>8?'PNG64:':'PNG32:')+input],config,signal);
    if(await pixelHash(entry.path,tools,config,signal)!==await pixelHash(input,tools,config,signal)) throw new ArchiveError('verification','Image preparation changed decoded pixels');
  }
  const args=[input,output,'--distance='+policy.distance,'--effort='+policy.effort,'--num_threads='+config.threads,'--container=1','--quiet'];
  if(entry.format==='JPEG') args.push('--lossless_jpeg='+(policy.mode==='lossless'?'1':'0'));
  await command(tools.encoder,args,config,signal);
  const candidateSize=(await stat(output)).size;
  if(candidateSize>=entry.size) return {entry,result:{...result,outcome:'retained',reason:'Candidate was not smaller',mode:policy.mode,distance:policy.distance,effort:policy.effort}};
  const handle=await open(output,'r');
  const header=Buffer.alloc(32);
  try{await handle.read(header,0,header.length,0);}finally{await handle.close();}
  if(imageFormat(header)!=='JPEG XL') throw new ArchiveError('verification','Encoder output is not JPEG XL');
  const decoded=output+(entry.format==='JPEG'&&policy.mode==='lossless'?'.jpg':'.png');
  await command(tools.decoder,[output,decoded,'--quiet'],config,signal);
  if(entry.format==='JPEG'&&policy.mode==='lossless'){
    if(await hashFile(decoded,signal)!==entry.hash) throw new ArchiveError('verification','JPEG reconstruction does not match the original');
  }else{
    const decodedInfo=await info(decoded,tools,config,signal);
    if(dimensions(sourceInfo)!==dimensions(decodedInfo)) throw new ArchiveError('verification','Candidate changed image dimensions or orientation');
    if(policy.mode==='lossless'&&await pixelHash(entry.path,tools,config,signal)!==await pixelHash(decoded,tools,config,signal)) throw new ArchiveError('verification','Lossless candidate changed decoded pixels');
    const sourceProfile=await profileHash(entry.path,sourceInfo,output+'.source.icc',tools,config,signal);
    const decodedProfile=await profileHash(decoded,decodedInfo,output+'.decoded.icc',tools,config,signal);
    if(sourceProfile!==decodedProfile) throw new ArchiveError('verification','Candidate did not preserve the colour profile');
  }
  const name=entry.name.replace(/\.[^/.]+$/,'')+'.jxl';
  return {entry:{...entry,name,path:output,size:candidateSize,hash:await hashFile(output,signal),format:'JPEG XL',compressed:false},
    result:{...result,outputEntry:name,finalSize:candidateSize,outcome:'converted',mode:policy.mode,distance:policy.distance,effort:policy.effort}};
}
