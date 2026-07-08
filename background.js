importScripts("./supabase.js")
importScripts("./config.js")

// =========================================================================
// 🌐 1. 인프라 초기화 및 환경 변수 바인딩
// =========================================================================
const SUPABASE_URL = ENV.SUPABASE_URL
const SUPABASE_KEY = ENV.SUPABASE_ANON_KEY
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY)

// 2호선 전체 노선도 (순환선 대응 기준 배열)
const SUBWAY_LINE_2_MAP = [
  "시청",
  "충정로",
  "아현",
  "이대",
  "신촌",
  "홍대입구",
  "합정",
  "당산",
  "영등포구청",
  "문래",
  "신도림",
  "대림",
  "구로디지털단지",
  "신대방",
  "신림",
  "봉천",
  "서울대입구",
  "낙성대",
  "사당",
  "방배",
  "서초",
  "교대",
  "강남",
  "역삼",
  "선릉",
  "삼성",
  "종합운동장",
  "잠실새내",
  "잠실",
  "잠실나루",
  "강변",
  "구의",
  "건대입구",
  "성수",
  "용답",
  "신답",
  "용두",
  "신설동",
  "도두리",
  "뚝섬",
  "한양대",
  "왕십리",
  "상왕십리",
  "신당",
  "동대문역사문화공원",
  "을지로4가",
  "uljiro3가",
  "을지로3가",
  "을지로입구",
]

// 지하철 상태 코드 이름표 사전
const TRAIN_STATUS = {
  0: "진입 중 🚄",
  1: "도착 완료 🚉",
  2: "출발 완료 💨",
  3: "전역 출발 (퇴근 타이밍!) 🚨",
}

// 알람 이름 상수 정의
const CLOCK_WATCHER_ALARM = "clock-watcher"
const SUBWAY_POLLING_ALARM = "subway-polling"

// =========================================================================
// ⚙️ 2. [신규 추가] 크롬 로컬 스토리지 데이터 통합 런타임 헬퍼 함수
// =========================================================================
async function getRuntimeSettings() {
  const defaultSettings = {
    stationName: "강남",
    targetStationOffset: 2,
    updnLine: "1",
    peakStartHour: 19,
    peakEndHour: 22,
    monitoringDays: [1, 2, 3, 4, 5, 6],
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        "stationName",
        "targetStationOffset",
        "updnLine",
        "monitoringDays",
        "peakStartHour",
        "peakEndHour",
      ],
      (result) => {
        resolve({
          stationName: result.stationName ?? defaultSettings.stationName,
          targetStationOffset:
            result.targetStationOffset ?? defaultSettings.targetStationOffset,
          updnLine: result.updnLine ?? defaultSettings.updnLine,
          monitoringDays:
            result.monitoringDays ?? defaultSettings.monitoringDays,
          peakStartHour: result.peakStartHour ?? defaultSettings.peakStartHour,
          peakEndHour: result.peakEndHour ?? defaultSettings.peakEndHour,
        })
      },
    )
  })
}

