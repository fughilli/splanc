import fs from 'node:fs/promises';
import path from 'node:path';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const root=process.argv[2],out=path.join(root,'output/advertising-kit-20261008');
const d=JSON.parse(await fs.readFile(path.join(out,'pricing/pricing-model.json'),'utf8'));
const wb=Workbook.create();
const summary=wb.worksheets.add('Launch pricing'),cost=wb.worksheets.add('Cost model'),bom=wb.worksheets.add('MAX BOM');
const usd='"$"#,##0.00';
function base(sh,last){sh.showGridLines=false;sh.getRange(last).format.font={name:'Helvetica',size:11,color:'#202B35'};sh.getRange(last).format.rowHeight=24;}
function title(sh,text,subtitle){sh.getRange('A1').values=[[text]];sh.getRange('A1').format.font={size:19,bold:true};sh.getRange('A2').values=[[subtitle]];sh.getRange('A2').format.font={size:10,color:'#596571'};sh.getRange('A1:K1').format.rowHeight=32;}
function header(sh,rng,values){sh.getRange(rng).values=[values];sh.getRange(rng).format={fill:'#253343',font:{bold:true,color:'#FFFFFF'},rowHeight:34,wrapText:true};}
base(summary,'A1:I30');base(cost,'A1:F50');base(bom,`A1:L${d.max_bom.length+6}`);
title(summary,'Splanc launch pricing','Planning estimates · USD · 1,000 units per product · 8 October 2026');
summary.getRange('A:A').format.columnWidth=21;summary.getRange('B:I').format.columnWidth=16;
header(summary,'A5:I5',['Product','Unit cost','Launch price','Target margin','Gross margin','Target price','Low cost','High cost','After 8% fee']);
title(cost,'Unit cost model','Low / central / high estimates. Yellow cells are editable assumptions.');
cost.getRange('A:A').format.columnWidth=20;cost.getRange('B:B').format.columnWidth=53;cost.getRange('C:E').format.columnWidth=18;cost.getRange('F:F').format.columnWidth=52;
header(cost,'A5:F5',['Product','Cost category','Low USD','Central USD','High USD','Basis']);
title(bom,'MAX r11 component budget','Existing parts retained; isolated supply and three-port network stage added.');
header(bom,'A5:L5',['Section','Part / allowance','Qty / unit','Low each','Central each','High each','Low total','Central total','High total','Price basis','Source URL','Notes']);
bom.getRange('A:A').format.columnWidth=16;bom.getRange('B:B').format.columnWidth=49;bom.getRange('C:C').format.columnWidth=10;bom.getRange('D:I').format.columnWidth=15;bom.getRange('J:L').format.columnWidth=65;
const br=6;
bom.getRange(`A6:L${d.max_bom.length+5}`).values=d.max_bom.map(r=>[r.group,r.part,r.qty,r.low,r.mid,r.high,null,null,null,r.basis,r.source||'Engineering allowance',r.note]);
for(let i=0;i<d.max_bom.length;i++){const r=i+br;for(const [a,b] of [['G','D'],['H','E'],['I','F']])bom.getRange(`${a}${r}`).formulas=[[`=C${r}*${b}${r}`]];}
const total=d.max_bom.length+6;bom.getRange(`B${total}`).values=[['Total components']];for(const col of ['G','H','I'])bom.getRange(`${col}${total}`).formulas=[[`=SUM(${col}6:${col}${total-1})`]];
bom.getRange(`B6:B${total-1}`).format.wrapText=true;bom.getRange(`J6:L${total-1}`).format.wrapText=true;bom.getRange(`A6:L${total-1}`).format.rowHeight=56;
bom.getRange(`C6:F${total-1}`).format.fill='#FFF2CE';bom.getRange(`D6:I${total}`).setNumberFormat(usd);bom.getRange(`A${total}:L${total}`).format.fill='#E9EEF3';bom.freezePanes.freezeRows(5);
let cr=6;const totals={};
for(const p of d.products){
 const start=cr;
 for(let i=0;i<p.lines.length;i++,cr++){
  const l=p.lines[i];cost.getRange(`A${cr}:F${cr}`).values=[[p.name,l.label.replaceAll('_',' '),...l.cost,p.name==='MAX'?'r11 estimate; component detail in MAX BOM':'Carried forward 21 September 2026']];
  if(p.name==='MAX'&&i===0)cost.getRange(`C${cr}:E${cr}`).formulas=[[`='MAX BOM'!G${total}`,`='MAX BOM'!H${total}`,`='MAX BOM'!I${total}`]];
  else if(l.label.includes('overage')){const prev=cr-1;cost.getRange(`C${cr}:E${cr}`).formulas=[[`=C${prev}*'Launch pricing'!B13`,`=D${prev}*'Launch pricing'!B13`,`=E${prev}*'Launch pricing'!B13`]];}
  else cost.getRange(`C${cr}:E${cr}`).format.fill='#FFF2CE';
 }
 cost.getRange(`A${cr}:B${cr}`).values=[[p.name,'Total first-batch unit cost']];cost.getRange(`C${cr}:E${cr}`).formulas=[[`=SUM(C${start}:C${cr-1})`,`=SUM(D${start}:D${cr-1})`,`=SUM(E${start}:E${cr-1})`]];cost.getRange(`A${cr}:F${cr}`).format.fill='#E9EEF3';cost.getRange(`A${cr}:F${cr}`).format.font.bold=true;totals[p.name]=cr;cr++;
}
cost.getRange(`C6:E${cr}`).setNumberFormat(usd);cost.getRange(`B6:B${cr}`).format.wrapText=true;cost.getRange(`F6:F${cr}`).format.wrapText=true;cost.getRange(`A6:F${cr}`).format.rowHeight=36;cost.freezePanes.freezeRows(5);
for(let i=0;i<d.products.length;i++){
 const p=d.products[i],r=6+i,tr=totals[p.name];summary.getRange(`A${r}:I${r}`).values=[[p.name,null,p.price,p.target,null,null,null,null,null]];
 for(const [c,f] of Object.entries({B:`='Cost model'!D${tr}`,E:`=1-B${r}/C${r}`,F:`=B${r}/(1-D${r})`,G:`='Cost model'!C${tr}`,H:`='Cost model'!E${tr}`,I:`=E${r}-$B$14`}))summary.getRange(`${c}${r}`).formulas=[[f]];
}
for(const c of ['B','C','F','G','H'])summary.getRange(`${c}6:${c}9`).setNumberFormat(usd);
summary.getRange('D6:E9').setNumberFormat('0.0%');summary.getRange('I6:I9').setNumberFormat('0.0%');summary.getRange('C6:D9').format.fill='#FFF2CE';
summary.getRange('A12:B14').values=[['Fixed volume basis',1000],['Component overage',.03],['Illustrative fee',.08]];summary.getRange('B13:B14').format.fill='#FFF2CE';summary.getRange('B13:B14').setNumberFormat('0.0%');
summary.getRange('D12').values=[['Prices are proposals; not advertised or committed.']];summary.getRange('D13').values=[['MAX excludes Pi, cooler, storage and external power supply.']];summary.getRange('D14').values=[['GNSS is a Splanc option; it shares the same exterior.']];
for(let i=0;i<d.notes.length;i++){summary.getRange(`A${17+i}:I${17+i}`).merge();summary.getRange(`A${17+i}`).values=[[d.notes[i]]];summary.getRange(`A${17+i}:I${17+i}`).format.wrapText=true;summary.getRange(`A${17+i}:I${17+i}`).format.rowHeight=34;}
const inspect=await wb.inspect({kind:'table',range:'Launch pricing!A5:I9',include:'values,formulas',tableMaxRows:5,tableMaxCols:9,maxChars:3000});
await fs.writeFile(path.join(out,'review/workbook-values.json'),inspect.ndjson);
for(let i=0;i<d.products.length;i++){const v=summary.getRange(`B${i+6}`).values[0][0];if(Math.abs(v-d.products[i].cost[1])>.0001)throw Error(`Cost mismatch ${v}`);}
const errs=await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:30},summary:'Formula error scan'});
await fs.writeFile(path.join(out,'review/workbook-errors.json'),errs.ndjson);
for(const [sheet,range,name] of [['Launch pricing','A1:I25','pricing'],['Cost model',`A1:F${cr-1}`,'cost-model'],['MAX BOM',`A1:I${total}`,'max-bom'],['MAX BOM',`J5:L${total-1}`,'sources']]){
 const png=await wb.render({sheetName:sheet,range,scale:1});await fs.writeFile(path.join(out,`review/${name}.png`),new Uint8Array(await png.arrayBuffer()));
}
const dir=path.join(out,'outputs/pricing-20261008');await fs.mkdir(dir,{recursive:true});await(await SpreadsheetFile.exportXlsx(wb)).save(path.join(dir,'splanc-pricing.xlsx'));
console.log(JSON.stringify({saved:path.join(dir,'splanc-pricing.xlsx'),maxCost:summary.getRange('B9').values,errors:errs.ndjson}));
