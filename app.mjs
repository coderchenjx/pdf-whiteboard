// Copyright (C) 2026 PDF Whiteboard contributors
// SPDX-License-Identifier: GPL-3.0-only
const $ = id => document.getElementById(id);
const pdfCanvas = $('pdf-canvas');
const inkCanvas = $('ink');
const inkContext = inkCanvas.getContext('2d');
const stage = $('stage');
const sheet = $('sheet');
const textLayer = $('text-layer');
const textEditor = $('text-editor');
const textInput = $('text-input');
const colorButtons = [...document.querySelectorAll('[data-ink-color]')];
const shapeTools = ['check', 'cross', 'ellipse', 'rectangle', 'line', 'arrow'];
const allTools = ['pen', 'text', 'eraser', 'hand', ...shapeTools];
const inkStorePrefix = 'pdf-classroom-whiteboard-v1:';
let pdfjs, pdf, loadingTask, fingerprint, currentPage = 1, requestedPage = 1;
let strokes = {}, history = new Map(), tool = 'pen';
let pageWidth = 1, pageHeight = 1, pixelRatio = 1;
let pendingRender, renderPump, renderTask, activePointer, activeStroke, activeShape, eraseBefore;
let loadingFile = false, storageAvailable = true, saveTimer, resizeTimer;
let handPosition, textDraft, textMove;
let selectedColor = '#df3030';
let textNodes = new Map();
let sidebarController;
let presenting = false, revealCounts = new Map(), toolBeforePresentation;
let preparationStrokes;
let presentationHistory = new Map(), eraseRevealBefore;
let stepsPanelController, selectedStepAnchor;
let stepsListCache;
const emptyAnnotations = [];

function message(text, error = false) {
  $('message').textContent = text;
  $('status').classList.toggle('error', error);
  if (error) sidebarController?.open();
}
function busy(on, text = '正在显示页面…') {
  $('loading').hidden = !on;
  $('loading-text').textContent = text;
  updateControls();
}
function updateControls() {
  const noDoc = !pdf || loadingFile;
  const writingBlocked = noDoc || !!renderPump;
  for (const id of ['page', 'zoom', 'export', 'import']) $(id).disabled = noDoc;
  $('import').disabled = noDoc || presenting;
  for (const id of [...allTools, 'thickness', 'text-size', 'stamp-size']) $(id).disabled = writingBlocked;
  $('hand').disabled = noDoc || !!renderPump;
  for (const button of colorButtons) button.disabled = writingBlocked;
  for (const id of ['text-done', 'text-cancel', 'text-move']) $(id).disabled = writingBlocked || !textDraft;
  $('text-delete').disabled = writingBlocked || !textDraft || textDraft.index === null;
  $('prev').disabled = noDoc || requestedPage <= 1;
  $('next').disabled = noDoc || requestedPage >= (pdf?.numPages ?? 1);
  const hasDraft = !!textDraft && !!textInput.value.trim();
  $('undo').disabled = writingBlocked || !((presenting ? presentationHistory : history).get(currentPage)?.length || hasDraft);
  const canClear = presenting ? (revealCounts.get(currentPage) ?? 0) > 0 || hasClassroomChanges() : visibleAnnotationCount() > 0;
  $('clear').disabled = writingBlocked || !(canClear || hasDraft);
  $('clear').textContent = presenting ? '清空随堂笔记' : '清空本页';
  $('clear').title = presenting ? '清除本页临时改动，恢复备课内容并重置到第 0 步；可撤销' : '清空本页所有标注，可用撤销恢复';
  $('open').disabled = loadingFile;
  $('start').disabled = loadingFile;
  updateRevealControls();
  updateStepsPanel();
}
function localState() {
  // Classroom edits belong only to the in-memory working copy, including on export.
  return {version: 4, fingerprint, page: currentPage, strokes: presenting ? preparationStrokes : strokes};
}
function saveNow() {
  clearTimeout(saveTimer);
  if (presenting || !pdf || !fingerprint) return;
  try {
    localStorage.setItem(inkStorePrefix + fingerprint, JSON.stringify(localState()));
    storageAvailable = true;
    message('备课笔迹、文字和图形已保存在本机。下次打开相同 PDF 可继续；换电脑请从“标注备份与帮助”导出备份。');
  } catch {
    storageAvailable = false;
    message('浏览器未能自动保存，请从“标注备份与帮助”导出备课标注备份。', true);
  }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  if (!presenting) saveTimer = setTimeout(saveNow, 180);
}

// Visibility uses a prefix of whole steps; classroom additions join the current step.
function revealStepEnds(page = currentPage) {
  const items = strokes[page] ?? [], ends = [];
  for (let i = 0; i < items.length; i++) {
    const group = items[i].revealGroup;
    if (group !== undefined && i > 0 && items[i - 1].revealGroup === group) ends[ends.length - 1] = i + 1;
    else ends.push(i + 1);
  }
  return ends;
}
function visibleAnnotationCount(page = currentPage) {
  if (!presenting) return strokes[page]?.length ?? 0;
  const ends = revealStepEnds(page);
  const count = Math.min(revealCounts.get(page) ?? 0, ends.length);
  return count > 0 ? ends[count - 1] : 0;
}
function hasClassroomChanges() {
  const items = strokes[currentPage] ?? emptyAnnotations;
  const prepared = preparationStrokes?.[currentPage] ?? emptyAnnotations;
  return items.length !== prepared.length || JSON.stringify(items) !== JSON.stringify(prepared);
}
function ungroupedStart(items = strokes[currentPage] ?? []) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].revealGroup !== undefined) return i + 1;
  return 0;
}
function updateRevealControls() {
  const blocked = !pdf || loadingFile || !!renderPump;
  const total = revealStepEnds().length;
  const count = Math.min(revealCounts.get(currentPage) ?? 0, total);
  $('reveal-start').disabled = blocked;
  $('reveal-start').title = presenting ? '开启编辑，显示已保存的笔记并丢弃本次临时笔记（Esc）' : '关闭编辑，保存笔记并从隐藏答案开始展示';
  $('reveal-start').setAttribute('aria-checked', String(!!pdf && !presenting));
  $('reveal-controls').hidden = !presenting;
  $('reveal-body').hidden = !presenting;
  $('reveal-progress').textContent = presenting ? `${count} / ${total} 步` : `共 ${total} 步`;
  $('reveal-progress').setAttribute('aria-label', presenting ? `第 ${currentPage} 页，已展示 ${count} / ${total} 步` : `本页共 ${total} 步`);
  $('shortcuts').hidden = presenting;
  for (const id of ['reveal-prev', 'reveal-hide']) $(id).disabled = blocked || !presenting || count === 0;
  for (const id of ['reveal-next', 'reveal-all']) $(id).disabled = blocked || !presenting || count === total;
}
function setPresentation(enabled, focus = true, {savePreparation = true} = {}) {
  if (enabled === presenting || enabled && (!pdf || loadingFile || renderPump)) return;
  finishInput();
  if (enabled) {
    // Explicit mode switches flush edits; opening a PDF only reads its saved notes.
    if (savePreparation) saveNow();
    const classroomStrokes = JSON.parse(JSON.stringify(strokes));
    preparationStrokes = strokes;
    strokes = classroomStrokes;
    toolBeforePresentation = tool;
    revealCounts.clear();
    presentationHistory.clear();
    presenting = true;
    setTool('hand');
  } else {
    strokes = preparationStrokes;
    preparationStrokes = undefined;
    presenting = false;
    presentationHistory.clear();
    revealCounts.clear();
    setTool(toolBeforePresentation ?? 'pen');
    toolBeforePresentation = undefined;
  }
  drawInk(); updateControls();
  if (focus) stage.focus({preventScroll: true});
  sidebarController?.scheduleHide();
  message(presenting ? '展示笔记仅本次有效。' : '编辑已开启，已恢复保存的笔记，临时展示笔记已丢弃。');
}
function revealTo(count) {
  if (!presenting || !pdf || loadingFile || renderPump) return;
  finishInput();
  const total = revealStepEnds().length;
  const target = typeof count === 'function' ? count(revealCounts.get(currentPage) ?? 0, total) : count;
  revealCounts.set(currentPage, Math.max(0, Math.min(total, target)));
  drawInk(); updateControls();
  stage.focus({preventScroll: true});
  sidebarController?.scheduleHide();
}
function groupNewAnnotations() {
  if (presenting || !pdf || loadingFile || renderPump) return;
  finishInput();
  const before = strokes[currentPage] ?? [], start = ungroupedStart(before);
  if (start >= before.length) return;
  const used = new Set(before.map(item => item.revealGroup));
  let group = 1;
  while (used.has(group)) group++;
  remember(before);
  strokes[currentPage] = before.map((item, index) => index < start ? item : {...item, revealGroup: group});
  scheduleSave(); updateControls();
  message(`已将新添加的 ${before.length - start} 条标注记为一步。继续写下一个答案，写完后再点一次。`);
}
$('reveal-start').onclick = () => setPresentation(!presenting);
$('step-group').onclick = groupNewAnnotations;
$('reveal-prev').onclick = () => revealTo(count => count - 1);
$('reveal-next').onclick = () => revealTo(count => count + 1);
$('reveal-hide').onclick = () => revealTo(0);
$('reveal-all').onclick = () => revealTo((_, total) => total);