// =========================================================================
// 🚀 3. 지하철 매칭 데이터 파이프라인 (기존 비즈니스 로직 스토리지 연동)
// =========================================================================
const fetchSubwaySnapshot = async () => {
  // 실시간 기동 시점에 로컬 스토리지에서 유저의 변경된 설정을 낚아챕니다.
  const currentSetting = await getRuntimeSettings()

  console.log("\n==============================================")
  console.log(
    `🏃‍♂️ [Pipeline] 지하철 매칭 파이프라인 가동 시작... (목표: ${currentSetting.stationName}역)`,
  )
  console.log("==============================================")

  try {
    console.log("1️⃣ [Step 1] Supabase 엣지 프록시 캐시 펑션 호출 중... 🔍")

    const PROXY_FUNCTION_URL =
      "https://yfjothhxiddwxfbuagjq.supabase.co/functions/v1/quick-api"

    const response = await fetch(PROXY_FUNCTION_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    })

    if (!response.ok) {
      throw new Error(`프록시 서버 응답 에러 (Status: ${response.status})`)
    }

    const data = await response.json()
    const realtimePositionList = data.realtimePositionList || []

    console.log(
      `✅ 엣지 캐싱 레이어 통과 성공! (현재 구동 중인 2호선 열차 수: ${realtimePositionList.length}대)`,
    )

    console.log("2️⃣ [Step 2] 유저 설정 분석 및 순환선 타겟 역 추론 시작...")
    const myStationIndex = SUBWAY_LINE_2_MAP.indexOf(currentSetting.stationName)
    if (myStationIndex === -1) {
      console.error(
        `❌ 노선도 배열에 [${currentSetting.stationName}] 역이 존재하지 않습니다.`,
      )
      return
    }

    let targetIndex = 0

    // 스토리지에서 불러온 실시간 방향 플래그 기준 연산
    if (currentSetting.updnLine === "0") {
      targetIndex = myStationIndex - currentSetting.targetStationOffset
      if (targetIndex < 0) {
        targetIndex = SUBWAY_LINE_2_MAP.length + targetIndex
      }
    } else {
      targetIndex = myStationIndex + currentSetting.targetStationOffset
      if (targetIndex >= SUBWAY_LINE_2_MAP.length) {
        targetIndex = targetIndex - SUBWAY_LINE_2_MAP.length
      }
    }

    const targetStationName = SUBWAY_LINE_2_MAP[targetIndex]
    console.log(
      `🎯 분석 완료: 유저 퇴근역 [${currentSetting.stationName}역] 기준, ${currentSetting.targetStationOffset}정거장 전 감시 대상역은 => [${targetStationName}역] 입니다.`,
    )

    console.log("3️⃣ [Step 3] 스냅샷 리스트 내부 1:1 매칭 조율 중...")

    const targetTrain = realtimePositionList.find(
      (train) =>
        train.statnNm === targetStationName &&
        train.updnLine === currentSetting.updnLine,
    )

    if (!targetTrain) {
      console.log(
        `😴 [안내] 현재 감시 대상역인 [${targetStationName}역] 근처에는 지나가는 열차가 없습니다.`,
      )
      return
    }

    const statusText = TRAIN_STATUS[targetTrain.trainSttus] || "운행 중 🚇"
    console.log(
      `👀 [타겟 발견!] ${targetTrain.trainNo}번 열차가 현재 [${targetTrain.statnNm}역]에 위치함.`,
    )
    console.log(`현재 열차 상태: ${statusText}`)

    const ALERT_ELIGIBLE_STATUS = ["0", "1", "3"]
    const isAlertTiming = ALERT_ELIGIBLE_STATUS.includes(targetTrain.trainSttus)

    if (isAlertTiming) {
      console.log(
        `🚨🚨🚨 [ALERT TRIGGER] 알림 조건 충족! 열차가 감시 대상역 범위에 들어왔습니다! 🏃‍♂️💨`,
      )
      showChromeNotification(
        targetTrain.trainNo,
        targetTrain.statnNm,
        statusText,
      )
    } else {
      if (targetTrain.trainSttus === "2") {
        console.log(
          "💨 열차가 이미 감시 대상역을 출발하여 다음 역으로 향하고 있습니다. 다음 열차를 대기합니다.",
        )
      } else {
        console.log(
          "⏳ 열차가 아직 감시 권역(전역 출발 및 진입)에 도달하지 않았습니다. 15초 뒤 스냅샷을 대기합니다.",
        )
      }
    }
  } catch (err) {
    console.error("💥 파이프라인 가동 중 치명적 시스템 에러 발생:", err)
  }
}

// =========================================================================
// 🧠 4. 타임 윈도우 판별 및 타이머 제어 모듈
// =========================================================================
const manageSchedulerGate = async () => {
  const currentSetting = await getRuntimeSettings()
  const now = new Date()
  const currentDay = now.getDay()
  const currentHour = now.getHours()

  const isDayMatched = currentSetting.monitoringDays.includes(currentDay)
  const isTimeMatched =
    currentHour >= currentSetting.peakStartHour &&
    currentHour < currentSetting.peakEndHour

  const isTimeWindowOpen = isDayMatched && isTimeMatched

  if (isTimeWindowOpen) {
    console.log(
      `🟢 [스케줄러] 현재 시각 ${currentHour}시! 타임 윈도우 활성화. ([${currentSetting.stationName}역] 추적 가동)`,
    )

    chrome.alarms.get(SUBWAY_POLLING_ALARM, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(SUBWAY_POLLING_ALARM, { periodInMinutes: 0.25 })
        fetchSubwaySnapshot()
      }
    })
  } else {
    console.log(
      `🔴 [스케줄러] 현재 시각 ${currentHour}시. 감시 범위 외 구역입니다. 자원을 격리합니다.`,
    )
    chrome.alarms.clear(SUBWAY_POLLING_ALARM)
  }
}

// =========================================================================
// 🔄 5. [신규 추가] 팝업창 저장 즉시 반영 동기화 가드 레이어
// =========================================================================
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local") {
    console.log(
      "🔄 [동기화] 팝업에서 새로운 설정이 감지되었습니다. 스케줄러를 재정렬합니다.",
    )
    manageSchedulerGate()
  }
})

// =========================================================================
// 🔔 6. 알림 인터페이스 및 주기 스케줄러 등록 규칙
// =========================================================================
const showChromeNotification = (trainNo, stationName, statusText) => {
  chrome.notifications.create({
    type: "basic",
    iconUrl:
      "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSHcoC1Vf-DNLzYsBkbGaBdVEHTk1AhxeEfgaJguZgz-XqWAuwnmJ4gkxPA&s=10",
    title: "🚃 퇴근 지하철 타이밍 포착!",
    message: `${trainNo}번 열차가 현재 [${stationName}역] ${statusText}! 지금 짐 싸서 출발하세요! 🏃‍♂️💨`,
    priority: 2,
  })
}

// 마스터 부팅 실행 규칙
manageSchedulerGate()

chrome.alarms.clear(CLOCK_WATCHER_ALARM)
chrome.alarms.create(CLOCK_WATCHER_ALARM, {
  periodInMinutes: 1.0,
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOCK_WATCHER_ALARM) {
    manageSchedulerGate()
  }
  if (alarm.name === SUBWAY_POLLING_ALARM) {
    fetchSubwaySnapshot()
  }
})
