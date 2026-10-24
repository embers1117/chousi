// src/fields.js —— 地点 / 人物 / 联系方式 / 优先级 / 分类 的抽取规则
// 所有函数只依赖传入的字符串（外加 offset 对齐的空白化文本），便于单测。

/** 场所后缀（长的排前面，保证「大会议室」不被「室」抢先截断） */
const PLACE_SUFFIX = [
  '会议室', '会议中心', '会议厅', '办公室', '教室', '餐厅', '食堂', '酒店', '宾馆',
  '大厦', '广场', '公园', '医院', '学校', '大学', '校区', '园区', '机场', '车站',
  '地铁站', '火车站', '图书馆', '体育馆', '展览馆', '博物馆', '大厅', '前台',
  '门口', '礼堂', '活动室', '实验室', '工作室', '门店', '服务中心', '派出所',
  '健身房', '银行', '超市', '商场', '药店', '楼层', '中心', '基地', '公司',
  '工厂', '家', '楼', '层', '室', '厅', '馆', '院', '站', '路', '街', '道', '店',
].join('|');

const PLACE_RE = new RegExp(
  `(?:地点|地址|位置|场地|会议地点|集合地点|开会地点|场地地点)\\s*(?:是|为)?\\s*[:：]?\\s*([^，。；;\\n！？!?]{2,40})` +
  `|(?:在|于|到|去|前往|来到)\\s*([\\u4e00-\\u9fa5A-Za-z0-9（）()·\\-#\\s]{0,20}(?:${PLACE_SUFFIX}))` +
  `|(线上|线下|网上|云端|腾讯会议|钉钉会议|飞书会议|视频会议|微信群|QQ群|群聊|语音会议)`,
  'g'
);

const ONLINE_MEETING = /(腾讯会议|钉钉|飞书|Zoom|Teams|Webex|腾讯会议号|会议号|会议\\s*ID|房间号|会议链接)/i;
const URL_RE = /https?:\/\/[^\s，。；)）]+/i;
const MEETING_ID_RE = /(?:会议号|会议\s*ID|房间号|会议码)\s*[:：]?\s*([\d\s\-]{6,20})/i;

/** 把若干区间替换成等长空格（保持偏移不变） */
export function blankSpans(text, spans) {
  if (!spans || !spans.length) return text;
  const arr = [...text];
  for (const s of spans) {
    for (let i = s.index; i < s.end && i < arr.length; i++) arr[i] = ' ';
  }
  return arr.join('');
}

/** 找出地点，返回第一个可用结果 */
export function findPlace(text, timeSpans = []) {
  const masked = blankSpans(text, timeSpans);
  let best = null;

  // 线上会议优先（比实体地点更具体）
  const idMatch = MEETING_ID_RE.exec(masked);
  const urlMatch = URL_RE.exec(masked);
  if (ONLINE_MEETING.test(masked)) {
    const kind = (masked.match(/腾讯会议/) && '腾讯会议')
      || (masked.match(/钉钉/) && '钉钉会议')
      || (masked.match(/飞书/) && '飞书会议')
      || (masked.match(/Zoom/i) && 'Zoom')
      || (masked.match(/Teams/i) && 'Teams')
      || (masked.match(/视频会议/) && '视频会议')
      || (masked.match(/微信群|群聊/) && '微信群')
      || '线上';
    let place = kind;
    if (idMatch) place += `（会议号 ${idMatch[1].trim().replace(/\s+/g, '')}）`;
    const idx = Math.max(0, masked.search(new RegExp(kind, 'i')));
    let end = idx + kind.length;
    if (idMatch) end = Math.max(end, idMatch.index + idMatch[0].length);
    while (end < masked.length && /[）)】」\s]/.test(masked[end])) end++;
    return { place, index: idx, end, online: true };
  }
  if (urlMatch) {
    return { place: '线上（会议链接）', index: urlMatch.index, end: urlMatch.index + urlMatch[0].length, online: true };
  }

  PLACE_RE.lastIndex = 0;
  let m;
  while ((m = PLACE_RE.exec(masked)) !== null) {
    const raw = (m[1] || m[2] || m[3] || '').trim();
    let place = cleanPlace(raw);
    if (!place) continue;
    const offsetInMatch = m[0].lastIndexOf(raw);
    const start = m.index + Math.max(0, offsetInMatch);
    const cand = { place, index: start, end: start + raw.length, online: /线上|网上|云端/.test(place) };
    // 越具体（带场所后缀、越长）越优先
    if (!best || scorePlace(cand.place) > scorePlace(best.place)) best = cand;
  }
  return best;
}

function cleanPlace(s) {
  let p = String(s || '')
    .replace(/^(的|了|是|在|于|去|到)/, '')
    .replace(/[，。；;、\s]+$/, '')
    .replace(/^[\s:：]+/, '')
    .trim();
  if (!p || p.length < 1) return '';
  if (/^(这里|那里|哪里|这边|那边|现场|各位|大家)$/.test(p)) return '';
  return p;
}