function pageSteps() {
  const items = strokes[currentPage] ?? emptyAnnotations;
  let start = 0;
  return revealStepEnds().map(end => {
    const step = {start, end, items: items.slice(start, end)};
    start = end;
    return step;
  });
}
function selectedStepIndex(steps = pageSteps()) {
  return selectedStepAnchor ? steps.findIndex(step => step.items.includes(selectedStepAnchor)) : -1;
}
function stepSummary(items) {
  const labels = {check:'打勾', cross:'打叉', ellipse:'画圈', rectangle:'长方形', line:'直线', arrow:'箭头'};
  const counts = new Map(), text = [];
  for (const item of items) {
    if (item.kind === 'text') text.push(item.text.replace(/\s+/g, ' '));
    const name = item.kind === 'text' ? '文字' : item.kind === 'shape' ? labels[item.shape] : '手写';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const kinds = [...counts].map(([name, count]) => `${name} × ${count}`).join(' · ');
  return {kinds, text: text.join(' / ').slice(0, 100)};
}
function stepBounds(step) {
  let left = pageWidth, top = pageHeight, right = 0, bottom = 0;
  const include = (x, y, padding = 0) => {
    left = Math.min(left, x - padding); top = Math.min(top, y - padding);
    right = Math.max(right, x + padding); bottom = Math.max(bottom, y + padding);
  };
  step.items.forEach((item, offset) => {
    if (item.kind === 'text') {
      const font = item.fontSize * pageWidth;
      const height = textNodes.get(step.start + offset)?.getBoundingClientRect().height ?? font * 1.35 * item.text.split('\n').length + 12;
      include(item.x * pageWidth, item.y * pageHeight);
      include(Math.min(1, item.x + item.boxWidth) * pageWidth, Math.min(pageHeight, item.y * pageHeight + height));
    } else if (item.kind === 'shape') {
      for (const path of shapePaths(item)) for (const [x, y] of path) include(x, y, item.width * pageWidth / 2);
    } else for (const [x, y] of item.points) include(x * pageWidth, y * pageHeight, item.width * pageWidth / 2);
  });
  return {left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top)};
}
function drawStepPreview(canvas, step) {
  canvas.width = 416; canvas.height = 140;
  const context = canvas.getContext('2d'), bounds = stepBounds(step);
  const scale = Math.min(398 / bounds.width, 122 / bounds.height);
  context.setTransform(scale, 0, 0, scale, (416 - bounds.width * scale) / 2 - bounds.left * scale, (140 - bounds.height * scale) / 2 - bounds.top * scale);
  for (const item of step.items) {
    if (item.kind === 'shape') drawShape(context, item);
    else if (item.kind !== 'text') drawLine(context, item);
    else {
      const font = item.fontSize * pageWidth, x = item.x * pageWidth + 4;
      context.fillStyle = item.color;
      context.font = `600 ${font}px Arial,"Microsoft YaHei",sans-serif`;
      context.textBaseline = 'top';
      const width = Math.max(font, Math.min(item.boxWidth, 1 - item.x) * pageWidth - 8);
      const lines = []; let line = '';
      for (const char of item.text.slice(0, 2000)) {
        if (char === '\n') { lines.push(line); line = ''; }
        else if (line && context.measureText(line + char).width > width) { lines.push(line); line = char; }
        else line += char;
        if (lines.length >= 80) break;
      }
      lines.push(line);
      lines.forEach((text, index) => context.fillText(text, x, item.y * pageHeight + 4 + index * font * 1.35));
    }
  }
}
function updateStepHighlight(steps, index) {
  const highlight = $('step-highlight');
  highlight.hidden = presenting || loadingFile || !pdf || index < 0;
  if (highlight.hidden) return;
  const bounds = stepBounds(steps[index]);
  const left = Math.max(0, bounds.left - 7), top = Math.max(0, bounds.top - 7);
  highlight.style.left = `${left}px`; highlight.style.top = `${top}px`;
  highlight.style.width = `${Math.min(pageWidth - left, bounds.width + 14)}px`;
  highlight.style.height = `${Math.min(pageHeight - top, bounds.height + 14)}px`;
  $('step-highlight-label').textContent = `第 ${index + 1} 步`;
}
function updateStepsPanel() {
  const available = !!pdf && !loadingFile && !presenting;
  stepsPanelController?.setAvailable(available);
  const items = available ? strokes[currentPage] ?? emptyAnnotations : emptyAnnotations;
  const steps = available ? pageSteps() : [];
  const index = selectedStepIndex(steps);
  if (index < 0) selectedStepAnchor = undefined;
  $('steps-page').textContent = available ? `第 ${currentPage} 页 · 共 ${steps.length} 步` : '打开 PDF 后显示本页步骤';
  $('steps-empty').hidden = steps.length > 0;
  $('steps-selected').textContent = index < 0 ? '点击步骤，可在教材上定位。' : `已选第 ${index + 1} 步 · ${steps[index].items.length} 条标注`;
  const blocked = !available || !!renderPump;
  const hasDraft = !!textDraft && !!textInput.value.trim();
  $('step-group').disabled = blocked || !(items.length > ungroupedStart(items) || hasDraft);
  $('steps-merge-prev').disabled = blocked || index <= 0;
  $('steps-merge-next').disabled = blocked || index < 0 || index >= steps.length - 1;
  $('steps-split').disabled = blocked || index < 0 || steps[index].items.length < 2;
  $('steps-undo').disabled = blocked || !(history.get(currentPage)?.length || textDraft && textInput.value.trim());
  updateStepHighlight(steps, index);
  const cache = [items, currentPage, pageWidth, pageHeight, index, blocked];
  if (stepsListCache?.every((value, i) => value === cache[i])) return;
  stepsListCache = cache;
  const list = $('steps-list'), previousFocus = document.activeElement;
  const restoreFocus = list.contains(previousFocus) && index >= 0;
  const scroll = list.scrollTop;
  list.replaceChildren();
  steps.forEach((step, stepIndex) => {
    const row = document.createElement('li'); row.className = 'step-row'; row.dataset.stepIndex = String(stepIndex);
    row.classList.toggle('selected', stepIndex === index);
    const select = document.createElement('button'); select.type = 'button'; select.className = 'step-select';
    select.dataset.stepSelect = String(stepIndex); select.disabled = blocked;
    select.setAttribute('aria-pressed', String(stepIndex === index));
    select.setAttribute('aria-label', `选择第 ${stepIndex + 1} 步并定位`);
    const title = document.createElement('strong'); title.textContent = `第 ${stepIndex + 1} 步`;
    const preview = document.createElement('canvas'); preview.className = 'step-preview'; preview.setAttribute('aria-hidden', 'true');
    drawStepPreview(preview, step);
    const summary = stepSummary(step.items);
    const kinds = document.createElement('span'); kinds.className = 'step-kinds'; kinds.textContent = summary.kinds;
    select.append(title); select.append(preview); select.append(kinds);
    if (summary.text) { const text = document.createElement('span'); text.className = 'step-excerpt'; text.textContent = summary.text; select.append(text); }
    select.onclick = () => selectStep(stepIndex);
    row.append(select);
    const moves = document.createElement('div'); moves.className = 'step-moves';
    for (const [delta, label] of [[-1, '上移'], [1, '下移']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = delta < 0 ? '↑' : '↓';
      button.title = label; button.setAttribute('aria-label', `将第 ${stepIndex + 1} 步${label}`);
      button.disabled = blocked || stepIndex + delta < 0 || stepIndex + delta >= steps.length;
      button.onclick = () => changeStep('move', stepIndex, delta);
      moves.append(button);
    }
    row.append(moves); list.append(row);
    if (restoreFocus && stepIndex === index) select.focus({preventScroll: true});
  });
  list.scrollTop = scroll;
}
function selectStep(index) {
  if (presenting || !pdf || loadingFile || renderPump) return;
  finishInput();
  const step = pageSteps()[index];
  if (!step) return;
  selectedStepAnchor = step.items[0]; updateStepsPanel();
  $('step-highlight').scrollIntoView({block: 'center', inline: 'center', behavior: 'smooth'});
}
function changeStep(action, index = selectedStepIndex(), direction = 0) {
  if (presenting || !pdf || loadingFile || renderPump) return;
  finishInput();
  const steps = pageSteps();
  let chunks = steps.map(step => step.items);
  if (!chunks[index]) return;
  let nextIndex = index;
  if (action === 'move') {
    nextIndex = index + direction;
    if (![-1, 1].includes(direction) || !chunks[nextIndex]) return;
    [chunks[index], chunks[nextIndex]] = [chunks[nextIndex], chunks[index]];
  } else if (action === 'merge') {
    if (![-1, 1].includes(direction) || !chunks[index + direction]) return;
    nextIndex = Math.min(index, index + direction);
    chunks.splice(nextIndex, 2, [...chunks[nextIndex], ...chunks[nextIndex + 1]]);
  } else if (action === 'split') {
    if (chunks[index].length < 2) return;
    const singles = chunks[index].map(item => [item]);
    chunks = [...chunks.slice(0, index), ...singles, ...chunks.slice(index + 1)];
  } else return;
  // Assign distinct group IDs to each step, including imported non-adjacent groups.
  const after = chunks.flatMap((chunk, group) => chunk.map(item => ({...item, revealGroup: group + 1})));
  const before = strokes[currentPage] ?? [];
  remember(before); strokes[currentPage] = after;
  selectedStepAnchor = after[chunks.slice(0, nextIndex).reduce((sum, chunk) => sum + chunk.length, 0)];
  drawInk(); updateControls(); scheduleSave();
  message(action === 'move' ? `已移到第 ${nextIndex + 1} 步，将按新顺序展示。` : action === 'merge' ? '已合并相邻步骤，这些标注会一起展示。' : '已将本步拆成单条标注，可继续移动或合并。');
}
$('steps-merge-prev').onclick = () => changeStep('merge', selectedStepIndex(), -1);
$('steps-merge-next').onclick = () => changeStep('merge', selectedStepIndex(), 1);
$('steps-split').onclick = () => changeStep('split');
$('steps-undo').onclick = () => $('undo').click();

function validateNotes(data, expectedFingerprint, pageCount) {
  if (![1, 2, 3, 4].includes(data?.version) || data.fingerprint !== expectedFingerprint || !data.strokes || typeof data.strokes !== 'object') {
    throw new Error('这份笔迹不属于当前 PDF，请先打开对应教材。');
  }
  const clean = {};
  let totalPoints = 0;
  let totalText = 0;
  let totalShapes = 0;
  for (const [key, lines] of Object.entries(data.strokes)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1 || page > pageCount || !Array.isArray(lines)) throw new Error('笔迹文件格式不正确。');
    clean[page] = lines.map(line => {
      const group = {};
      if (data.version >= 4 && line?.revealGroup !== undefined) {
        if (!Number.isSafeInteger(line.revealGroup) || line.revealGroup < 1) throw new Error('展示步骤备份格式不正确。');
        group.revealGroup = line.revealGroup;
      }
      if (line?.kind === 'shape') {
        const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(n => Number.isFinite(n) && n >= 0 && n <= 1);
        if (data.version < 3 || !shapeTools.includes(line.shape) || !/^#[0-9a-f]{6}$/i.test(line.color) ||
            !Number.isFinite(line.width) || line.width <= 0 || line.width > .1 || !validPoint(line.from) || !validPoint(line.to)) throw new Error('图形备份格式不正确。');
        if (++totalShapes > 100000) throw new Error('图形备份太大，请分开保存。');
        return {kind: 'shape', shape: line.shape, color: line.color, width: line.width, from: [...line.from], to: [...line.to], ...group};
      }
      if (line?.kind === 'text') {
        if (data.version < 2 || !/^#[0-9a-f]{6}$/i.test(line.color) || typeof line.text !== 'string' || !line.text.trim() || line.text.length > 10000 ||
            ![line.x, line.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) ||
            !Number.isFinite(line.fontSize) || line.fontSize <= 0 || line.fontSize > 0.2 ||
            !Number.isFinite(line.boxWidth) || line.boxWidth <= 0 || line.boxWidth > 1) throw new Error('文字备份格式不正确。');
        totalText += line.text.length;
        if (totalText > 1500000) throw new Error('文字备份太大，请分开保存。');
        return {kind: 'text', text: line.text, color: line.color, x: line.x, y: line.y, fontSize: line.fontSize, boxWidth: line.boxWidth, ...group};
      }
      if (line?.kind && line.kind !== 'stroke') throw new Error('笔迹文件格式不正确。');
      if (!line || !/^#[0-9a-f]{6}$/i.test(line.color) || !Number.isFinite(line.width) || line.width <= 0 || line.width > 0.1 || !Array.isArray(line.points) || !line.points.length) throw new Error('笔迹文件格式不正确。');
      const points = line.points.map(point => {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('笔迹文件格式不正确。');
        if (++totalPoints > 1500000) throw new Error('笔迹文件太大，请分开保存。');
        return [point[0], point[1]];
      });
      return {color: line.color, width: line.width, points, ...group};
    });
  }
  return {strokes: clean, page: Math.max(1, Math.min(pageCount, Number.isInteger(data.page) ? data.page : 1))};
}

function restoreNotes() {
  if (presenting) setPresentation(false, false);
  revealCounts.clear();
  selectedStepAnchor = undefined;
  strokes = {}; history = new Map(); currentPage = 1;
  try {
    const raw = localStorage.getItem(inkStorePrefix + fingerprint);
    if (raw) {
      const saved = validateNotes(JSON.parse(raw), fingerprint, pdf.numPages);
      strokes = saved.strokes; currentPage = saved.page;
    }
    storageAvailable = true;
  } catch { storageAvailable = false; }
}

async function initializeLibrary() {
  const bundle = JSON.parse($('pdfjs-data').textContent);
  const asURL = encoded => {
    const binary = atob(encoded), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], {type: 'text/javascript'}));
  };
  const mainURL = asURL(bundle.main);
  const workerURL = asURL(bundle.worker);
  pdfjs = await import(mainURL);
  pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
  URL.revokeObjectURL(mainURL);
  // The worker URL stays alive for subsequent PDF files and worker fallback.
}
const libraryReady = initializeLibrary();
libraryReady.catch(() => message('PDF 阅读组件未能启动，请使用新版 Edge 或 Chrome 打开此网页。', true));

