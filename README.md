# 🚃 2호선 알리미 (크롬 익스텐션)

> 공공 데이터 API 트래픽 과부하 문제를 **온디맨드 프록시 캐싱 레이어**로 방어하고, 브라우저 자원을 극도로 절약하는 **타임 윈도우 정밀 스케줄러** 기반의 초개인화 지하철 스마트 알림 시스템입니다.

---

## 🚀 Key Engineering Challenges & Architecture

본 프로젝트는 단순한 API 래퍼(Wrapper) 클론 코딩을 넘어, **브라우저 생태계의 제약 사항**과 **외부 공공 API 인프라의 한계**를 아키텍처적으로 우아하게 극복하는 데 초점을 맞추어 설계되었습니다.

### 1️⃣ 인프라 보호를 위한 On-Demand 프록시 캐싱 레이어 (Supabase Edge Functions)

- **Problem:** 수백, 수천 명의 클라이언트가 실시간 지하철 위치 API를 15초마다 직접 호출할 경우, 서울시 오픈 API 서버의 과부하 및 IP 차단(Rate Limit) 문제가 발생하여 상용 서비스 지속이 불가능합니다.
- **Solution:** 클라이언트와 원천 데이터 소스 사이에 **Supabase를 프록시 캐시 서버로 배치**하는 아키텍처를 설계했습니다.
  - 유저의 실시간 요청이 도달했을 때만 작동하는 **On-Demand** 방식으로 구동됩니다.
  - `updated_at` 타임스탬프 기반의 **15초 만료 가드 절(Guard Clause)**을 구축하여, 동시간대에 수많은 유저가 밀집하더라도 서울시 API 호출은 15초당 딱 1회(1분에 4회)로 고정(Throttling)되며, 나머지 트래픽은 DB 스냅샷 복사본으로 안전하게 방어합니다.

### 2️⃣ 서비스 워커 영속성 확보 및 Time-Window 정밀 스케줄링 (Client-side)

- **Problem:** 크롬 익스텐션 Manifest V3의 서비스 워커(`background.js`)는 메모리 자원 절약을 위해 30초 동안 백그라운드 작업이 없으면 프로세스를 강제로 종료(Lifecycle Idle)시키는 제약이 존재합니다.
- **Solution:** `chrome.alarms` API를 활용하여 브라우저의 강제 수면 상태를 무력화하고 **백그라운드 영속성(Persistence)을 완벽히 확보**했습니다.
- **Optimization:** 온종일 무식하게 Polling을 도는 자원 낭비를 막기 위해, 유저가 설정한 커스텀 요일 및 출퇴근 시간대 범위를 판별하는 **[Time-Window 정밀 스케줄러]**를 구현했습니다. 지정된 시간 윈도우가 열렸을 때만 15초 초정밀 추적 타이머를 기동하고, 범위 밖으로 벗어나면 타이머 인스턴스를 흔적도 없이 파괴(Destroy)하여 클라이언트 자원 사용량과 서버 트래픽을 완벽하게 0원으로 제어합니다.

---

## 🛠️ Tech Stacks

- **Client:** Chrome Extension API (Manifest V3), JavaScript (ES6+), Web Notifications API
- **Backend / Infrastructure:** Supabase (Edge Functions, PostgreSQL, Deno Runtime)
- **Data Source:** 서울 데이터 광장 (서울시 실시간 열차 위치 오픈 API)

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

🛠️ Infrastructure Setup (For Self-Hosting)
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

storage: 유저 초개인화 설정값의 로컬 영속화 목적
