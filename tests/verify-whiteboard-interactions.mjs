// Copyright (C) 2026 PDF Whiteboard contributors
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const items = new Map(), saved = new Map();
let nodeId = 0;
const documentListeners = new Map(), windowListeners = new Map();
let noteWrites = 0;
const testOutput=new URL('../test-output/',import.meta.url);
fs.mkdirSync(testOutput,{recursive:true});
const template=fs.readFileSync(new URL('../viewer.template.html',import.meta.url),'utf8');
const tags=new Map([...template.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"/gi)].map(match=>[match[2],match[1].toUpperCase()]));
const panelIds=new Set([...template.match(/<aside[\s\S]*?<\/aside>/)[0].matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
const stepsIds=new Set([...template.match(/<aside id="steps-panel"[\s\S]*?<\/aside>/)[0].matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
const audioIds=new Set([...template.match(/<section id="audio-section"[\s\S]*?<\/section>/)[0].matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]));
const liveURLs=new Set(), revokedURLs=[];
const trackedURL={createObjectURL(blob){const value=URL.createObjectURL(blob);liveURLs.add(value);return value},revokeObjectURL(value){revokedURLs.push(value);liveURLs.delete(value);URL.revokeObjectURL(value)}};
function element(id) {
  if (items.has(id)) return items.get(id);
  const listeners = new Map(), captured = new Set(), classes = new Set(), attributes = new Map();
  const context = {drawCount:0,setTransform(){},clearRect(){this.drawCount=0},beginPath(){},arc(){},fill(){this.drawCount++},moveTo(){},lineTo(){},stroke(){this.drawCount++},measureText(text){return {width:text.length*12}},fillText(){this.drawCount++}};
  const e = {id, style:{setProperty(name,value){this[name]=value}}, dataset:{}, children:[], value:'', hidden:true, disabled:false, textContent:'', tagName:tags.get(id)??'DIV', clientWidth:1100, clientHeight:760, scrollTop:0, scrollLeft:0,
    classList:{toggle(name,on){if(on??!classes.has(name))classes.add(name);else classes.delete(name)},add(name){classes.add(name)},remove(name){classes.delete(name)},contains:name=>classes.has(name)},
    getContext:()=>context, setAttribute(name,value){attributes.set(name,value)},getAttribute:name=>attributes.get(name),addEventListener(name,fn){const list=listeners.get(name)??[];list.push(fn);listeners.set(name,list)},
    emit(name,event={}){event.target??=e;for(const fn of listeners.get(name)??[]) fn(event)},
    setPointerCapture(id){captured.add(id)},hasPointerCapture(id){return captured.has(id)},releasePointerCapture(id){captured.delete(id)},
    getBoundingClientRect(){return {left:parseFloat(e.style.left)||0,top:parseFloat(e.style.top)||0,width:parseFloat(e.style.width)||600,height:parseFloat(e.style.height)|| (parseFloat(e.style.fontSize) ? parseFloat(e.style.fontSize)*1.35*e.textContent.split('\n').length+12 : 800)}},
    get scrollHeight(){return (parseFloat(e.style.fontSize)||20)*1.35*e.value.split('\n').length+8},
    replaceChildren(){e.children=[]},append(node){e.children.push(node)},setSelectionRange(){},focus(){documentMock.activeElement=e},scrollIntoView(options){e.lastScrollOptions=options},
    contains(node){return node===e || e.children.some(child=>child.contains(node)) || id==='tool-panel' && (panelIds.has(node?.id)||node?.dataset?.inkColor) || id==='steps-panel' && (stepsIds.has(node?.id)||element('steps-list').contains(node)) || id==='more-colors' && (node?.dataset?.extraColor||['more-colors-toggle','current-color-chip','current-color-name'].includes(node?.id)) || id==='audio-section' && audioIds.has(node?.id) || id==='audio-body' && audioIds.has(node?.id) && !['audio-section','audio-collapse'].includes(node?.id) || id==='text-editor' && ['text-input','text-move'].includes(node?.id)},
    click(event={detail:1}){if(!e.disabled){event.target??=e;e.onclick?.(event);e.emit('click',event)}},blur(){if(documentMock.activeElement===e)documentMock.activeElement=element('body')},files:[]};
  items.set(id,e);return e;
}
element('zoom').value='page';element('thickness').value='3.5';element('text-size').value='28';element('stamp-size').value='36';
element('audio-rate').value='1';element('audio-loop').checked=false;element('audio-seek').value='0';element('audio-volume').value='1';
const media=element('audio-player');
Object.assign(media,{duration:NaN,currentTime:0,paused:true,ended:false,volume:1,muted:false,playbackRate:1,defaultPlaybackRate:1,loop:false,playCount:0,error:null,
  pause(){media.paused=true;media.emit('pause')},
  load(){media.duration=NaN;media.currentTime=0;media.ended=false;media.error=null;media.playbackRate=media.defaultPlaybackRate},
  play(){media.playCount++;if(media.playFailure)return Promise.reject(media.playFailure);media.paused=false;media.ended=false;media.emit('play');return Promise.resolve()}});
const swatchTags=[...template.matchAll(/<button\b[^>]*\bdata-ink-color="([^"]+)"[^>]*>/g)];
const colors=swatchTags.map(([tag,color],i)=>{const b=element('swatch-'+i);b.dataset.inkColor=color;b.dataset.extraColor=i>=6;b.title=tag.match(/\btitle="([^"]+)"/)[1];return b});
const doc = {
  numPages:121, fingerprints:['fixture'],
  async getPage(n) {
    return {
      getViewport:({scale})=>({width:600*scale,height:800*scale}),
      render() {
        let reject;
        const promise=new Promise((resolve,rej)=>{reject=rej;queueMicrotask(resolve)});
        return {promise,cancel(){reject(Object.assign(new Error('cancel'),{name:'RenderingCancelledException'}))}};
      },
      cleanup(){}
    };
  }
};
const fakePDFJS={getDocument:()=>({promise:Promise.resolve(doc),destroy:async()=>{}})};
const documentMock={getElementById:element,querySelectorAll:()=>colors,querySelector:()=>element('tool-panel'),
  addEventListener(name,fn){const list=documentListeners.get(name)??[];list.push(fn);documentListeners.set(name,list)},
  documentElement:{},createElement:tag=>{const node=element('node-'+(++nodeId));node.tagName=tag.toUpperCase();return node},fullscreenElement:null,
  body:element('body'),activeElement:element('body')};
function dispatchDocument(name,event){for(const fn of documentListeners.get(name)??[])fn(event)}
function dispatchWindow(name,event={}){for(const fn of windowListeners.get(name)??[])fn(event)}
const testContext=vm.createContext({console,Blob,URL:trackedURL,atob,setTimeout,clearTimeout,queueMicrotask,JSON,Uint8Array,Map,Math,Number,Array,Object,Error,SyntaxError,
  document:documentMock,
  window:{devicePixelRatio:1,addEventListener(name,fn){const list=windowListeners.get(name)??[];list.push(fn);windowListeners.set(name,list)}},
  localStorage:{getItem:key=>saved.get(key)??null,setItem(key,value){if(key.startsWith('pdf-classroom-whiteboard-v1:'))noteWrites++;saved.set(key,value)}},
  prompt:()=>null,confirm:()=>true,fakePDFJS});
let source=fs.readFileSync(new URL('../app.mjs',import.meta.url),'utf8');
source=source.replace('const libraryReady = initializeLibrary();','pdfjs = fakePDFJS; const libraryReady = Promise.resolve();');
vm.runInContext(source,testContext);
const run=code=>vm.runInContext(code,testContext);
// Observe rendering while opening: restored answers must never be drawn on a visible sheet.
async function openForClassroom(code) {
  let restored=false, visibleFrames=0;
  testContext.observeRestore=()=>{restored=true};
  testContext.observeOpenDraw=()=>{
    if(restored&&!element('sheet').hidden){
      visibleFrames++;
      assert.equal(run('presenting'),true,'The visible sheet must already be in classroom mode');
      assert.equal(run('visibleAnnotationCount()'),0,'Opening a PDF must never flash prepared answers');
    }
  };
  run('globalThis.restoreBeforeOpen=restoreNotes;globalThis.drawBeforeOpen=drawInk;restoreNotes=function(){globalThis.observeRestore();globalThis.restoreBeforeOpen()};drawInk=function(){globalThis.observeOpenDraw();globalThis.drawBeforeOpen()}');
  try {await run(code)} finally {run('restoreNotes=globalThis.restoreBeforeOpen;drawInk=globalThis.drawBeforeOpen')}
  assert.ok(restored&&visibleFrames>0,'The default classroom state must be verified through the open and render path');
  assert.equal(run('presenting'),true);assert.equal(run('visibleAnnotationCount()'),0);
  assert.equal(element('steps-panel').hidden,true);assert.equal(element('steps-handle').hidden,true);
  assert.equal(element('reveal-start').getAttribute('aria-checked'),'false','The edit switch must default to off in presentation');
  assert.equal(run('tool'),'hand');
  assert.equal(run('revealCounts.size'),0);
}
await openForClassroom("openFile({name:'sample.pdf',type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})");
assert.equal(run('currentPage'),1);
assert.equal(noteWrites,0,'Opening the PDF in classroom mode must not save or overwrite preparation notes');
element('reveal-start').click();assert.equal(run('presenting'),false,'Preparation must be explicitly entered');
assert.equal(element('reveal-start').getAttribute('aria-checked'),'true','Enabling edit must update the accessible switch state');
const sidebar=()=>JSON.parse(run('JSON.stringify(sidebarController.snapshot())'));
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
const autoHide=async()=>{run('sidebarController.scheduleHide(0)');await tick()};
assert.deepEqual(sidebar(),{side:'right',pinned:false,expanded:true});
const originalDimensions=run('JSON.stringify([pageWidth,pageHeight,sheet.style.width,sheet.style.height])');
element('stage').emit('pointerdown');assert.equal(sidebar().expanded,false,'Writing area must close an unpinned panel');
assert.equal(element('tool-panel').inert,true);assert.equal(element('tool-panel').getAttribute('aria-hidden'),'true');
element('panel-handle').emit('pointerenter',{pointerType:'mouse'});assert.equal(sidebar().expanded,true);
await autoHide();assert.equal(sidebar().expanded,true,'Hovered handle must remain open');
element('panel-handle').emit('pointerleave',{pointerType:'mouse'});
element('tool-panel').emit('pointerenter',{pointerType:'mouse'});
await autoHide();assert.equal(sidebar().expanded,true,'Hovered panel must remain open');
element('tool-panel').emit('pointerleave',{pointerType:'mouse'});
await autoHide();assert.equal(sidebar().expanded,false,'Leaving the panel must automatically hide it');
element('panel-handle').emit('pointerenter',{pointerType:'touch'});assert.equal(sidebar().expanded,false,'Touch hover must not accidentally open the panel');
element('panel-handle').click();assert.equal(sidebar().expanded,true,'Tapping the handle must open it');
element('panel-pin').click();assert.equal(sidebar().pinned,true);
element('stage').emit('pointerdown');await autoHide();assert.equal(sidebar().expanded,true,'Pinned tools must stay open');
element('panel-close').click();assert.equal(sidebar().expanded,false,'Explicit close must work even while pinned');
assert.equal(documentMock.activeElement.id,'panel-handle','Explicit close must return keyboard focus to the handle');
element('panel-handle').click();element('panel-pin').click();assert.equal(sidebar().pinned,false);
element('panel-side').value='left';element('panel-side').onchange();
assert.equal(sidebar().side,'left');assert.equal(documentMock.body.dataset.panelSide,'left');
assert.deepEqual(JSON.parse(saved.get('pdf-classroom-sidebar-v1')),{side:'left',pinned:false});
element('page').focus();await autoHide();assert.equal(sidebar().expanded,true,'Page input must not disappear during typing');
element('page').blur();element('zoom').focus();await autoHide();assert.equal(sidebar().expanded,true,'Select menus must remain visible while focused');
element('tool-panel').emit('change',{target:element('zoom')});
await autoHide();assert.equal(sidebar().expanded,false,'Choosing a dropdown option with a pointer must release focus for auto-hide');
run('sidebarController.open()');element('more').open=true;await autoHide();assert.equal(sidebar().expanded,true,'Help and backup must remain open while in use');
element('more').open=false;element('more').emit('toggle');await autoHide();assert.equal(sidebar().expanded,false);
element('panel-handle').click({detail:0});assert.equal(documentMock.activeElement.id,'open');
dispatchDocument('keydown',{target:element('open'),key:'Tab'});await autoHide();assert.equal(sidebar().expanded,true,'Keyboard navigation must hold the tools open');
element('zoom').focus();element('tool-panel').emit('change',{target:element('zoom')});
assert.equal(documentMock.activeElement.id,'zoom','Keyboard dropdown changes must retain focus');
element('open').focus();
dispatchDocument('keydown',{target:element('open'),key:'Escape',preventDefault(){}});assert.equal(sidebar().expanded,false,'Escape must close tools and restore focus');
run('sidebarController.open()');element('stage').emit('pointerdown');
run("message('An error',true)");assert.equal(sidebar().expanded,true,'Errors must reveal their status message');
element('tool-panel').emit('pointerdown',{pointerType:'touch'});element('tool-panel').emit('click',{target:element('pen')});
await autoHide();assert.equal(sidebar().expanded,false,'Touch selection must allow automatic hiding');
assert.equal(run('JSON.stringify([pageWidth,pageHeight,sheet.style.width,sheet.style.height])'),originalDimensions,'Side changes and hiding must never resize the PDF');
function pointer(name,x,y,id=7){element('ink').emit(name,{pointerId:id,button:0,clientX:x,clientY:y,preventDefault(){}})}
function draw(x=100,y=100){pointer('pointerdown',x,y);pointer('pointermove',x+80,y+30);pointer('pointerup',x+80,y+30)}
draw();assert.equal(run('strokes[1].length'),1);
const normalized=run('JSON.stringify(strokes[1][0])');
run('sidebarController.open()');element('panel-side').value='right';element('panel-side').onchange();
element('stage').emit('pointerdown');assert.equal(run('JSON.stringify(strokes[1][0])'),normalized,'Moving or hiding tools must not alter ink coordinates');
await run('requestRender(2)');draw(200,200);assert.equal(run('strokes[2].length'),1);
await run('requestRender(1)');assert.equal(run('strokes[1].length'),1);
element('zoom').value='width';await run('requestRender()');
assert.equal(run('JSON.stringify(strokes[1][0])'),normalized,'Zoom must preserve page-relative ink');
element('clear').click();assert.equal(run('strokes[1].length'),0);
element('undo').click();assert.equal(run('strokes[1].length'),1);
run("setTool('eraser')");
const p=run('[strokes[1][0].points[0][0]*pageWidth,strokes[1][0].points[0][1]*pageHeight]');
pointer('pointerdown',p[0],p[1]);pointer('pointerup',p[0],p[1]);assert.equal(run('strokes[1].length'),0);
element('undo').click();assert.equal(run('strokes[1].length'),1,'Undo eraser must restore stroke');
run('saveNow(); strokes={}; restoreNotes()');
assert.equal(run('strokes[1].length'),1);assert.equal(run('strokes[2].length'),1);
await run('Promise.all([requestRender(5),requestRender(6),requestRender(7)])');
assert.equal(run('currentPage'),7,'Rapid page requests must show the latest page');
assert.throws(()=>run("validateNotes({version:1,fingerprint:'wrong',strokes:{}},'fixture',121)"));

colors[1].click();
draw();assert.equal(run('strokes[7][0].color'),'#2166cf','Named palette must set pen color');
element('text').click();
pointer('pointerdown',200,200);
assert.equal(run('!!textDraft'),true,'Text tool must open a text box on the PDF');
element('text-input').value='apple\n苹果';element('text-input').emit('input',{});
colors[5].click();element('text-size').value='36';element('text-size').onchange();
element('text-done').click();
assert.equal(run('strokes[7][1].kind'),'text');
assert.equal(run('strokes[7][1].text'),'apple\n苹果');
assert.equal(run('strokes[7][1].color'),'#873eb5');
assert.equal(run('strokes[7][1].fontSize'),36/800);
run("textNodes.get(1).emit('pointerdown',{button:0,preventDefault(){},stopPropagation(){}})");
element('text-input').value='banana';element('text-done').click();
assert.equal(run('strokes[7][1].text'),'banana');
element('undo').click();assert.equal(run('strokes[7][1].text'),'apple\n苹果','Undo must restore edited text');

run('startText(null,1)');
const initialX=run('textDraft.x'),initialY=run('textDraft.y');
element('text-move').emit('pointerdown',{button:0,pointerId:9,clientX:100,clientY:100,preventDefault(){},stopPropagation(){}});
element('text-move').emit('pointermove',{pointerId:9,clientX:140,clientY:130,preventDefault(){}});
element('text-move').emit('pointerup',{pointerId:9});element('text-done').click();
assert.ok(run('strokes[7][1].x')>initialX);assert.ok(run('strokes[7][1].y')>initialY);
const typedSnapshot=run('JSON.stringify(strokes[7][1])');
await run('requestRender(8)');await run('requestRender(7)');
element('zoom').value='page';await run('requestRender()');
assert.equal(run('JSON.stringify(strokes[7][1])'),typedSnapshot,'Text coordinates and style must survive zoom and page changes');

run('startText(null,1)');element('text-input').value='cancel me';element('text-cancel').click();
assert.equal(run('strokes[7][1].text'),'apple\n苹果');
run('startText(null,1)');element('text-delete').click();assert.equal(run('strokes[7].length'),1);
element('undo').click();assert.equal(run('strokes[7].length'),2,'Deleted text must be undoable');
run("setTool('eraser')");
const tp=run('[strokes[7][1].x*pageWidth+10,strokes[7][1].y*pageHeight+10]');
pointer('pointerdown',...tp);pointer('pointerup',...tp);
assert.equal(run('strokes[7].length'),1);element('undo').click();assert.equal(run('strokes[7].length'),2);
element('clear').click();assert.equal(run('strokes[7].length'),0);
element('undo').click();assert.equal(run('strokes[7].length'),2,'Clear/undo must include handwriting and text');

run('saveNow(); strokes={}; restoreNotes()');
assert.equal(run('strokes[7][1].text'),'apple\n苹果');
assert.equal(run('localState().version'),4);
run("validateNotes({version:1,fingerprint:'fixture',strokes:{'1':[{color:'#df3030',width:.004,points:[[.1,.1],[.2,.2]]}]}},'fixture',121)");
assert.throws(()=>run("validateNotes({version:2,fingerprint:'fixture',strokes:{'1':[{kind:'text',text:'bad',color:'#df3030',x:2,y:.1,fontSize:.03,boxWidth:.3}]}},'fixture',121)"));
assert.ok(!/type\s*=\s*["']color["']/i.test(template),'No RGB/native color picker may remain');
assert.equal(colors.length,36);assert.equal(colors.filter(button=>button.dataset.extraColor).length,30);
assert.equal(new Set(colors.map(button=>button.dataset.inkColor)).size,36,'All swatches must offer distinct colors');

await run('requestRender(9)');
element('check').click();colors[1].click();
assert.equal(run('tool'),'check','Choosing a color must keep the selected shape tool');
pointer('pointerdown',100,100);pointer('pointerup',100,100);
pointer('pointerdown',170,100);pointer('pointerup',170,100);
assert.equal(run('strokes[9].length'),2,'Check tool must allow repeated single-click stamps');
assert.equal(run('strokes[9][0].shape'),'check');assert.equal(run('strokes[9][0].color'),'#2166cf');
element('cross').click();element('stamp-size').value='52';
pointer('pointerdown',240,100);pointer('pointerup',240,100);
assert.equal(run('strokes[9][2].shape'),'cross');
assert.ok(run('strokes[9][2].to[0]-strokes[9][2].from[0]')>run('strokes[9][0].to[0]-strokes[9][0].from[0]'));
for (const name of ['ellipse','rectangle','line','arrow']) {
  element(name).click();
  const count=run('strokes[9].length');
  pointer('pointerdown',100,200);pointer('pointermove',260,310);
  assert.equal(run('strokes[9].length'),count,'Preview must remain uncommitted until pointerup');
  assert.equal(run('activeShape.shape'),name);
  pointer('pointerup',280,330);
  assert.equal(run('strokes[9].at(-1).shape'),name);
  assert.equal(run('strokes[9].length'),count+1);
  assert.equal(run('Math.round(strokes[9].at(-1).to[0]*pageWidth)'),280,'Pointerup must record the final endpoint');
}
element('undo').click();assert.equal(run('strokes[9].at(-1).shape'),'line','Undo must remove the last complete shape');
element('line').click();const beforeTiny=run('strokes[9].length');
pointer('pointerdown',100,200);pointer('pointerup',100,200);
assert.equal(run('strokes[9].length'),beforeTiny,'Accidental clicks must not create invisible line objects');
pointer('pointerdown',100,200);pointer('pointermove',300,300);
dispatchDocument('keydown',{key:'Escape',target:{tagName:'DIV'},preventDefault(){}});
pointer('pointerup',300,300);assert.equal(run('strokes[9].length'),beforeTiny,'Esc must cancel preview without storing a shape');
pointer('pointerdown',100,200);pointer('pointermove',300,300);pointer('pointercancel',300,300);
assert.equal(run('strokes[9].length'),beforeTiny,'Cancelled touch gestures must not store shapes');

await run('requestRender(10)');element('ellipse').click();
pointer('pointerdown',100,100);pointer('pointermove',300,240);pointer('pointerup',300,240);
const savedEllipse=run('JSON.stringify(strokes[10][0])');
element('eraser').click();pointer('pointerdown',200,170);pointer('pointerup',200,170);
assert.equal(run('strokes[10].length'),1,'An empty ellipse interior must not count as an eraser hit');
pointer('pointerdown',300,170);pointer('pointerup',300,170);
assert.equal(run('strokes[10].length'),0,'Touching the ellipse outline must erase the whole shape');
element('undo').click();assert.equal(run('JSON.stringify(strokes[10][0])'),savedEllipse);
element('rectangle').click();
pointer('pointerdown',380,360);pointer('pointermove',180,270);pointer('pointerup',180,270);
assert.equal(run('strokes[10][1].shape'),'rectangle','Reverse drags must be accepted');
const allShapes=run('JSON.stringify(strokes[10])');
await run('requestRender(11)');await run('requestRender(10)');
element('zoom').value='width';await run('requestRender()');
assert.equal(run('JSON.stringify(strokes[10])'),allShapes,'Shape coordinates must survive page changes and zoom');
element('clear').click();assert.equal(run('strokes[10].length'),0);element('undo').click();
assert.equal(run('JSON.stringify(strokes[10])'),allShapes);
run('saveNow();strokes={};restoreNotes()');
assert.equal(run('JSON.stringify(strokes[10])'),allShapes,'Shapes must survive local persistence and v3 validation');
assert.equal(run('strokes[7][1].text'),'apple\n苹果','Adding shapes must preserve previous text');
assert.throws(()=>run("validateNotes({version:3,fingerprint:'fixture',strokes:{'1':[{kind:'shape',shape:'bogus',color:'#df3030',width:.01,from:[.1,.1],to:[.5,.5]}]}},'fixture',121)"));

// More colors use the same annotation paths, with names instead of RGB inputs.
await run('requestRender(12)');element('pen').click();
const lake=colors.find(button=>button.dataset.inkColor==='#00acc1');
const rose=colors.find(button=>button.dataset.inkColor==='#ad1457');
const gray=colors.find(button=>button.dataset.inkColor==='#616161');
const moreColors=element('more-colors');
run('sidebarController.open()');moreColors.open=true;moreColors.emit('toggle');await autoHide();
assert.equal(sidebar().expanded,true,'The sidebar must remain visible while choosing from the expanded palette');
lake.click();assert.equal(moreColors.open,false,'Extra palette must fold after selecting a color');
assert.equal(element('current-color-name').textContent,'湖蓝');assert.equal(element('current-color-chip').style['--current-ink'],'#00acc1');
assert.equal(documentMock.activeElement.id,'more-colors-toggle','Focus must return to the visible palette summary');
assert.equal(lake.getAttribute('aria-pressed'),'true');assert.equal(colors.filter(button=>button.classList.contains('chosen')).length,1);
draw();assert.equal(run('strokes[12][0].color'),'#00acc1','An extra swatch must color pen strokes');
element('text').click();pointer('pointerdown',200,200);element('text-input').value='更多颜色';
moreColors.open=true;rose.click();
assert.equal(run('textDraft.color'),'#ad1457');assert.equal(element('text-input').value,'更多颜色','Changing color must preserve the unfinished text');
element('text-done').click();assert.equal(run('strokes[12][1].color'),'#ad1457');
element('arrow').click();moreColors.open=true;gray.click();
assert.equal(run('tool'),'arrow','An extra color must preserve the chosen shape tool');
pointer('pointerdown',100,300);pointer('pointermove',250,350);pointer('pointerup',250,350);
assert.equal(run('strokes[12][2].color'),'#616161');
const extraNotes=run('JSON.stringify(strokes[12])');run('saveNow();strokes={};restoreNotes()');
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[12])')),JSON.parse(extraNotes),'Extra colors must survive local save and note validation');
colors[1].click();assert.equal(element('current-color-name').textContent,'蓝色');assert.equal(gray.getAttribute('aria-pressed'),'false');
moreColors.open=true;dispatchDocument('click',{target:element('stage')});assert.equal(moreColors.open,false,'Clicking away must close the palette');
run('sidebarController.open()');moreColors.open=true;
dispatchDocument('keydown',{key:'Escape',target:element('more-colors-toggle'),preventDefault(){}});
assert.equal(moreColors.open,false);assert.equal(sidebar().expanded,false);

// Exercise local audio without requiring PDF content changes or external files.
const audioState=run('JSON.stringify(strokes)');
const collapseAudio=element('audio-collapse'), audioBody=element('audio-body');
assert.equal(audioBody.hidden,false,'Audio tools must initially be expanded');
assert.equal(collapseAudio.getAttribute('aria-expanded'),'true');
collapseAudio.click();assert.equal(audioBody.hidden,true,'Audio tools can fold before choosing a file');
collapseAudio.click();assert.equal(audioBody.hidden,false);
const track=Object.assign(new Blob(['fixture audio'],{type:'audio/mpeg'}),{name:'Unit 1 听力.mp3'});
testContext.audioFixture=track;
run('audioController.openFile(audioFixture)');
assert.equal(media.hidden,true);assert.equal(element('audio-options').hidden,false);
assert.equal(element('audio-filename').textContent,track.name);
assert.equal(media.paused,true,'Selecting audio must not autoplay');
assert.equal(element('audio-restart').disabled,true,'Seeking must wait for metadata');
media.duration=120;media.emit('loadedmetadata');
assert.equal(element('audio-restart').disabled,false);assert.equal(element('audio-rate').disabled,false);
const seekControl=element('audio-seek');
assert.equal(seekControl.disabled,false);assert.equal(seekControl.max,'120');
media.currentTime=37.5;media.emit('timeupdate');
assert.equal(Number(seekControl.value),37.5);assert.equal(element('audio-current').textContent,'00:37');assert.equal(element('audio-duration').textContent,'02:00');
assert.equal(seekControl.style['--seek-progress'],'31.25%');
seekControl.focus();seekControl.emit('pointerdown',{button:0,pointerId:41});
seekControl.value='85.4';media.currentTime=38;media.emit('timeupdate');
assert.equal(seekControl.value,'85.4','Playback updates must not pull the handle away from the user during a drag');
seekControl.emit('input');assert.equal(media.currentTime,85.4);assert.equal(media.paused,true,'Dragging a paused track must not autoplay');
assert.equal(element('audio-current').textContent,'01:25');
run('sidebarController.open()');seekControl.blur();await autoHide();
assert.equal(sidebar().expanded,true,'The sidebar must remain visible throughout a progress drag even if focus leaves the range');
seekControl.emit('pointerup',{pointerId:41});assert.equal(seekControl.hasPointerCapture(41),false);await autoHide();
assert.equal(sidebar().expanded,false,'Auto-hide must resume after the progress drag ends');
seekControl.emit('pointerdown',{button:0,pointerId:42});seekControl.emit('pointercancel',{pointerId:42});
assert.equal(seekControl.dataset.dragging,undefined);assert.equal(seekControl.hasPointerCapture(42),false,'Cancelled touch gestures must release the slider');
seekControl.value='62';seekControl.emit('change');assert.equal(media.currentTime,62,'Keyboard/range changes must seek without needing a pointer');
assert.equal(seekControl.getAttribute('aria-valuetext'),'01:02 / 02:00');
await element('audio-toggle').onclick();assert.equal(media.paused,false);assert.ok(element('audio-toggle').textContent.includes('暂停'));
await element('audio-toggle').onclick();assert.equal(media.paused,true);assert.ok(element('audio-toggle').textContent.includes('播放'));
element('audio-volume').value='.4';element('audio-volume').emit('input');assert.equal(media.volume,.4);
element('audio-mute').click();assert.equal(media.muted,true);assert.equal(element('audio-mute').textContent,'恢复声音');
element('audio-mute').click();assert.equal(media.muted,false);assert.equal(media.volume,.4,'Unmuting must preserve the chosen volume');
element('audio-volume').value='0';element('audio-volume').emit('input');element('audio-mute').click();assert.equal(media.volume,.5,'Restoring sound from zero volume must become audible');
media.duration=3661;media.currentTime=3605;media.emit('durationchange');
assert.equal(element('audio-current').textContent,'1:00:05');assert.equal(element('audio-duration').textContent,'1:01:01');
media.duration=Infinity;media.emit('durationchange');assert.equal(seekControl.disabled,true,'Unknown/infinite duration must not allow invalid seeking');
media.duration=120;media.currentTime=0;media.emit('durationchange');
await media.play();media.currentTime=30;
element('audio-back').click();assert.equal(media.currentTime,25);assert.equal(media.paused,false);
element('audio-forward').click();assert.equal(media.currentTime,30);
media.currentTime=2;element('audio-back').click();assert.equal(media.currentTime,0,'Rewind must clamp at the start');
media.currentTime=118;element('audio-forward').click();assert.equal(media.currentTime,120,'Forward must clamp at duration');
media.pause();media.currentTime=20;element('audio-back').click();assert.equal(media.paused,true,'Seeking paused audio must not start playback');
await element('audio-restart').onclick();assert.equal(media.currentTime,0);assert.equal(media.paused,false,'Replay must start from the beginning');
element('audio-rate').value='0.75';element('audio-rate').onchange();assert.equal(media.playbackRate,.75);assert.equal(media.preservesPitch,true);
element('audio-loop').checked=true;element('audio-loop').onchange();assert.equal(media.loop,true);
const playbackSnapshot=()=>JSON.stringify([media.src,media.currentTime,media.paused,media.playbackRate,media.volume,media.loop]);
const beforeFold=playbackSnapshot();element('audio-rate').focus();collapseAudio.click();
assert.equal(audioBody.hidden,true);assert.equal(collapseAudio.getAttribute('aria-expanded'),'false');
assert.equal(element('audio-section').classList.contains('audio-collapsed'),true);
assert.equal(documentMock.activeElement.id,'audio-collapse','Collapsing must move focus out of hidden controls');
assert.equal(playbackSnapshot(),beforeFold,'Folding must preserve playback, source, position, volume, rate and loop');
media.currentTime+=1;media.emit('timeupdate');assert.equal(audioBody.hidden,true,'Playback updates must not unfold the card');
collapseAudio.click();assert.equal(audioBody.hidden,false);assert.equal(media.paused,false);assert.equal(collapseAudio.getAttribute('aria-expanded'),'true');
media.pause();collapseAudio.click();collapseAudio.click();assert.equal(media.paused,true,'Unfolding paused audio must not autoplay');
await media.play();seekControl.focus();seekControl.emit('pointerdown',{button:0,pointerId:43});collapseAudio.click();
assert.equal(seekControl.dataset.dragging,undefined);assert.equal(seekControl.hasPointerCapture(43),false,'Folding while dragging must release the drag state');
collapseAudio.click();
run('sidebarController.open()');element('stage').emit('pointerdown');assert.equal(media.paused,false,'Hiding tools must not pause audio');
await run('requestRender(11)');assert.equal(media.paused,false,'PDF navigation must not pause audio');
const audioPage=run('currentPage');
dispatchDocument('keydown',{key:'ArrowRight',target:media,preventDefault(){}});
assert.equal(run('requestedPage'),audioPage,'Audio keyboard shortcuts must not flip the PDF');
dispatchDocument('keydown',{key:'ArrowLeft',target:element('audio-back'),preventDefault(){}});
assert.equal(run('requestedPage'),audioPage,'Audio toolbar buttons must not trigger PDF shortcuts');
assert.equal(run('JSON.stringify(strokes)'),audioState,'Playing audio must preserve annotations');
const oldURL=media.src;
collapseAudio.click();assert.equal(audioBody.hidden,true);
run("audioController.openFile({name:'not-audio.txt',type:'text/plain'})");
assert.equal(audioBody.hidden,false,'An audio error must unfold its message');
assert.equal(media.src,oldURL,'Invalid files must leave current audio available');
assert.equal(element('audio-status').classList.contains('error'),true);
run('audioController.openFile(null)');assert.equal(media.src,oldURL,'Cancelling file selection must preserve current track');
run('audioController.openFile(audioFixture)');assert.notEqual(media.src,oldURL);
assert.ok(revokedURLs.includes(oldURL),'Replacing audio must release its previous object URL');
assert.equal(media.paused,true);assert.equal(media.playbackRate,.75);assert.equal(media.loop,true);
media.duration=120;media.emit('loadedmetadata');
media.playFailure=Object.assign(new Error('blocked'),{name:'NotAllowedError'});
await element('audio-restart').onclick();assert.equal(element('audio-status').classList.contains('error'),true,'Blocked playback must show a helpful error');
media.playFailure=null;media.error={code:4};media.emit('error');
assert.equal(element('audio-restart').disabled,true);assert.equal(element('audio-status').classList.contains('error'),true);
run('audioController.openFile(audioFixture)');collapseAudio.click();media.duration=120;media.emit('loadedmetadata');
assert.equal(audioBody.hidden,true,'Metadata finishing loading must respect a manually folded card');
collapseAudio.click();
assert.equal(element('audio-restart').disabled,false);assert.equal(element('audio-status').classList.contains('error'),false,'Changing files must recover from decoding errors');
assert.ok(/<input id="audio-seek"[^>]+type="range"/.test(template),'Playback must use the dedicated full-width range control');
assert.ok(template.includes('height:44px')&&template.includes('width:28px;height:28px'),'The timeline needs a generous hit area and large thumb');
assert.ok(![...saved.values()].some(value=>value.includes('blob:')||value.includes(track.name)),'Audio URLs and files must not enter annotation or layout storage');

// Prepare complete answers once, then reveal them without mutating the stored lesson.
await run('requestRender(13)');element('pen').click();draw(50,60);draw(150,160);
assert.equal(run('revealStepEnds().length'),2);
element('step-group').click();assert.equal(run('revealStepEnds().length'),1);
assert.equal(run('strokes[13][0].revealGroup'),run('strokes[13][1].revealGroup'));
assert.equal(element('step-group').disabled,true,'Only annotations added since the last group may be grouped');
element('undo').click();assert.equal(run('revealStepEnds().length'),2,'Grouping must be undoable without modifying historical objects');
assert.equal(run('strokes[13][0].revealGroup'),undefined);
element('step-group').click();
element('text').click();pointer('pointerdown',220,220);element('text-input').value='A complete answer';element('text-input').emit('input');
element('step-group').click();assert.equal(run('textDraft'),null,'Grouping must commit a pending text answer');
assert.equal(run('strokes[13].at(-1).kind'),'text');assert.equal(run('revealStepEnds().length'),2);
run('startText(null,2)');element('text-input').value='完整答案';element('text-done').click();
assert.equal(run('strokes[13][2].revealGroup'),2,'Editing a grouped text answer must preserve its step');
element('rectangle').click();pointer('pointerdown',70,350);pointer('pointermove',300,450);pointer('pointerup',300,450);
assert.equal(run('revealStepEnds().length'),3);
const prepared=JSON.parse(run('JSON.stringify(strokes[13])'));
run('saveNow();strokes={};restoreNotes();drawInk();updateControls()');
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared,'Grouping must survive automatic saving and validation');
assert.deepEqual(JSON.parse(run("JSON.stringify(validateNotes(localState(),'fixture',121).strokes[13])")),prepared,'Backups must preserve all three annotation types and their grouping');
for(const value of ['0','-1','1.5','"bad"','9007199254740992']) {
  assert.throws(()=>run(`validateNotes({version:4,fingerprint:'fixture',strokes:{'1':[{color:'#df3030',width:.004,points:[[.1,.1]],revealGroup:${value}}]}},'fixture',121)`));
}
run("validateNotes({version:2,fingerprint:'fixture',strokes:{'1':[{kind:'text',text:'legacy',color:'#df3030',x:.1,y:.1,fontSize:.03,boxWidth:.3}]}},'fixture',121)");
run("validateNotes({version:3,fingerprint:'fixture',strokes:{'1':[{kind:'shape',shape:'line',color:'#df3030',width:.01,from:[.1,.1],to:[.5,.5]}]}},'fixture',121)");
await media.play();const revealAudio=playbackSnapshot();
element('reveal-start').click();
assert.equal(run('presenting'),true);assert.equal(run('tool'),'hand');assert.equal(documentMock.activeElement.id,'stage');
assert.equal(element('reveal-start').getAttribute('aria-checked'),'false','Disabling edit must return to presentation');
assert.equal(run('visibleAnnotationCount()'),0);assert.equal(run('textNodes.size'),0);assert.equal(element('ink').getContext().drawCount,0,'Hidden ink must actually be absent from the canvas');
assert.equal(element('reveal-prev').disabled,true);assert.equal(element('pen').disabled,false);assert.equal(element('import').disabled,true);assert.equal(element('hand').disabled,false);
const revealKey=(key,target=element('stage'),extra={})=>dispatchDocument('keydown',{key,target,preventDefault(){},...extra});
revealKey(' ');assert.equal(run('visibleAnnotationCount()'),2);assert.equal(element('ink').getContext().drawCount,2,'Two grouped strokes must appear together');
revealKey('ArrowDown');assert.equal(run('visibleAnnotationCount()'),3);assert.equal(run('textNodes.size'),1);
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),4);assert.equal(element('ink').getContext().drawCount,3);
assert.equal(element('reveal-next').disabled,true);assert.equal(documentMock.activeElement.id,'stage');
revealKey('ArrowUp');assert.equal(run('visibleAnnotationCount()'),3);assert.equal(element('ink').getContext().drawCount,2);
const countBeforeInputs=run('visibleAnnotationCount()');
for(const target of [element('text-input'),element('audio-back'),element('audio-seek'),element('reveal-start'),{tagName:'SUMMARY'},{tagName:'DIV',isContentEditable:true}]) revealKey(' ',target);
revealKey(' ',element('stage'),{isComposing:true});
assert.equal(run('visibleAnnotationCount()'),countBeforeInputs,'Classroom shortcuts must not hijack controls or text composition');
// Annotate the current revealed answer without exposing the next prepared answer.
assert.equal(element('undo').disabled,true,'Classroom undo must start separately from preparation history');
element('undo').onclick();run('groupNewAnnotations()');
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared);
element('pen').click();colors[1].click();draw(350,80);
assert.equal(run('strokes[13].length'),5);assert.equal(run('visibleAnnotationCount()'),4);
assert.equal(run('revealCounts.get(13)'),2);assert.equal(run('revealStepEnds().length'),3,'A classroom addition joins the displayed step');
assert.equal(run('strokes[13][3].color'),'#2166cf');assert.equal(run('strokes[13][4].shape'),'rectangle');
assert.equal(element('ink').getContext().drawCount,3,'Only the revealed handwriting and live addition should render');
run('saveNow()');
assert.deepEqual(JSON.parse(saved.get('pdf-classroom-whiteboard-v1:fixture')).strokes[13],prepared,'New classroom ink must never overwrite saved preparation');
element('undo').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared);
element('text').click();pointer('pointerdown',300,240);element('text-input').value='课堂补充';element('text-input').emit('input');
colors[5].click();element('text-size').value='36';element('text-size').onchange();element('text-done').click();
assert.equal(run('strokes[13][3].text'),'课堂补充');assert.equal(run('strokes[13][3].color'),'#873eb5');assert.equal(run('textNodes.size'),2);
assert.equal(run('strokes[13][4].shape'),'rectangle');assert.equal(run('revealCounts.get(13)'),2);
run("textNodes.get(2).emit('pointerdown',{button:0,preventDefault(){},stopPropagation(){}})");
element('text-input').value='课堂更正';element('text-done').click();assert.equal(run('strokes[13][2].text'),'课堂更正');
element('undo').click();assert.equal(run('strokes[13][2].text'),'完整答案');element('undo').click();
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared,'New text and edits to revealed text must be undoable');
pointer('pointerdown',300,240);element('text-input').value='switch between text notes';element('text-input').emit('input');
const existingClassText=run('textNodes.get(2)');
dispatchDocument('pointerdown',{target:existingClassText});
existingClassText.emit('pointerdown',{button:0,preventDefault(){},stopPropagation(){}});
assert.equal(run('textDraft.index'),2,'Clicking a revealed note must commit the new draft and edit the clicked note in one click');
assert.equal(run('textInput.value'),'完整答案');element('text-cancel').click();element('undo').click();
for(const name of ['check','cross','ellipse','rectangle','line','arrow']){
  element(name).click();
  pointer('pointerdown',360,500);if(!['check','cross'].includes(name))pointer('pointermove',450,560);pointer('pointerup',450,560);
  assert.equal(run('strokes[13][3].shape'),name);assert.equal(run('strokes[13].length'),5);
  assert.equal(run('revealCounts.get(13)'),2);assert.equal(run('revealStepEnds().length'),3);
  element('undo').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared,'Every classroom shape must undo without changing hidden notes');
}
element('line').click();pointer('pointerdown',360,500);pointer('pointermove',450,560);revealKey('Escape');pointer('pointerup',450,560);
assert.equal(run('presenting'),true);assert.equal(run('activeShape'),null);assert.equal(run('strokes[13].length'),4,'Esc must cancel an unfinished shape before leaving presentation');
element('text').click();run('startText(null,2)');element('text-delete').click();
assert.equal(run('visibleAnnotationCount()'),2);assert.equal(run('revealCounts.get(13)'),1);assert.equal(run('textNodes.size'),0);
assert.equal(run('strokes[13][2].shape'),'rectangle');assert.equal(element('ink').getContext().drawCount,2,'Deleting the entire current step must keep the next step hidden');
element('undo').click();run('startText(null,2)');element('text-input').value='';element('text-done').click();
assert.equal(run('revealCounts.get(13)'),1);element('undo').click();
element('clear').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared,'Classroom clear must restore all prepared answers and their grouping');
assert.equal(run('revealCounts.get(13)'),0);
assert.equal(run('visibleAnnotationCount()'),0);assert.equal(element('ink').getContext().drawCount,0);assert.equal(element('clear').disabled,true);
element('undo').click();assert.equal(run('revealCounts.get(13)'),2);
element('reveal-hide').click();element('eraser').click();
const hiddenRectanglePoint=run('[strokes[13][3].from[0]*pageWidth,strokes[13][3].from[1]*pageHeight]');
pointer('pointerdown',...hiddenRectanglePoint);pointer('pointerup',...hiddenRectanglePoint);
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared,'Eraser must ignore all hidden annotations');
element('reveal-next').click();
const firstClassStroke=run('[strokes[13][0].points[0][0]*pageWidth,strokes[13][0].points[0][1]*pageHeight]');
const secondClassStroke=run('[strokes[13][1].points[0][0]*pageWidth,strokes[13][1].points[0][1]*pageHeight]');
pointer('pointerdown',...firstClassStroke);pointer('pointerup',...firstClassStroke);
assert.equal(run('strokes[13].length'),3);assert.equal(run('visibleAnnotationCount()'),1);assert.equal(run('textNodes.size'),0);
element('undo').click();assert.equal(run('visibleAnnotationCount()'),2);
pointer('pointerdown',...firstClassStroke);pointer('pointermove',...secondClassStroke);pointer('pointerup',...secondClassStroke);
assert.equal(run('visibleAnnotationCount()'),0);assert.equal(run('textNodes.size'),0);assert.equal(element('ink').getContext().drawCount,0);
assert.equal(run('strokes[13].length'),2,'Erasing the visible group must preserve both hidden answers');
element('undo').click();assert.equal(run('revealCounts.get(13)'),1);assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared);
element('reveal-hide').click();element('pen').click();draw(350,80);draw(350,130);
assert.equal(run('visibleAnnotationCount()'),2);assert.equal(run('revealCounts.get(13)'),1);assert.equal(run('revealStepEnds().length'),4);
assert.equal(run('textNodes.size'),0,'Writing before the first reveal must not expose any prepared text');
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),4);assert.equal(run('textNodes.size'),0);
element('undo').click();assert.equal(run('visibleAnnotationCount()'),1);element('undo').click();assert.equal(run('visibleAnnotationCount()'),0);
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared);
// Finishing text before moving to the next step must attach it to the old step.
element('text').click();pointer('pointerdown',300,240);element('text-input').value='before first answer';element('text-input').emit('input');
element('reveal-next').click();assert.equal(run('textDraft'),null);assert.equal(run('visibleAnnotationCount()'),3);assert.equal(run('revealCounts.get(13)'),2);
assert.equal(run('strokes[13][0].text'),'before first answer');assert.equal(run('textNodes.size'),1);
element('undo').click();assert.equal(run('visibleAnnotationCount()'),0);
run("revealTo(2);setTool('hand')");
element('import-file').files=[{size:2,text:async()=>{throw new Error('Must not read imports in presentation mode')}}];
await element('import-file').onchange({target:element('import-file')});
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[13])')),prepared,'Undoing classroom changes must fully restore prepared annotations');
assert.equal(run('textDraft'),null);assert.equal(run('tool'),'hand');
run('saveNow()');assert.deepEqual(JSON.parse(saved.get('pdf-classroom-whiteboard-v1:fixture')).strokes[13],prepared,'Saving hidden annotations must preserve the complete lesson');
run('download = (name,data) => { globalThis.exportedNotes = data; }');element('export').click();
assert.deepEqual(JSON.parse(run('exportedNotes')).strokes[13],prepared,'Export must include hidden answers and step groups');
await run('requestRender(12)');assert.equal(run('visibleAnnotationCount()'),0,'An unvisited page must begin hidden');
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),1,'Legacy notes still reveal one annotation per step');
await run('requestRender(13)');assert.equal(run('visibleAnnotationCount()'),3,'Returning to a page must restore its current session progress');
element('zoom').value='page';await run('requestRender()');assert.equal(run('visibleAnnotationCount()'),3,'Zoom must preserve classroom progress');
element('reveal-hide').click();assert.equal(run('visibleAnnotationCount()'),0);assert.equal(run('textNodes.size'),0);
element('reveal-all').click();assert.equal(run('visibleAnnotationCount()'),4);assert.equal(run('textNodes.size'),1);
revealKey('Escape');assert.equal(run('presenting'),false);assert.equal(run('tool'),'rectangle');assert.equal(run('visibleAnnotationCount()'),4);assert.equal(element('pen').disabled,false);
assert.equal(playbackSnapshot(),revealAudio,'Showing, hiding, flipping pages and leaving presentation must preserve audio playback');
// Starting a presentation commits any unfinished text, and each new session starts at zero.
element('text').click();pointer('pointerdown',300,500);element('text-input').value='last answer';element('text-input').emit('input');
element('reveal-start').click();assert.equal(run('textDraft'),null);assert.equal(run('strokes[13].at(-1).text'),'last answer');assert.equal(run('visibleAnnotationCount()'),0);
element('reveal-next').click();
await openForClassroom("openFile({name:'sample-again.pdf',type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})");
assert.equal(run('strokes[13].length'),5,'Reopening must restore preparation without displaying it');
element('reveal-start').click();assert.equal(run('presenting'),false);assert.equal(run('tool'),'text');