async function openFile(file) {
  if (!file || loadingFile) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    message('请选择 PDF 文件。', true); return;
  }
  finishInput();
  if (pdf) saveNow();
  loadingFile = true;
  busy(true, '正在打开 PDF…');
  let newTask;
  try {
    await libraryReady;
    const data = new Uint8Array(await file.arrayBuffer());
    newTask = pdfjs.getDocument({data, isEvalSupported: false, enableXfa: false, useWasm: false});
    newTask.onPassword = (updatePassword, reason) => {
      const password = prompt(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重新输入 PDF 密码：' : '此 PDF 需要密码：');
      if (password === null) { void newTask.destroy(); return; }
      updatePassword(password);
    };
    const nextPDF = await newTask.promise;
    pendingRender = null;
    renderTask?.cancel();
    if (renderPump) await renderPump;
    if (loadingTask) await loadingTask.destroy();
    loadingTask = newTask;
    // Keep the sheet hidden until restored answers are isolated and hidden.
    sheet.hidden = true;
    pdf = nextPDF;
    fingerprint = pdf.fingerprints[0];
    restoreNotes();
    $('filename').textContent = file.name;
    $('filename').title = file.name;
    document.title = `${file.name} · PDF 课堂白板`;
    $('count').textContent = `/ ${pdf.numPages}`;
    $('page').max = pdf.numPages;
    $('empty').hidden = true;
    loadingFile = false;
    setPresentation(true, true, {savePreparation: false});
    sheet.hidden = false;
    requestedPage = currentPage;
    await requestRender(currentPage);
    message(storageAvailable ? '展示中，已保存的答案已隐藏。展示笔记仅本次有效。' : '浏览器未能读取笔记。可开启“编辑”导入标注备份。', !storageAvailable);
  } catch (error) {
    if (newTask && newTask !== loadingTask) await newTask.destroy().catch(() => {});
    message(error?.name === 'PasswordException' ? 'PDF 密码未验证，未能打开文件。' : '未能打开 PDF。请确认文件完整，并使用新版 Edge 或 Chrome。', true);
  } finally {
    loadingFile = false;
    if (!renderPump) busy(false);
    updateControls();
    $('file').value = '';
    sidebarController?.scheduleHide(1600);
  }
}

function requestRender(target = requestedPage) {
  if (!pdf) return Promise.resolve();
  finishInput();
  requestedPage = Math.max(1, Math.min(pdf.numPages, Math.trunc(target)));
  $('page').value = requestedPage;
  pendingRender = requestedPage;
  renderTask?.cancel();
  if (renderPump) { updateControls(); return renderPump; }
  renderPump = Promise.resolve().then(renderPages).finally(() => {
    renderPump = null;
    busy(false);
    updateControls();
  });
  updateControls();
  return renderPump;
}

