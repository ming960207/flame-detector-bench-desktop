import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const numeric = value => value === '-' || value === '' ? null : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
export function archiveMayContainDate(name, date) {
  const utc = name.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z-/);
  if (utc) return new Date(Date.UTC(...[+utc[1], +utc[2] - 1, +utc[3], +utc[4] + 8, +utc[5], +utc[6]])).toISOString().slice(0, 10) === date;
  const local = name.match(/^(\d{4})(\d\d)(\d\d)_\d{6}$/);
  return !!local && `${local[1]}-${local[2]}-${local[3]}` === date;
}
function table(text, title, columns) {
  const part = text.replaceAll('\r\n', '\n').split(`\n${title}\n`)[1];
  if (!part) throw new Error(`日志缺少“${title}”`);
  const rows = []; let started = false;
  for (const line of part.split('\n')) {
    if (line.startsWith('|')) {
      started = true; const row = line.split('|').slice(1, -1).map(x => x.trim());
      if (row.every(x => /^-+$/.test(x))) continue;
      if (row.length !== columns) throw new Error(`“${title}”列数不符`);
      rows.push(row);
    } else if (started) break;
  }
  if (rows.length < 2) throw new Error(`“${title}”没有数据行`);
  return rows.slice(1).map(row => row.map(numeric));
}
export function parseLog(text, archive) {
  const time = text.match(/完成时间：([^（\r\n]+)/)?.[1].trim();
  const batch = text.match(/批次：([^|\r\n]+)/)?.[1].trim();
  if (!time || !batch) throw new Error(`${archive} 缺少完成时间或批次`);
  return { time, batch, archive, noise: table(text, '噪声采集诊断', 8), stages: table(text, '工序检测明细', 10) };
}
function run(exe, args, options = {}) {
  try { return execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }); }
  catch (e) { throw new Error(`${exe} 执行失败：${String(e.stderr || e.message).trim()}`); }
}
function office(args) {
  const launcher = run('where.exe',['genoffice.cmd']).split(/\r?\n/).find(Boolean);
  if (!launcher) throw new Error('未找到 GenOffice CLI');
  const cliDir = path.dirname(launcher); const executable=path.resolve(cliDir,'..','..','GenOffice.exe');
  const r = spawnSync(executable, [path.join(cliDir,'genoffice.cjs'),...args], { encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'} });
  let parsed; try { parsed = JSON.parse(r.stdout); } catch { throw new Error(`GenOffice 调用失败：${r.stderr || r.stdout || r.error?.message}`); }
  if (r.status !== 0 || parsed.status !== 'ok') throw new Error(`GenOffice：${parsed.message || parsed.error || r.stderr}`);
  return parsed;
}
export function createWorkbook(records, output, scratch) {
  const sheets = [
    ['噪声数据', [['测试完成时间（北京时间）','批次','设备','采样数','P2 RAW 10秒最大波动','P2 RAW绝对值','P3 RAW 10秒最大波动','P3 RAW绝对值','结果','说明'], ...records.flatMap(r => r.noise.map(row => [r.time, r.batch, ...row]))]],
    ['工序比值', [['测试完成时间（北京时间）','批次','工序','设备','采样数','干扰比','一致性','P2/P1','P2/P3','P3/P1','结果','说明'], ...records.flatMap(r => r.stages.map(row => [r.time, r.batch, ...row]))]],
    ['批次索引', [['测试完成时间（北京时间）','批次','归档目录'], ...records.map(r => [r.time,r.batch,r.archive])]],
    ['数据说明', [['字段','说明'],['时间','记录中的测试完成时间，Asia/Shanghai（UTC+8）。'],['正式噪声','RAW 10秒滚动波动值=(max-min)/2 的全过程最大值，以及 RAW 绝对值。'],['工序比值','按日志记录的热源、爆闪及其他工序原值列示。'],['设备编号','表示测试位，不能据此认定跨批次为同一物理探头。'],['数据范围','仅包含执行时 GitHub 对应分支上已上传且完成时间属于所选日期的日志。']]],
  ];
  const data = path.join(scratch, 'data.json'); const opsFile = path.join(scratch, 'ops.json');
  fs.writeFileSync(data, JSON.stringify(sheets[0][1]), 'utf8');
  office(['create','--type','xlsx','--from',data,'--out',output,'--json']);
  let ops = [{op:'rename_sheet',name:sheets[0][0]}, ...sheets.slice(1).map(([name])=>({op:'add_sheet',name}))];
  fs.writeFileSync(opsFile, JSON.stringify(ops), 'utf8'); office(['sheet','apply',output,'--ops',opsFile,'--json']);
  for (const [name, rows] of sheets.slice(1)) {
    const chunkSize=Math.floor(1500/rows[0].length);
    for(let i=0;i<rows.length;i+=chunkSize){fs.writeFileSync(opsFile,JSON.stringify([{op:'set_range',sheet:name,start:`A${i+1}`,values:rows.slice(i,i+chunkSize)}]),'utf8');office(['sheet','apply',output,'--ops',opsFile,'--json']);}
  }
  ops = [];
  for (const [name, rows] of sheets) {
    const last = String.fromCharCode(64 + rows[0].length);
    ops.push({op:'format_range',sheet:name,range:`A1:${last}1`,format:{bold:true,fillColor:'#17476B',fontColor:'#FFFFFF',wrapText:true}},
      {op:'set_freeze',sheet:name,rows:1,columns:0}, {op:'set_col_width',sheet:name,column:'A',widthPx:180},
      {op:'set_col_width',sheet:name,column:'B',widthPx:name === '数据说明'?700:250});
    if (name !== '数据说明') {ops.push({op:'set_filter',sheet:name,range:`A1:${last}${rows.length}`}); for(let i=2;i<rows[0].length;i++)ops.push({op:'set_col_width',sheet:name,column:String.fromCharCode(65+i),widthPx:i===rows[0].length-1?270:130});}
  }
  fs.writeFileSync(opsFile, JSON.stringify(ops), 'utf8'); office(['sheet','apply',output,'--ops',opsFile,'--json']);
  const check = office(['sheet','check',output,'--json']); if (check.detail?.issues?.some(x=>x.level==='error')) throw new Error('Excel 检查发现错误');
}
function main() {
  const args = process.argv.slice(2); const dateArg = args.indexOf('--date');
  if (args.some((x,i)=>x!=='--date' && i!==dateArg+1) || (dateArg>=0 && !args[dateArg+1])) throw new Error('用法：node scripts/test-log-export.mjs [--date YYYY-MM-DD]');
  const date = dateArg >= 0 ? args[dateArg+1] : new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date) throw new Error('日期必须为有效的 YYYY-MM-DD');
  const config = JSON.parse(fs.readFileSync(path.join(project,'config/release-source.json'),'utf8')); const url = config.git.remoteUrl; const branch = config.branch;
  if (!url || !branch || !/^https:\/\/github\.com\//i.test(url)) throw new Error('config/release-source.json 中缺少 GitHub 地址或分支');
  const base = path.join(project,'test-log-exports'); fs.mkdirSync(base,{recursive:true});
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'flame-git-')); const cache=path.join(temp,'repo');
  try {
  console.log(`正在从 GitHub 拉取 ${date} 的测试日志……`);
  run('git',['clone','--depth=1','--filter=blob:none','--no-checkout','--single-branch','--branch',branch,url,cache]);
  const names = run('git',['-C',cache,'ls-tree','--name-only','HEAD:diagnostic-logs']).split(/\r?\n/).filter(n=>archiveMayContainDate(n,date));
  if (!names.length) throw new Error(`${date} 没有找到已上传的日志归档`);
  const stamp = new Date(Date.now()+8*3600000).toISOString().replace(/[-:.TZ]/g,'').slice(0,14); let dest=path.join(base,`${date}_${stamp}`); let suffix=1; while(fs.existsSync(dest))dest=path.join(base,`${date}_${stamp}_${suffix++}`); fs.mkdirSync(dest);
  run('git',['-C',cache,'sparse-checkout','init','--no-cone']);
  run('git',['-C',cache,'sparse-checkout','set','--no-cone','--stdin'],{input:names.map(n=>`/diagnostic-logs/${n}/`).join('\n')+'\n'});
  run('git',['-C',cache,'checkout']);
  const selected=[];
  for (const name of names) {
    const tree=`HEAD:diagnostic-logs/${name}`;
    const entries=run('git',['-C',cache,'ls-tree','-r',tree]).split(/\r?\n/).filter(Boolean).map(line=>{const match=line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);if(!match)throw new Error(`无法解析归档 ${name}`);return {sha:match[1],file:match[2]};});
    const wanted=entries.filter(({file:f})=>f==='manifest.txt'||/^backend\/(test-results-.*\.log|detector-lifecycle\.log)$/.test(f));
    if(!wanted.some(({file})=>/^backend\/test-results-.*\.log$/.test(file)))throw new Error(`归档 ${name} 中未找到测试结果日志`);
    selected.push({name,wanted});
  }
  const records=[]; const seen=new Set();
  for (const {name,wanted} of selected) {
    for(const {file} of wanted){const data=fs.readFileSync(path.join(cache,'diagnostic-logs',name,...file.split('/')));const target=path.join(dest,'原始日志',name,...file.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
    const logs=wanted.map(x=>x.file).filter(f=>/^backend\/test-results-.*\.log$/.test(f));
    for(const file of logs){const text=fs.readFileSync(path.join(dest,'原始日志',name,...file.split('/')),'utf8');const record=parseLog(text,name); if(!record.time.startsWith(date))continue; if(seen.has(record.batch))throw new Error(`批次重复：${record.batch}，请检查原始日志`);seen.add(record.batch);records.push(record);}
  }
  if (!records.length) throw new Error(`${date} 的归档中没有该日期的测试结果；原始日志保存在 ${dest}`);
  records.sort((a,b)=>a.time.localeCompare(b.time));
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'flame-export-'));
  try { const output=path.join(dest,`火焰探测器测试数据_${date}.xlsx`);createWorkbook(records,output,scratch);console.log(`完成：${records.length} 个批次\nExcel：${output}\n原始日志：${path.join(dest,'原始日志')}`); }
  finally { fs.rmSync(scratch,{recursive:true,force:true}); }
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {try{main()}catch(e){console.error(`导出失败：${e.message}`);process.exitCode=1;}}
