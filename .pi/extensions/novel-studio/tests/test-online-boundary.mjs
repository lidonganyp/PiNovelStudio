// 完整测试：containsContractedRemotePhysicalAction 修复验证
// 包含主语归属守卫 + 远程方位词守卫

const CONTRACTED_REMOTE_PHYSICAL_ACTION_TERMS = [
  "背靠","靠在","跨前","上前","后退","站起","站起来","站直","站直身体","站到","站在",
  "坐下","坐到","坐在","走到","走进","走出","踏进","凑近","靠近","伸手","推门","拉门",
  "打开门","递交","递给","触碰","摸到","摸出","摸向","拿起","抓住","按住","挡在","阻挡","越过",
];

const CONTRACTED_REMOTE_MEDIATED_ACTION_TERMS = [
  "发帖","回帖","回复","留言","评论","私信","发来","传来","上传","贴出","补充","说明",
  "发送","通话","录音","语音","转述",
];

function containsAny(text, terms) {
  return terms.some(term => text.includes(term));
}

function isNameImmediatePhysicalSubject(afterName) {
  for (const term of CONTRACTED_REMOTE_PHYSICAL_ACTION_TERMS) {
    if (afterName.startsWith(term)) return true;
  }
  const m = afterName.match(/^[，,、。！？；;\s]*(?:忽然|突然|猛地|缓缓|直接|立刻|马上|便|就|才|也|还|已|正|慢慢|轻轻)?[，,、\s]*/);
  if (m) {
    const rest = afterName.slice(m[0].length);
    for (const term of CONTRACTED_REMOTE_PHYSICAL_ACTION_TERMS) {
      if (rest.startsWith(term)) return true;
    }
  }
  return false;
}

function isRemoteDirectionalReference(actionWindow, name) {
  const afterName = actionWindow.slice(name.length);
  return /^(?:那边|这头|这端|那端|那头)/.test(afterName);
}

function hasOtherSubjectBeforeAction(prefix, remoteName) {
  const commaPronounPattern = /[，,。；;]\s*(?:他|她|它|他们|她们)[^，,。；;]{0,8}$/u;
  if (commaPronounPattern.test(prefix)) return true;

  const commaNamePattern = /[，,。；;]\s*([\u4e00-\u9fff]{2,8})[^，,。；;]{0,6}$/u;
  const commaNameMatch = prefix.match(commaNamePattern);
  if (commaNameMatch) {
    const candidateName = commaNameMatch[1];
    if (candidateName !== remoteName && !/^(那边|这里|那里|这个|那个|什么|怎么|为什么)$/.test(candidateName)) {
      return true;
    }
  }

  const directPronounPattern = /(?:他|她|它|他们|她们)(?:转身|缓缓|猛地|忽然|直接|立刻|马上|便|就|才|也|还|已|正|慢慢|轻轻)?$/u;
  if (directPronounPattern.test(prefix)) return true;

  return false;
}

function isPhysicalActionAttributedToName(actionWindow, name) {
  for (const term of CONTRACTED_REMOTE_PHYSICAL_ACTION_TERMS) {
    let termIndex = actionWindow.indexOf(term);
    while (termIndex >= 0) {
      const prefix = actionWindow.slice(Math.max(0, termIndex - 18), termIndex);
      if (hasOtherSubjectBeforeAction(prefix, name)) {
        termIndex = actionWindow.indexOf(term, termIndex + term.length);
        continue;
      }
      const nameInPrefix = prefix.lastIndexOf(name);
      if (nameInPrefix >= 0) {
        const afterName = prefix.slice(nameInPrefix + name.length);
        if (isNameImmediatePhysicalSubject(afterName + term)) {
          return true;
        }
      }
      return true;
    }
  }
  return false;
}

function containsPhysicalActionTerm(text) {
  return CONTRACTED_REMOTE_PHYSICAL_ACTION_TERMS.some(t => text.includes(t));
}