async function renderPages() {
  while (pendingRender !== null && pendingRender !== undefined) {
    const target = pendingRender;
    pendingRender = null;
    busy(true, `正在显示第 ${target} 页…`);
    try {
      const page = await pdf.getPage(target);
      if (pendingRender !== null) continue;
      const base = page.getViewport({scale: 1});
      const availableWidth = Math.max(180, stage.clientWidth - 34);
      const availableHeight = Math.max(180, stage.clientHeight - 34);
      const zoom = $('zoom').value;
      const scale = zoom === 'page' ? Math.min(availableWidth / base.width, availableHeight / base.height) : zoom === 'width' ? availableWidth / base.width : Number(zoom);
      const viewport = page.getViewport({scale});
      pageWidth = viewport.width; pageHeight = viewport.height;
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(18000000 / (pageWidth * pageHeight)));
      sheet.style.width = `${pageWidth}px`; sheet.style.height = `${pageHeight}px`;
      for (const canvas of [pdfCanvas, inkCanvas]) {
        canvas.width = Math.ceil(pageWidth * pixelRatio);
        canvas.height = Math.ceil(pageHeight * pixelRatio);
        canvas.style.width = `${pageWidth}px`; canvas.style.height = `${pageHeight}px`;
      }
      renderTask = page.render({canvasContext: pdfCanvas.getContext('2d'), viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0], background: 'rgb(255,255,255)'});
      await renderTask.promise;
      renderTask = null;
      page.cleanup();
      if (pendingRender !== null) continue;
      const pageChanged = currentPage !== target;
      currentPage = target;
      drawInk();
      if (pageChanged) { stage.scrollTop = 0; stage.scrollLeft = 0; }
      scheduleSave();
    } catch (error) {
      renderTask = null;
      if (error?.name === 'RenderingCancelledException') continue;
      requestedPage = currentPage;
      $('page').value = currentPage;
      message('这一页未能显示，请尝试重新打开 PDF 或切换到其他页。', true);
      break;
    }
  }
}

function drawLine(context, line) {
  const points = line.points;
  if (!points.length) return;
  context.strokeStyle = line.color; context.fillStyle = line.color;
  context.lineWidth = line.width * pageWidth;
  context.lineCap = 'round'; context.lineJoin = 'round';
  context.beginPath();
  if (points.length === 1) {
    context.arc(points[0][0] * pageWidth, points[0][1] * pageHeight, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill(); return;
  }
  context.moveTo(points[0][0] * pageWidth, points[0][1] * pageHeight);
  for (let i = 1; i < points.length; i++) context.lineTo(points[i][0] * pageWidth, points[i][1] * pageHeight);
  context.stroke();
}

function shapePaths(item) {
  const x0 = item.from[0] * pageWidth, y0 = item.from[1] * pageHeight;
  const x1 = item.to[0] * pageWidth, y1 = item.to[1] * pageHeight;
  const left = Math.min(x0, x1), top = Math.min(y0, y1);
  const width = Math.abs(x1 - x0), height = Math.abs(y1 - y0);
  if (item.shape === 'check') return [[[left + width * .1, top + height * .52], [left + width * .37, top + height * .8], [left + width * .91, top + height * .15]]];
  if (item.shape === 'cross') return [
    [[left + width * .16, top + height * .16], [left + width * .84, top + height * .84]],
    [[left + width * .84, top + height * .16], [left + width * .16, top + height * .84]]
  ];
  if (item.shape === 'rectangle') return [[[left, top], [left + width, top], [left + width, top + height], [left, top + height], [left, top]]];
  if (item.shape === 'ellipse') {
    const points = [];
    for (let i = 0; i <= 96; i++) {
      const angle = i / 96 * Math.PI * 2;
      points.push([left + width / 2 + Math.cos(angle) * width / 2, top + height / 2 + Math.sin(angle) * height / 2]);
    }
    return [points];
  }
  const paths = [[[x0, y0], [x1, y1]]];
  if (item.shape === 'arrow') {
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = Math.min(Math.hypot(x1 - x0, y1 - y0) * .4, Math.max(14 * pageWidth / 800, item.width * pageWidth * 4));
    paths.push([[x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6)], [x1, y1], [x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6)]]);
  }
  return paths;
}
function drawShape(context, item) {
  context.strokeStyle = item.color;
  context.lineWidth = item.width * pageWidth;
  context.lineCap = 'round'; context.lineJoin = 'round';
  for (const points of shapePaths(item)) {
    context.beginPath(); context.moveTo(...points[0]);
    for (let i = 1; i < points.length; i++) context.lineTo(...points[i]);
    context.stroke();
  }
}
function addAnnotation(item) {
  const before = strokes[currentPage] ?? [];
  remember(before);
  if (presenting) {
    const chunks = pageSteps().map(step => step.items);
    const count = Math.min(revealCounts.get(currentPage) ?? 0, chunks.length);
    if (count > 0) chunks[count - 1] = [...chunks[count - 1], item];
    else chunks.unshift([item]);
    strokes[currentPage] = chunks.flatMap((chunk, index) => chunk.map(entry => ({...entry, revealGroup: index + 1})));
    revealCounts.set(currentPage, Math.max(1, count));
  } else strokes[currentPage] = [...before, item];
  scheduleSave();
}
function replaceAnnotations(after, visibleCount) {
  if (!presenting) { strokes[currentPage] = after; return; }
  // Never join a visible step to a hidden one when deleting its neighbours.
  let group = 0, previousGroup;
  strokes[currentPage] = after.map((item, index) => {
    if (index === 0 || index === visibleCount || item.revealGroup === undefined || item.revealGroup !== previousGroup) group++;
    previousGroup = item.revealGroup;
    return {...item, revealGroup: group};
  });
  revealCounts.set(currentPage, revealStepEnds().filter(end => end <= visibleCount).length);
}
function placeStamp(point) {
  const size = Math.min(Number($('stamp-size').value) / 800 * pageWidth, pageWidth, pageHeight);
  const padding = Number($('thickness').value) / 800 * pageWidth;
  const left = Math.max(padding, Math.min(pageWidth - size - padding, point[0] * pageWidth - size / 2));
  const top = Math.max(padding, Math.min(pageHeight - size - padding, point[1] * pageHeight - size / 2));
  addAnnotation({kind: 'shape', shape: tool, color: selectedColor, width: Number($('thickness').value) / 800,
    from: [left / pageWidth, top / pageHeight], to: [(left + size) / pageWidth, (top + size) / pageHeight]});
  drawInk(); updateControls();
}
function drawInk() {
  inkContext.setTransform(1, 0, 0, 1, 0, 0);
  inkContext.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
  inkContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  for (const line of (strokes[currentPage] ?? []).slice(0, visibleAnnotationCount())) {
    if (line.kind === 'shape') drawShape(inkContext, line);
    else if (line.kind !== 'text') drawLine(inkContext, line);
  }
  if (activeStroke) drawLine(inkContext, activeStroke);
  if (activeShape) drawShape(inkContext, activeShape);
  drawTextBoxes();
  updateStepsPanel();
}

