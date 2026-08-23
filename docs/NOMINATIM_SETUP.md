# Nominatim 本地 Geocoding Server 設定說明書

## 概述

呢份文件會解釋點樣設定同運行本地既 Nominatim geocoding server，等 GoPro telemetry extraction 程式可以响本地進行 reverse geocoding（GPS 座標轉做地址），唔洗依賴外面既 OpenStreetMap API。

---

## 系統架構

```
┌─────────────────────────────────────────────────────────────┐
│                        Windows Host                          │
│                                                              │
│   ┌──────────────────────┐    ┌──────────────────────┐    │
│   │   GoPro Dashcam     │    │   Docker Desktop      │    │
│   │   (Node.js App)      │───▶│                      │    │
│   │                      │    │  ┌───────────────┐   │    │
│   │   extract.js         │    │  │ nominatim-web │   │    │
│   │   - 提取 GPS 數據     │    │  │   :8080       │   │    │
│   │   - 呼叫 geocoding   │───▶│  └───────┬───────┘   │    │
│   │   - 生成 SRT 字幕   │    │          │            │    │
│   └──────────────────────┘    │  ┌───────▼───────┐   │    │
│                               │  │  nominatim-db │   │    │
│                               │  │   :5432        │   │    │
│                               │  └───────────────┘   │    │
│                               └──────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Docker Container 說明

### 目前既 Container

| Container Name | Image | Port | 功能 |
|---------------|-------|------|------|
| `nominatim-web` | stefanreuter/nominatim | 8080 | Web API server |
| `nominatim-db` | stefanreuter/nominatim | 5432 | PostgreSQL database |

### 啟動 Command

```powershell
# 啟動 database container
docker run -d --name nominatim-db `
  -v nominatim-data:/data `
  stefanreuter/nominatim:latest `
  /app/startpostgres.sh

# 啟動 web container
docker run -d --name nominatim-web `
  -p 8080:8080 `
  --link nominatim-db:db `
  -v nominatim-data:/data `
  stefanreuter/nominatim:latest `
  /app/start.sh
```

---

## 2. 數據導入 (Import OSM Data)

### 2.1 下載 OSM 數據

去 https://download.geofabrik.de/ 下載你想要既地區既 .pbf 文件。

例如：
- Hong Kong: https://download.geofabrik.de/asia/hong-kong-latest.osm.pbf
- China: https://download.geofabrik.de/asia/china-latest.osm.pbf
- Taiwan: https://download.geofabrik.de/asia/taiwan-latest.osm.pbf

### 2.2 導入數據

```powershell
# 1. 進入 database container
docker exec -it nominatim-db bash

# 2. 導入數據 (假設你已經將 .pbf 文件放入 /data 目錄)
# 第一次導入
./utils/index.php --import --all < /data/hong-kong-latest.osm.pbf

# 或者用初始化脚本
/app/init.sh /data/hong-kong-latest.osm.pbf
```

### 2.3 現有數據

目前既數據已經包含：
- Hong Kong (24MB)
- 總共約 1,080,483 個地點

---

## 3. Database 設定

### 3.1 建立連接用戶

Web server 需要一個 PostgreSQL user 來連接數據庫。

```sql
-- 創建 www-data 用戶 (必須)
CREATE ROLE "www-data" WITH LOGIN PASSWORD 'www-data';
GRANT ALL PRIVILEGES ON DATABASE nominatim TO "www-data";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "www-data";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "www-data";
```

### 3.2 設定 Web Server 連接

响 `nominatim-web` container 度既 settings 文件：

**文件位置**: `/app/src/build/settings/local.php`

```php
<?php
 // 數據庫連接設定
 @define('CONST_Database_DSN', 'pgsql://www-data:www-data@<DB_IP>:5432/nominatim');
 @define('CONST_InstallPath', '/app/src/build');
?>
```

**注意**:
- `<DB_IP>` 應該係 `nominatim-db` 既 IP address (例如 172.17.0.2)
- 如果 container restart 之後 IP 變咗，要更新呢個設定

### 3.3 獲取 Database IP

```powershell
docker inspect nominatim-db --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

---

## 4. 測試 Nominatim Server

### 4.1 檢查 Server 狀態

```powershell
# 從 host 測試
Invoke-WebRequest -Uri 'http://localhost:8080/status'

# 或者响 container 內測試
docker exec nominatim-web curl -s http://localhost:8080/status.php
```

應該返回：`OK`

### 4.2 測試 Search API

