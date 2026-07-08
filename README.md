# 🚃 퇴근길 2호선 맞춤 알림이 (Smart Subway Alarm)

> 크롬 익스텐션의 30초 백그라운드 종료 제약을 극복하고, 서울시 API의 트래픽 제한 문제를 프록시 캐싱 구조로 해결한 유저 맞춤형 지하철 실시간 진입 알림 크롬 익스텐션입니다.

---

## 🚀 프로젝트 배경 및 핵심 기술 과제 (Engineering Challenges)

매일 퇴근길에 반복적으로 지하철 앱을 켜서 열차 위치를 확인해야 하는 번거로움을 해결하고자 시작된 프로젝트입니다. 개발 과정에서 크롬 익스텐션(Manifest V3) 사양과 공공 API 인프라의 한계점을 마주쳤고, 이를 극복하기 위해 아래 두 가지 핵심 과제를 해결하는 데 집중했습니다.

### 1. 서비스 워커 생명주기 제어 및 타임 윈도우 스케줄러 (`background.js`)
* **문제 상황:** 크롬 익스텐션 Manifest V3의 서비스 워커는 메모리 자원 최적화를 위해 **30초간 비활성(Idle) 상태가 지속되면 프로세스를 강제로 종료**시킵니다. 주기적으로 열차 위치를 감시하고 매칭해야 하는 백그라운드 엔진에게는 치명적인 제약이었습니다.
* **해결 방안:** `chrome.alarms` API를 연동하여 브라우저 엔진에 지속적으로 시그널을 전달함으로써 서비스 워커가 종료되지 않도록 **백그라운드 영속성을 안정적으로 확보**했습니다.
* **리소스 최적화:** 모니터링이 필요 없는 주말이나 심야 시간대까지 무식하게 타이머를 구동하는 것은 클라이언트 리소스와 서버 트래픽 측면에서 대단히 비효율적입니다. 따라서 유저가 설정한 특정 요일과 출퇴근 시간대를 판별하는 **정밀 스케줄러**를 구현했습니다. 지정된 시간 범위 내에서만 15초 주기 초정밀 타이머를 가동하고, 범위 밖으로 벗어나면 타이머 인스턴스를 즉시 파괴(Destroy)하여 자원 낭비를 완벽히 차단했습니다.

### 2. 인프라 보호를 위한 On-Demand 프록시 캐싱 레이어 (`Supabase Edge Functions`)
* **문제 상황:** 만약 다수의 클라이언트가 실시간 열차 위치 오픈 API를 15초마다 직접 호출하게 되면, 서울시 서버 측에 과도한 트래픽 부하를 유발하고 IP 차단(Rate Limit) 등의 제약을 받을 위험이 큽니다.
* **해결 방안:** 클라이언트와 원천 데이터 소스 사이에 **Supabase Edge Function을 프록시(Proxy) 캐시 서버로 전면 배치**했습니다.
  * 유저의 실시간 요청이 도달했을 때만 비용 효율적으로 작동하는 On-Demand 방식으로 구동됩니다.
  * `updated_at` 타임스탬프를 대조하는 **"15초 캐시 방어막"** 메커니즘을 구축했습니다. 동시간대에 수많은 유저가 밀집하더라도 서울시 API 실제 호출은 15초당 딱 1회로 제한(Throttling)하며, 나머지 트래픽은 DB 스냅샷 복사본을 반환하도록 설계하여 외부 인프라 보호와 초고속 캐시 응답을 동시에 달성했습니다.

---

## 🛠️ Tech Stacks

- **Client:** Chrome Extension API (Manifest V3), Vanilla JS, Web Notifications API
- **Backend / DB:** Supabase (Edge Functions, PostgreSQL, Deno Runtime)
- **Data Source:** 서울 데이터 광장 (실시간 열차 위치 오픈 API)
  
---

## ⚙️ Data Pipeline Diagram

```text
[Chrome Extension (Client)] 
         │ 
         │ (15s Loop inside Time-Window)
         ▼
[Supabase Edge Function (quick-api)]
         │
         ├─── [Cache Hit (timeDiff < 15s)] ──▶ [Supabase DB Snapshot] (Fast Return)
         │
         └─── [Cache Miss (timeDiff >= 15s)] ──▶ [서울시 오픈 API] (Fresh Fetch)
                                                        │
                                                        ▼
                                             [Upsert to Supabase DB]
```
---