function drawTextBoxes() {
  textLayer.replaceChildren(); textNodes = new Map();
  const visibleCount = visibleAnnotationCount();
  (strokes[currentPage] ?? []).forEach((item, index) => {
    if (index >= visibleCount || item.kind !== 'text' || textDraft?.index === index) return;
    const node = document.createElement('div');
    node.className = 'typed-text';
    node.textContent = item.text;
    node.style.left = `${item.x * pageWidth}px`;
    node.style.top = `${item.y * pageHeight}px`;
    node.style.width = `${Math.min(item.boxWidth, 1 - item.x) * pageWidth}px`;
    node.style.maxHeight = `${(1 - item.y) * pageHeight}px`;
    node.style.fontSize = `${item.fontSize * pageWidth}px`;
    node.style.color = item.color;
    node.tabIndex = tool === 'text' ? 0 : -1;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `编辑文字：${item.text}`);
    node.title = tool === 'text' ? '点击修改文字；拖动框旁的 ⠿ 调整位置' : '';
    node.addEventListener('pointerdown', event => {
      if (tool !== 'text' || renderPump || loadingFile || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      editTextItem(item);
    });
    node.addEventListener('keydown', event => {
      if (tool !== 'text' || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      editTextItem(item);
    });
    textLayer.append(node); textNodes.set(index, node);
  });
}

function updatePalette() {
  for (const button of colorButtons) {
    const chosen = button.dataset.inkColor === selectedColor;
    button.classList.toggle('chosen', chosen);
    button.setAttribute('aria-pressed', String(chosen));
  }
  $('current-color-chip').style.setProperty('--current-ink', selectedColor);
  $('current-color-name').textContent = colorButtons.find(button => button.dataset.inkColor === selectedColor)?.title || '自定义色';
}
function selectColor(color) {
  selectedColor = color; updatePalette();
  if (textDraft) { captureTextWidth(); textDraft.color = color; layoutTextEditor(); }
  else if (['eraser', 'hand'].includes(tool)) setTool('pen');
}
function startText(point, index = null) {
  if (presenting && index !== null && index >= visibleAnnotationCount()) return;
  finishInput();
  const existing = index === null ? null : strokes[currentPage]?.[index];
  if (index !== null && existing?.kind !== 'text') return;
  if (existing) {
    textDraft = {...existing, index};
    selectedColor = existing.color; updatePalette();
    const preset = String(Math.round(existing.fontSize * 800));
    if (['20', '28', '36', '48'].includes(preset)) $('text-size').value = preset;
  } else {
    const x = Math.min(point[0], Math.max(0, 1 - 90 / pageWidth));
    textDraft = {kind: 'text', index: null, x, y: Math.min(point[1], .9), boxWidth: Math.min(.36, 1 - x), fontSize: Number($('text-size').value) / 800, color: selectedColor, text: ''};
  }
  textInput.value = textDraft.text;
  textEditor.hidden = false;
  layoutTextEditor(); drawTextBoxes();
  textInput.focus({preventScroll: true});
  textInput.setSelectionRange(textInput.value.length, textInput.value.length);
  message(presenting ? '输入文字。' : '透明框内输入文字；点击侧栏“完成”或按 Ctrl+Enter 保存。拖动框旁的 ⠿ 调整位置。');
  updateControls();
}
function editTextItem(item) {
  const index = (strokes[currentPage] ?? []).indexOf(item);
  if (index < 0) return;
  const deletedBefore = textDraft?.index !== null && textDraft?.index < index && !textInput.value.trim();
  finishInput();
  startText(null, index - (deletedBefore ? 1 : 0));
}
function layoutTextEditor() {
  if (!textDraft) return;
  const x = textDraft.x * pageWidth;
  const width = Math.min(textDraft.boxWidth * pageWidth, pageWidth - x);
  textEditor.style.left = `${x}px`;
  textEditor.style.top = `${textDraft.y * pageHeight}px`;
  textEditor.style.width = `${width}px`;
  textInput.style.width = `${width}px`;
  textInput.style.minWidth = `${Math.min(90, pageWidth - x)}px`;
  textInput.style.maxWidth = `${pageWidth - x}px`;
  textInput.style.color = textDraft.color;
  textInput.style.fontSize = `${textDraft.fontSize * pageWidth}px`;
  growTextInput();
}
function growTextInput() {
  if (!textDraft) return;
  const available = Math.max(28, (1 - textDraft.y) * pageHeight);
  textInput.style.height = 'auto';
  const height = Math.min(available, Math.max(textDraft.fontSize * pageWidth * 1.35 + 12, textInput.scrollHeight + 4));
  textInput.style.height = `${height}px`;
  const x = textDraft.x * pageWidth;
  const width = textInput.getBoundingClientRect().width;
  // Keep the small drag handle outside the transparent typing area.
  let handleLeft = -26, handleTop = 0;
  if (x < 26) {
    if (x + width + 26 <= pageWidth) handleLeft = width + 3;
    else { handleLeft = 0; handleTop = textDraft.y * pageHeight >= 28 ? -28 : height + 3; }
  }
  $('text-move').style.left = `${handleLeft}px`;
  $('text-move').style.top = `${handleTop}px`;
}
function captureTextWidth() {
  if (textDraft) textDraft.boxWidth = Math.min(1 - textDraft.x, Math.max(.01, textInput.getBoundingClientRect().width / pageWidth));
}
function commitText() {
  if (!textDraft) return;
  captureTextWidth();
  const {index, ...draft} = textDraft;
  const before = strokes[currentPage] ?? [];
  const visibleCount = visibleAnnotationCount();
  const text = textInput.value.replace(/\r\n?/g, '\n');
  const item = {...draft, text};
  textDraft = null; textMove = null; textEditor.hidden = true;
  let after = before;
  if (index === null) { if (text.trim()) addAnnotation(item); }
  else if (!text.trim()) after = before.filter((_, i) => i !== index);
  else if (JSON.stringify(before[index]) !== JSON.stringify(item)) after = before.map((entry, i) => i === index ? item : entry);
  if (after !== before) { remember(before); replaceAnnotations(after, visibleCount - (before.length - after.length)); scheduleSave(); }
  drawInk(); updateControls();
}
function cancelText() {
  textDraft = null; textMove = null; textEditor.hidden = true;
  drawTextBoxes(); updateControls();
}
function deleteText() {
  if (!textDraft) return;
  const index = textDraft.index;
  cancelText();
  if (index !== null) {
    const before = strokes[currentPage] ?? [];
    const visibleCount = visibleAnnotationCount();
    remember(before); replaceAnnotations(before.filter((_, i) => i !== index), visibleCount - 1);
    drawInk(); scheduleSave(); updateControls();
  }
}
function pointerPoint(event) {
  const rect = inkCanvas.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
}
function remember(before, revealCount = revealCounts.get(currentPage) ?? 0) {
  const target = presenting ? presentationHistory : history;
  const stack = target.get(currentPage) ?? [];
  stack.push(presenting ? {items: before.slice(), revealCount} : before.slice());
  if (stack.length > 40) stack.shift();
  target.set(currentPage, stack);
}
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function eraseAt(point) {
  const x = point[0] * pageWidth, y = point[1] * pageHeight;
  const before = strokes[currentPage] ?? [];
  const visibleCount = visibleAnnotationCount();
  const remaining = before.filter((line, index) => {
    if (index >= visibleCount) return true;
    if (line.kind === 'text') {
      const height = textNodes.get(index)?.getBoundingClientRect().height ?? line.fontSize * pageWidth * 1.35 + 12;
      const left = line.x * pageWidth, top = line.y * pageHeight;
      return !(x >= left - 6 && x <= left + line.boxWidth * pageWidth + 6 && y >= top - 6 && y <= top + height + 6);
    }
    const threshold = 11 + line.width * pageWidth / 2;
    if (line.kind === 'shape') {
      return !shapePaths(line).some(path => path.some((point, i) => {
        const previous = path[Math.max(0, i - 1)];
        return distanceToSegment(x, y, previous[0], previous[1], point[0], point[1]) <= threshold;
      }));
    }
    for (let i = 0; i < line.points.length; i++) {
      const a = line.points[Math.max(0, i - 1)], b = line.points[i];
      if (distanceToSegment(x, y, a[0] * pageWidth, a[1] * pageHeight, b[0] * pageWidth, b[1] * pageHeight) <= threshold) return false;
    }
    return true;
  });
  if (remaining.length !== before.length) { replaceAnnotations(remaining, visibleCount - (before.length - remaining.length)); drawInk(); }
}
function finishInput() {
  commitText();
  if (activeShape) {
    const dx = Math.abs(activeShape.to[0] - activeShape.from[0]) * pageWidth;
    const dy = Math.abs(activeShape.to[1] - activeShape.from[1]) * pageHeight;
    const isLine = ['line', 'arrow'].includes(activeShape.shape);
    if (isLine ? Math.hypot(dx, dy) >= 3 : dx >= 3 && dy >= 3) addAnnotation(activeShape);
    activeShape = null;
  }
  if (activeStroke) {
    addAnnotation(activeStroke);
    activeStroke = null;
  }
  if (eraseBefore) {
    const now = strokes[currentPage] ?? [];
    if (now.length !== eraseBefore.length) { remember(eraseBefore, eraseRevealBefore); scheduleSave(); }
    eraseBefore = null;
    eraseRevealBefore = undefined;
  }
  if (activePointer !== undefined) {
    const pointer = activePointer;
    activePointer = undefined;
    if (inkCanvas.hasPointerCapture(pointer)) inkCanvas.releasePointerCapture(pointer);
  }
  drawInk(); updateControls();
}
function setTool(value) {
  finishInput(); tool = value;
  for (const name of allTools) {
    $(name).classList.toggle('active', name === tool);
    $(name).setAttribute('aria-pressed', String(name === tool));
  }
  inkCanvas.classList.toggle('browse', tool === 'hand');
  inkCanvas.classList.toggle('eraser', tool === 'eraser');
  inkCanvas.classList.toggle('text-mode', tool === 'text');
  sheet.classList.toggle('text-mode', tool === 'text');
  $('text-size').hidden = tool !== 'text';
  $('text-actions').hidden = tool !== 'text';
  $('thickness').hidden = tool === 'text';
  $('stamp-size').hidden = !['check', 'cross'].includes(tool);
  sheet.style.cursor = tool === 'hand' ? 'grab' : '';
  drawTextBoxes();
  const hints = {
    check: '点击页面打勾，可连续放置。大小、颜色和粗细可在侧栏选择。',
    cross: '点击页面打叉，可连续放置。大小、颜色和粗细可在侧栏选择。',
    ellipse: '在需要圈选的内容外侧按住拖动，松手完成。圆圈内部透明；按 Esc 取消当前图形。',
    rectangle: '从一个角拖到另一个角，松手完成长方形。内部透明；按 Esc 取消当前图形。',
    line: '从起点拖到终点，松手完成直线连接；按 Esc 取消当前图形。',
    arrow: '从起点拖到终点，箭头指向松手的位置；按 Esc 取消当前图形。'
  };
  message(presenting ? '展示笔记仅本次有效。' : hints[tool] ?? (tool === 'text' ? '点击页面输入文字；点击已有文字可修改。字号和颜色可在侧栏选择。' : tool === 'eraser' ? '橡皮会擦除碰到的整条笔迹、文字框或图形，可撤销。' : tool === 'hand' ? '触屏上下滑动，或用鼠标拖动页面。切回“笔”继续书写。' : '直接在页面上写答案；点击“红、蓝、黑”等按钮选择颜色。'));
}
inkCanvas.addEventListener('pointerdown', event => {
  if (!pdf || renderPump || loadingFile || tool === 'hand' || activePointer !== undefined || event.button !== 0) return;
  event.preventDefault();
  if (tool === 'text') { startText(pointerPoint(event)); return; }
  if (['check', 'cross'].includes(tool)) { placeStamp(pointerPoint(event)); return; }
  activePointer = event.pointerId; inkCanvas.setPointerCapture(activePointer);
  if (shapeTools.includes(tool)) {
    const point = pointerPoint(event);
    activeShape = {kind: 'shape', shape: tool, color: selectedColor, width: Number($('thickness').value) / 800, from: point, to: point.slice()};
    drawInk();
  } else if (tool === 'pen') {
    activeStroke = {color: selectedColor, width: Number($('thickness').value) / 800, points: [pointerPoint(event)]};
    drawInk();
  } else { eraseBefore = (strokes[currentPage] ?? []).slice(); eraseRevealBefore = revealCounts.get(currentPage) ?? 0; eraseAt(pointerPoint(event)); }
});
inkCanvas.addEventListener('pointermove', event => {
  if (activePointer !== event.pointerId) return;
  event.preventDefault();
  if (activeShape) { activeShape.to = pointerPoint(event); drawInk(); return; }
  const events = event.getCoalescedEvents?.() ?? [event];
  for (const item of events.length ? events : [event]) {
    const point = pointerPoint(item);
    if (activeStroke) {
      const last = activeStroke.points.at(-1);
      if (Math.hypot((point[0] - last[0]) * pageWidth, (point[1] - last[1]) * pageHeight) >= .5) activeStroke.points.push(point);
    } else eraseAt(point);
  }
  if (activeStroke) drawInk();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) inkCanvas.addEventListener(name, event => {
  if (activePointer !== event.pointerId) return;
  if (activeShape && name === 'pointerup') activeShape.to = pointerPoint(event);
  else if (activeShape) activeShape = null;
  finishInput();
});
sheet.addEventListener('pointerdown', event => {
  if (tool !== 'hand' || event.pointerType === 'touch' || event.button !== 0) return;
  handPosition = {id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop};
  sheet.setPointerCapture(event.pointerId); sheet.style.cursor = 'grabbing';
});
sheet.addEventListener('pointermove', event => {
  if (!handPosition || event.pointerId !== handPosition.id) return;
  stage.scrollLeft = handPosition.left - (event.clientX - handPosition.x);
  stage.scrollTop = handPosition.top - (event.clientY - handPosition.y);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) sheet.addEventListener(name, event => {
  if (handPosition?.id !== event.pointerId) return;
  handPosition = null; sheet.style.cursor = tool === 'hand' ? 'grab' : '';
});

function chooseFile() { finishInput(); $('file').click(); }
$('open').onclick = chooseFile;
$('start').onclick = chooseFile;
$('file').onchange = event => openFile(event.target.files[0]);
$('prev').onclick = () => requestRender(requestedPage - 1);
$('next').onclick = () => requestRender(requestedPage + 1);
$('page-form').onsubmit = event => {
  event.preventDefault();
  const target = Number($('page').value);
  if (Number.isInteger(target) && target >= 1 && target <= pdf.numPages) {
    $('page').blur(); requestRender(target);
  } else { $('page').value = requestedPage; message(`请输入 1 到 ${pdf.numPages} 之间的 PDF 页码。`, true); }
};
$('zoom').onchange = () => requestRender();
for (const name of allTools) $(name).onclick = () => setTool(name);
for (const button of colorButtons) button.onclick = () => {
  selectColor(button.dataset.inkColor);
  const wasExtra = $('more-colors').contains(button);
  $('more-colors').open = false;
  if (wasExtra) $('more-colors-toggle').focus({preventScroll: true});
};
$('thickness').onchange = () => { if (['eraser', 'hand'].includes(tool)) setTool('pen'); };
$('text-size').onchange = () => {
  if (textDraft) { captureTextWidth(); textDraft.fontSize = Number($('text-size').value) / 800; layoutTextEditor(); }
};
textInput.addEventListener('input', () => { growTextInput(); updateControls(); });
textInput.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'Enter') { event.preventDefault(); commitText(); $('text').focus(); }
  if (event.key === 'Escape') { event.preventDefault(); cancelText(); $('text').focus(); }
});
$('text-done').onclick = () => { commitText(); $('text').focus(); };
$('text-cancel').onclick = () => { cancelText(); $('text').focus(); };
$('text-delete').onclick = () => { deleteText(); $('text').focus(); };
$('text-move').addEventListener('pointerdown', event => {
  if (!textDraft || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  captureTextWidth();
  textMove = {id: event.pointerId, startX: event.clientX, startY: event.clientY, x: textDraft.x, y: textDraft.y};
  $('text-move').setPointerCapture(event.pointerId);
});
$('text-move').addEventListener('pointermove', event => {
  if (!textMove || !textDraft || textMove.id !== event.pointerId) return;
  event.preventDefault();
  textDraft.x = Math.max(0, Math.min(1 - textDraft.boxWidth, textMove.x + (event.clientX - textMove.startX) / pageWidth));
  textDraft.y = Math.max(0, Math.min(Math.max(0, 1 - textInput.getBoundingClientRect().height / pageHeight), textMove.y + (event.clientY - textMove.startY) / pageHeight));
  layoutTextEditor();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) $('text-move').addEventListener(name, event => {
  if (textMove?.id !== event.pointerId) return;
  textMove = null;
  if ($('text-move').hasPointerCapture(event.pointerId)) $('text-move').releasePointerCapture(event.pointerId);
});
$('undo').onclick = () => {
  if (!pdf || loadingFile || renderPump) return;
  finishInput();
  const before = (presenting ? presentationHistory : history).get(currentPage)?.pop();
  if (before) {
    strokes[currentPage] = presenting ? before.items : before;
    if (presenting) revealCounts.set(currentPage, before.revealCount);
    drawInk(); scheduleSave();
  }
  updateControls();
};
$('clear').onclick = () => {
  if (!pdf || loadingFile || renderPump) return;
  finishInput();
  const before = strokes[currentPage] ?? [];
  if (presenting) {
    if ((revealCounts.get(currentPage) ?? 0) > 0 || hasClassroomChanges()) {
      remember(before);
      const prepared = preparationStrokes[currentPage];
      if (prepared) strokes[currentPage] = JSON.parse(JSON.stringify(prepared));
      else delete strokes[currentPage];
      revealCounts.set(currentPage, 0);
      drawInk();
      message('已清空本页随堂笔记，展示已重置到第 0 步。');
    }
    stage.focus({preventScroll: true});
    sidebarController?.scheduleHide();
  } else if (before.length) {
    remember(before); strokes[currentPage] = []; drawInk(); scheduleSave();
  }
  updateControls();
};
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { message('浏览器未允许全屏，可以按 F11 或使用浏览器菜单。'); }
};
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
});
document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'q') {
    if (!presenting && pdf && !loadingFile && !renderPump && !event.repeat) {
      event.preventDefault();
      groupNewAnnotations();
      if (event.target === textInput) stage.focus({preventScroll: true});
    }
    return;
  }
  if (event.altKey || event.target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName) || $('audio-section').contains(event.target)) return;
  if (($('steps-panel').contains(event.target) || event.target === $('steps-handle')) && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z')) return;
  if (event.key === 'Escape' && activeShape) { event.preventDefault(); activeShape = null; finishInput(); return; }
  if (presenting && event.key === 'Escape') { event.preventDefault(); setPresentation(false); return; }
  if (presenting && !event.ctrlKey && !event.metaKey && !['BUTTON', 'SUMMARY'].includes(event.target.tagName)) {
    if ([' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      revealTo(count => count + (event.key === 'ArrowUp' ? -1 : 1));
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && pdf && !renderPump) { event.preventDefault(); $('undo').click(); return; }
  if (event.ctrlKey || event.metaKey) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); $('fullscreen').click(); return; }
  if (!pdf || loadingFile) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); requestRender(requestedPage - 1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); requestRender(requestedPage + 1); }
  if (!renderPump && event.key.toLowerCase() === 'p') setTool('pen');
  if (!renderPump && event.key.toLowerCase() === 't') setTool('text');
  if (!renderPump && event.key.toLowerCase() === 'e') setTool('eraser');
  if (!renderPump && event.key.toLowerCase() === 'h') setTool('hand');
});
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdf && !loadingFile) requestRender(); }, 150);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && pdf) { finishInput(); saveNow(); } });
window.addEventListener('pagehide', () => { if (pdf) { finishInput(); saveNow(); } });