// Edit the actual classroom steps from the preparation panel opposite the toolbar.
await run('requestRender(14)');element('pen').click();draw(50,70);draw(120,120);element('step-group').click();
element('text').click();pointer('pointerdown',210,230);element('text-input').value='第二步文字';element('text-done').click();
element('rectangle').click();pointer('pointerdown',90,380);pointer('pointermove',280,470);pointer('pointerup',280,470);
const stepRows=()=>element('steps-list').children;
const pickStep=index=>stepRows()[index].children[0].click();
const moveStep=(index,delta)=>stepRows()[index].children[1].children[delta<0?0:1].click();
const contentOnly=()=>JSON.parse(run('JSON.stringify(strokes[14].map(({revealGroup,...item})=>item))'));
const baseContents=contentOnly();
assert.equal(stepRows().length,3);assert.equal(element('steps-panel').hidden,false);assert.equal(element('steps-handle').hidden,false);
assert.ok(element('steps-page').textContent.includes('14'));assert.ok(element('steps-page').textContent.includes('3'));
assert.equal(stepRows()[0].children[0].children[1].getContext().drawCount,2,'Grouped handwriting must have a real thumbnail');
assert.ok(stepRows()[1].children[0].children.some(node=>node.textContent==='第二步文字'),'Text steps must show their text excerpt');
assert.equal(stepRows()[0].children[1].children[0].disabled,true);assert.equal(stepRows()[2].children[1].children[1].disabled,true);
pickStep(1);assert.equal(run('selectedStepIndex()'),1);assert.equal(element('step-highlight').hidden,false);
assert.equal(element('step-highlight-label').textContent,'第 2 步');assert.equal(element('step-highlight').lastScrollOptions.block,'center');
assert.deepEqual(contentOnly(),baseContents,'Selecting a step must not change annotations');
const pageBeforeStepKeys=run('currentPage');revealKey('ArrowRight',stepRows()[1].children[0]);
assert.equal(run('currentPage'),pageBeforeStepKeys,'Arrow keys inside the steps panel must not turn PDF pages');
assert.equal(run('requestedPage'),pageBeforeStepKeys);
stepRows()[2].children[1].children[0].focus();moveStep(2,-1);
assert.equal(run('pageSteps()[1].items[0].shape'),'rectangle');assert.equal(run('selectedStepIndex()'),1);
assert.equal(documentMock.activeElement,stepRows()[1].children[0],'Rebuilding the list must retain keyboard focus on the moved step');
moveStep(1,-1);assert.equal(run('strokes[14][0].shape'),'rectangle');assert.equal(run('revealStepEnds().length'),3);
element('steps-undo').click();element('steps-undo').click();assert.deepEqual(contentOnly(),baseContents,'Reordering must be fully undoable');
pickStep(0);element('steps-merge-next').click();assert.equal(run('pageSteps().length'),2);assert.equal(run('pageSteps()[0].items.length'),3);
element('steps-undo').click();assert.deepEqual(contentOnly(),baseContents);
pickStep(1);element('steps-merge-prev').click();assert.equal(run('pageSteps().length'),2);assert.equal(run('selectedStepIndex()'),0);
element('steps-split').click();assert.equal(run('pageSteps().length'),4,'Splitting must create a step for each annotation');
assert.deepEqual(contentOnly(),baseContents,'Merging and splitting must preserve every position, color, width, text and shape');
element('steps-undo').click();assert.equal(run('pageSteps().length'),2);element('steps-undo').click();assert.equal(run('pageSteps().length'),3);
moveStep(2,-1);moveStep(1,-1);
const arranged=JSON.parse(run('JSON.stringify(strokes[14])'));
run('saveNow();strokes={};restoreNotes();drawInk();updateControls()');
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[14])')),arranged,'A reordered lesson must survive saving and reopening');
assert.equal(run('strokes[14][0].shape'),'rectangle');assert.equal(run('pageSteps()[1].items.length'),2);
element('export').click();assert.deepEqual(JSON.parse(run('exportedNotes')).strokes[14],arranged,'Export must preserve the edited step order');
const audioDuringStepEdit=playbackSnapshot();element('reveal-start').click();
assert.equal(element('steps-panel').hidden,true);assert.equal(element('steps-handle').hidden,true);assert.equal(element('step-highlight').hidden,true);
element('steps-split').onclick();run("changeStep('move',0,1)");
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[14])')),arranged,'Presentation mode must block step editing');
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),1);assert.equal(element('ink').getContext().drawCount,1,'The first revealed step must now be the moved rectangle');
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),3,'The grouped two-stroke answer must remain grouped after reordering');
element('reveal-start').click();assert.equal(element('steps-panel').hidden,false);assert.equal(playbackSnapshot(),audioDuringStepEdit);

