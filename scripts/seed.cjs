/**
 * 解析 青甘大环线 Excel 并生成 seed 数据
 * 使用方法: node scripts/seed.js > src/frontend/seed.json
 * 然后在浏览器 console 运行: import('./seed.json').then(d => initTrip(d))
 */
const XLSX = require('xlsx');

const wb = XLSX.readFile('/Users/a58/Desktop/mf/青甘大环线松弛版行程表_含青海湖版.xlsx');
const sheet = wb.Sheets['行程表'];
const raw = XLSX.utils.sheet_to_json(sheet, { header: 1 });

const TITLE = raw[0][0];
const m = raw[1][0].match(/（(\d+)天(\d+)晚）/);
const DAYS = m ? parseInt(m[1]) : 10;

// 解析每天数据
const START_DATE = new Date('2026-09-25');
const rows = raw.slice(3, 3 + DAYS).map((r, i) => {
  const d = new Date(START_DATE);
  d.setDate(d.getDate() + i);
  return {
    daySeq: i + 1,
    date: d.toISOString().slice(0, 10),
    theme: r[2],
    plan: r[3],
    drive: r[4],
    hotel: r[5],
  };
});

// 景点坐标映射（从 青甘行程地图.html 提取）
const COORDS = {
  '兰州': [103.8154, 36.0647],
  '中山桥夜景': [103.8154, 36.0647],
  '天梯山石窟': [102.6320, 37.7420],
  '张掖大佛寺': [100.4545, 38.9315],
  '七彩丹霞（看日落）': [100.0150, 38.9325],
  '瓜州（吃瓜+逛锁阳城）': [96.2410, 40.2520],
  '敦煌': [94.6620, 40.1410],
  '鸣沙山月牙泉（骑骆驼/看日落）': [94.6700, 40.0860],
  '丝路遗产城（下午4点后拍照）': [94.5800, 40.1150],
  '黑独山+胭脂山（日落前到）': [94.3500, 38.9200],
  '大柴旦': [95.3600, 37.8550],
  '茶卡盐湖': [99.0800, 36.7930],
  '青海湖（看日落）': [100.1780, 36.8900],
  '西宁（睡到自然醒再出发）': [101.7780, 36.6170],
  '青海湖': [100.1780, 36.8900],
};

function getCoord(name) {
  for (const [key, coord] of Object.entries(COORDS)) {
    if (name.includes(key) || key.includes(name)) return coord;
  }
  return null;
}

// 提取景点名称
function extractLandmarks(text) {
  const items = [];
  const parts = text.split(/[→、，,]/);
  for (const p of parts) {
    const t = p.trim();
    if (!t || t === '抵达' || t === '睡到自然醒' || t === '睡到自然醒再出发') continue;
    if (t.includes('中山桥') || t.includes('牛肉面') || t.includes('天梯山石窟') ||
        t.includes('大佛寺') || t.includes('七彩丹霞') || t.includes('瓜州') ||
        t.includes('锁阳城') || t.includes('敦煌') || t.includes('鸣沙山') ||
        t.includes('月牙泉') || t.includes('丝路遗产城') || t.includes('黑独山') ||
        t.includes('胭脂山') || t.includes('大柴旦') || t.includes('茶卡盐湖') ||
        t.includes('青海湖') || t.includes('西宁') || t.includes('兰州')) {
      const coord = getCoord(t);
      items.push({ name: t, lng: coord ? coord[0] : 0, lat: coord ? coord[1] : 0 });
    }
  }
  return items;
}

// 生成 seed
const seed = {
  trip: {
    title: TITLE,
    destination: '青甘大环线',
    startDate: rows[0].date,
    endDate: rows[rows.length - 1].date,
    companionCount: 2,
    currency: 'CNY',
    totalBudget: 15000,
  },
  days: rows.map((r) => ({
    daySeq: r.daySeq,
    date: r.date,
    theme: r.theme,
    plan: r.plan,
    drive: r.drive,
    hotel: r.hotel,
    landmarks: extractLandmarks(r.plan),
  })),
};

console.log(JSON.stringify(seed, null, 2));