function download(name, data) {
  const url = URL.createObjectURL(new Blob([data], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('export').onclick = () => {
  finishInput();
  const name = ($('filename').textContent || 'PDF').replace(/\.pdf$/i, '');
  download(`${name}-备课标注.json`, JSON.stringify(localState()));
  $('more').open = false;
};
$('import').onclick = () => { if (presenting) return; $('import-file').click(); $('more').open = false; };
$('import-file').onchange = async event => {
  const file = event.target.files[0];
  if (!file || !pdf || presenting || loadingFile) return;
  const importFingerprint = fingerprint;
  try {
    if (file.size > 40000000) throw new Error('笔迹文件太大，请检查是否选对了文件。');
    const raw = await file.text();
    if (presenting || loadingFile || fingerprint !== importFingerprint) return;
    const notes = validateNotes(JSON.parse(raw), fingerprint, pdf.numPages);
    if (Object.values(strokes).some(lines => lines.length) && !confirm('导入将替换当前教材的笔迹、文字和图形。要先保留当前内容，请取消并导出备份。继续导入？')) return;
    finishInput(); strokes = notes.strokes; history.clear(); revealCounts.clear(); selectedStepAnchor = undefined;
    await requestRender(notes.page); saveNow();
  } catch (error) { message(error instanceof SyntaxError ? '文件不是有效的笔迹备份，请选择导出的 JSON 文件。' : error.message, true); }
  finally { $('import-file').value = ''; }
};
for (const name of ['dragenter', 'dragover']) stage.addEventListener(name, event => {
  event.preventDefault();
  if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) stage.classList.add('dragover');
});
stage.addEventListener('dragleave', event => { if (!stage.contains(event.relatedTarget)) stage.classList.remove('dragover'); });
stage.addEventListener('drop', event => { event.preventDefault(); stage.classList.remove('dragover'); openFile(event.dataTransfer?.files[0]); });
document.addEventListener('click', event => {
  for (const id of ['more', 'more-colors']) if (!$(id).contains(event.target)) $(id).open = false;
});
document.addEventListener('pointerdown', event => {
  if (textDraft && !textEditor.contains(event.target) && !textLayer.contains(event.target) && !document.querySelector('.toolbar').contains(event.target) && !$('panel-handle').contains(event.target) && !$('steps-panel').contains(event.target) && !$('steps-handle').contains(event.target)) commitText();
}, true);

function initializeSidebar() {
  const panel = $('tool-panel'), handle = $('panel-handle');
  const preferenceKey = 'pdf-classroom-sidebar-v1';
  let side = 'right', pinned = false, expanded = true;
  let panelHovered = false, handleHovered = false, hideTimer;
  let lastPointerType = 'mouse', keyboardInput = false;
  try {
    const preference = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
    if (['left', 'right'].includes(preference?.side)) side = preference.side;
    if (typeof preference?.pinned === 'boolean') pinned = preference.pinned;
  } catch { /* Layout preferences are optional. */ }
  function persistPreference() {
    try { localStorage.setItem(preferenceKey, JSON.stringify({side, pinned})); } catch { /* Keep using the current layout. */ }
  }
  function update() {
    document.body.dataset.panelSide = side;
    document.body.classList.toggle('panel-open', expanded);
    panel.classList.toggle('collapsed', !expanded);
    panel.inert = !expanded;
    panel.setAttribute('aria-hidden', String(!expanded));
    handle.setAttribute('aria-expanded', String(expanded));
    $('panel-handle-arrow').textContent = side === 'right' ? (expanded ? '›' : '‹') : (expanded ? '‹' : '›');
    $('panel-pin').classList.toggle('active', pinned);
    $('panel-pin').setAttribute('aria-pressed', String(pinned));
    $('panel-pin').textContent = pinned ? '已固定' : '固定';
    $('panel-pin').title = pinned ? '取消固定，恢复自动隐藏' : '固定工具栏，关闭自动隐藏';
    $('panel-mode').textContent = pinned ? '已固定，点击可恢复自动隐藏' : '移出后自动收起';
    $('panel-side').value = side;
  }
  function cancelHide() { clearTimeout(hideTimer); }
  function editingControls() {
    const active = document.activeElement;
    if (!active || !panel.contains(active)) return false;
    return ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) || active.isContentEditable || keyboardInput;
  }
  function canHide() {
    return !pinned && !panelHovered && !handleHovered && !loadingFile && !$('audio-seek').dataset.dragging && !editingControls() && !$('more').open && !$('more-colors').open;
  }
  function open() {
    cancelHide(); expanded = true; update();
  }
  function close(force = false, focusHandle = false) {
    if (!force && !canHide()) return false;
    cancelHide();
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    expanded = false; panelHovered = false; handleHovered = false; update();
    if (focusHandle) handle.focus({preventScroll: true});
    return true;
  }
  function scheduleHide(delay = 750) {
    cancelHide();
    if (!expanded || pinned) return;
    hideTimer = setTimeout(() => close(), delay);
  }
  handle.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch') return;
    handleHovered = true; open();
  });
  handle.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    handleHovered = false; scheduleHide();
  });
  handle.onclick = event => {
    open();
    if (event?.detail === 0) $('open').focus({preventScroll: true});
  };
  panel.addEventListener('pointerenter', event => {
    if (event.pointerType === 'touch') return;
    panelHovered = true; cancelHide();
  });
  panel.addEventListener('pointerleave', event => {
    if (event.pointerType === 'touch') return;
    panelHovered = false; scheduleHide();
  });
  panel.addEventListener('pointerdown', event => {
    lastPointerType = event.pointerType || 'mouse'; keyboardInput = false; cancelHide();
    if (lastPointerType === 'touch') panelHovered = false;
  });
  panel.addEventListener('click', event => {
    if (lastPointerType === 'touch' && !['panel-pin', 'panel-close', 'panel-side'].includes(event.target.id)) scheduleHide(1600);
  });
  panel.addEventListener('change', event => {
    if (event.target.tagName !== 'SELECT' || keyboardInput) return;
    event.target.blur();
    scheduleHide(lastPointerType === 'touch' ? 1600 : 750);
  });
  panel.addEventListener('focusout', () => scheduleHide());
  $('more').addEventListener('toggle', () => { if ($('more').open) cancelHide(); else scheduleHide(); });
  $('more-colors').addEventListener('toggle', () => { if ($('more-colors').open) cancelHide(); else scheduleHide(); });
  $('panel-close').onclick = () => close(true, true);
  $('panel-pin').onclick = () => {
    pinned = !pinned; persistPreference(); open();
    if (!pinned) scheduleHide();
  };
  $('panel-side').onchange = () => {
    side = $('panel-side').value === 'left' ? 'left' : 'right';
    panelHovered = false; handleHovered = false;
    persistPreference(); open();
    if (!keyboardInput) $('panel-side').blur();
    scheduleHide(1200);
  };
  stage.addEventListener('pointerdown', () => {
    if (presenting) stage.focus({preventScroll: true});
    panelHovered = false; handleHovered = false; keyboardInput = false;
    if (!pinned && expanded) {
      if (panel.contains(document.activeElement)) document.activeElement.blur();
      close();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!panel.contains(event.target)) return;
    keyboardInput = true; cancelHide();
    if (event.key === 'Escape' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) {
      event.preventDefault(); $('more').open = false; $('more-colors').open = false; close(true, true);
    }
  });
  update(); scheduleHide(2200);
  return {open, close, scheduleHide, cancelHide, snapshot: () => ({side, pinned, expanded})};
}
sidebarController = initializeSidebar();