function scorePlace(p) {
  let s = p.length;
  if (/会议室|会议中心|会议厅|办公室|教室|酒店|餐厅|大厅|礼堂/.test(p)) s += 6;
  if (/楼|层|室|厅|馆/.test(p)) s += 3;
  if (/^\d+$/.test(p)) s -= 10;
  return s;
}

const TITLES = '老师|经理|主任|总监|同学|医生|师傅|同事|助理|秘书|部长|处长|科长|老板|护士|警官|律师|会计';
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴鬱胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍卻璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公';

const NAME_STOP = new Set([
  '时间', '地点', '大家', '部门', '公司', '负责', '通知', '确认', '回复', '准备', '材料',
  '文件', '明天', '后天', '今天', '上午', '下午', '晚上', '中午', '我们', '你们', '他们',
  '自己', '同事', '领导', '老师', '学生', '会议', '报告', '地址', '电话', '事项', '问题',
  '情况', '意见', '结果', '计划', '项目', '之前', '以后', '相关', '人员', '单位', '系统',
  '平台', '微信', '邮箱', '表格', '费用', '发票', '单据', '报销', '以下', '以上', '其他',
  '具体', '备注', '注意', '提醒', '要求', '时候', '地方', '东西', '事情', '工作', '上面',
  '下面', '里面', '外面', '前面', '后面', '左边', '右边', '时间表', '负责人', '联系人',
  '客户', '甲方', '乙方', '财务', '行政', '人事', '采购', '后勤', '技术', '产品', '运营',
  '销售', '市场', '设计', '研发', '全体', '各位', '同学', '家长', '朋友们', '邀请',
  '提前', '一下', '这个', '那个', '今天', '后天', '各位', '部门', '负责人', '这边', '那边',
]);

/** 名字里不该出现的「功能字」 */
const NAME_BAD = /[的了是在和与跟把被为对从到这那什么怎么还有你我他她它给报周交发送提请要都得地着过上下都也就还再让部局处科室系组队会班一二三四五六七八九十第年月日时分秒]/;

function isName(s) {
  if (!s || s.length < 2 || s.length > 4) return false;
  if (NAME_STOP.has(s)) return false;
  if (NAME_BAD.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  return true;
}

/**
 * 从一串可能带脏字符的片段里挑出最像人名的部分：
 * 先试 3 字，再 2 字，最后 1 字（1 字只认常见姓）。
 */
export function pickName(run) {
  const s = String(run || '').trim();
  if (!s) return null;
  for (const n of [3, 2]) {
    if (s.length < n) continue;
    const cand = s.slice(-n);
    if (isName(cand)) return cand;
  }
  const c1 = s.slice(-1);
  if (c1 && SURNAMES.includes(c1)) return c1;
  return null;
}

const PHONE_RE = /(?:电话|手机|联系|致电)?\s*(1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|400-?\d{3}-?\d{4})/g;

/** 找出人物（含 @昵称、负责人、电话） */
export function findPeople(text, timeSpans = []) {
  const masked = blankSpans(text, timeSpans);
  const people = new Set();
  const phones = new Set();
  let m;

  // 带职务：王小明老师 / 李医生
  const reTitle = new RegExp(`([\\u4e00-\\u9fa5]{1,4})(${TITLES})`, 'g');
  while ((m = reTitle.exec(masked)) !== null) {
    const n = pickName(m[1]);
    if (n) people.add(n.length === 1 ? n + m[2] : n);
  }

  // 动词 + 姓名（要求右边界干净）
  const reVerb = /(?:联系|通知|提醒|找|交给|发给|汇报给|对接|请教)\s*([\u4e00-\u9fa5]{2,4})(?=处|那边|这边|一下|过来|[，。、；;：:\s]|$)/g;
  while ((m = reVerb.exec(masked)) !== null) {
    const n = pickName(m[1]);
    if (n) people.add(n);
  }

  // 小张 / 老王 这类昵称
  const reNick = /(?:交给|发给|交给|找|联系|通知|提醒|请问|问)\s*[\u4e00-\u9fa5]{0,6}?([小老][\u4e00-\u9fa5])(?=处|那边|这儿|[，。、；;：:\s）)]|$)/g;
  while ((m = reNick.exec(masked)) !== null) {
    if (!NAME_STOP.has(m[1])) people.add(m[1]);
  }

  // 负责人：X
  const reOwner = /(?:负责人|联系人|经办人|对接人)\s*[:：]\s*([\u4e00-\u9fa5]{2,3})/g;
  while ((m = reOwner.exec(masked)) !== null) {
    if (isName(m[1])) people.add(m[1]);
  }

  // @昵称
  const reAt = /@([\w\u4e00-\u9fa5]{2,20})/g;
  while ((m = reAt.exec(masked)) !== null) people.add(m[1]);

  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(masked)) !== null) phones.add(m[1]);

  return { people: [...people], phones: [...phones] };
}

