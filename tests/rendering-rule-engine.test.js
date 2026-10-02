const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../modules/rendering-rule-engine');

function rule(options = {}, regex = '待处理', template = '处理中') {
  return { name: '独立测试规则', chatId: ['global'], isEnabled: true, regex, template, options };
}
function process(input, rules, meta = {}, stage = 'display') {
  return engine.run(input, Array.isArray(rules) ? rules : [rules], 'chat', { messageId: 1, role: 'assistant', type: 'text', ...meta }, stage, true);
}

const cases = [
  ['普通文字按字面匹配', 'a.b aXb', { matchMode: 'text' }, 'a.b', 'x', 'x aXb'],
  ['关键词', '甲乙丙', { matchMode: 'keywords' }, '甲\n丙', 'x', 'x乙x'],
  ['整词', 'cat cats cat', { matchMode: 'word' }, 'cat', 'dog', 'dog cats dog'],
  ['整行', '保留\n待处理一行\n结束', { matchMode: 'line', action: 'delete' }, '待处理', '', '保留\n结束'],
  ['起止标记', 'a[备注]内容[/备注]b', { matchMode: 'markers', startMarker: '[备注]', endMarker: '[/备注]' }, '', '$1', 'a内容b'],
  ['首次匹配', 'aa', { matchMode: 'text', firstOnly: true }, 'a', 'b', 'ba'],
  ['匹配次数', 'aaa', { matchMode: 'text', maxMatches: 2 }, 'a', 'b', 'bba'],
  ['对照替换不产生替换链', '甲乙甲', { action: 'map', mapping: '甲 → 乙\n乙 → 丙' }, '', '', '乙丙乙'],
  ['对照表长词优先', '甲乙甲', { action: 'map', mapping: '甲 → x\n甲乙 → y' }, '', '', 'yx'],
  ['前面添加', '甲', { action: 'prefix', matchMode: 'text' }, '甲', '前', '前甲'],
  ['后面添加', '甲', { action: 'suffix', matchMode: 'text' }, '甲', '后', '甲后'],
  ['前后添加', '甲', { action: 'wrap', matchMode: 'text', suffix: '后' }, '甲', '前', '前甲后'],
  ['模板反斜杠保留', 'a', { matchMode: 'text' }, 'a', '\\路径\\', '\\路径\\'],
  ['代码保护', '待处理 `待处理`\n```\n待处理\n```', { matchMode: 'text', protectCode: true }, '待处理', '完成', '完成 `待处理`\n```\n待处理\n```'],
  ['链接保护', 'a https://a.test', { matchMode: 'text', protectLinks: true }, 'a', 'b', 'b https://a.test'],
  ['指定区域保护', 'a [a] a', { matchMode: 'text', protectStart: '[', protectEnd: ']' }, 'a', 'b', 'b [a] b'],
  ['对话区域', '待处理「待处理」待处理', { matchMode: 'text', region: 'dialogue' }, '待处理', '完成', '待处理「完成」待处理'],
  ['描写区域', '待处理「待处理」待处理', { matchMode: 'text', region: 'description' }, '待处理', '完成', '完成「待处理」完成'],
  ['格式整理保留代码边界', '  a  \n```\nx  y\n```\n b  ', { action: 'format', protectCode: true, format: { spaces: true, trailingSpace: true, trim: true } }, '', '', 'a\n```\nx  y\n```\n b'],
  ['遮罩', '待处理', { matchMode: 'text', action: 'mask', maskText: '隐藏' }, '待处理', '', '隐藏'],
];
for (const [name, input, options, regex, template, expected] of cases) {
  test(name, () => assert.equal(process(input, rule(options, regex, template)).content, expected));
}

test('旧模板原生替换语义完整保留', () => {
  for (const template of ['$$ $& $1 $2 $10 $01 $00', "$`|$'", '$<name>', '\\路径\\', '<div>$1</div>']) {
    const legacy = { name: '旧规则', regex: '(a)', template, chatId: ['global'], isEnabled: true };
    assert.equal(process('aba', legacy).content, 'aba'.replace(/(a)/g, template));
    assert.equal(process('aba', rule({ matchMode: 'regex' }, '(a)', template)).content.replace(/&lt;/g, '<').replace(/&gt;/g, '>'), 'aba'.replace(/(a)/g, template));
  }
});

test('随机标准写法、旧式写法、嵌套和捕获数据', () => {
  for (const template of ['{{random::晴朗::多云::小雨}}', '{{random:晴朗,多云,小雨}}', '{{random::{{random::晴朗::多云}}::小雨}}']) {
    const outputs = new Set();
    for (let messageId = 0; messageId < 100; messageId++) {
      const result = process('天气', rule({}, '天气', template), { messageId });
      assert.ok(['晴朗', '多云', '小雨'].includes(result.content)); outputs.add(result.content);
      assert.deepEqual(result.warnings, []);
    }
    assert.equal(outputs.size, 3);
  }
  const captured = '{{random::原文一::原文二}}';
  assert.equal(process(captured, rule({}, '(.*)', '$1{{random::尾}}')).content, captured + '尾尾');
});