function initializeStepsPanel() {
  const panel = $('steps-panel'), handle = $('steps-handle');
  let available = false, expanded = true, pinned = false, hovered = false, handleHovered = false, keyboardInput = false, hideTimer;
  try { pinned = JSON.parse(localStorage.getItem('pdf-classroom-steps-panel-v1') || 'null')?.pinned === true; } catch { /* Optional layout preference. */ }
  function cancelHide() { clearTimeout(hideTimer); }
  function update() {
    panel.hidden = handle.hidden = !available;
    panel.classList.toggle('collapsed', !expanded);
    panel.inert = !available || !expanded;
    panel.setAttribute('aria-hidden', String(!available || !expanded));
    document.body.classList.toggle('steps-open', available && expanded);
    handle.setAttribute('aria-expanded', String(available && expanded));
    $('steps-pin').textContent = pinned ? '已固定' : '固定';
    $('steps-pin').setAttribute('aria-pressed', String(pinned));
    $('steps-pin').title = pinned ? '恢复自动隐藏步骤面板' : '固定步骤面板';
  }
  function close(force = false, focusHandle = false) {
    if (!force && (pinned || hovered || handleHovered || keyboardInput && panel.contains(document.activeElement))) return false;
    cancelHide();
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    expanded = false; hovered = handleHovered = keyboardInput = false; update();
    if (focusHandle && available) handle.focus({preventScroll: true});
    return true;
  }
  function scheduleHide(delay = 850) {
    cancelHide();
    if (available && expanded && !pinned) hideTimer = setTimeout(() => close(), delay);
  }
  function open() {
    if (!available) return;
    cancelHide(); expanded = true; update();
  }
  function setAvailable(value) {
    if (available === value) return;
    available = value;
    if (value) { expanded = true; update(); scheduleHide(2600); }
    else {
      cancelHide();
      if (panel.contains(document.activeElement) || document.activeElement === handle) stage.focus({preventScroll: true});
      hovered = handleHovered = keyboardInput = false; update();
    }
  }
  handle.onclick = () => { open(); scheduleHide(2200); };
  handle.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { handleHovered = true; open(); } });
  handle.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') { handleHovered = false; scheduleHide(); } });
  panel.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') { hovered = true; cancelHide(); } });
  panel.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') { hovered = false; scheduleHide(); } });
  panel.addEventListener('pointerdown', event => { keyboardInput = false; if (event.pointerType === 'touch') hovered = false; cancelHide(); });
  panel.addEventListener('click', () => scheduleHide(1600));
  panel.addEventListener('focusout', () => scheduleHide());
  $('steps-close').onclick = () => close(true, true);
  $('steps-pin').onclick = () => {
    pinned = !pinned;
    try { localStorage.setItem('pdf-classroom-steps-panel-v1', JSON.stringify({pinned})); } catch { /* Optional layout preference. */ }
    open(); scheduleHide();
  };
  stage.addEventListener('pointerdown', () => {
    hovered = handleHovered = keyboardInput = false;
    if (!pinned) close();
    if (selectedStepAnchor) { selectedStepAnchor = undefined; updateStepsPanel(); }
  }, true);
  document.addEventListener('keydown', event => {
    if (!panel.contains(event.target)) return;
    keyboardInput = true; cancelHide();
    if (event.key === 'Escape') { event.preventDefault(); close(true, true); }
  });
  update();
  return {setAvailable, open, close, cancelHide, scheduleHide, snapshot: () => ({available, expanded, pinned})};
}
stepsPanelController = initializeStepsPanel();

