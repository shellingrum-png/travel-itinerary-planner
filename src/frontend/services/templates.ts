/**
 * V6.0 行程模板服务
 * 冷启动关键:用户输入城市列表 → 匹配本地模板 → 一键套用生成完整行程
 */
import { db } from './db';
import type { TripTemplate, CityNode, Trip, ItineraryItem, Poi, Hotel } from '../types';

/** 模板 content_json 内部结构 */
export interface TemplateContent {
  days: Array<{
    theme: string;                        // 当日主题
    city: string;                         // 所在城市
    landmarks: Array<{ name: string; lng: number; lat: number }>;
    hotel?: { name: string; address?: string; lng: number; lat: number };
    transport?: { note: string; from: string; to: string };
  }>;
}

/** 模板匹配:按城市重合度排序 */
export function matchTemplates(templates: TripTemplate[], userCities: string[]): TripTemplate[] {
  return [...templates]
    .map((tpl) => {
      const tplCities = tpl.cities.split(',').map((c) => c.trim());
      const overlap = tplCities.filter((c) => userCities.includes(c)).length;
      const score = overlap / Math.max(1, tplCities.length);
      return { tpl, score };
    })
    .filter((x) => x.score > 0.3) // 至少重合 30%
    .sort((a, b) => b.score - a.score)
    .map((x) => x.tpl);
}

/** 解析 content_json 并套用到新旅程 */
export async function applyTemplate(
  tpl: TripTemplate,
  input: {
    title: string;
    startDate: string;
    endDate: string;
    companionCount: number;
    currency: string;
    cityNodes: CityNode[];
  },
): Promise<Trip> {
  const content = JSON.parse(tpl.contentJson) as TemplateContent;

  // 1. 创建旅程 + 天数骨架
  const trip = await db.createTrip({
    title: input.title,
    destination: content.days.find((d) => d.city)?.city || tpl.cities,
    startDate: input.startDate,
    endDate: input.endDate,
    companionCount: input.companionCount,
    currency: input.currency,
    cityNodes: input.cityNodes,
  });

  const days = await db.listDays(trip.id);

  // 2. 遍历模板每一天,写入 POI + items + hotel
  for (let i = 0; i < content.days.length; i++) {
    const dayData = content.days[i];
    const day = days[i];
    if (!day) continue;

    // 每日主题
    if (dayData.theme) {
      await db.updateDay(day.id, { note: dayData.theme }).catch(() => {});
    }

    // 交通节点(城际移动)
    if (dayData.transport) {
      await db.addItem({
        dayId: day.id,
        itemType: 'transport',
        transportMode: 'drive',
        note: dayData.transport.note,
        visitMinutes: 0,
      });
    }

    // 景点
    for (const lm of dayData.landmarks || []) {
      const poiId = crypto.randomUUID();
      await db.upsertPoi({
        id: poiId,
        name: lm.name,
        lng: lm.lng,
        lat: lm.lat,
        category: 'poi',
      });
      await db.addItem({
        dayId: day.id,
        poiId,
        itemType: 'poi',
        transportMode: 'walk',
        note: lm.name,
        visitMinutes: 90,
      });
    }

    // 酒店
    if (dayData.hotel) {
      const poiId = crypto.randomUUID();
      await db.upsertPoi({
        id: poiId,
        name: dayData.hotel.name,
        lng: dayData.hotel.lng,
        lat: dayData.hotel.lat,
        category: 'hotel',
        address: dayData.hotel.address,
      });
      await db.addItem({
        dayId: day.id,
        poiId,
        itemType: 'hotel',
        transportMode: 'walk',
        note: dayData.hotel.name,
        visitMinutes: 0,
      });
      const h: Omit<Hotel, 'id'> = {
        tripId: trip.id,
        name: dayData.hotel.name,
        address: dayData.hotel.address,
        lng: dayData.hotel.lng,
        lat: dayData.hotel.lat,
        checkIn: day.date,
        checkOut: day.date,
        poiId,
      };
      await db.addHotel(h);
    }
  }

  return trip;
}

/** 生成青甘大环线模板(内置冷启动数据) */
export function qingganTemplate(): TripTemplate {
  const content: TemplateContent = {
    days: [
      { theme: '初见金城', city: '兰州', landmarks: [
        { name: '中山桥', lng: 103.8154, lat: 36.0647 },
        { name: '黄河母亲雕塑', lng: 103.8255, lat: 36.0678 },
      ], hotel: { name: '兰州中心假日酒店', lng: 103.8396, lat: 36.0744 } },
      { theme: '河西走廊', city: '张掖', transport: { note: '自驾 兰州→张掖 约 2 小时', from: '兰州', to: '张掖' }, landmarks: [
        { name: '张掖大佛寺', lng: 100.4545, lat: 38.9315 },
        { name: '张掖湿地公园', lng: 100.4678, lat: 38.9578 },
      ], hotel: { name: '张掖宾馆', lng: 100.4558, lat: 38.9302 } },
      { theme: '丹霞盛宴', city: '张掖', landmarks: [
        { name: '七彩丹霞', lng: 100.015, lat: 38.9325 },
      ], hotel: { name: '丹霞口民宿', lng: 100.0208, lat: 38.9291 } },
      { theme: '丝路敦煌', city: '瓜州', transport: { note: '自驾 张掖→瓜州 约 3 小时', from: '张掖', to: '瓜州' }, landmarks: [
        { name: '锁阳城', lng: 96.241, lat: 40.252 },
      ], hotel: { name: '瓜州丝路宾馆', lng: 96.1985, lat: 40.0206 } },
      { theme: '沙漠日落', city: '敦煌', transport: { note: '自驾 瓜州→敦煌 约 3 小时', from: '瓜州', to: '敦煌' }, landmarks: [
        { name: '鸣沙山月牙泉', lng: 94.67, lat: 40.086 },
      ], hotel: { name: '敦煌山庄', lng: 94.6702, lat: 40.0592 } },
      { theme: '丝路遗梦', city: '敦煌', landmarks: [
        { name: '莫高窟', lng: 94.8099, lat: 40.04 },
      ], hotel: { name: '敦煌山庄', lng: 94.6702, lat: 40.0592 } },
      { theme: '盐湖秘境', city: '青海湖', transport: { note: '自驾 敦煌→青海湖 约 6.5 小时', from: '敦煌', to: '青海湖' }, landmarks: [
        { name: '青海湖', lng: 100.178, lat: 36.89 },
      ], hotel: { name: '青海湖边客栈', lng: 100.1847, lat: 36.8928 } },
    ],
  };

  return {
    id: 'tpl-qinggan-7d',
    title: '青甘大环线经典7日游',
    cities: '西宁,张掖,敦煌,兰州',
    daysCount: 7,
    contentJson: JSON.stringify(content),
  };
}