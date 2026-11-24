export interface Point { recorded_at:string; current_bytes:number|null; saved_bytes:number|null; formats:Record<string,number>|null; }
export interface Series {name:string;color:string;value:(point:Point)=>number|null;}
const namespace='http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag:K,attrs:Record<string,string|number>={},text?:string):SVGElementTagNameMap[K]{
  const element=document.createElementNS(namespace,tag);for(const [key,value]of Object.entries(attrs))element.setAttribute(key,String(value));if(text!==undefined)element.textContent=text;return element;
}
const date=(value:string)=>new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'});
export function chart(container:HTMLElement,points:Point[],series:Series[],unit:string,since:string,until:string):void{
  container.replaceChildren();
  const valid=points.filter(point=>Number.isFinite(Date.parse(point.recorded_at)));
  const values=valid.flatMap(point=>series.map(line=>line.value(point))).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
  if(!values.length){const empty=document.createElement('p');empty.className='chart-empty';empty.textContent=unit==='GB'?'Library history will appear after a scan.':'Format history will appear after a complete inventory.';container.append(empty);return;}
  const plot=svg('svg',{viewBox:'0 0 405 216',role:'img','aria-label':unit==='GB'?'Library size and cumulative savings in gigabytes':'Image counts by format over time'});
  const low=Math.min(0,...values),high=Math.max(0,...values),span=high-low||1;
  const min=low<0?low-span*.08:0,max=high>0?high+span*.08:low<0?0:1;
  const end=Date.parse(until),start=Math.max(Date.parse(since),Math.min(end-86400000,...valid.map(point=>Date.parse(point.recorded_at))));
  const x=(time:string)=>44+346*(Date.parse(time)-start)/(end-start),y=(value:number)=>177-150*(value-min)/(max-min);
  plot.append(svg('text',{x:44,y:13},unit));
  for(let i=0;i<=3;i++){
    const value=min+(max-min)*i/3,py=y(value);
    plot.append(svg('line',{x1:44,x2:390,y1:py,y2:py,class:'tick'}),svg('text',{x:36,y:py+4,'text-anchor':'end'},value.toLocaleString(undefined,{notation:'compact',maximumSignificantDigits:3})));
  }
  plot.append(svg('text',{x:44,y:202},date(new Date(start).toISOString())),svg('text',{x:390,y:202,'text-anchor':'end'},date(until)));
  const detail=document.createElement('p');detail.className='chart-detail';detail.textContent=valid.length===1?'One recorded measurement. History grows with each scan.':'Inspect a point for its recorded measurement.';
  for(const line of series){
    let path='',pen=false;
    for(const point of valid){
      const value=line.value(point);if(value===null||!Number.isFinite(value)){pen=false;continue;}
      path+=(pen?' L ':' M ')+x(point.recorded_at).toFixed(2)+' '+y(value).toFixed(2);pen=true;
    }
    plot.append(svg('path',{d:path,fill:'none',stroke:line.color,'stroke-width':2,'stroke-linejoin':'round'}));
    for(const point of valid){
      const value=line.value(point);if(value===null||!Number.isFinite(value))continue;
      const label=new Date(point.recorded_at).toLocaleString()+': '+line.name+' '+value.toLocaleString(undefined,{maximumFractionDigits:unit==='GB'?3:0})+' '+unit;
      const dot=svg('circle',{cx:x(point.recorded_at),cy:y(value),r:3,fill:line.color,tabindex:0,role:'img','aria-label':label});
      dot.append(svg('title',{},label));dot.addEventListener('mouseenter',()=>{detail.textContent=label;});dot.addEventListener('focus',()=>{detail.textContent=label;});plot.append(dot);
    }
  }
  const legend=document.createElement('div');legend.className='legend';
  for(const line of series){const item=document.createElement('span'),mark=svg('svg',{viewBox:'0 0 13 4','aria-hidden':'true'});mark.append(svg('line',{x1:0,x2:13,y1:2,y2:2,stroke:line.color,'stroke-width':3}));item.append(mark,document.createTextNode(line.name));legend.append(item);}
  container.append(plot,legend,detail);
}
