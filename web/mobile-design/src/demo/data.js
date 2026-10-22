export const jobs = [
  { id: 'tech', company: '示例科技', industry: '互联网', size: '100-499人', title: '前端开发工程师', salary: '18–25K/月', location: '上海', education: '本科', experience: '1-3年', major: '计算机', color: 'blue', source: '公告原文已提取', date: '10月23日', next: '补充作品集', applied: '10月22日', score: 86 },
  { id: 'factory', company: '示例制造', industry: '制造业', size: '1000-9999人', title: '管理培训生', salary: '薪资未公开', location: '杭州', education: '应届生', experience: '不限', major: '不限专业', color: 'orange', source: '长期招聘 · 有效性待核实', date: '10月23日', next: '准备笔试', applied: '10月21日', score: 72 },
  { id: 'energy', company: '示例能源', industry: '能源', size: '1000-9999人', title: '数据分析专员', salary: '12–18K/月', location: '北京', education: '本科', experience: '应届生', major: '统计学', color: 'teal', source: '截止日期：11月10日', date: '10月22日', next: '整理项目经历', applied: '10月20日', score: 68 },
];
export const questions = [
  { id:'q1', section:'数量关系', prompt:'某车间每小时生产 24 个零件，连续生产 5 小时，共生产多少个零件？', options:['96个','100个','120个','144个'], correct:2, analysis:'总量 = 每小时产量 × 时间。24 × 5 = 120（个），所以选 C。', topic:'工程问题' },
  { id:'q2', section:'数量关系', prompt:'一件商品原价 200 元，打八折后售价是多少元？', options:['120元','140元','160元','180元'], correct:2, analysis:'八折就是原价的 80%，200 × 0.8 = 160（元），所以选 C。', topic:'经济利润' },
  { id:'q3', section:'数量关系', prompt:'某班有 40 人，其中 25% 参加了志愿活动。参加活动的有多少人？', options:['8人','10人','12人','15人'], correct:1, analysis:'40 × 25% = 10（人），所以选 B。', topic:'比例问题' },
  { id:'q4', section:'数量关系', prompt:'一列火车以每小时 90 千米的速度行驶 2 小时，共行驶多少千米？', options:['45千米','90千米','180千米','270千米'], correct:2, analysis:'路程 = 速度 × 时间，90 × 2 = 180（千米），所以选 C。', topic:'行程问题' },
  { id:'q5', section:'数量关系', prompt:'数列 2、5、8、11 的下一项是多少？', options:['12','13','14','15'], correct:2, analysis:'相邻两项相差 3，11 + 3 = 14，所以选 C。', topic:'数字推理' },
];
export const stages = { saved:'收藏', applied:'已投递', interview:'面试', offer:'Offer' };
export const navigation = [ {path:'/discover',label:'发现',icon:'search'}, {path:'/pipeline',label:'进度',icon:'clipboard'}, {path:'/prep',label:'备考',icon:'file'}, {path:'/account',label:'我的',icon:'user'} ];
export const demoDefaults = () => ({
  version:1, profile:{name:'小路',year:'2027',major:'计算机',education:'本科',city:'上海',role:'前端开发',salary:'18–25K/月'},
  saved:[], hidden:[], progress:{tech:{stage:'applied',next:'补充作品集',date:'2026-10-23',time:'15:00',note:''},factory:{stage:'applied',next:'准备笔试',date:'',time:'',note:''}},
  filters:{q:'',city:'',major:'',salary:false}, searches:[{id:'search-1',name:'上海 · 前端开发',q:'前端',city:'上海',major:''}],
  bookmarks:[], wrong:[], practice:{index:0,answer:null,submitted:false,answers:{}}, exam:null,
  attachments:[{id:'file-1',name:'小路_前端简历.pdf',size:'236 KB',type:'PDF · 仅存储，未解析'}],
  tickets:[], orders:[], messagesRead:false, emailEnabled:false, pushEnabled:false,
  scenario:'normal', signedIn:true, ai:{status:'idle',consent:false},
});