// The second panel can hide or pin independently without resizing or shifting the PDF.
const stepsSnapshot=()=>JSON.parse(run('JSON.stringify(stepsPanelController.snapshot())'));
const stepsAutoHide=async()=>{run('stepsPanelController.scheduleHide(0)');await tick()};
const beforeStepLayout=run('JSON.stringify([pageWidth,pageHeight,sheet.style.width,sheet.style.height])');
run('stepsPanelController.open()');await stepsAutoHide();assert.equal(stepsSnapshot().expanded,false);
element('steps-handle').emit('pointerenter',{pointerType:'mouse'});await stepsAutoHide();assert.equal(stepsSnapshot().expanded,true);
element('steps-handle').emit('pointerleave',{pointerType:'mouse'});element('steps-panel').emit('pointerenter',{pointerType:'mouse'});
await stepsAutoHide();assert.equal(stepsSnapshot().expanded,true);
element('steps-panel').emit('pointerleave',{pointerType:'mouse'});await stepsAutoHide();assert.equal(stepsSnapshot().expanded,false);
element('steps-handle').click();element('steps-pin').click();element('stage').emit('pointerdown');await stepsAutoHide();
assert.equal(stepsSnapshot().expanded,true);assert.equal(stepsSnapshot().pinned,true);
assert.deepEqual(JSON.parse(saved.get('pdf-classroom-steps-panel-v1')),{pinned:true});
element('steps-close').click();assert.equal(stepsSnapshot().expanded,false);assert.equal(documentMock.activeElement.id,'steps-handle');
element('steps-handle').click();element('steps-pin').click();pickStep(0);element('stage').emit('pointerdown');
assert.equal(stepsSnapshot().expanded,false);assert.equal(element('step-highlight').hidden,true,'Clicking the worksheet must clear the temporary selection frame');
run('stepsPanelController.open()');stepRows()[0].children[0].focus();revealKey('Tab',stepRows()[0].children[0]);await stepsAutoHide();assert.equal(stepsSnapshot().expanded,true,'Keyboard use must prevent the steps panel disappearing');
revealKey('Escape',stepRows()[0].children[0]);assert.equal(stepsSnapshot().expanded,false);
element('panel-side').value='left';element('panel-side').onchange();assert.equal(documentMock.body.dataset.panelSide,'left');
assert.ok(template.includes('body[data-panel-side="left"] .steps-panel{left:auto;right:0'));
assert.equal(run('JSON.stringify([pageWidth,pageHeight,sheet.style.width,sheet.style.height])'),beforeStepLayout,'Step panel placement must not resize the PDF');
await run('requestRender(15)');assert.equal(stepRows().length,0);assert.equal(element('steps-empty').hidden,false);
// Imported IDs may be repeated in disjoint steps; moving them together must not merge them.
run("strokes[15]=[0,1,2].map((n)=>({color:'#df3030',width:.004,points:[[.1+n*.1,.1]],revealGroup:n===1?2:1}));drawInk();updateControls()");
moveStep(2,-1);assert.equal(run('pageSteps().length'),3,'Moving disjoint imported group IDs together must keep distinct steps');
await run('requestRender(14)');assert.equal(stepRows().length,3);
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[14])')),arranged,'Editing another page must leave the original lesson intact');