```powershell
# Search (forward geocoding)
docker exec nominatim-web curl -s "http://localhost:8080/search?format=json&q=Shenzhen"
```

### 4.3 測試 Reverse Geocoding

```powershell
# Reverse geocoding (座標 -> 地址)
docker exec nominatim-web curl -s "http://localhost:8080/reverse?format=json&lat=22.5499&lon=114.0545"
```

應該返回類似：
```json
{
  "display_name": "深圳书城·中心城, 2014号, 福中一路, 福中社区, 莲花, 福田区, 深圳市, 粤, 518038, China 中国",
  "address": {
    "road": "福中一路",
    "suburb": "莲花",
    "county": "福田区",
    "city": "深圳市",
    "country": "China 中国"
  }
}
```

---

## 5. GoPro Dashcam 程式設定

### 5.1 Geocoding 配置

响 `extract.js` 入面，geocoding 已經 set 好使用本地既 Nominatim server：

```javascript
// extract.js 中的 reverseGeocode 函數
const url = `http://localhost:8080/reverse?format=json&lat=${lat}&lon=${lon}`;
```

### 5.2 Caching

程式有內置 geocoding cache，相同既座標唔會重複 request：

```javascript
const geoCache = new Map();

async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;  // 精確到 100米
  
  if (geoCache.has(key)) {
    return geoCache.get(key);  // 直接由 cache 返回
  }
  // ... 如果無 cache，先 geocode 再存入 cache
}
```

---

## 6. 常見問題

### Q1: Container restart 之後 geocoding 唔 work？

**原因**: Docker 會分配新既 IP address 比 container

**解決方法**:
1. 獲取新既 IP:
```powershell
docker inspect nominatim-db --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
```

2. 更新 local.php:
```php
@define('CONST_Database_DSN', 'pgsql://www-data:www-data@<新IP>:5432/nominatim');
```

3. 重新啟動 Apache:
```bash
docker exec nominatim-web apache2ctl restart
```

### Q2: 出現 "Too many requests" 錯誤？

**原因**: Nominatim 有 rate limiting

**解決方法**: 
- 我地既設定已經使用本地 server，唔會有呢個問題
- 如果真係有，可以响 extract.js 度加入 delay：
```javascript
await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
```

### Q3: www-data role 消失？

**原因**: `nominatim-db` container restart 之後，數據庫既 user 會重置

**解決方法**:
```powershell
# 重新創建 www-data role
docker exec nominatim-db bash -c 'su postgres -c "psql -d nominatim -c \"CREATE ROLE \\\\\\"www-data\\\\\\\" WITH LOGIN PASSWORD \\\\\\"www-data\\\\\\\";\""'
docker exec nominatim-db bash -c 'su postgres -c "psql -d nominatim -c \"GRANT ALL PRIVILEGES ON DATABASE nominatim TO \\\\\\"www-data\\\\\\\";\""'
```

---

## 7. 添加其他地區既 OSM 數據

### 7.1 添加台灣數據

```powershell
# 1. 下載台灣數據
# 去 https://download.geofabrik.de/asia/taiwan-latest.osm.pbf

# 2. 複製到 container
docker cp taiwan-latest.osm.pbf nominatim-db:/data/

# 3. 導入數據 (需要較長時間)
docker exec nominatim-db bash -c 'cd /app/src && ./utils/index.php --import --all < /data/taiwan-latest.osm.pbf'
```

### 7.2 添加澳門數據

```powershell
# 下載澳門數據
# https://download.geofabrik.de/asia/macau-latest.osm.pbf
```

### 7.3 添加更多城市

可以一次過導入多個地區既數據，Nominatim 會自動合併。

---

## 8. 維護命令

```powershell
# 停止所有 containers
docker stop nominatim-web nominatim-db

# 啟動所有 containers  
docker start nominatim-db nominatim-web

# 查看 logs
docker logs nominatim-web
docker logs nominatim-db

# 進入 container
docker exec -it nominatim-web bash
docker exec -it nominatim-db bash

# 數據庫查詢
docker exec -it nominatim-db psql -U postgres -d nominatim

# 統計地點數量
docker exec -u postgres nominatim-db psql -d nominatim -c "SELECT COUNT(*) FROM placex"
```

---

## 9. 參考資料

- Nominatim Official Documentation: https://nominatim.org/
- Geofabrik OSM Data: https://download.geofabrik.de/
- Nominatim Docker Image: https://github.com/mediagis/nominatim-docker
- OpenStreetMap: https://www.openstreetmap.org/

---

*最後更新: 2026-03-17*
