import tpl from './problem-list.html';
import { ui } from '../ui-api.js';
import { repo } from '../../state/repo.js';
import { actions } from '../../state/actions.js';
import { submitAnswer } from '../../tsm/answer.js';
import { queryAI } from '../../ai/openai.js';
import { formatProblemForAI } from '../../tsm/ai-format.js';
import { PROBLEM_TYPE_MAP } from '../../core/types.js';
import { parseAIAnswer } from '../../tsm/ai-format.js';

const L = (...a) => console.log('[雨课堂助手][DBG][problem-list]', ...a);
const W = (...a) => console.warn('[雨课堂助手][WARN][problem-list]', ...a);

function $(sel) { return document.querySelector(sel); }
function create(tag, cls){ const n=document.createElement(tag); if(cls) n.className=cls; return n; }
function pretty(obj){ try{ return JSON.stringify(obj, null, 2); }catch{ return String(obj); } }

const HEADERS = () => ({
  'Content-Type': 'application/json',
  'xtbz': 'ykt',
  'X-Client': 'h5',
  'Authorization': 'Bearer ' + (typeof localStorage!=='undefined' ? (localStorage.getItem('Authorization')||'') : '')
});

async function httpGet(url){
  return new Promise((resolve,reject)=>{
    try{
      const xhr=new XMLHttpRequest();
      xhr.open('GET', url, true);
      const h=HEADERS(); for(const k in h) xhr.setRequestHeader(k,h[k]);
      xhr.onload=()=>{ try{ resolve(JSON.parse(xhr.responseText)); }catch{ reject(new Error('解析响应失败')); } };
      xhr.onerror=()=>reject(new Error('网络失败'));
      xhr.send();
    }catch(e){ reject(e); }
  });
}

// 依次尝试多个端点，先成功先用
async function fetchProblemDetail(problemId){
  const candidates = [
    `/api/v3/lesson/problem/detail?problemId=${problemId}`,
    `/api/v3/lesson/problem/get?problemId=${problemId}`,
    `/mooc-api/v1/lms/problem/detail?problem_id=${problemId}`,
  ];
  for (const url of candidates){
    try{
      const resp = await httpGet(url);
      if (resp && typeof resp === 'object' && (resp.code === 0 || resp.success === true)){
        return resp;
      }
    }catch(_){ /* try next */ }
  }
  throw new Error('无法获取题目信息');
}

/**
 * 将所有可见课件中的题目页灌入 repo.problems / repo.encounteredProblems
 * 目的：绕过 XHR/fetch 拦截失效，直接从现有内存结构构建题目列表
 */
function hydrateProblemsFromPresentations() {
  try {
    const beforeCnt = repo.problems?.size || 0;
    const encBefore = (repo.encounteredProblems || []).length;
    const seen = new Set((repo.encounteredProblems || []).map(e => e.problemId));

    let foundSlides = 0, filledProblems = 0, addedEvents = 0;

    for (const [, pres] of repo.presentations) {
      const slides = pres?.slides || [];
      if (!slides.length) continue;
      for (const s of slides) {
        if (!s || !s.problem) continue;
        foundSlides++;
        const pid = s.problem.problemId || s.problem.id;
        if (!pid) continue;
        const pidStr = String(pid);

        // 填充 repo.problems
        if (!repo.problems.has(pidStr)) {
          const normalized = {
            problemId: pidStr,
            problemType: s.problem.problemType || s.problem.type || s.problem.questionType || 'unknown',
            body: s.problem.body || s.problem.title || '',
            options: s.problem.options || [],
            result: s.problem.result || null,
            status: s.problem.status || {},
            startTime: s.problem.startTime,
            endTime: s.problem.endTime,
            slideId: String(s.id),
            presentationId: String(pres.id),
          };
          repo.problems.set(pidStr, Object.assign({}, s.problem, normalized));
          filledProblems++;
        }

        // 填充 repo.encounteredProblems
        if (!seen.has(pidStr)) {
          seen.add(pidStr);
          (repo.encounteredProblems || (repo.encounteredProblems = [])).push({
            problemId: pidStr,
            problemType: s.problem.problemType || s.problem.type || s.problem.questionType || 'unknown',
            body: s.problem.body || s.problem.title || '',
            presentationId: String(pres.id),
            slideId: String(s.id),
            slide: s,
            endTime: s.problem.endTime,
            startTime: s.problem.startTime,
          });
          addedEvents++;
        }
      }
    }

    // 按 presentationId+slide.index 排序
    if (repo.encounteredProblems && repo.encounteredProblems.length) {
      repo.encounteredProblems.sort((a,b)=>{
        if (a.presentationId !== b.presentationId) return String(a.presentationId).localeCompare(String(b.presentationId));
        const ax = a.slide?.index ?? 0, bx = b.slide?.index ?? 0;
        return ax - bx;
      });
    }

    const afterCnt = repo.problems?.size || 0;
    const encAfter = (repo.encounteredProblems || []).length;
    L('[hydrateProblemsFromPresentations]', {
      foundSlides, filledProblems, addedEvents,
      problemsBefore: beforeCnt, problemsAfter: afterCnt,
      encounteredBefore: encBefore, encounteredAfter: encAfter,
      sampleProblems: Array.from(repo.problems.keys()).slice(0,8),
    });
  } catch (e) {
    W('hydrateProblemsFromPresentations error:', e);
  }
}

