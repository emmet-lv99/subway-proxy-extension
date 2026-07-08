importScripts("./supabase.js")
importScripts("./config.js")

// SUPABASE INFO
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

// [가정] 유저가 설정한 퇴근 세팅값 (실제 서비스에서는 크롬 스토리지 등에서 팝업창 값을 읽어옴)
const USER_SETTING = {
  stationName: "강남", // 내 퇴근역 (서울시 데이터 기준 '역' 자 제외)
  targetStationOffset: 2, // 감시할 정거장 수 (예: 2정거장 전 열차 감시)
  updnLine: "1", // "0": 내선/상행, "1": 외선/하행
  peakStartHour: 19, // "나는 5시부터 퇴근 준비해!" (오후 5시)
  peakEndHour: 22, // "7시까지만 촘촘하게 감시해줘" (오후 7시)
  monitoringDays: [1, 2, 3, 4, 5, 6], // 요일 번호 (0: 일, 1: 월 ... 6: 토) -> "난 토요일도 출근해!"
}

// 알람 이름 상수 정의
const CLOCK_WATCHER_ALARM = "clock-watcher" // 1분 주기 감시
const SUBWAY_POLLING_ALARM = "subway-polling"

const fetchSubwaySnapshot = async () => {
  console.log("\n==============================================")
  console.log("🏃‍♂️ [Pipeline] 지하철 매칭 파이프라인 가동 시작...")
  console.log("==============================================")

  try {
    // ----------------------------------------------------
    // 1단계: 🎯 [수정] 진짜 실시간 프록시 캐시 펑션 호출!
    // ----------------------------------------------------
    console.log("1️⃣ [Step 1] Supabase 엣지 프록시 캐시 펑션 호출 중... 🔍")

    // 유저님의 펑션 실제 주소 (quick-api)
    const PROXY_FUNCTION_URL =
      "https://yfjothhxiddwxfbuagjq.supabase.co/functions/v1/quick-api"

    const response = await fetch(PROXY_FUNCTION_URL, {
      method: "GET",
      headers: {
        // 엣지 펑션이 익스텐션의 접근을 거부하지 않도록 공용 anon 키를 헤더에 가볍게 얹어줍니다.
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

    // ----------------------------------------------------
    // 2단계: 유저 세팅값 분석 및 '진짜 감시 대상 역' 계산 (순환선 보정)
    // ----------------------------------------------------
    console.log("2️⃣ [Step 2] 유저 설정 분석 및 순환선 타겟 역 추론 시작...")
    const myStationIndex = SUBWAY_LINE_2_MAP.indexOf(USER_SETTING.stationName)
    if (myStationIndex === -1) {
      console.error(
        `❌ 노선도 배열에 [${USER_SETTING.stationName}] 역이 존재하지 않습니다.`,
      )
      return
    }

    let targetIndex = 0

    // 유저 방향 설정에 따른 연산 및 오버플로우/언더플로우 예외 처리
    if (USER_SETTING.updnLine === "0") {
      // 내선 순환 : 인덱스가 감소하는 방향으로 역 추적
      targetIndex = myStationIndex - USER_SETTING.targetStationOffset
      if (targetIndex < 0) {
        targetIndex = SUBWAY_LINE_2_MAP.length + targetIndex
      }
    } else {
      // 외선 순환 : 인덱스가 증가하는 방향으로 역 추적
      targetIndex = myStationIndex + USER_SETTING.targetStationOffset
      if (targetIndex >= SUBWAY_LINE_2_MAP.length) {
        targetIndex = targetIndex - SUBWAY_LINE_2_MAP.length
      }
    }

    const targetStationName = SUBWAY_LINE_2_MAP[targetIndex]
    console.log(
      `🎯 분석 완료: 유저 퇴근역 [${USER_SETTING.stationName}역] 기준, ${USER_SETTING.targetStationOffset}정거장 전 감시 대상역은 => [${targetStationName}역] 입니다.`,
    )

    // ----------------------------------------------------
    // 3단계: 타겟 열차 정보 매칭 및 알림 타이밍 판별
    // ----------------------------------------------------
    console.log("3️⃣ [Step 3] 스냅샷 리스트 내부 1:1 매칭 조율 중...")

    const targetTrain = realtimePositionList.find(
      (train) =>
        train.statnNm === targetStationName &&
        train.updnLine === USER_SETTING.updnLine,
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

    // ====================================================
    // 3단계 하단: 알림 조건 검증 구역 리팩토링
    // ====================================================

    // 👀 기존: const isAlertTiming = targetTrain.trainSttus === "3"

    // 🎯 수정: 감시 대상역(서초역) 근처에 열차가 '진입(0)', '도착(1)', '전역출발(3)' 상태라면 모두 알림 대상으로 인정!
    // (단, "출발 완료(2)"는 이미 서초역을 떠나 강남역으로 가버린 상태이므로 기호에 따라 제외하거나 포함할 수 있습니다.)
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
      // 로그 메시지도 상황에 맞게 정교하게 다듬어 줍니다.
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

// ==========================================
// 🧠 타임 윈도우 판별 및 타이머 제어 엔진
// ==========================================

const manageSchedulerGate = () => {
  const now = new Date()
  // 0:일, 1:월, 2:화, 3:수, 4:목, 5:금, 6:토
  const currentDay = now.getDay()
  const currentHour = now.getHours()

  // 1. 지금이 유저가 설정한 요일과 시간대 안에 포함되는지 검사
  const isDayMatched = USER_SETTING.monitoringDays.includes(currentDay)
  const isTimeMatched =
    currentHour >= USER_SETTING.peakStartHour &&
    currentHour < USER_SETTING.peakEndHour

  // 🎯 지금이 진짜 감시해야 하는 '타임 윈도우(시간의 창)'인가?
  const isTimeWindowOpen = isDayMatched && isTimeMatched

  if (isTimeWindowOpen) {
    console.log(
      `🟢 [스케줄러] 현재 시각 ${currentHour}시! 타임 윈도우가 열렸습니다. 파수꾼 출근 시킵니다.`,
    )

    // 15초 타이머가 없을 때만 새로 생성(중복 생성 방지)
    chrome.alarms.get(SUBWAY_POLLING_ALARM, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(SUBWAY_POLLING_ALARM, { periodInMinutes: 0.25 })
        // 1회 먼저 실행
        fetchSubwaySnapshot()
      }
    })
  } else {
    console.log(
      `🔴 [스케줄러] 현재 시각 ${currentHour}시. 감시 시간이 아닙니다. 파수꾼을 퇴근시키고 자원을 격리합니다.`,
    )

    // 타임 윈도우가 닫혔으므로 15초 주기 타이머를 흔적도 없이 파괴!
    chrome.alarms.clear(SUBWAY_POLLING_ALARM)
  }
}

// 🎯 크롬 시스템 푸시 알림을 실제로 화면에 띄우는 함수
const showChromeNotification = (trainNo, stationName, statusText) => {
  chrome.notifications.create({
    type: "basic",
    iconUrl:
      "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSHcoC1Vf-DNLzYsBkbGaBdVEHTk1AhxeEfgaJguZgz-XqWAuwnmJ4gkxPA&s=10", // 💡 루트 폴더에 icon.png 파일이 없더라도 기본 알림창은 정상적으로 출력됩니다.
    title: "🚃 퇴근 지하철 타이밍 포착!",
    message: `${trainNo}번 열차가 현재 [${stationName}역] ${statusText}! 지금 짐 싸서 출발하세요! 🏃‍♂️💨`,
    priority: 2, // 가장 높은 우선순위로 모니터 화면에 즉시 팝업 노출
  })
}

// ==========================================
// ⏰ 크롬 알람 마스터 스케줄러 등록 규칙
// ==========================================

// 1. 최초 기동 시 즉시 문지기 함수를 실행해서 현재 시간대 파악하기
manageSchedulerGate()

// 2. 온종일 백그라운드에서 1분마다 시계바늘만 슬쩍 쳐다볼 감시자 등록
chrome.alarms.clear(CLOCK_WATCHER_ALARM)
chrome.alarms.create(CLOCK_WATCHER_ALARM, {
  periodInMinutes: 1.0, // ⏱️ 1분마다 문지기 작동
})

// 3. 알람 통합 리스너 분기 처리
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLOCK_WATCHER_ALARM) {
    // 1분마다 지금이 유저가 설정한 시간인지 검사해서 15초 타이머를 켤지 꼴지 결정
    manageSchedulerGate()
  }

  if (alarm.name === SUBWAY_POLLING_ALARM) {
    // 타임 윈도우가 열려있을 때만 15초마다 돌면서 실시간 데이터 가공 파이프라인 작동
    fetchSubwaySnapshot()
  }
})