/** 优先级 */
export function findPriority(text) {
  const high = /(重要|紧急|务必|必须|一定要|尽快|马上|立刻|立即|加急|勿忘|别忘了|最后期限|deadline|ddl|优先处理|特急|急)/i;
  const low = /(有空|方便时|有时间|可选|不急|看情况|随缘|尽量就好)/;
  if (high.test(text)) return 'high';
  if (low.test(text)) return 'low';
  return 'normal';
}

/** 分类 */
const CATS = {
  work: ['会议', '开会', '汇报', '报告', '项目', '客户', '领导', '部门', '公司', '上班', '加班', '方案', '需求', '上线', '评审', '甲方', '乙方', '周报', '月报', '绩效', '面试', '培训', '合同', '签字', '审批'],
  study: ['作业', '考试', '复习', '课程', '上课', '论文', '老师', '同学', '学习', '讲座', '答辩', '实验', '学费', '教材', '背单词', '预习'],
  life: ['快递', '外卖', '超市', '买', '做饭', '打扫', '洗衣', '搬家', '修理', '取件', '垃圾', '水电', '物业', '宠物', '遛狗'],
  health: ['体检', '医院', '医生', '挂号', '疫苗', '药', '看病', '复诊', '运动', '健身', '牙', '睡眠', '跑步'],
  money: ['报销', '发票', '缴费', '转账', '付款', '退款', '工资', '账单', '贷款', '信用卡', '续费', '充值', '交费', '房租', '押金', '转账'],
  social: ['聚餐', '聚会', '生日', '婚礼', '朋友', '见面', '拜访', '团建', '送礼', '约会', '婚礼', '请客'],
};

export function findCategory(text) {
  let bestKey = 'other', best = 0;
  for (const [k, words] of Object.entries(CATS)) {
    let n = 0;
    for (const w of words) if (text.includes(w)) n++;
    if (n > best) { best = n; bestKey = k; }
  }
  return bestKey;
}

/** 备注线索：明确要求带走/携带/注意的东西 */
const NOTE_MARKERS = /(?:备注|注意|提醒|须知|要求|携带|带上|带着|自带|记得|别忘了|请带|需带|必须带|准备|准备一下|最好|不要|切勿|禁止|逾期|过期|否则|否则|如需|如果有|地点变|改到|改期|取消|押金|费用|自费|每人|限额)[:：]?\s*([^。；;！？!?\n]{2,60})/g;

export function findNoteHints(text) {
  const out = [];
  NOTE_MARKERS.lastIndex = 0;
  let m;
  while ((m = NOTE_MARKERS.exec(text)) !== null) {
    const t = (m[1] || '').trim().replace(/^[:：，,、\s]+/, '');
    if (t.length < 3) continue;
    if (/^(一下|下|吧|了|的|哦|呀|啊)$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** 动作动词（用来判断一句话是不是「要干的事」） */
export const ACTION_VERBS = [
  '参加', '出席', '开会', '召开', '举行', '举办', '组织', '会诊', '提交', '上交', '交纳',
  '缴纳', '缴费', '付款', '付', '转账', '报名', '确认', '回复', '答复', '反馈', '准备',
  '整理', '检查', '审核', '审批', '发送', '领取', '携带', '购买', '预约', '预定', '订',
  '联系', '打电话', '致电', '通知', '提醒', '完成', '填报', '上传', '下载', '打印', '复印',
  '签字', '面谈', '面试', '汇报', '讨论', '培训', '学习', '复习', '考试', '体检', '打疫苗',
  '看病', '搬家', '接送', '出发', '沟通', '对接', '上线', '发布', '更新', '备份', '验收',
  '安装', '维修', '报销', '续费', '充值', '聚餐', '吃饭', '用餐', '团建', '值班', '打卡',
  '签到', '申请', '办理', '续签', '签收', '邮寄', '寄出', '归还', '查看', '阅读', '练习',
  '修改', '完善', '跟进', '催', '核对', '对账', '结账', '报到', '入职', '离职', '交接',
  '买', '取', '带', '发', '交', '送', '接', '写', '填', '抄', '改', '借', '还', '洗',
];

const ACTION_RE = new RegExp(ACTION_VERBS.join('|'));
/** 事件名词：这类句子即使没有动词，也基本是在说一件事 */
const EVENT_NOUN_RE = /(聚餐|吃饭|会议|开会|讲座|面试|体检|报名|预约|汇报|上课|培训|总结会|讨论会|评审会|答辩|考试|婚礼|团建|年会|活动)/;

export function hasAction(text) {
  return ACTION_RE.test(text) || EVENT_NOUN_RE.test(text);
}