test('随机稳定性、权重与消息内选择策略', () => {
  const random = rule({ action: 'random', matchMode: 'text', candidates: '[0] 禁用\n[1] 晴朗\n[3] 多云' }, 'a', '');
  const counts = { 晴朗: 0, 多云: 0 };
  for (let messageId = 0; messageId < 300; messageId++) {
    const result = process('a', random, { messageId }).content;
    counts[result]++;
    assert.equal(result, process('a', { ...random, name: '改名', options: { ...random.options, tags: ['标签'], samples: [] } }, { messageId }).content);
  }
  assert.ok(counts.多云 > counts.晴朗 && counts.晴朗 > 30);
  for (const selection of ['cycle', 'no-repeat']) {
    const result = process('aaaaaa', rule({ action: 'random', matchMode: 'text', candidates: '甲\n乙\n丙', selection }, 'a', '')).content;
    for (let i = 1; i < result.length; i++) assert.notEqual(result[i], result[i - 1]);
  }
  const shared = process('aaaa', rule({ action: 'random', matchMode: 'text', candidates: '甲\n乙', selection: 'message' }, 'a', '')).content;
  assert.equal(new Set(shared).size, 1);
});

test('空候选、逗号与转义', () => {
  assert.equal(process('a', rule({}, 'a', '{{random::}}')).content, '');
  assert.equal(process('a', rule({}, 'a', '{{random::甲，乙}}')).content, '甲，乙');
  assert.equal(process('a', rule({}, 'a', '{{random::甲\\:\\:乙}}')).content, '甲::乙');
  assert.throws(() => engine.compileRule(rule({}, 'a', '{{random::甲')), /结束/);
  assert.throws(() => engine.compileRule(rule({}, 'a', '{{random}}')), /候选/);
});

test('范围、阶段、停用、上下文删除和排除均独立生效', () => {
  const scoped = rule({ roles: ['user'], types: ['offline_text'], fields: ['content'], after: 100, stages: ['context'] });
  assert.equal(process('待处理', scoped).content, '待处理');
  assert.equal(process('待处理', scoped, { role: 'user', type: 'offline_text', timestamp: 200 }, 'context').content, '处理中');
  const removed = { ...rule(), doNotSend: true };
  assert.equal(process('待处理', removed, {}, 'context').content, '');
  assert.equal(process('待处理', { ...removed, isEnabled: false }, {}, 'context').content, '待处理');
  assert.equal(process('待处理', rule({ action: 'exclude', stages: ['context'] }), {}, 'context').excluded, true);
  assert.equal(process('待处理', rule({ stages: ['copy'] }), {}, 'copy').content, '处理中');
  assert.equal(process('待处理', rule({ stages: ['copy'] })).content, '待处理');
});

test('条件分支、规则顺序、停止与错误恢复', () => {
  const conditional = rule({ condition: { contains: '条件', useElse: true }, elseTemplate: '备用' });
  assert.equal(process('待处理', conditional).content, '备用');
  const a = { ...rule({}, 'a', 'b'), executionOrder: 0 };
  const b = { ...rule({}, 'b', 'c'), executionOrder: 1 };
  assert.equal(process('a', [b, a]).content, 'c');
  assert.equal(process('a', [{ ...a, options: { stop: 'stage' } }, b]).content, 'b');
  const invalid = rule({ matchMode: 'regex' }, '[', 'x');
  const result = process('a', [invalid, a]);
  assert.equal(result.content, 'b'); assert.equal(result.warnings.length, 1);
});

test('展示组件不会执行捕获文字，HTML 分支按实际结果判断', () => {
  for (const action of ['highlight', 'badge', 'note', 'fold', 'quote', 'card', 'table']) {
    const result = process('前<script>alert(1)</script>后', rule({ action }, '(<script>.*?</script>)', '$1'));
    assert.equal(result.isHtml, true);
    assert.ok(result.content.includes('&lt;script&gt;'));
    assert.ok(!result.content.includes('<script>'));
  }
  const plain = process('<b>a</b>', rule({ action: 'prefix', matchMode: 'text' }, '<b>a</b>', '文字'));
  assert.equal(plain.isHtml, false);
  const outputs = [];
  for (let messageId = 0; messageId < 30; messageId++) outputs.push(process('a', rule({}, 'a', '{{random::文字::<span>标签</span>}}'), { messageId }));
  assert.ok(outputs.some(result => !result.isHtml)); assert.ok(outputs.some(result => result.isHtml));
});