// Classroom notes survive page changes within one session, but never enter persistence or preparation history.
await run('requestRender(16)');element('text').click();pointer('pointerdown',100,100);element('text-input').value='prepared answer';element('text-done').click();
element('arrow').click();pointer('pointerdown',100,350);pointer('pointermove',260,400);pointer('pointerup',260,400);
const prepared16=JSON.parse(run('JSON.stringify(strokes[16])'));
const prepHistory16=run('JSON.stringify(history.get(16))');
const allPrepared=JSON.parse(run('JSON.stringify(strokes)'));
const writesBeforePresentation=noteWrites;
element('reveal-start').click();run('startText(null,0)');assert.equal(run('textDraft'),null,'Hidden prepared text cannot be edited');
assert.equal(noteWrites,writesBeforePresentation+1,'Entering presentation must flush the pending preparation save');
const diskBeforeClass=saved.get('pdf-classroom-whiteboard-v1:fixture');
assert.deepEqual(JSON.parse(diskBeforeClass).strokes,allPrepared);
const classWrites=noteWrites;
element('reveal-next').click();element('pen').click();draw(320,100);
element('text').click();pointer('pointerdown',300,220);element('text-input').value='live explanation';element('text-done').click();
element('check').click();pointer('pointerdown',380,360);pointer('pointerup',380,360);
assert.equal(run('strokes[16].length'),5);assert.equal(run('visibleAnnotationCount()'),4);assert.equal(run('revealStepEnds().length'),2);
const class16=JSON.parse(run('JSON.stringify(strokes[16])'));
element('export').click();assert.deepEqual(JSON.parse(run('exportedNotes')).strokes,allPrepared,'Export while presenting must contain only the original preparation across every page');
await run('requestRender(17)');assert.equal(run('visibleAnnotationCount()'),0);element('pen').click();draw(320,100);
assert.equal(run('visibleAnnotationCount()'),1,'Classroom writing must also work on an empty page');
const class17=JSON.parse(run('JSON.stringify(strokes[17])'));
element('reveal-hide').click();assert.equal(element('clear').disabled,false,'Hidden temporary notes must still be clearable at step zero');
element('clear').click();assert.equal(run('strokes[17]'),undefined);assert.equal(run('revealCounts.get(17)'),0);assert.equal(element('clear').disabled,true);
element('undo').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[17])')),class17);assert.equal(run('revealCounts.get(17)'),0);
element('reveal-next').click();
await run('requestRender(16)');assert.equal(run('visibleAnnotationCount()'),4);
element('zoom').value='width';await run('requestRender()');assert.equal(run('visibleAnnotationCount()'),4);
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),class16);
element('reveal-hide').click();assert.equal(run('visibleAnnotationCount()'),0);assert.equal(run('textNodes.size'),0);
assert.equal(element('clear').disabled,false);assert.equal(element('clear').textContent,'清空随堂笔记');
element('clear').click();
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16,'Clear must remove hidden live ink, text and shapes while restoring the prepared page');
assert.equal(run('revealCounts.get(16)'),0);assert.equal(run('revealStepEnds().length'),2);assert.equal(element('clear').disabled,true);
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[17])')),class17,'Clearing one page must preserve the other page’s temporary notes');
assert.equal(run('revealCounts.get(17)'),1,'Clearing one page must preserve the other page’s presentation progress');
assert.equal(saved.get('pdf-classroom-whiteboard-v1:fixture'),diskBeforeClass);assert.equal(noteWrites,classWrites,'Classroom clear must not write to preparation storage');
assert.equal(documentMock.activeElement.id,'stage');
element('undo').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),class16);assert.equal(run('revealCounts.get(16)'),0);
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),4,'Live additions must hide and reappear with their original step');