function containsContractedRemotePhysicalAction(sentence, name) {
  const compactSentence = sentence.replace(/\s+/g, "");
  let nameIndex = compactSentence.indexOf(name);
  while (nameIndex >= 0) {
    const actionWindow = compactSentence.slice(nameIndex, nameIndex + name.length + 42);
    if (isRemoteDirectionalReference(actionWindow, name)) {
      nameIndex = compactSentence.indexOf(name, nameIndex + name.length);
      continue;
    }
    if (
      containsPhysicalActionTerm(actionWindow) &&
      !containsAny(actionWindow, CONTRACTED_REMOTE_MEDIATED_ACTION_TERMS)
    ) {
      if (!isPhysicalActionAttributedToName(actionWindow, name)) {
        nameIndex = compactSentence.indexOf(name, nameIndex + name.length);
        continue;
      }
      return true;
    }
    nameIndex = compactSentence.indexOf(name, nameIndex + name.length);
  }
  return false;
}

// 完整测试用例
const testCases = [
  // === 用户报告的误判（应返回 false）===
  { sentence: "陈锋那边停了几秒才发来", name: "陈锋", expected: false, desc: "E3误判:消息发送延迟" },
  { sentence: "陈锋的声音压得很低", name: "陈锋", expected: false, desc: "E3误判:语音消息播放" },

  // === 远程方位词守卫（应返回 false）===
  { sentence: "陈锋那边走到门口", name: "陈锋", expected: false, desc: "远程方位词:那边+物理动作" },
  { sentence: "陈锋那头站起身来", name: "陈锋", expected: false, desc: "远程方位词:那头+物理动作" },
  { sentence: "陈锋这头伸手推门", name: "陈锋", expected: false, desc: "远程方位词:这头+物理动作" },

  // === 主语归属守卫（应返回 false）===
  { sentence: "陈锋的声音压得很低，他走到窗边", name: "陈锋", expected: false, desc: "代词'他'执行动作" },
  { sentence: "陈锋说完，她站起身来", name: "陈锋", expected: false, desc: "代词'她'执行动作" },
  { sentence: "他转身走到桌前，陈锋的声音还在耳边", name: "陈锋", expected: false, desc: "代词在名字前面" },
  { sentence: "陈锋的声音从听筒传来，他拿起手机", name: "陈锋", expected: false, desc: "代词'他'拿起手机" },
  { sentence: "陈锋那边停了几秒才发来，李一凡走到桌前", name: "陈锋", expected: false, desc: "其他角色名+mediated" },

  // === 远程通信上下文（应返回 false）===
  { sentence: "陈锋在电话那头说", name: "陈锋", expected: false, desc: "无物理动作词" },
  { sentence: "陈锋那边又敲了一条消息过来", name: "陈锋", expected: false, desc: "无物理动作词" },
  { sentence: "陈锋发来一条消息", name: "陈锋", expected: false, desc: "mediated term" },

  // === 正确阻断场景（应返回 true）===
  { sentence: "陈锋走到门口", name: "陈锋", expected: true, desc: "名字直接执行物理动作" },
  { sentence: "陈锋伸手推门", name: "陈锋", expected: true, desc: "名字直接执行物理动作" },
  { sentence: "陈锋猛地站起", name: "陈锋", expected: true, desc: "名字+副词+物理动作" },
  { sentence: "陈锋，走到门口", name: "陈锋", expected: true, desc: "名字+逗号+物理动作" },
  { sentence: "陈锋缓缓靠近", name: "陈锋", expected: true, desc: "名字+副词+物理动作" },
  { sentence: "陈锋站起身来", name: "陈锋", expected: true, desc: "名字+物理动作" },
  { sentence: "陈锋说完，走到门口", name: "陈锋", expected: true, desc: "名字+说完+走到(无明确其他主语)" },
  { sentence: "陈锋沉默片刻，走到窗边", name: "陈锋", expected: true, desc: "名字+沉默+走到" },
];

let passed = 0;
let failed = 0;
for (const tc of testCases) {
  const result = containsContractedRemotePhysicalAction(tc.sentence, tc.name);
  const ok = result === tc.expected;
  if (ok) {
    passed++;
    console.log(`  PASS: "${tc.sentence}" → ${result} (${tc.desc})`);
  } else {
    failed++;
    console.log(`  FAIL: "${tc.sentence}" → ${result} (expected ${tc.expected}, ${tc.desc})`);
  }
}
console.log(`\nResults: ${passed} passed, ${failed} failed`);
