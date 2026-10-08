import { describe, it, expect } from 'vitest';
import {
  amapScheme, amapWeb, baiduScheme, baiduWeb, tencentScheme, tencentWeb,
  NAV_APPS, findPrevPoint, type NavTarget,
} from '../navUrl';

// 用一个经纬度差异明显的点,能一眼看出顺序是否写反
const poi: NavTarget = { name: '玉门关', lng: 93.86, lat: 40.35 };
const from: NavTarget = { name: '兰州中川机场', lng: 103.62, lat: 36.51 };

describe('App 唤起链接(scheme)', () => {
  it('高德:amapuri 协议 + t=0 驾车 + dev=0', () => {
    const u = amapScheme(poi);
    expect(u.startsWith('amapuri://route/plan/?')).toBe(true);
    expect(u).toContain('dlat=40.35');
    expect(u).toContain('dlon=93.86');
    expect(u).toContain('t=0');
    expect(u).toContain('dev=0');
  });

  it('高德带起点:slat/slon/sname(纬度在前)', () => {
    const u = amapScheme(poi, from);
    expect(u).toContain(`slat=${from.lat}`);
    expect(u).toContain(`slon=${from.lng}`);
    expect(u).toContain(`sname=${encodeURIComponent(from.name)}`);
  });

  it('高德不带起点:不出现 slat', () => {
    expect(amapScheme(poi)).not.toContain('slat=');
  });

  it('百度:baidumap 协议 + 坐标 lat,lng(纬度在前)', () => {
    const u = baiduScheme(poi);
    expect(u.startsWith('baidumap://map/direction?')).toBe(true);
    expect(u).toContain('destination=40.35,93.86');
    expect(u).toContain('coord_type=gcj02');
  });

  it('百度带起点:origin=lat,lng(纬度在前)', () => {
    expect(baiduScheme(poi, from)).toContain(`origin=${from.lat},${from.lng}`);
  });

  it('腾讯:qqmap 协议 + 坐标 lat,lng(纬度在前)', () => {
    const u = tencentScheme(poi);
    expect(u.startsWith('qqmap://map/routeplan?')).toBe(true);
    expect(u).toContain('tocoord=40.35,93.86');
  });

  it('腾讯带起点:from 名称 + fromcoord=lat,lng', () => {
    const u = tencentScheme(poi, from);
    expect(u).toContain(`fromcoord=${from.lat},${from.lng}`);
    expect(u).toContain(`from=${encodeURIComponent(from.name)}`);
  });
});

describe('网页版链接(兜底)', () => {
  it('三家都是 https(保证点了有反应)', () => {
    for (const u of [amapWeb(poi), baiduWeb(poi), tencentWeb(poi)]) {
      expect(u.startsWith('https://')).toBe(true);
    }
  });

  it('高德网页版坐标 lng,lat(经度在前)', () => {
    const u = amapWeb(poi);
    expect(u).toContain('to=93.86,40.35');
    expect(u).toContain('coordinate=gaode');
  });

  it('百度网页版坐标 lat,lng(纬度在前)', () => {
    expect(baiduWeb(poi)).toContain('destination=40.35,93.86');
  });

  it('网页版也带上起点', () => {
    expect(amapWeb(poi, from)).toContain(`from=${from.lng},${from.lat},`);
    expect(baiduWeb(poi, from)).toContain(`origin=${from.lat},${from.lng}`);
    expect(tencentWeb(poi, from)).toContain(`fromcoord=${from.lat},${from.lng}`);
  });
});

describe('名称特殊字符编码', () => {
  const weird: NavTarget = { ...poi, name: '和田&夜市 分店' };
  const enc = encodeURIComponent('和田&夜市 分店');
  it('scheme 链接里的终点名会被编码', () => {
    expect(amapScheme(weird)).toContain(`dname=${enc}`);
    expect(tencentScheme(weird)).toContain(`to=${enc}`);
  });
  it('web 链接里的终点名会被编码', () => {
    expect(amapWeb(weird)).toContain(enc);
    expect(tencentWeb(weird)).toContain(enc);
  });
});

describe('NAV_APPS', () => {
  it('暴露三个 App,各有 scheme 与 web', () => {
    expect(NAV_APPS.map((a) => a.key)).toEqual(['amap', 'baidu', 'tencent']);
    for (const a of NAV_APPS) {
      expect(typeof a.scheme(poi)).toBe('string');
      expect(typeof a.web(poi)).toBe('string');
    }
  });
});

describe('findPrevPoint', () => {
  const pts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('取前一个点', () => { expect(findPrevPoint(pts, 'c')).toEqual({ id: 'b' }); });
  it('第一个点无上一站', () => { expect(findPrevPoint(pts, 'a')).toBeUndefined(); });
  it('找不到该点返回 undefined', () => { expect(findPrevPoint(pts, 'z')).toBeUndefined(); });
});