// Finishing pending text on lifecycle events or export must stay in memory, with no storage writes.
element('text').click();pointer('pointerdown',300,520);element('text-input').value='temporary on visibility change';element('text-input').emit('input');
documentMock.hidden=true;dispatchDocument('visibilitychange',{});documentMock.hidden=false;
assert.equal(run('textDraft'),null);assert.equal(run('strokes[16].length'),6);
pointer('pointerdown',300,600);element('text-input').value='temporary on page hide';element('text-input').emit('input');
dispatchWindow('pagehide');assert.equal(run('textDraft'),null);assert.equal(run('strokes[16].length'),7);
pointer('pointerdown',300,660);element('text-input').value='temporary on export';element('text-input').emit('input');element('export').click();
assert.equal(run('textDraft'),null);assert.deepEqual(JSON.parse(run('exportedNotes')).strokes,allPrepared);
run('saveNow();scheduleSave()');await new Promise(resolve=>setTimeout(resolve,220));
assert.equal(noteWrites,classWrites,'Classroom edits, auto-save timers, pagehide, visibilitychange and explicit saves must write no notes to storage');
assert.equal(saved.get('pdf-classroom-whiteboard-v1:fixture'),diskBeforeClass);
assert.equal(run('JSON.stringify(history.get(16))'),prepHistory16,'Preparation undo history must be isolated during presentation');