/**
 * 在无法从 repo.problems 命中时，跨 presentations 查找并回写
 */
function crossFindProblem(problemIdStr) {
  for (const [, pres] of repo.presentations) {
    const arr = pres?.slides || [];
    for (const s of arr) {
      const pid = s?.problem?.problemId || s?.problem?.id;
      if (pid && String(pid) === problemIdStr) {
        // 回写
        const normalized = Object.assign({},
          s.problem,
          {
            problemId: problemIdStr,
            problemType: s.problem.problemType || s.problem.type || s.problem.questionType || 'unknown',
            body: s.problem.body || s.problem.title || '',
            options: s.problem.options || [],
            result: s.problem.result || null,
            status: s.problem.status || {},
            startTime: s.problem.startTime,
            endTime: s.problem.endTime,
            slideId: String(s.id),
            presentationId: String(pres.id),
          }
        );
        repo.problems.set(problemIdStr, normalized);
        return { problem: normalized, slide: s, presentationId: String(pres.id) };
      }
    }
  }
  return null;
}

// ========== 行渲染与交互 ==========
function bindRowActions(row, e, prob){
  const actionsBar = row.querySelector('.problem-actions');

  // 查看：跳到对应的课件页
  const btnGo = create('button'); btnGo.textContent = '查看';
  btnGo.onclick = () => {
    const presId = e.presentationId || prob?.presentationId;
    const slideId = (e.slide?.id || e.slideId || prob?.slideId);
    L('查看题目 -> navigateTo', { presId, slideId });
    if (presId && slideId) actions.navigateTo(String(presId), String(slideId));
    else ui.toast('缺少跳转信息');
  };
  actionsBar.appendChild(btnGo);

  // AI 解答：打开 AI 面板并优先使用该题所在页（若拿得到）
  const btnAI = create('button'); btnAI.textContent = 'AI解答';
  btnAI.onclick = () => {
    const presId = e.presentationId || prob?.presentationId;
    const slideId = (e.slide?.id || e.slideId || prob?.slideId);
    if (slideId) {
      // 派发“提问当前PPT”以便 AI 面板优先识别该页
      window.dispatchEvent(new CustomEvent('ykt:ask-ai-for-slide', {
        detail: {
          slideId: String(slideId),
          imageUrl: repo.slides.get(String(slideId))?.image || repo.slides.get(String(slideId))?.thumbnail || ''
        }
      }));
    }
    window.dispatchEvent(new CustomEvent('ykt:open-ai', { detail:{ problemId: e.problemId } }));
  };
  actionsBar.appendChild(btnAI);

  // 修改后刷新题目
  const btnRefresh = create('button'); btnRefresh.textContent = '刷新题目';
  btnRefresh.onclick = async () => {
    row.classList.add('loading');
    try{
      const resp = await fetchProblemDetail(e.problemId);
      const detail = resp.data?.problem || resp.data || resp.result || {};
      const merged = Object.assign({}, prob||{}, detail, { problemId: e.problemId, problemType: e.problemType });
      repo.problems.set(e.problemId, merged);
      updateRow(row, e, merged);
      ui.toast('已刷新题目');
    }catch(err){
      ui.toast('刷新失败：' + (err?.message || err));
    }finally{
      row.classList.remove('loading');
    }
  };
  actionsBar.appendChild(btnRefresh);
}

