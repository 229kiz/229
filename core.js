/* Pure, deterministic data checks. No network, no model calls. MIT licensed. */
(function(root){
'use strict';
const LABELS={do:'溶解氧',air:'供气量',temp:'温度',time:'时间'};
function parseCSV(text){
 text=String(text).replace(/^\uFEFF/,'');
 const first=text.split(/\r?\n/)[0];const delim=first.includes('\t')?'\t':(first.split(';').length>first.split(',').length?';':',');
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else if(quoted||field==='')quoted=!quoted;else field+=c;}else if(c===delim&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()!==''))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw new Error('CSV 引号未闭合，请检查文件。');row.push(field);if(row.some(v=>v.trim()!==''))rows.push(row);
 if(rows.length<2)throw new Error('CSV 至少需要表头和一行数据。');
 const headers=rows.shift().map(v=>v.trim());if(headers.some(v=>!v)||new Set(headers).size!==headers.length)throw new Error('表头必须非空且名称唯一。');
 if(rows.length>20000)throw new Error('演示版最多支持 20,000 行，请先按时间范围截取。');
 rows.forEach((r,i)=>{if(r.length!==headers.length)throw new Error(`第 ${i+2} 条 CSV 记录的列数与表头不符。`);});return{headers,rows};
}
function number(v){if(v==null||String(v).trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function timestamp(s){s=String(s||'').trim();if(!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(s))return null;const m=s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);const y=+m[1],mo=+m[2],d=+m[3];if(mo<1||mo>12||d<1||d>new Date(Date.UTC(y,mo,0)).getUTCDate()||+m[4]>23||+m[5]>59||+(m[6]||0)>59)return null;const t=Date.parse(s.replace(' ','T'));return Number.isFinite(t)?t:null;}
function median(a){if(!a.length)return null;a=[...a].sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;}
function validateConfig(map,cfg){if(!map.time)throw new Error('请先映射时间列。');if(!map.do&&!map.air&&!map.temp)throw new Error('请至少映射一项数值字段。');const chosen=Object.values(map).filter(Boolean);if(new Set(chosen).size!==chosen.length)throw new Error('每个字段必须对应不同的 CSV 列。');for(const k of ['do','air','temp']){const b=cfg.bounds[k];if(!b||!b.every(Number.isFinite)||b[0]>=b[1])throw new Error(`${LABELS[k]}的最小值必须小于最大值，且均为有效数字。`);}if(!Number.isFinite(cfg.flatMinutes)||cfg.flatMinutes<=0||!Number.isFinite(cfg.jumpRate)||cfg.jumpRate<=0)throw new Error('持续时间和突变阈值必须大于零。');}
function analyze(data,map,cfg){
 validateConfig(map,cfg);const keys=['do','air','temp'].filter(k=>map[k]);const indexes=Object.fromEntries(Object.entries(map).map(([k,v])=>[k,data.headers.indexOf(v)]));
 for(const k of ['time',...keys])if(indexes[k]<0)throw new Error('映射列不存在，请重新确认。');
 const records=data.rows.map((raw,i)=>{const vals={};for(const k of keys){let v=number(raw[indexes[k]]);if(v!==null){if(k==='do'&&cfg.units.do==='ug/L')v/=1000;if(k==='air'&&cfg.units.air==='m3/min')v*=60;if(k==='temp'&&cfg.units.temp==='F')v=(v-32)*5/9;}vals[k]=v;}return{i,raw,t:timestamp(raw[indexes.time]),v:vals};});
 const ordered=records.filter(r=>r.t!==null).sort((a,b)=>a.t-b.t||a.i-b.i);const gaps=[];for(let i=1;i<ordered.length;i++)if(ordered[i].t>ordered[i-1].t)gaps.push(ordered[i].t-ordered[i-1].t);const interval=median(gaps);const events=[];
 function add(type,key,rs,detail,advice,hard=false){if(!rs.length)return;events.push({id:`E${String(events.length+1).padStart(3,'0')}`,type,key,rows:[...new Set(rs.map(r=>r.i))],start:rs.find(r=>r.t!==null)?.t??null,end:[...rs].reverse().find(r=>r.t!==null)?.t??null,detail,advice,hard,status:'pending',note:''});}
 function grouped(key,pred,cb){let batch=[];for(const r of ordered){if(pred(r)){if(batch.length&&interval&&r.t-batch[batch.length-1].t>interval*1.5){cb(batch);batch=[];}batch.push(r);}else if(batch.length){cb(batch);batch=[];}}if(batch.length)cb(batch);const invalid=records.filter(r=>r.t===null&&pred(r));if(invalid.length)cb(invalid);}
 add('无效时间','time',records.filter(r=>r.t===null),'时间为空、格式不受支持或日期无效。','核对原始时间戳，使用 ISO 8601 时间。',true);
 const byTime=new Map();for(const r of ordered){if(!byTime.has(r.t))byTime.set(r.t,[]);byTime.get(r.t).push(r);}for(const rs of byTime.values())if(rs.length>1)add('重复时间','time',rs,`同一时间有 ${rs.length} 条记录。`,'确认是否重复导出，或不同测点被混在同一列。',true);
 let inversions=[];let prev=null;for(const r of records){if(r.t===null)continue;if(prev&&r.t<prev.t)inversions.push(prev,r);prev=r;}add('时间逆序','time',inversions,'原始记录存在时间倒序；图表已按时间排序，原始数据未变。','确认导出顺序；用于建模前需显式排序。',true);
 if(interval)for(let i=1;i<ordered.length;i++){const a=ordered[i-1],b=ordered[i];if(b.t-a.t>interval*1.5)add('采样断档','time',[a,b],`相邻记录相距 ${((b.t-a.t)/60000).toFixed(1)} 分钟；中位采样间隔 ${(interval/60000).toFixed(1)} 分钟。`,'检查采集或导出是否中断；间隔由数据估计，变频采样需人工解释。',true);}
 for(const key of keys){
 grouped(key,r=>r.v[key]===null,rs=>add('缺测 / 非数值',key,rs,`${rs.length} 条记录为空或不是有限数值。`,'核对采集与仪表状态；未知值不能自动当成零。',true));
 grouped(key,r=>r.v[key]!==null&&(r.v[key]<cfg.bounds[key][0]||r.v[key]>cfg.bounds[key][1]),rs=>add('范围越界',key,rs,`超出配置范围 [${cfg.bounds[key][0]}, ${cfg.bounds[key][1]}]，共 ${rs.length} 条。`,'先确认单位和规则范围，再核查仪表或实际工况。',true));
 let flat=[];function flush(){if(flat.length>=3&&(flat[flat.length-1].t-flat[0].t)/60000>=cfg.flatMinutes)add('持续卡值',key,flat,`读数 ${flat[0].v[key].toFixed(3)} 持续 ${((flat[flat.length-1].t-flat[0].t)/60000).toFixed(0)} 分钟不变（容差 0.000001）。`,'对照设备状态和其他测点；恒定读数也可能来自稳定工况。');flat=[];}
 for(const r of ordered){if(r.v[key]===null){flush();continue;}const p=flat[flat.length-1];if(p&&(Math.abs(r.v[key]-p.v[key])>1e-6||r.t<=p.t||(interval&&r.t-p.t>interval*1.5)))flush();flat.push(r);}flush();
 }
 if(keys.includes('do'))for(let i=1;i<ordered.length;i++){const a=ordered[i-1],b=ordered[i],dt=(b.t-a.t)/60000;if(dt>0&&(!interval||b.t-a.t<=interval*1.5)&&a.v.do!==null&&b.v.do!==null){const rate=Math.abs(b.v.do-a.v.do)/dt;if(rate>cfg.jumpRate)add('DO 突变','do',[a,b],`${a.v.do.toFixed(2)} → ${b.v.do.toFixed(2)} mg/L，变化速率 ${rate.toFixed(2)} mg/L/min。`,'结合供气、检修与负荷记录判断；不要直接删除真实工况变化。');}}
 const flagged=new Set(events.flatMap(e=>e.rows));const finite=records.reduce((n,r)=>n+keys.filter(k=>r.v[k]!==null).length,0);
 return{records,ordered,events,keys,interval,flagged:[...flagged],completeness:records.length?100*finite/(records.length*keys.length):0,config:JSON.parse(JSON.stringify(cfg)),mapping:{...map}};
}
function assessment(result){const pending=result.events.filter(e=>e.status==='pending').length;const bad=result.events.filter(e=>e.status==='data_error').length;const retainedHard=result.events.filter(e=>e.hard&&e.status==='process_change').length;let title,detail;
 if(bad){title='存在已确认异常，需处理后复检';detail='人工已确认数据异常。测量值尚未修复或删除，当前标记文件不能直接视作清洗后输入。';}
 else if(pending){title='建议先核查，再用于建模';detail='规则发现可疑片段。请核对单位、采集记录及工况，完成逐项判断；本工具不自动修改测量值。';}
 else if(retainedHard){title='已记录解释，仍需处理输入结构';detail='缺测、时间或越界等硬性标记仍存在。人工解释不会补齐数据或修正格式，请完成输入处理后复检。';}
 else{title=result.events.length?'人工核查已完成，可进入下一步验证':'未发现规则异常，可进入下一步验证';detail='仅表示本次检查没有待核查项。是否适合模型，还需确认测点位置、采样频率、校准情况和输入边界。';}
 if(!result.mapping.do)detail+=' 当前未映射 DO，不能评价曝气分区的溶解氧数据可用性。';
 if(result.records.length<12)detail+=' 数据少于 12 条，持续性检查证据不足。';
 return{title,detail,pending,bad,retainedHard};}
function demo(problem=true){const headers=['timestamp','DO_mg_L','airflow_m3_h','temperature_C'];const rows=[];const base=Date.parse('2026-06-01T00:00:00+02:00');for(let i=0;i<288;i++){const wave=Math.sin(i/14),fine=Math.sin(i*1.73);rows.push([new Date(base+i*300000).toISOString(),(2.2+.35*wave+.06*fine).toFixed(3),(650+70*Math.sin(i/18)+9*fine).toFixed(2),(19+1.1*Math.sin(i/58)+.015*fine).toFixed(3)]);}
 if(problem){for(let i=43;i<49;i++)rows[i][1]='';for(let i=110;i<=128;i++)rows[i][1]='2.100';rows[171][1]='7.500';rows[204][2]='-120';rows[205][2]='-115';rows[236][3]='65';rows.splice(261,0,[...rows[260]]);rows.splice(82,3);}
 return{headers,rows};}
function csvCell(v){let s=String(v??'');if(/^[\s]*[=+@]/.test(s)||(/^[\s]*-/.test(s)&&number(s)===null))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function toCSV(headers,rows){return '\uFEFF'+[headers,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n');}
const api={parseCSV,number,timestamp,analyze,assessment,demo,toCSV,LABELS};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.ADC=api;
})(typeof window!=='undefined'?window:globalThis);