pointer('pointerdown',300,700);element('text-input').value='pending on end';element('text-input').emit('input');
element('reveal-start').click();assert.equal(run('textDraft'),null);assert.equal(run('visibleAnnotationCount()'),2);
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes)')),allPrepared,'Ending presentation must discard changes across all pages, including a previously blank page');
assert.equal(run('JSON.stringify(history.get(16))'),prepHistory16,'Classroom undo entries must never be merged into preparation history');
assert.equal(run('presentationHistory.size'),0);assert.equal(run('preparationStrokes'),undefined);
element('undo').click();assert.equal(run('strokes[16].length'),1,'The next preparation undo must undo the original prepared arrow, not a classroom addition');
run('strokes[16]=JSON.parse('+JSON.stringify(JSON.stringify(prepared16))+');drawInk();updateControls()');

element('reveal-start').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16,'A new presentation must start from the original prepared notes');
element('reveal-next').click();run('startText(null,0)');element('text-input').value='temporary edit to prepared text';element('text-done').click();
element('reveal-all').click();element('eraser').click();
const preparedArrowPoint=run('[strokes[16][1].from[0]*pageWidth,strokes[16][1].from[1]*pageHeight]');
pointer('pointerdown',...preparedArrowPoint);pointer('pointerup',...preparedArrowPoint);
assert.equal(run('strokes[16].length'),1);
element('text').click();run('startText(null,0)');element('text-delete').click();
assert.equal(run('strokes[16].length'),0);assert.equal(run('visibleAnnotationCount()'),0);
assert.equal(element('clear').disabled,false,'Classroom deletions must be resettable even when no annotations remain visible');
element('clear').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16);
assert.equal(run('revealCounts.get(16)'),0);
element('text').click();pointer('pointerdown',300,520);element('text-input').value='pending note to clear';element('text-input').emit('input');
element('clear').click();assert.equal(run('textDraft'),null);assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16,'Clearing must also remove pending text without saving it');
assert.equal(run('revealCounts.get(16)'),0);
element('reveal-start').click();assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16,'Ending must restore edits, erased shapes, clears and original grouping without requiring undo');

element('reveal-start').click();element('pen').click();draw(320,100);element('text').click();pointer('pointerdown',300,220);element('text-input').value='pending temporary note on reload';element('text-input').emit('input');
await openForClassroom("openFile({name:'continue-class.pdf',type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})");
assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16);
assert.equal(run('textDraft'),null);assert.equal(run('pageSteps().length'),2,'Reopening must restore the prepared steps and discard the temporary first step');
assert.equal(run('strokes[17]'),undefined,'Classroom-only pages must not be restored');
element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),1);assert.equal(run('textNodes.size'),1);
element('pen').click();draw(320,100);dispatchWindow('pagehide');
run('restoreNotes();drawInk();updateControls()');
assert.equal(run('presenting'),false);assert.deepEqual(JSON.parse(run('JSON.stringify(strokes[16])')),prepared16,'Restoring after pagehide must recover only persisted preparation');
element('reveal-start').click();element('reveal-next').click();assert.equal(run('visibleAnnotationCount()'),1);
element('reveal-start').click();

// Repeated imported IDs on either side of a deleted step must not expose the hidden side.
await run('requestRender(18)');
run("strokes[18]=[0,1,2].map(n=>({color:'#df3030',width:.004,points:[[.15+n*.25,.2]],revealGroup:n===1?2:1}));drawInk();updateControls()");
element('reveal-start').click();element('reveal-next').click();element('reveal-next').click();element('eraser').click();
const middleImported=run('[strokes[18][1].points[0][0]*pageWidth,strokes[18][1].points[0][1]*pageHeight]');
pointer('pointerdown',...middleImported);pointer('pointerup',...middleImported);
assert.equal(run('strokes[18].length'),2);assert.equal(run('visibleAnnotationCount()'),1);assert.equal(element('ink').getContext().drawCount,1);
element('undo').click();assert.equal(run('visibleAnnotationCount()'),2);assert.equal(run('strokes[18].length'),3);
element('reveal-start').click();

