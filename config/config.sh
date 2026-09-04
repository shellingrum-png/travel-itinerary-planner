# /config —— 平台无关的统一配置
# 前后端通用常量与枚举,避免魔法字符串

# 出行方式
TRANSPORT_MODES=(walk drive transit)
TRANSPORT_MODE_LABEL_walk=步行
TRANSPORT_MODE_LABEL_drive=自驾/打车
TRANSPORT_MODE_LABEL_transit=公共交通

# 记账分类
EXPENSE_CATEGORIES=(transport hotel food ticket local_traffic other)
EXPENSE_CATEGORY_LABEL_transport=大交通
EXPENSE_CATEGORY_LABEL_hotel=住宿
EXPENSE_CATEGORY_LABEL_food=餐饮
EXPENSE_CATEGORY_LABEL_ticket=门票
EXPENSE_CATEGORY_LABEL_local_traffic=本地交通
EXPENSE_CATEGORY_LABEL_other=其他

# 行程状态
TRIP_STATUSES=(planning ongoing finished)

# 缓存 TTL(天)
ROUTE_CACHE_TTL_DAYS=30
POI_SEARCH_CACHE_TTL_DAYS=7