## 💻 Code Structure & Logic Highlight

### 🧠 Client-side: Time-Window 정밀 스케줄러 관리 엔진

1분 주기의 `CLOCK_WATCHER_ALARM`이 문지기 역할을 수행하며, 유저의 시간 조건 충족 여부에 따라 15초 추적 타이머를 온디맨드 형태로 스케줄링 제어합니다.

````javascript
function manageSchedulerGate() {
  const now = new Date();
  const isDayMatched = USER_SETTING.monitoringDays.includes(now.getDay());
  const isTimeMatched = now.getHours() >= USER_SETTING.peakStartHour && now.getHours() < USER_SETTING.peakEndHour;

  if (isDayMatched && isTimeMatched) {
    // 타임 윈도우가 열리면 15초 폴링 알람 활성화 (중복 방지)
    chrome.alarms.get("subway-polling", (alarm) => {
      if (!alarm) chrome.alarms.create("subway-polling", { periodInMinutes: 0.25 });
    });
  } else {
    // 범위 밖일 경우 타이머를 완전히 제거하여 메모리 및 트래픽 격리
    chrome.alarms.clear("subway-polling");
  }
}
````

🧠 Backend-side: 15초 방어막 온디맨드 엣지 프록시 (index.ts)
클라이언트의 크로스 오리진 요청에 대응하는 CORS 헤더 방어와 데이터 일관성을 지키는 아토믹한 캐시 만료 검증 로직입니다.

````TypeScript
// 15초 이내 재접근 시 서울시 API 우회 및 고속 캐시 반환
if (snapshot && snapshot.updated_at) {
  const timeDiff = (new Date().getTime() - new Date(snapshot.updated_at).getTime()) / 1000;
  if (timeDiff < 15) {
    return new Response(JSON.stringify({ realtimePositionList: snapshot.realtimePositionList }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
````

🏃‍♂️ Getting Started
1. 환경 변수 설정 (Security Isolation)
본 프로젝트는 자격 증명 유출 방지를 위해 환경 변수를 철저히 격리합니다. 루트 디렉토리에 config.js 파일을 생성하고 아래와 같이 본인의 Supabase 엔드포인트 정보를 입력합니다. (해당 파일은 .gitignore에 등록되어 레포지토리에 노출되지 않습니다.)

````JavaScript
// config.js
self.ENV = {
  SUPABASE_URL: "YOUR_SUPABASE_PROJECT_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY"
};
````

2. 크롬 확장 프로그램 로드
본 레포지토리를 클론합니다.

크롬 브라우저 주소창에 chrome://extensions/를 입력하여 이동합니다.

우측 상단의 '개발자 모드'를 활성화합니다.

'압축해제된 확장 프로그램을 로드' 버튼을 눌러 프로젝트 루트 폴더를 선택합니다.


🛠️ Infra Structure Setup (For Self-Hosting)
1. Database Table 생성
Supabase Table Editor를 통해 아래 구조의 테이블을 생성합니다.

Table Name: subway_route_snapshots

Columns:

subway_nm (text, Primary Key) : 감시 노선 기준점 (예: "2호선")

realtimePositionList (jsonb) : 데이터 스냅샷 배열

updated_at (timestamptz) : 캐시 만료 판별용 타임스탬프


2. Supabase Edge Function 배포 및 환경 변수 등록
Supabase 콘솔에서 quick-api 이름으로 새로운 Edge Function을 생성하고 코드를 적용합니다.

Function Settings -> Secrets 메뉴에 SEOUL_API_KEY 이름으로 서울 데이터 광장에서 발급받은 본인의 API Key를 등록합니다.


🛒 Production Release Justification

본 프로젝트는 크롬 웹 스토어의 Manifest V3 보안 및 권한 최소화 가이드라인을 엄격히 준수합니다.

alarms: 서비스 워커의 백그라운드 영속성 유지 및 타임 윈도우 기반 정밀 스케줄러 제어 목적

notifications: 유저 커스텀 매칭 열차 진입 시 실시간 데스크톱 푸시 알림 목적

storage: 유저 설정값의 로컬 영속화 목적