// The preparation grouping shortcut works from the worksheet, steps panel and active text editor.
await run('requestRender(19)');element('pen').click();draw(60,80);draw(180,160);
const beforeShortcut=run('JSON.stringify(strokes[19])');
for(const extra of [{isComposing:true},{keyCode:229},{repeat:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:false}]){
  revealKey('q',element('stage'),{altKey:true,...extra});
  assert.equal(run('JSON.stringify(strokes[19])'),beforeShortcut,'IME, repeated keys, plain Q and other modifier combinations must not group notes');
}
revealKey('Enter',element('stage'),{ctrlKey:true,shiftKey:true});
assert.equal(run('JSON.stringify(strokes[19])'),beforeShortcut,'The replaced shortcut must no longer group notes');
run('loadingFile=true');revealKey('q',element('stage'),{altKey:true});run('loadingFile=false');
assert.equal(run('JSON.stringify(strokes[19])'),beforeShortcut);
run('renderPump=Promise.resolve()');revealKey('q',element('stage'),{altKey:true});run('renderPump=undefined');
assert.equal(run('JSON.stringify(strokes[19])'),beforeShortcut);
run('globalThis.shortcutPDF=pdf;pdf=undefined');revealKey('q',element('stage'),{altKey:true});run('pdf=globalThis.shortcutPDF');
assert.equal(run('JSON.stringify(strokes[19])'),beforeShortcut);
revealKey('q',element('step-group'),{altKey:true});assert.equal(run('revealStepEnds().length'),1,'Alt+Q must work from the preparation panel');
element('undo').click();assert.equal(run('revealStepEnds().length'),2,'Shortcut grouping must be undoable');

element('text').click();pointer('pointerdown',200,260);element('text-input').value='Ctrl Enter commits only';element('text-input').emit('input');
const textKey=extra=>{const event={key:'Enter',target:element('text-input'),preventDefault(){this.defaultPrevented=true},...extra};element('text-input').emit('keydown',event);dispatchDocument('keydown',event);return event};
textKey({ctrlKey:true});assert.equal(run('textDraft'),null);assert.equal(run('revealStepEnds().length'),3);
assert.equal(run('strokes[19][2].revealGroup'),undefined,'Ctrl+Enter must retain its text-completion behavior without grouping');
pointer('pointerdown',200,400);element('text-input').value='pending answer to group';element('text-input').emit('input');
textKey({key:'q',altKey:true,isComposing:true});assert.notEqual(run('textDraft'),null);assert.equal(run('strokes[19].length'),3);
const groupedTextEvent=textKey({key:'q',altKey:true});assert.equal(groupedTextEvent.defaultPrevented,true);
assert.equal(run('textDraft'),null);assert.equal(run('strokes[19].length'),4);assert.equal(run('revealStepEnds().length'),1);
assert.equal(run('strokes[19][3].text'),'pending answer to group');assert.equal(documentMock.activeElement.id,'stage');
element('undo').click();assert.equal(run('revealStepEnds().length'),4,'Undo grouping must keep the newly completed text');
revealKey('q',element('stage'),{altKey:true});
element('pen').click();draw(300,480);draw(360,520);
revealKey('Q',element('stage'),{altKey:true});assert.equal(run('revealStepEnds().length'),2,'The shortcut must handle Caps Lock and group only the new tail after the preceding group');
assert.equal(run('pageSteps()[0].items.length'),4);assert.equal(run('pageSteps()[1].items.length'),2);
element('reveal-start').click();element('reveal-next').click();element('text').click();pointer('pointerdown',200,600);
element('text-input').value='classroom draft must stay ungrouped';element('text-input').emit('input');
const shortcutClassSnapshot=run('JSON.stringify(strokes[19])');
textKey({key:'q',altKey:true});assert.notEqual(run('textDraft'),null);assert.equal(run('JSON.stringify(strokes[19])'),shortcutClassSnapshot,'Preparation grouping shortcut must be inactive during classroom presentation');
element('reveal-start').click();assert.equal(run('strokes[19].length'),6);
assert.ok(/id="step-group"[^>]+aria-keyshortcuts="Alt\+Q"/.test(template));

// Even when the last session was preparation, opening again must start in the classroom.
element('text').click();pointer('pointerdown',200,680);element('text-input').value='last prepared answer before reopening';element('text-input').emit('input');
const writesBeforePrepReopen=noteWrites;
await openForClassroom("openFile({name:'prepared-again.pdf',type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})");
assert.equal(noteWrites,writesBeforePrepReopen+1,'Reopening from preparation must save its pending input once and then enter classroom without another write');
assert.equal(run('strokes[19].at(-1).text'),'last prepared answer before reopening');
assert.equal(JSON.parse(saved.get('pdf-classroom-whiteboard-v1:fixture')).strokes[19].at(-1).text,'last prepared answer before reopening');

doc.fingerprints=['another-fixture'];
await openForClassroom("openFile({name:'different.pdf',type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})");
assert.equal(run('revealCounts.size'),0);assert.equal(run('Object.keys(strokes).length'),0,'A different PDF must not inherit answers or classroom state');
saved.set('pdf-classroom-whiteboard-v1:another-fixture','invalid stored notes');
const writesBeforeBadNotes=noteWrites;
await openForClassroom("openFile({name:'bad-notes.pdf',type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)})");
assert.equal(noteWrites,writesBeforeBadNotes,'Default classroom mode must not overwrite a backup that could not be read');
assert.equal(saved.get('pdf-classroom-whiteboard-v1:another-fixture'),'invalid stored notes');
assert.equal(run('storageAvailable'),false);
assert.ok(template.includes('id="stage" class="stage" tabindex="0"'));
assert.equal([...template.matchAll(/<section[^>]*data-block=/g)].length,7);

// File System Access API: keep prepared notes next to the PDF, and carry them to
// a fresh browser without relying on its localStorage or its drive letter.
const notFound=()=>Object.assign(new Error('not found'),{name:'NotFoundError'});
function memoryFile(name,content='') {
  return {kind:'file',name,content,writes:[],fail:false,active:0,maxActive:0,aborted:0,
    async getFile(){return {name,type:'application/json',size:Buffer.byteLength(this.content),text:async()=>this.content}},
    async createWritable(){
      const file=this;
      if(file.fail)throw new Error('U disk unavailable');
      file.active++;file.maxActive=Math.max(file.maxActive,file.active);
      let draft;
      return {async write(value){if(file.gate)await file.gate;if(file.failWrite)throw new Error('disk full');draft=value},
        async close(){file.content=draft;file.writes.push(draft);file.active--},
        async abort(){file.aborted++;file.active--}};
    }};
}
function memoryDirectory(name,children=[]) {
  return {kind:'directory',name,entries:new Map(children.map(child=>[child.name,child])),
    async *values(){yield* this.entries.values()},
    async getDirectoryHandle(name,options={}){
      let child=this.entries.get(name);
      if(!child&&options.create){child=memoryDirectory(name);this.entries.set(name,child)}
      if(!child)throw notFound();if(child.kind!=='directory')throw new Error('not a directory');return child;
    },
    async getFileHandle(name,options={}){
      let child=this.entries.get(name);
      if(!child&&options.create){child=memoryFile(name);this.entries.set(name,child)}
      if(!child)throw notFound();if(child.kind!=='file')throw new Error('not a file');return child;
    }};
}
const pdfHandle=name=>({kind:'file',name,async getFile(){return {name,type:'application/pdf',arrayBuffer:async()=>new ArrayBuffer(1)}}});
const usbPDF=pdfHandle('英语教材.pdf'), usbDirectory=memoryDirectory('U盘教材',[usbPDF]);
testContext.usbDirectory=usbDirectory;
testContext.window.showDirectoryPicker=async options=>{assert.equal(options.mode,'readwrite');return usbDirectory};
Object.assign(element('folder-picker'),{showModal(){this.open=true},close(){this.open=false}});
doc.fingerprints=['usb-fixture'];
await run('chooseFolder()');
assert.equal(run('presenting'),true);assert.equal(run('visibleAnnotationCount()'),0);
const notesDirectory=usbDirectory.entries.get('英语教材');
assert.ok(notesDirectory,'The folder must match the PDF basename exactly');
assert.equal(notesDirectory.entries.size,0,'Opening for presentation must not create or overwrite a notes file');
assert.ok(element('folder-save-status').textContent.includes('U盘教材/英语教材/备课数据.json'));
assert.equal(element('save-now').disabled,true);
element('reveal-start').click();element('pen').click();draw(100,150);
element('text').click();pointer('pointerdown',200,300);element('text-input').value='USB answer';element('text-input').emit('input');element('text-done').click();
element('check').click();pointer('pointerdown',350,400);pointer('pointerup',350,400);
element('step-group').click();
const expectedUSB=run('JSON.stringify(localState())');
await run('saveNow()');
const notesFile=notesDirectory.entries.get('备课数据.json');
assert.equal(notesFile.content,expectedUSB);
assert.equal(JSON.parse(notesFile.content).strokes[1].length,3);
assert.ok(element('folder-save-status').textContent.endsWith('已保存'));
assert.equal(run('pendingDiskSaves'),0);
assert.equal(element('save-now').disabled,false);

// A closing tab is warned while an asynchronous save is incomplete. Writes must
// remain serialized snapshots even when the app enters presentation meanwhile.
let releaseDisk;
notesFile.gate=new Promise(resolve=>{releaseDisk=resolve});
element('pen').click();draw(200,450);const firstSnapshot=run('JSON.stringify(localState())');
const firstDiskSave=run('saveNow()');
draw(250,500);const lastPreparedSnapshot=run('JSON.stringify(localState())');
const lastDiskSave=run('saveNow()');
const leaving={prevented:false,preventDefault(){this.prevented=true}};
dispatchWindow('beforeunload',leaving);assert.equal(leaving.prevented,true);
element('reveal-start').click();element('reveal-all').click();element('pen').click();draw(350,550);
run('saveNow()');
releaseDisk();await firstDiskSave;await lastDiskSave;delete notesFile.gate;
assert.equal(notesFile.content,lastPreparedSnapshot,'Temporary presentation notes must never enter the disk file');
assert.ok(notesFile.writes.includes(firstSnapshot),'The first queued write must retain its original immutable snapshot');
assert.equal(notesFile.maxActive,1,'Writes to one file must be serialized');
const savedDiskWrites=notesFile.writes.length;
element('text').click();pointer('pointerdown',200,600);element('text-input').value='temporary classroom text';element('text-input').emit('input');element('text-done').click();
dispatchDocument('visibilitychange',{});dispatchWindow('pagehide');await run('saveNow()');
assert.equal(notesFile.writes.length,savedDiskWrites,'Lifecycle events in presentation must never write classroom notes');