function initializeAudio() {
  const player = $('audio-player'), input = $('audio-file');
  const rate = $('audio-rate'), loop = $('audio-loop');
  const seek = $('audio-seek'), volume = $('audio-volume');
  const audioBody = $('audio-body'), collapseButton = $('audio-collapse');
  let sourceURL, sourceVersion = 0, failed = false, seekPointer;
  function setAudioCollapsed(collapsed) {
    if (collapsed) {
      endSeek();
      if (audioBody.contains(document.activeElement)) collapseButton.focus({preventScroll: true});
    }
    audioBody.hidden = collapsed;
    $('audio-section').classList.toggle('audio-collapsed', collapsed);
    collapseButton.setAttribute('aria-expanded', String(!collapsed));
    collapseButton.setAttribute('aria-label', collapsed ? '展开音频工具' : '折叠音频工具');
    collapseButton.textContent = collapsed ? '展开 ▾' : '折叠 ▴';
    collapseButton.title = collapsed ? '展开音频工具' : '折叠音频工具';
  }
  collapseButton.onclick = () => setAudioCollapsed(!audioBody.hidden);
  setAudioCollapsed(false);
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds), hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60, rest = total % 60;
    return (hours ? `${hours}:` : '') + `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  function updateTimeline() {
    const duration = sourceURL && !failed && Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    const current = Math.max(0, Math.min(duration, Number.isFinite(player.currentTime) ? player.currentTime : 0));
    seek.max = String(duration);
    if (!seek.dataset.dragging) seek.value = String(current);
    const shown = seek.dataset.dragging ? Number(seek.value) : current;
    $('audio-current').textContent = formatTime(shown);
    $('audio-duration').textContent = duration ? formatTime(duration) : '--:--';
    seek.setAttribute('aria-valuetext', `${formatTime(shown)} / ${duration ? formatTime(duration) : '--:--'}`);
    seek.style.setProperty('--seek-progress', `${duration ? shown / duration * 100 : 0}%`);
  }
  function audioMessage(text, error = false) {
    $('audio-status').textContent = text;
    $('audio-status').classList.toggle('error', error);
    if (error) { setAudioCollapsed(false); sidebarController?.open(); }
  }
  function updateAudioControls() {
    const available = !!sourceURL && !failed;
    const canSeek = available && Number.isFinite(player.duration) && player.duration > 0;
    for (const id of ['audio-back', 'audio-restart', 'audio-forward', 'audio-seek']) $(id).disabled = !canSeek;
    for (const id of ['audio-toggle', 'audio-mute', 'audio-volume']) $(id).disabled = !available;
    rate.disabled = loop.disabled = !available;
    $('audio-toggle').textContent = player.paused || player.ended ? '▶ 播放' : '❚❚ 暂停';
    const silent = player.muted || player.volume === 0;
    $('audio-mute').textContent = silent ? '恢复声音' : '静音';
    $('audio-mute').setAttribute('aria-pressed', String(silent));
    volume.value = String(player.volume);
    updateTimeline();
  }
  function applyRate() {
    player.defaultPlaybackRate = Number(rate.value);
    player.playbackRate = Number(rate.value);
    player.preservesPitch = true;
  }
  function openAudio(file) {
    if (!file) return;
    if (!/^audio\//i.test(file.type || '') && !/\.(mp3|wav|m4a|aac|ogg|flac|opus|weba|aiff?|aif)$/i.test(file.name)) {
      audioMessage('请选择音频文件，例如 MP3、WAV 或 M4A。', true); return;
    }
    let nextURL;
    try { nextURL = URL.createObjectURL(file); }
    catch { audioMessage('未能读取音频文件，请重新选择。', true); return; }
    const previousURL = sourceURL;
    endSeek();
    sourceVersion++; failed = false;
    player.pause();
    sourceURL = nextURL;
    player.src = sourceURL;
    player.loop = loop.checked;
    applyRate();
    player.load();
    if (previousURL) URL.revokeObjectURL(previousURL);
    $('audio-filename').textContent = file.name;
    $('audio-filename').title = file.name;
    $('audio-filename').hidden = $('audio-options').hidden = false;
    $('audio-open').textContent = '更换音频文件';
    setAudioCollapsed(false);
    audioMessage('正在读取音频…');
    updateAudioControls();
  }
  function seekTo(seconds) {
    if (!sourceURL || failed || !Number.isFinite(player.duration) || player.duration <= 0) return;
    player.currentTime = Math.max(0, Math.min(player.duration, seconds));
    updateTimeline();
  }
  function seekBy(seconds) { seekTo((player.currentTime || 0) + seconds); }
  function endSeek(event) {
    if (event && event.pointerId !== seekPointer) return;
    const pointer = seekPointer;
    seekPointer = undefined;
    delete seek.dataset.dragging;
    if (pointer !== undefined && seek.hasPointerCapture(pointer)) seek.releasePointerCapture(pointer);
    updateTimeline();
    if (event) {
      seek.blur();
      sidebarController?.scheduleHide();
    }
  }
  $('audio-open').onclick = () => { input.value = ''; input.click(); };
  input.onchange = event => { openAudio(event.target.files[0]); input.value = ''; };
  $('audio-back').onclick = () => seekBy(-5);
  $('audio-forward').onclick = () => seekBy(5);
  async function playAudio() {
    if (!sourceURL || failed) return;
    const version = sourceVersion;
    try { await player.play(); }
    catch (error) {
      if (version === sourceVersion && error?.name !== 'AbortError') audioMessage('未能开始播放，请点击播放器的播放按钮，或更换音频文件。', true);
    }
    if (version === sourceVersion) updateAudioControls();
  }
  $('audio-toggle').onclick = () => {
    if (player.paused || player.ended) return playAudio();
    player.pause(); updateAudioControls();
  };
  $('audio-restart').onclick = () => {
    if ($('audio-restart').disabled) return;
    seekTo(0); return playAudio();
  };
  seek.addEventListener('input', () => seekTo(Number(seek.value)));
  seek.addEventListener('change', () => { seekTo(Number(seek.value)); updateTimeline(); });
  seek.addEventListener('pointerdown', event => {
    if (seek.disabled || event.button !== 0) return;
    seekPointer = event.pointerId;
    seek.dataset.dragging = 'true';
    seek.setPointerCapture(event.pointerId);
    sidebarController?.cancelHide();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) seek.addEventListener(name, endSeek);
  $('audio-mute').onclick = () => {
    const silent = player.muted || player.volume === 0;
    player.muted = !silent;
    if (silent && player.volume === 0) player.volume = .5;
    updateAudioControls();
  };
  volume.addEventListener('input', () => {
    player.volume = Number(volume.value);
    if (player.volume > 0) player.muted = false;
    updateAudioControls();
  });
  rate.onchange = applyRate;
  loop.onchange = () => { player.loop = loop.checked; };
  player.addEventListener('loadedmetadata', () => {
    if (!sourceURL || player.error) return;
    failed = false; applyRate(); updateAudioControls();
    audioMessage('点击播放按钮开始。翻页或收起侧栏时，音频会继续播放。');
  });
  for (const name of ['durationchange', 'play', 'pause', 'ended', 'volumechange']) player.addEventListener(name, updateAudioControls);
  for (const name of ['timeupdate', 'seeked', 'seeking']) player.addEventListener(name, updateTimeline);
  player.addEventListener('ratechange', () => {
    const value = String(player.playbackRate);
    if (['0.5', '0.75', '1', '1.25', '1.5', '2'].includes(value)) rate.value = value;
  });
  player.addEventListener('error', () => {
    if (!sourceURL || !player.error) return;
    failed = true; endSeek(); updateAudioControls();
    audioMessage('此音频未能播放，请尝试 MP3 或 WAV 文件，并确认文件完整。', true);
  });
  // Keep playback independent of PDF navigation, saving, and sidebar visibility.
  return {openFile: openAudio};
}
const audioController = initializeAudio();
