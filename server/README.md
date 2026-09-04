# 交通查询后端

> 包装 fly-flight 的 `transport_service.py`,提供 REST 接口查询国内航班/高铁真实班次。

## 启动

```bash
cd server
node index.js          # 默认端口 8766
# 或指定端口
TRANSPORT_PORT=8766 node index.js
```

## 接口

| 接口 | 说明 |
|:---|:---|
| `GET /api/health` | 健康检查 |
| `GET /api/transport?mode=train&from=北京&to=上海&date=2026-09-10` | 高铁查询 |
| `GET /api/transport?mode=flight&from=北京&to=西宁&date=2026-09-10` | 航班查询 |

## 返回结构(节选)

```json
{
  "mode": "train",
  "provider": "12306-public",
  "outbound": {
    "route": { "from": { "code": "BJP", "name": "北京" }, "to": { "code": "SHH" }, "date": "2026-09-10" },
    "options": [
      {
        "train_no": "D7",
        "departure_time": "19:18", "arrival_time": "07:25", "duration": "12:07",
        "seat_prices": { "second_class": 451 }
      }
    ]
  }
}
```
航班 option 含 `flight_no / airline_name / departure_time / arrival_time / duration / ticket_price`。

## 数据源
- 高铁:12306 官方公开接口
- 航班:同程公开页面

## 技术说明
- 零 npm 依赖(纯 Node http)
- 通过 `child_process` 调 Python,需 `python3` 环境
- 项目根 `package.json` 有 `type:module`,Python 需引用的 `extract_tongcheng_state` 用 `.cjs`