// Clear this computer's browser cache to simulate the same USB on another PC.
saved.clear();
await run('openFile({name:"英语教材.pdf",type:"application/pdf",arrayBuffer:async()=>new ArrayBuffer(1)},usbDirectory)');
assert.equal(run('presenting'),true);assert.equal(run('visibleAnnotationCount()'),0);
assert.deepEqual(JSON.parse(run('JSON.stringify(localState())')),JSON.parse(lastPreparedSnapshot));
assert.equal(notesFile.writes.length,savedDiskWrites,'Reading an existing USB lesson must be read-only');
assert.equal(run('revealStepEnds().length'),3,'Prepared grouping and the order of steps must travel with the PDF');
element('reveal-start').click();
const cleanExit={prevented:false,preventDefault(){this.prevented=true}};
dispatchWindow('beforeunload',cleanExit);assert.equal(cleanExit.prevented,false,'An unchanged, saved lesson should close without a warning');

// A full/unplugged disk must retain its previous file and the browser recovery
// copy; retrying the same data must really attempt another disk write.
notesFile.failWrite=true;element('pen').click();draw(400,600);
const retrySnapshot=run('JSON.stringify(localState())');
await run('saveNow()');
assert.equal(notesFile.content,lastPreparedSnapshot);
assert.equal(notesFile.aborted,1);assert.equal(notesFile.active,0);
assert.equal(saved.get('pdf-classroom-whiteboard-v1:usb-fixture'),retrySnapshot);
assert.ok(element('folder-save-status').classList.contains('error'));
assert.ok(element('folder-save-status').textContent.includes('写入失败'));
notesFile.failWrite=false;await element('save-now').onclick();
assert.equal(notesFile.content,retrySnapshot);assert.equal(element('folder-save-status').classList.contains('error'),false);
const previousCacheWriter=testContext.localStorage.setItem;
testContext.localStorage.setItem=()=>{throw new Error('browser quota')};
draw(420,620);await run('saveNow()');
assert.equal(JSON.parse(notesFile.content).strokes[1].length,7,'Folder saving must work even if the browser cache is full');
assert.ok(element('folder-save-status').textContent.endsWith('已保存'));
testContext.localStorage.setItem=previousCacheWriter;
await run('saveNow()');

// Browser-only notes from earlier versions migrate when entering edit mode.
const legacyDirectory=memoryDirectory('旧教材目录',[pdfHandle('旧教材.pdf')]);
testContext.legacyDirectory=legacyDirectory;
await run('openFile({name:"旧教材.pdf",type:"application/pdf",arrayBuffer:async()=>new ArrayBuffer(1)},legacyDirectory)');
assert.equal(run('folderStorage.migrating'),true);
assert.equal(legacyDirectory.entries.get('旧教材').entries.size,0);
element('reveal-start').click();await run('saveNow()');
assert.equal(JSON.parse(legacyDirectory.entries.get('旧教材').entries.get('备课数据.json').content).strokes[1].length,7);

// Switching PDFs waits for the previous folder to finish saving and cannot
// redirect a pending write into the next textbook's folder.
const legacyFile=legacyDirectory.entries.get('旧教材').entries.get('备课数据.json');
let releaseLegacy;
legacyFile.gate=new Promise(resolve=>{releaseLegacy=resolve});
element('pen').click();draw(180,250);const outgoingSnapshot=run('JSON.stringify(localState())');
const outgoingWrite=run('saveNow()');
const nextDirectory=memoryDirectory('下一份目录',[pdfHandle('新教材.pdf')]);testContext.nextDirectory=nextDirectory;
let openedNext=false;
const openNext=run('openFile({name:"新教材.pdf",type:"application/pdf",arrayBuffer:async()=>new ArrayBuffer(1)},nextDirectory)').then(()=>{openedNext=true});
await tick();assert.equal(openedNext,false);assert.equal(element('filename').textContent,'旧教材.pdf');
releaseLegacy();await outgoingWrite;await openNext;delete legacyFile.gate;
assert.equal(legacyFile.content,outgoingSnapshot);
assert.equal(element('filename').textContent,'新教材.pdf');assert.equal(run('presenting'),true);
assert.equal(nextDirectory.entries.get('新教材').entries.size,0,'An outgoing save must not write into the incoming folder');

// An existing file that is malformed or belongs to another PDF must never be
// replaced with an empty lesson, even after the user starts editing.
for(const content of ['{broken JSON',JSON.stringify({version:4,fingerprint:'different-pdf',page:1,strokes:{}})]) {
  const protectedFile=memoryFile('备课数据.json',content);
  const protectedDirectory=memoryDirectory('受保护教材',[pdfHandle('教材.pdf'),memoryDirectory('教材',[protectedFile])]);
  testContext.protectedDirectory=protectedDirectory;
  await run('openFile({name:"教材.pdf",type:"application/pdf",arrayBuffer:async()=>new ArrayBuffer(1)},protectedDirectory)');
  assert.equal(run('folderStorage.blocked'),true);assert.ok(element('folder-save-status').classList.contains('error'));
  element('reveal-start').click();element('pen').click();draw(150,200);await run('saveNow()');
  assert.equal(protectedFile.content,content);assert.equal(protectedFile.writes.length,0);assert.equal(element('save-now').disabled,true);
}

// Folder selection supports several PDFs, keyboard cancellation, empty folders,
// and unsupported browsers without resetting the currently displayed lesson.
const multiple=memoryDirectory('多教材',[pdfHandle('练习10.pdf'),pdfHandle('练习2.pdf'),memoryFile('其他.txt')]);
testContext.window.showDirectoryPicker=async()=>multiple;
const choosingMultiple=run('chooseFolder()');await tick();
assert.equal(element('folder-picker').open,true);
const progressBeforePickerKey=run('JSON.stringify([...revealCounts])');
dispatchDocument('keydown',{key:'ArrowDown',target:element('folder-picker-cancel'),preventDefault(){throw new Error('Textbook shortcuts must not intercept modal navigation')}});
assert.equal(run('JSON.stringify([...revealCounts])'),progressBeforePickerKey);
assert.deepEqual(element('folder-pdf-list').children.map(button=>button.textContent),['练习2.pdf','练习10.pdf']);
element('folder-pdf-list').children[1].click();await choosingMultiple;
assert.equal(element('filename').textContent,'练习10.pdf');
assert.ok(multiple.entries.has('练习10'));assert.equal(multiple.entries.has('练习2'),false);
const cancelSelection=run('chooseFolder()');await tick();
element('folder-picker').emit('cancel',{preventDefault(){}});await cancelSelection;
assert.equal(element('filename').textContent,'练习10.pdf');assert.equal(run('choosingFolder'),false);
testContext.window.showDirectoryPicker=async()=>{throw Object.assign(new Error('cancelled'),{name:'AbortError'})};
await run('chooseFolder()');assert.equal(element('filename').textContent,'练习10.pdf');
testContext.window.showDirectoryPicker=async()=>memoryDirectory('空目录');
await run('chooseFolder()');assert.ok(element('message').textContent.includes('没有 PDF'));
delete testContext.window.showDirectoryPicker;
let fallbackSelections=0;element('file').onclick=()=>{fallbackSelections++};
await run('chooseFolder()');assert.equal(fallbackSelections,1);assert.equal(element('filename').textContent,'练习10.pdf');
await run('openFile({name:"单独打开.pdf",type:"application/pdf",arrayBuffer:async()=>new ArrayBuffer(1)})');
assert.equal(run('folderStorage'),null,'Opening a bare PDF must not keep the previous PDF’s directory handle');
assert.equal(element('save-now').disabled,true);

// Render the actual drawing functions to inspect the six icons and transparent interiors.
const runtimeRequire=createRequire(import.meta.url);
const {createCanvas}=runtimeRequire('@napi-rs/canvas');
const preview=createCanvas(1200,560), previewContext=preview.getContext('2d');
previewContext.fillStyle='#e9edeb';previewContext.fillRect(0,0,1200,560);
testContext.previewContext=previewContext;run('pageWidth=1200;pageHeight=560');
for (const [i,name] of ['check','cross','ellipse','rectangle','line','arrow'].entries()) {
  const x=(i%3)*400,y=Math.floor(i/3)*280;
  previewContext.fillStyle='#fff';previewContext.fillRect(x+8,y+8,384,264);
  previewContext.fillStyle='#ecf3f8';previewContext.fillRect(x+50,y+130,300,30);
  previewContext.fillStyle='#38584b';previewContext.font='18px Arial';previewContext.fillText(name,x+25,y+38);
  testContext.previewItem={kind:'shape',shape:name,color:'#df3030',width:3.5/800,from:[(x+100)/1200,(y+75)/560],to:[(x+300)/1200,(y+215)/560]};
  run('drawShape(previewContext,previewItem)');
}
for (const [x,y] of [[1000,145],[200,425]]) {
  const pixel=previewContext.getImageData(x,y,1,1).data;
  assert.deepEqual([...pixel],[236,243,248,255],'Ellipse/rectangle interiors must preserve the original background');
}
fs.writeFileSync(new URL('whiteboard-shapes.png',testOutput),preview.toBuffer('image/png'));
const thumbnailSheet=createCanvas(460,400), thumbnailContext=thumbnailSheet.getContext('2d');
thumbnailContext.fillStyle='#eef3ef';thumbnailContext.fillRect(0,0,460,400);
run('pageWidth=600;pageHeight=800;textNodes=new Map()');
const previewSteps=[baseContents.slice(0,2),[baseContents[2]],[baseContents[3]],baseContents];
for(const [i,annotations] of previewSteps.entries()){
  const thumb=createCanvas(416,140);testContext.actualStepCanvas=thumb;testContext.previewStep={start:0,items:annotations};
  run('drawStepPreview(actualStepCanvas,previewStep)');
  const pixels=thumb.getContext('2d').getImageData(0,0,416,140).data;
  assert.ok(pixels.some((value,index)=>index%4===3&&value>0),'Each step thumbnail must render visible content');
  const x=(i%2)*230,y=Math.floor(i/2)*200;
  thumbnailContext.fillStyle='#fff';thumbnailContext.fillRect(x+10,y+34,210,150);
  thumbnailContext.fillStyle='#385345';thumbnailContext.font='14px Arial';thumbnailContext.fillText(['Handwriting','Typed answer','Shape','Merged step'][i],x+12,y+24);
  thumbnailContext.drawImage(thumb,x+12,y+70,206,70);
}
fs.writeFileSync(new URL('whiteboard-step-previews.png',testOutput),thumbnailSheet.toBuffer('image/png'));
run('clearTimeout(saveTimer); clearTimeout(resizeTimer); sidebarController.cancelHide(); stepsPanelController.cancelHide()');
for(const value of liveURLs)URL.revokeObjectURL(value);
console.log('Verified: USB folder saving, fresh-browser restore, serialized snapshots, temporary-note isolation, legacy migration, failure/retry, corrupt-file protection, folder selection and fallback; default classroom mode, no visible answer flash, isolated persistence/undo, Alt+Q, step editor, sidebar, audio, palette and canvas checks.');