function updateRow(row, e, prob){
   // 标题
  const title = row.querySelector('.problem-title');
  title.textContent = (prob?.body || e.body || prob?.title || `题目 ${e.problemId}`).slice(0, 120);

  // 先拿 status & 时窗
  const status = prob?.status || e.status || {};
  const ps = repo.problemStatus?.get?.(e.problemId);
  const startTime = Number(
    status?.startTime ?? prob?.startTime ?? e.startTime ?? ps?.startTime ?? 0
  ) || undefined;
  const endTime = Number(
    status?.endTime   ?? prob?.endTime   ?? e.endTime   ?? ps?.endTime   ?? 0
  ) || undefined;

  // 元信息（含截止时间）
  const meta = row.querySelector('.problem-meta');
  const answered = !!(prob?.result || status?.myAnswer || status?.answered);
  meta.textContent =
    `PID: ${e.problemId} / 类型: ${e.problemType} / 状态: ${answered ? '已作答' : '未作答'} / 截止: ${endTime ? new Date(endTime).toLocaleString() : '未知'}`;

  // 容器
  let detail = row.querySelector('.problem-detail');
  if (!detail){ detail = create('div','problem-detail'); row.appendChild(detail); }
  detail.innerHTML = '';

  // 已作答答案
  const answeredBox = create('div','answered-box');
  const ansLabel = create('div','label'); ansLabel.textContent = '已作答答案';
  const ansPre = create('pre'); ansPre.textContent = pretty(prob?.result || status?.myAnswer || {});
  answeredBox.appendChild(ansLabel); answeredBox.appendChild(ansPre);
  detail.appendChild(answeredBox);

  // ========== 类型感知的答题输入区 ==========
  const editorBox = create('div','editor-box');
  const pType = Number(e.problemType);
  const options = prob?.options || e.options || [];

  // 从友好输入中构建 result payload
  let getResultFromInputs;

  if (pType === 1 || pType === 3) {
    // 单选 / 投票：radio buttons
    const editLabel = create('div','label');
    editLabel.textContent = pType === 1 ? '单选题 - 选择答案' : '投票题 - 选择答案';
    editorBox.appendChild(editLabel);

    const radioGroup = create('div','retry-options-group');
    const radioName = `retry-radio-${e.problemId}`;
    const existingAnswer = Array.isArray(prob?.result) ? prob.result[0] : null;

    if (options.length > 0) {
      options.forEach(opt => {
        const lbl = create('label','retry-option-label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = radioName;
        radio.value = opt.key;
        if (existingAnswer && opt.key === existingAnswer) radio.checked = true;
        lbl.appendChild(radio);
        const span = create('span');
        span.textContent = ` ${opt.key}. ${opt.value || ''}`;
        lbl.appendChild(span);
        radioGroup.appendChild(lbl);
      });
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'retry-text-input';
      input.placeholder = '输入选项字母，如 A';
      input.value = existingAnswer || '';
      radioGroup.appendChild(input);
    }
    editorBox.appendChild(radioGroup);

    getResultFromInputs = () => {
      if (options.length > 0) {
        const checked = radioGroup.querySelector(`input[name="${radioName}"]:checked`);
        return checked ? [checked.value] : null;
      }
      const val = radioGroup.querySelector('input[type="text"]')?.value?.trim().toUpperCase();
      return val ? [val] : null;
    };

  } else if (pType === 2) {
    // 多选：checkboxes
    const editLabel = create('div','label');
    editLabel.textContent = '多选题 - 选择答案（可多选）';
    editorBox.appendChild(editLabel);

    const checkGroup = create('div','retry-options-group');
    const existingAnswers = Array.isArray(prob?.result) ? prob.result : [];

    if (options.length > 0) {
      options.forEach(opt => {
        const lbl = create('label','retry-option-label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt.key;
        if (existingAnswers.includes(opt.key)) cb.checked = true;
        lbl.appendChild(cb);
        const span = create('span');
        span.textContent = ` ${opt.key}. ${opt.value || ''}`;
        lbl.appendChild(span);
        checkGroup.appendChild(lbl);
      });
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'retry-text-input';
      input.placeholder = '输入选项字母，如 A,B,C';
      input.value = existingAnswers.join(',');
      checkGroup.appendChild(input);
    }
    editorBox.appendChild(checkGroup);

    getResultFromInputs = () => {
      if (options.length > 0) {
        const checked = [...checkGroup.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
        return checked.length ? checked.sort() : null;
      }
      const val = checkGroup.querySelector('input[type="text"]')?.value?.trim().toUpperCase();
      return val ? val.split(/[,，、\s]+/).filter(Boolean).sort() : null;
    };

  } else if (pType === 4) {
    // 填空
    const editLabel = create('div','label');
    editLabel.textContent = '填空题 - 输入答案（多空用逗号分隔）';
    editorBox.appendChild(editLabel);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'retry-text-input';
    input.placeholder = '答案1,答案2,...';
    const existingFills = Array.isArray(prob?.result) ? prob.result.join(',') : '';
    input.value = existingFills;
    editorBox.appendChild(input);

    getResultFromInputs = () => {
      const val = input.value.trim();
      return val ? val.split(/[,，]+/).map(s => s.trim()) : null;
    };

  } else {
    // 主观题 (type 5) 或未知类型
    const editLabel = create('div','label');
    editLabel.textContent = '主观题 - 输入答案';
    editorBox.appendChild(editLabel);

    const textarea = document.createElement('textarea');
    textarea.className = 'retry-subjective-input';
    textarea.rows = 4;
    textarea.placeholder = '输入回答内容...';
    const existingSub = prob?.result;
    if (existingSub) {
      textarea.value = typeof existingSub === 'string' ? existingSub : (existingSub.content || '');
    }
    editorBox.appendChild(textarea);

    getResultFromInputs = () => {
      const val = textarea.value.trim();
      return val ? { content: val, pics: [] } : null;
    };
  }

  // 高级模式（可折叠的原始 JSON 编辑器）
  const advToggle = create('div','retry-adv-toggle');
  advToggle.textContent = '▶ 高级模式（JSON）';
  const advBox = create('div','retry-adv-box');
  advBox.style.display = 'none';
  const advTextarea = create('textarea');
  advTextarea.rows = 5;
  advTextarea.className = 'retry-json-textarea';
  advTextarea.placeholder = '直接编辑 JSON 格式的答案';
  advTextarea.value = pretty(prob?.result || status?.myAnswer || {});
  advBox.appendChild(advTextarea);

  advToggle.onclick = () => {
    const visible = advBox.style.display !== 'none';
    advBox.style.display = visible ? 'none' : 'block';
    advToggle.textContent = visible ? '▶ 高级模式（JSON）' : '▼ 高级模式（JSON）';
  };
  editorBox.appendChild(advToggle);
  editorBox.appendChild(advBox);

  // 从当前输入获取 result 的统一入口（优先高级模式的 JSON）
  function collectResult() {
    if (advBox.style.display !== 'none' && advTextarea.value.trim()) {
      return JSON.parse(advTextarea.value);
    }
    const r = getResultFromInputs();
    if (r == null) throw new Error('请先填写答案');
    return r;
  }

  // 按钮栏
  const submitBar = create('div','submit-bar');

  // 提交
  const btnSubmit = create('button'); btnSubmit.textContent = '提交';
  btnSubmit.onclick = async () => {
    try{
      const result = collectResult();
      row.classList.add('loading');
      const { route } = await submitAnswer(
        { problemId: e.problemId, problemType: e.problemType },
        result,
        { startTime, endTime }
      );
      ui.toast(route==='answer' ? '提交成功' : '补交成功');
      const merged = Object.assign({}, prob||{}, { result }, { status: { ...(prob?.status||{}), answered: true } });
      repo.problems.set(e.problemId, merged);
      updateRow(row, e, merged);
    }catch(err){
      ui.toast('提交失败：' + (err?.message || err));
    }finally{
      row.classList.remove('loading');
    }
  };
  submitBar.appendChild(btnSubmit);

  // 强制补交
  const btnForceRetry = create('button'); btnForceRetry.textContent = '强制补交';
  btnForceRetry.onclick = async () => {
    try{
      const result = collectResult();
      row.classList.add('loading');
      await submitAnswer(
        { problemId: e.problemId, problemType: e.problemType },
        result,
        { startTime, endTime, forceRetry: true }
      );
      ui.toast('补交成功');
      const merged = Object.assign({}, prob||{}, { result }, { status: { ...(prob?.status||{}), answered: true } });
      repo.problems.set(e.problemId, merged);
      updateRow(row, e, merged);
    }catch(err){ ui.toast('补交失败：' + (err?.message || err)); }
    finally{ row.classList.remove('loading'); }
  };
  submitBar.appendChild(btnForceRetry);

  // AI 补交：调用 AI 生成答案 → 填入输入 → 自动补交
  const btnAIRetry = create('button','retry-ai-btn'); btnAIRetry.textContent = 'AI 补交';
  btnAIRetry.onclick = async () => {
    if (!ui.config.ai?.profiles?.length && !ui.config.ai?.kimiApiKey) {
      ui.toast('请先在设置中配置 API Key');
      return;
    }
    btnAIRetry.disabled = true;
    btnAIRetry.textContent = 'AI 分析中...';
    try {
      const q = formatProblemForAI(prob || { problemId: e.problemId, problemType: pType, body: e.body || '', options }, PROBLEM_TYPE_MAP);
      const aiAnswer = await queryAI(q, ui.config.ai);
      const parsed = parseAIAnswer({ problemType: pType, options }, aiAnswer);
      if (!parsed) {
        ui.toast('AI 返回了答案但解析失败，已填入高级模式');
        advBox.style.display = 'block';
        advToggle.textContent = '▼ 高级模式（JSON）';
        advTextarea.value = aiAnswer;
        return;
      }
      // 将 AI 结果回填到友好输入
      fillInputsFromResult(parsed, pType, editorBox, e.problemId, options);
      advTextarea.value = pretty(parsed);
      ui.toast('AI 已生成答案，请确认后点击"强制补交"');
    } catch (err) {
      ui.toast('AI 生成失败：' + (err?.message || err));
    } finally {
      btnAIRetry.disabled = false;
      btnAIRetry.textContent = 'AI 补交';
    }
  };
  submitBar.appendChild(btnAIRetry);

  editorBox.appendChild(submitBar);
  detail.appendChild(editorBox);
}

function fillInputsFromResult(result, pType, editorBox, problemId, options) {
  if ((pType === 1 || pType === 3) && Array.isArray(result)) {
    const val = result[0];
    if (options.length > 0) {
      const radioName = `retry-radio-${problemId}`;
      const radio = editorBox.querySelector(`input[name="${radioName}"][value="${val}"]`);
      if (radio) radio.checked = true;
    } else {
      const input = editorBox.querySelector('.retry-text-input');
      if (input) input.value = val || '';
    }
  } else if (pType === 2 && Array.isArray(result)) {
    if (options.length > 0) {
      editorBox.querySelectorAll('.retry-options-group input[type="checkbox"]').forEach(cb => {
        cb.checked = result.includes(cb.value);
      });
    } else {
      const input = editorBox.querySelector('.retry-text-input');
      if (input) input.value = result.join(',');
    }
  } else if (pType === 4 && Array.isArray(result)) {
    const input = editorBox.querySelector('.retry-text-input');
    if (input) input.value = result.join(',');
  } else if (pType === 5 || (typeof result === 'object' && result.content !== undefined)) {
    const ta = editorBox.querySelector('.retry-subjective-input');
    if (ta) ta.value = typeof result === 'string' ? result : (result.content || '');
  }
}

// ========== 面板生命周期 ==========
let mounted = false;
let root;

export function mountProblemListPanel() {
  if (mounted) return root;
  const wrap = document.createElement('div');
  wrap.innerHTML = tpl;
  document.body.appendChild(wrap.firstElementChild);
  root = document.getElementById('ykt-problem-list-panel');

  $('#ykt-problem-list-close')?.addEventListener('click', () => showProblemListPanel(false));
  window.addEventListener('ykt:open-problem-list', () => showProblemListPanel(true));

  mounted = true;

  // 首次挂载时就做一次灌入
  hydrateProblemsFromPresentations();
  updateProblemList();
  return root;
}

export function showProblemListPanel(visible = true) {
  mountProblemListPanel();
  root.classList.toggle('visible', !!visible);
  if (visible) {
    // 面板打开时再做一次灌入
    hydrateProblemsFromPresentations();
    updateProblemList();
  }
}

export function updateProblemList() {
  mountProblemListPanel();
  const container = $('#ykt-problem-list');
  container.innerHTML = '';

  // 兜底刷新
  if (!repo.encounteredProblems || repo.encounteredProblems.length === 0) {
    hydrateProblemsFromPresentations();
  }

  const list = (repo.encounteredProblems || []);
  L('updateProblemList', { count: list.length });

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'problem-empty';
    empty.textContent = '暂无题目（可尝试切换章节或刷新页面）';
    container.appendChild(empty);
    return;
  }

  list.forEach((e) => {
    let prob = repo.problems.get(e.problemId) || null;
    if (!prob) {
      const cross = crossFindProblem(String(e.problemId));
      if (cross) {
        prob = cross.problem;
        e.presentationId = e.presentationId || cross.presentationId;
        e.slide = e.slide || cross.slide;
        e.slideId = e.slideId || cross.slide?.id;
        L('cross-fill problem', { pid: e.problemId, pres: e.presentationId, slideId: e.slideId });
      }
    }

    const row = document.createElement('div');
    row.className = 'problem-row';

    const title = document.createElement('div');
    title.className = 'problem-title';
    row.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'problem-meta';
    row.appendChild(meta);

    const actionsBar = document.createElement('div');
    actionsBar.className = 'problem-actions';
    row.appendChild(actionsBar);

    bindRowActions(row, e, prob || {});
    updateRow(row, e, prob || {});
    container.appendChild(row);
  });
}
